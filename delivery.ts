import { setTimeout as wait } from "node:timers/promises";
import { createNoticeStore, type Notice, type NoticeRedis } from "./store.ts";
import { createTargetStore, selectNoticeGroups } from "./targets.ts";

export interface NoticeDeliveryHost {
  onlineBots(): readonly number[];
  listGroups(botId: number): Promise<readonly { id: number; name?: string }[]>;
  sendGroup(botId: number, groupId: number, content: string): Promise<number>;
  deleteMessage(botId: number, messageId: number): Promise<void>;
}

type Destination = { botId: number; groupId: number };
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
  stopped?: "cancelled" | "notice-changed" | "storage-error";
};

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

const claimGroup = `
local previous = redis.call('HGET', KEYS[1], ARGV[1])
if previous and cjson.decode(previous).state ~= 'not-sent' then return 0 end
if redis.call('GET', KEYS[2]) ~= ARGV[2] or redis.call('HGET', KEYS[3], 'content') ~= ARGV[3] then
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

function readReceipt(group: string, raw: string): DeliveryReceipt {
  const { botId, groupId, state, messageId, recall } = JSON.parse(raw) as {
    botId: unknown; groupId: unknown; state: unknown; messageId?: unknown; recall?: unknown;
  };
  if (id(botId) && id(groupId) && String(groupId) === group) {
    if (state === "confirmed" && typeof messageId === "number" && Number.isSafeInteger(messageId)) {
      if (recall === undefined) return { botId, groupId, state, messageId };
      if (recallState(recall)) return { botId, groupId, state, messageId, recall };
      throw new Error("公告撤回回执格式无效");
    }
    if (state === "pending" || state === "not-sent" || state === "unknown") {
      return { botId, groupId, state };
    }
  }
  throw new Error("公告投递回执格式无效");
}

async function send(host: NoticeDeliveryHost, notice: Notice, target: Destination): Promise<DeliveryReceipt> {
  const content = `【公告通知】\n${notice.content}\n${notice.timestamp}`;
  try {
    const messageId = await host.sendGroup(target.botId, target.groupId, content);
    return Number.isSafeInteger(messageId)
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
    async push(signal?: AbortSignal, scheduled?: Notice): Promise<Result> {
      const result: Result = { selected: 0, receipts: [], alreadyClaimed: 0, discoveryFailures: 0 };
      if (signal?.aborted) return { ...result, stopped: "cancelled" };
      const notice = scheduled ?? await notices.current();
      if (!notice) return result;
      result.noticeId = notice.id;
      const destinations = new Map<number, Destination & { interval: number }>();
      for (const botId of new Set(host.onlineBots().filter(id))) {
        if (signal?.aborted) return { ...result, stopped: "cancelled" };
        try {
          const settings = await targets.settings(String(botId));
          if (signal?.aborted) return { ...result, stopped: "cancelled" };
          if (!settings.account?.enabled) continue;
          const groups = await host.listGroups(botId);
          if (signal?.aborted) return { ...result, stopped: "cancelled" };
          for (const selected of selectNoticeGroups(settings, groups.map((group) => group.id).filter(id))) {
            const groupId = Number(selected);
            if (!destinations.has(groupId)) {
              destinations.set(groupId, { botId, groupId, interval: settings.account.pushInterval ?? defaultInterval });
            }
          }
        } catch {
          result.discoveryFailures++;
        }
      }
      result.selected = destinations.size;

      const lastSend = new Map<number, number>();
      for (const { botId, groupId, interval } of destinations.values()) {
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

        const pending = JSON.stringify({ botId, groupId, state: "pending", attempt: crypto.randomUUID() });
        try {
          const claim = await redis.eval(claimGroup, {
            keys: [receiptKey(notice.id), currentKey, noticeKey(notice.id)],
            arguments: [String(groupId), notice.id, notice.content, pending],
          });
          if (claim === -1) return { ...result, stopped: "notice-changed" };
          if (claim === 0) {
            result.alreadyClaimed++;
            continue;
          }
          if (claim !== 1) return { ...result, stopped: "storage-error" };

          const receipt = signal?.aborted
            ? { botId, groupId, state: "not-sent" as const }
            : await send(host, notice, { botId, groupId });
          const saved = await redis.eval(finishGroup, {
            keys: [receiptKey(notice.id), noticeKey(notice.id)],
            arguments: [String(groupId), pending, JSON.stringify(receipt), receipt.state],
          });
          if (saved !== 1) return { ...result, stopped: "storage-error" };
          result.receipts.push(receipt);
          lastSend.set(botId, Date.now());
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
        const pending = JSON.stringify({ ...receipt, recall: "pending", recallAttempt: crypto.randomUUID() });
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
              await host.deleteMessage(receipt.botId, receipt.messageId);
              recall = "confirmed";
            } catch (error) {
              recall = unconfirmed(error);
            }
          }
          const updated = { ...receipt, recall };
          const saved = await redis.eval(replaceReceipt, {
            keys: [key], arguments: [group, pending, JSON.stringify(updated)],
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
