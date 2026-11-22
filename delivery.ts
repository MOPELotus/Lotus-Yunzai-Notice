import { setTimeout as wait } from "node:timers/promises";
import { decorateNotice, type NoticeSegment } from "./content.ts";
import { createNoticeStore, type Notice, type NoticeRedis } from "./store.ts";
import { createTargetStore, selectNoticeGroups } from "./targets.ts";

type NoticeAdapter = "onebot" | "milky";
type GroupMembership = readonly { id: number; name?: string }[];
export type NoticeDeliverySegment = NoticeSegment | { readonly type: "image"; readonly file: Uint8Array };
export type NoticeDeliveryReply = string | readonly NoticeDeliverySegment[];

export interface NoticeAccount {
  readonly botId: number;
  readonly adapter: NoticeAdapter;
  listGroups(signal?: AbortSignal): Promise<GroupMembership>;
  sendGroup(groupId: number, content: NoticeDeliveryReply, signal?: AbortSignal): Promise<number>;
}

export interface NoticeDeliveryHost {
  onlineBots(): readonly number[];
  listGroups(botId: number): Promise<GroupMembership>;
  sendGroup(botId: number, groupId: number, content: NoticeDeliveryReply): Promise<number>;
  deleteMessage(botId: number, messageId: number): Promise<void>;
  noticeAccounts?(): readonly NoticeAccount[];
  recallGroupMessage?(adapter: NoticeAdapter, botId: number, groupId: number, messageId: number, signal?: AbortSignal): Promise<void>;
}

type Destination = { botId: number; groupId: number; adapter?: "milky" };
type DeliveryState = "pending" | "confirmed" | "not-sent" | "unknown";
type RecallState = DeliveryState;
export type DeliveryReceipt = Destination & (
  | { state: "confirmed"; messageId: number; recall?: RecallState }
  | { state: Exclude<DeliveryState, "confirmed"> }
);

type Result = {
  noticeId?: string;
  selected: number;
  receipts: DeliveryReceipt[];
  alreadyClaimed: number;
  discoveryFailures: number;
  accountTotals: ReadonlyMap<number, number>;
  stopped?: "cancelled" | "notice-changed" | "storage-error";
};

export type NoticePushProgress = (noticeId: string, processed: number, selected: number, confirmed: number, accounts: number) => Promise<void>;

type RecallOptions = { noticeId?: string; groupId?: number; signal?: AbortSignal };
type RecallResult = {
  noticeId?: string;
  selected: number;
  receipts: Array<Extract<DeliveryReceipt, { state: "confirmed" }>>;
  alreadyClaimed: number;
  stopped?: "cancelled" | "storage-error";
};

const noticeIdPattern = /^\d{5}[A-Z]{3}$/u;
const currentKey = "notice:current";
const defaultInterval = 2_000;
const receiptKey = (noticeId: string) => `notice:delivery:${noticeId}`;
const noticeKey = (noticeId: string) => `notice:ann:${noticeId}`;
const id = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

export function noticeAccounts(host: NoticeDeliveryHost): readonly NoticeAccount[] {
  if (!host.noticeAccounts) {
    return [...new Set(host.onlineBots().filter(id))].map((botId) => ({
      botId, adapter: "onebot",
      listGroups: () => host.listGroups(botId),
      sendGroup: (groupId, content) => host.sendGroup(botId, groupId, content),
    }));
  }
  const selected = new Map<number, NoticeAccount>();
  for (const account of host.noticeAccounts()) {
    if (!id(account.botId) || (account.adapter !== "milky" && account.adapter !== "onebot")) continue;
    const current = selected.get(account.botId);
    if (!current || (current.adapter === "milky" && account.adapter === "onebot")) selected.set(account.botId, account);
  }
  return [...selected.values()];
}

export function noticeAdapter(account: NoticeAccount): { adapter?: "milky" } {
  return account.adapter === "milky" ? { adapter: "milky" } : {};
}

const claimGroup = `
local previous = redis.call('HGET', KEYS[1], ARGV[1])
if previous and cjson.decode(previous).state ~= 'not-sent' then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] or redis.call('HGET', KEYS[3], 'content') ~= ARGV[3] or
  (redis.call('HGET', KEYS[3], 'segments') or '') ~= ARGV[5] then
  return -1
end
local status = redis.call('HGET', KEYS[3], 'status')
if status == '已撤回' or status == 'recalled' then return -1 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
local ttl = redis.call('PTTL', KEYS[3])
if ttl >= 0 then
  redis.call('PEXPIRE', KEYS[1], ttl + 2592000000)
else
  redis.call('PERSIST', KEYS[1])
end
return 1
`;

const finishGroup = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
if ARGV[4] == 'confirmed' and redis.call('TYPE', KEYS[2]).ok == 'hash' then
  redis.call('HSET', KEYS[2], 'push', '已推送')
