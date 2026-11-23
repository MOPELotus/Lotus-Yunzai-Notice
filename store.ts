import { decodeNoticeSegments, encodeNoticeContent, type NoticeReply, type NoticeSegment } from "./content.ts";

const currentKey = "notice:current";
const historyKey = "notice:history";
const announcementPrefix = "notice:ann:";
const validId = /^\d{5}[A-Z]{3}$/u;

export interface NoticeRedis {
  get(key: string): Promise<string | null>;
  lRange(key: string, first: number, last: number): Promise<string[]>;
  hGetAll(key: string): Promise<Record<string, string>>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface Notice {
  readonly id: string;
  readonly content: string;
  readonly creator: string;
  readonly status?: string;
  readonly timestamp: string;
  readonly segments?: readonly NoticeSegment[];
  readonly segmentSource?: string;
}

export type NoticeWriteReceipt =
  | { readonly state: "confirmed"; readonly notice: Notice }
  | { readonly state: "missing" | "rejected" | "unknown" };

function activeNotice(id: string, entry: Record<string, string>): Notice | undefined {
  if (!entry.content?.trim() || !entry.timestamp || !entry.creator ||
      ["已撤回", "recalled"].includes(entry.status ?? "")) return;

  const notice = { id, content: entry.content, creator:entry.creator, status:entry.status, timestamp: entry.timestamp };
  if (!entry.segments) return notice;
  const segments = decodeNoticeSegments(entry.segments, entry.content);
  return { ...notice, segmentSource: entry.segments, ...(segments ? { segments } : {}) };
}

// All mutations are serialized by Valkey. Check key types before issuing the
// first mutation because errors during a Lua script do not roll back writes.
const mutateScript = `
local function expect_type(key, kind)
  local actual = redis.call('TYPE', key).ok
  return actual == 'none' or actual == kind
end

local op, prefix, new_id, content, creator, timestamp, now, segments = unpack(ARGV)
if not expect_type(KEYS[1], 'string') or not expect_type(KEYS[2], 'list') then
  return 'rejected'
end

local current = redis.call('GET', KEYS[1])
if current and not string.match(current, '^%d%d%d%d%d[A-Z][A-Z][A-Z]$') then
  return 'rejected'
end
local old = current and prefix .. current
if old and not expect_type(old, 'hash') then
  return 'rejected'
end
local status = old and redis.call('HGET', old, 'status')
local alive = old and status ~= '已撤回' and status ~= 'recalled' and
  redis.call('HEXISTS', old, 'content') == 1 and
  redis.call('HEXISTS', old, 'timestamp') == 1 and
  redis.call('HEXISTS', old, 'creator') == 1

local function archive(state)
  redis.call('HSET', old, 'status', state)
  redis.call('LREM', KEYS[2], 0, current)
  redis.call('LPUSH', KEYS[2], current)
  redis.call('LTRIM', KEYS[2], 0, 49)
end

if op == 'publish' then
  local target = prefix .. new_id
  if new_id == current or redis.call('EXISTS', target) == 1 or redis.call('LPOS', KEYS[2], new_id) then
    return 'collision'
  end
  if alive then archive('已归档') end
  redis.call('HSET', target, 'content', content, 'creator', creator,
    'timestamp', timestamp, 'status', '当前', 'push', '未推送', 'created', now)
  if segments ~= '' then redis.call('HSET', target, 'segments', segments) end
  redis.call('EXPIRE', target, 2592000)
  redis.call('SET', KEYS[1], new_id)
  return {new_id, creator, timestamp, '当前'}
end

if not alive then return false end
if op == 'edit' then
  local metadata = redis.call('HMGET', old, 'creator', 'timestamp')
  redis.call('HSET', old, 'content', content)
  if segments == '' then redis.call('HDEL', old, 'segments')
  else redis.call('HSET', old, 'segments', segments) end
  return {current, metadata[1], metadata[2], status or ''}
elseif op == 'recall' then
  archive('已撤回')
  redis.call('DEL', KEYS[1])
end
return current
`;

export function createNoticeStore(redis: NoticeRedis) {
  async function mutate(
    op: "publish" | "edit" | "recall",
    id = "",
    { text, segments } = { text: "", segments: "" },
    creator = "",
    time = new Date(),
  ) {
    const iso = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium",
    }).format(time);
    return redis.eval(mutateScript, {
      keys: [currentKey, historyKey],
      arguments: [op, announcementPrefix, id, text, creator, iso, String(time.getTime()), segments],
    });
  }

  async function write(content: NoticeReply, creator?: string): Promise<NoticeWriteReceipt> {
    const op = creator === undefined ? "edit" : "publish";
    const { text, segments } = encodeNoticeContent(content);
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = op === "publish" ? newNoticeId() : "";
        const receipt = await mutate(op, id, { text, segments }, creator);
        if (receipt === "collision" && op === "publish") continue;
        if (receipt === "rejected") return { state: "rejected" };
        if ((receipt === null || receipt === false) && op === "edit") return { state: "missing" };
        if (Array.isArray(receipt) && receipt.length === 4) {
          const [savedId, savedCreator, timestamp, status] = receipt;
          if (typeof savedId === "string" && validId.test(savedId) && (!id || (id === savedId && creator === savedCreator)) &&
              typeof savedCreator === "string" && typeof timestamp === "string" && typeof status === "string") {
            const notice = activeNotice(savedId, { creator: savedCreator, timestamp, status, content: text, segments });
            if (notice) return { state: "confirmed", notice };
          }
        }
        // A missing or malformed receipt does not rule out a committed write.
        return { state: "unknown" };
      }
      return { state: "rejected" };
    } catch {
      return { state: "unknown" };
    }
  }

  function newNoticeId() {
    const bytes = crypto.getRandomValues(new Uint32Array(4));
    return String(10_000 + bytes[0]! % 90_000) + String.fromCharCode(...[...bytes.slice(1)].map((value) => 65 + value % 26));
  }

  return {
    async current(unpushedOnly = false) {
      const id = await redis.get(currentKey);
      if (!id || !validId.test(id)) return;
      const entry = await redis.hGetAll(announcementPrefix + id);
      if (unpushedOnly && (entry.status !== "当前" || entry.push !== "未推送")) return;
      return activeNotice(id, entry);
    },

    async history() {
      const ids = [...new Set(await redis.lRange(historyKey, 0, 49))].filter((id) => validId.test(id));
      const records = await Promise.all(ids.map((id) => redis.hGetAll(announcementPrefix + id)));
      return records.flatMap((record, index) => {
        const id = ids[index];
        const notice = id && activeNotice(id, record);
        return notice ? [notice] : [];
      });
    },

    write,
    async recall() {
      const receipt = await mutate("recall");
      if (receipt === "rejected") throw new Error("公告存储键无效");
      return typeof receipt === "string" && validId.test(receipt);
    },
  };
}
