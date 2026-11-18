import type { NoticeRedis } from "./store.ts";

export type GroupList = "whitelist" | "blacklist";
type Change = "add" | "remove";
type Redis = Pick<NoticeRedis, "eval">;

interface Lists {
  readonly whitelist: readonly string[];
  readonly blacklist: readonly string[];
}

export interface TargetSettings {
  readonly global: Lists;
  readonly account?: Lists & { readonly enabled: boolean; readonly pushInterval?: number };
}

const globalKeys = ["notice:whitelist", "notice:blacklist"];

function accountKey(account: string) {
  if (!validTargetId(account)) throw new Error("无效的公告账号");
  return `notice:account:${account}:config`;
}

export function validTargetId(id: string): boolean {
  return /^[1-9]\d*$/u.test(id);
}

function parseIds(values: unknown): string[] {
  if (!Array.isArray(values)) throw new Error("公告名单格式无效");
  const ids = values.map((value: unknown) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
    if (typeof value === "string" && validTargetId(value)) return value;
    throw new Error("公告名单含无效群号");
  });
  return [...new Set(ids)];
}

function parseAccountList(value: unknown): string[] {
  if (value === null) return [];
  if (typeof value !== "string") throw new Error("公告账号名单格式无效");
  return parseIds(JSON.parse(value));
}

function parseEnabled(value: unknown): boolean {
  if (value === null || value === "true") return true;
  if (value === "false") return false;
  if (typeof value === "string" && /^-?\d+$/u.test(value)) return Number(value) !== 0;
  throw new Error("公告账号启用状态无效");
}

// One snapshot for both filters so a concurrent config edit cannot mix fields.
const readLists = `
local global = {redis.call('SMEMBERS', KEYS[1]), redis.call('SMEMBERS', KEYS[2])}
if #KEYS == 2 then return global end
local account = redis.call('HMGET', KEYS[3], 'whitelist', 'blacklist', 'enabled', 'pushInterval')
return {global[1], global[2], account[1], account[2], account[3], account[4]}
`;

const editGlobal = `
if ARGV[1] == 'add' then
  return redis.call('SADD', KEYS[1], unpack(ARGV, 2))
end
return redis.call('SREM', KEYS[1], unpack(ARGV, 2))
`;

const editAccount = `
local field, op = ARGV[1], ARGV[2]
local raw = redis.call('HGET', KEYS[1], field)
local existing = {}
if raw then
  if not string.match(raw, '^%s*%[') then
    return redis.error_reply('notice account group list must be an array')
  end
  existing = cjson.decode(raw)
end

local requested = {}
for i = 3, #ARGV do requested[ARGV[i]] = true end
local output, present, changed = {}, {}, 0
for _, id in ipairs(existing) do
  if type(id) == 'number' and id == math.floor(id) and id > 0 and id <= 9007199254740991 then
    id = string.format('%.0f', id)
  end
  if type(id) ~= 'string' or not string.match(id, '^[1-9]%d*$') then
    return redis.error_reply('invalid group ID in notice account list')
  end
  if not present[id] then
    present[id] = true
    if op == 'remove' and requested[id] then changed = changed + 1
    else output[#output + 1] = id end
  end
end
if op == 'add' then
  for i = 3, #ARGV do
    if not present[ARGV[i]] then
      output[#output + 1] = ARGV[i]
      present[ARGV[i]] = true
      changed = changed + 1
    end
  end
end
if changed > 0 then
  local json = #output == 0 and '[]' or cjson.encode(output)
  redis.call('HSET', KEYS[1], field, json)
  redis.call('EXPIRE', KEYS[1], 2592000)
end
return changed
`;

export function createTargetStore(redis: Redis) {
  return {
    async settings(account?: string): Promise<TargetSettings> {
      const keys = account === undefined ? globalKeys : [...globalKeys, accountKey(account)];
      const result = await redis.eval(readLists, { keys, arguments: [] });
      if (!Array.isArray(result) || result.length !== (account === undefined ? 2 : 6)) {
        throw new Error("无法读取公告目标群配置");
      }
      const global = { whitelist: parseIds(result[0]), blacklist: parseIds(result[1]) };
      if (account === undefined) return { global };
      const interval = Number(result[5]);
      return {
        global,
        account: {
          whitelist: parseAccountList(result[2]),
          blacklist: parseAccountList(result[3]),
          enabled: parseEnabled(result[4]),
          pushInterval: Number.isInteger(interval) && interval >= 500 && interval <= 10_000 ? interval : undefined,
        },
      };
    },

    async change(list: GroupList, operation: Change, groupIds: readonly string[], account?: string): Promise<number> {
      const ids = parseIds(groupIds);
      if (!ids.length) return 0;

      const result = account === undefined
        ? await redis.eval(editGlobal, {
          keys: [`notice:${list}`],
          arguments: [operation, ...ids],
        })
        : await redis.eval(editAccount, {
          keys: [accountKey(account)],
          arguments: [list, operation, ...ids],
        });
      if (typeof result !== "number") throw new Error("公告名单写入失败");
      return result;
    },
  };
}

/** membership must come from the active bot account, not the old groups cache. */
export function selectNoticeGroups(settings: TargetSettings, membership: readonly (string | number)[]): string[] {
  if (!settings.account?.enabled) return [];

  const allowLists = [settings.global.whitelist, settings.account.whitelist]
    .filter((ids) => ids.length > 0).map((ids) => new Set(ids));
  const blocked = new Set([...settings.global.blacklist, ...settings.account.blacklist]);
  return parseIds(membership).filter((id) =>
    !blocked.has(id) && allowLists.every((allow) => allow.has(id)));
}