end
return 1
`;

const replaceReceipt = `
if redis.call('HGET', KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
`;

function unconfirmed(error: unknown): "not-sent" | "unknown" {
  return error instanceof Error && "delivery" in error && error.delivery === "not-sent"
    ? "not-sent" : "unknown";
}

function recallState(value: unknown): value is RecallState {
  return value === "pending" || value === "confirmed" || value === "not-sent" || value === "unknown";
}

function writeReceipt(receipt: DeliveryReceipt & { recallAttempt?: string }): string {
  if (receipt.adapter === "milky" && receipt.state === "confirmed") {
    // Older versions only read state and must never send a Milky sequence to OneBot.
    return JSON.stringify({ ...receipt, state: "unknown", milkyState: "confirmed" });
  }
  return JSON.stringify(receipt);
}

function readReceipt(group: string, raw: string): DeliveryReceipt {
  const { botId, groupId, adapter, state: storedState, milkyState, messageId, recall } = JSON.parse(raw) as {
    botId: unknown; groupId: unknown; adapter?: unknown; state: unknown; milkyState?: unknown; messageId?: unknown; recall?: unknown;
  };
  const state = adapter === "milky" && storedState === "unknown" && milkyState === "confirmed" ? "confirmed" : storedState;
  if (id(botId) && id(groupId) && String(groupId) === group && (adapter === undefined || adapter === "onebot" || adapter === "milky")) {
    const destination: Destination = { botId, groupId, ...(adapter === "milky" ? { adapter } : {}) };
    if (state === "confirmed" && typeof messageId === "number" && Number.isSafeInteger(messageId) && (adapter !== "milky" || messageId >= 0)) {
      if (recall === undefined) return { ...destination, state, messageId };
      if (recallState(recall)) return { ...destination, state, messageId, recall };
      throw new Error("公告撤回回执格式无效");
    }
    if (state === "pending" || state === "not-sent" || state === "unknown") {
      return { ...destination, state };
    }
  }
  throw new Error("公告投递回执格式无效");
}

async function send(account: NoticeAccount, notice: Notice, target: Destination, signal?: AbortSignal): Promise<DeliveryReceipt> {
  const content = decorateNotice(notice.content, notice.segments, "【公告通知】\n", `\n${notice.timestamp}`);
  try {
    const messageId = await account.sendGroup(target.groupId, content, signal);
    return Number.isSafeInteger(messageId) && (account.adapter !== "milky" || messageId >= 0)
      ? { ...target, state: "confirmed", messageId }
      : { ...target, state: "unknown" };
  } catch (error) {
    return {
      ...target,
      state: unconfirmed(error),
    };
  }
}

export function createNoticeDelivery(
  redis: NoticeRedis,
  host: NoticeDeliveryHost,
  pause: (milliseconds: number, signal?: AbortSignal) => Promise<void> = (ms, signal) =>
    wait(ms, undefined, { signal }),
) {
  const notices = createNoticeStore(redis);
  const targets = createTargetStore(redis);

  async function readEntries(noticeId: string) {
    if (!noticeIdPattern.test(noticeId)) throw new Error("公告编号无效");
    const entries = await redis.hGetAll(receiptKey(noticeId));
    return Object.entries(entries).map(([group, raw]) => ({
      raw, receipt: readReceipt(group, raw),
    })).sort((a, b) => a.receipt.groupId - b.receipt.groupId);
  }

  return {
    async push(signal?: AbortSignal, scheduled?: Notice, accounts?: readonly NoticeAccount[], progress?: NoticePushProgress): Promise<Result> {
      const accountTotals = new Map<number, number>();
      const result: Result = { selected: 0, receipts: [], alreadyClaimed: 0, discoveryFailures: 0, accountTotals };
      if (signal?.aborted) return { ...result, stopped: "cancelled" };
      const notice = scheduled ?? await notices.current();
      if (!notice) return result;
      const noticeId = notice.id;
      result.noticeId = noticeId;
      const destinations = new Map<number, { groupId: number; interval: number; account: NoticeAccount }>();
      for (const account of accounts ?? noticeAccounts(host)) {
        const { botId } = account;
        if (signal?.aborted) return { ...result, stopped: "cancelled" };
        try {
          const settings = await targets.settings(String(botId));
          if (signal?.aborted) return { ...result, stopped: "cancelled" };
          if (!settings.account?.enabled) continue;
          const groups = await account.listGroups(signal);
          if (signal?.aborted) return { ...result, stopped: "cancelled" };
          for (const selected of selectNoticeGroups(settings, groups.map((group) => group.id).filter(id))) {
            const groupId = Number(selected);
            if (!destinations.has(groupId)) {
              destinations.set(groupId, { account, groupId, interval: settings.account.pushInterval ?? defaultInterval });
              accountTotals.set(botId, (accountTotals.get(botId) ?? 0) + 1);
            }
          }
        } catch {
          result.discoveryFailures++;
        }
      }
      result.selected = destinations.size;
      if (result.selected > 0) await report(0, 0);

      let confirmed = 0;
      let processed = 0;
      const checkpoint = Math.ceil(result.selected / 5);
      async function report(processed: number, confirmed: number) {
        if (!progress || signal?.aborted) return;
        try { await progress(noticeId, processed, result.selected, confirmed, accountTotals.size); }
        catch { /* A failed progress reply must not interrupt group delivery. */ }
      }

      const lastSend = new Map<number, number>();
      for (const { account, groupId, interval } of destinations.values()) {
        const { botId } = account;
        const destination = { botId, groupId, ...noticeAdapter(account) };
        if (signal?.aborted) return { ...result, stopped: "cancelled" };
        const gap = lastSend.get(botId);
        if (gap !== undefined) {
          const remaining = gap + interval - Date.now();
          if (remaining > 0) {
            try {
              await pause(remaining, signal);
            } catch (error) {
              if (!signal?.aborted) throw error;
            }
          }
        }
        if (signal?.aborted) return { ...result, stopped: "cancelled" };

        const pending = JSON.stringify({ ...destination, state: "pending", attempt: crypto.randomUUID() });
        try {
          const claim = await redis.eval(claimGroup, {
            keys: [receiptKey(notice.id), currentKey, noticeKey(notice.id)],
            arguments: [String(groupId), notice.id, notice.content, pending, notice.segmentSource ?? ""],
          });
          if (claim === -1) return { ...result, stopped: "notice-changed" };
          if (claim === 0) {
            result.alreadyClaimed++;
            processed++;
            if (processed < result.selected && processed % checkpoint === 0) await report(processed, confirmed);
            continue;
          }
          if (claim !== 1) return { ...result, stopped: "storage-error" };

          const receipt = signal?.aborted
            ? { ...destination, state: "not-sent" as const }
            : await send(account, notice, destination, signal);
          const saved = await redis.eval(finishGroup, {
            keys: [receiptKey(notice.id), noticeKey(notice.id)],
            arguments: [String(groupId), pending, writeReceipt(receipt), receipt.state],
          });
          if (saved !== 1) return { ...result, stopped: "storage-error" };
          result.receipts.push(receipt);
          lastSend.set(botId, Date.now());
          if (receipt.state === "confirmed") confirmed++;
          processed++;
          if (processed < result.selected && processed % checkpoint === 0) await report(processed, confirmed);
        } catch {
          return { ...result, stopped: "storage-error" };
        }
      }
      return signal?.aborted ? { ...result, stopped: "cancelled" } : result;
    },

    async recall({ noticeId, groupId, signal }: RecallOptions = {}): Promise<RecallResult> {
      const result: RecallResult = { selected: 0, receipts: [], alreadyClaimed: 0 };
      if (signal?.aborted) return { ...result, stopped: "cancelled" };
      if (groupId !== undefined && !id(groupId)) throw new Error("公告目标群无效");

      const resolved = noticeId ?? (await notices.current())?.id;
      if (resolved === undefined) return result;
      result.noticeId = resolved;
      const candidates = (await readEntries(resolved)).filter(({ receipt }) =>
        receipt.state === "confirmed" && (groupId === undefined || receipt.groupId === groupId));
      result.selected = candidates.length;

      for (const { raw, receipt } of candidates) {
        if (signal?.aborted) return { ...result, stopped: "cancelled" };
        if (receipt.state !== "confirmed") continue;
        if (receipt.recall !== undefined && receipt.recall !== "not-sent") {
          result.alreadyClaimed++;
          continue;
        }

        const key = receiptKey(resolved);
        const group = String(receipt.groupId);
        const pending = writeReceipt({ ...receipt, recall: "pending", recallAttempt: crypto.randomUUID() });
        try {
          const claim = await redis.eval(replaceReceipt, {
            keys: [key], arguments: [group, raw, pending],
          });
          if (claim === 0) {
            result.alreadyClaimed++;
            continue;
          }
          if (claim !== 1) return { ...result, stopped: "storage-error" };

          let recall: RecallState = "not-sent";
          if (!signal?.aborted) {
            try {
              const adapter = receipt.adapter ?? "onebot";
              if (host.recallGroupMessage) {
                await host.recallGroupMessage(adapter, receipt.botId, receipt.groupId, receipt.messageId, signal);
                recall = "confirmed";
              } else if (adapter === "onebot") {
                await host.deleteMessage(receipt.botId, receipt.messageId);
                recall = "confirmed";
              }
            } catch (error) {
              recall = unconfirmed(error);
            }
          }
          const updated = { ...receipt, recall };
          const saved = await redis.eval(replaceReceipt, {
            keys: [key], arguments: [group, pending, writeReceipt(updated)],
          });
          if (saved !== 1) return { ...result, stopped: "storage-error" };
          result.receipts.push(updated);
        } catch {
          return { ...result, stopped: "storage-error" };
        }
      }
      return signal?.aborted ? { ...result, stopped: "cancelled" } : result;
    },

    async receipts(noticeId?: string): Promise<{ noticeId: string; receipts: DeliveryReceipt[] } | undefined> {
      const resolved = noticeId ?? (await notices.current())?.id;
      if (resolved === undefined) return;
      return { noticeId: resolved, receipts: (await readEntries(resolved)).map(({ receipt }) => receipt) };
    },
  };
}
