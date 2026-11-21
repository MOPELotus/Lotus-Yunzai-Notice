import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Job } from "node-schedule";
import type { NoticeReply } from "./content.ts";
import { noticeAccounts, type NoticeAccount, type NoticeDeliveryHost } from "./delivery.ts";
import { numberId, type AnnouncementConfig } from "./mys-announcement-config.ts";
import { effectiveAnnouncementTargets } from "./mys-announcement.ts";
import { createActivityExpirySource, type ActivityGame, type UpcomingExpiry } from "./mys-activity-source.ts";
import type { NoticeRedis } from "./store.ts";

const games = ["sr","gs"] as const;
const names = { gs:"原神", sr:"星铁" };
const targetKey = (game: ActivityGame) => `lotus-yunzai:notice:mys:${game}:activity-targets`;
const legacyQueue = (botId: number) => `Yz:apgl:${botId}`;
const local = (now: number) => new Date(now + 8*3_600_000);
const chinaDay = (now: number) => local(now).toISOString().slice(0,10);
const chinaTime = (now: number) => local(now).toISOString().slice(0,19).replace("T"," ");
const activityDisabled = -2;

const claimActivity = `
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return -1 end
if redis.call('HGET', KEYS[3], ARGV[2]) == 'off' then return ${activityDisabled} end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[2], ARGV[3], 'EX', 259200)
return 1
`;

const verifyActivityClaim = `
if redis.call('GET', KEYS[2]) ~= ARGV[3] then return -1 end
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then
  redis.call('DEL', KEYS[2])
  return -1
end
if redis.call('HGET', KEYS[3], ARGV[2]) == 'off' then
  redis.call('DEL', KEYS[2])
  return ${activityDisabled}
end
return 1
`;

const settleActivity = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then return redis.call('DEL', KEYS[1]) end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1
`;

const advanceQueue = `
if (redis.call('GET', KEYS[1]) or '') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1
`;

interface Context {
  readonly isMaster: boolean;
  readonly message_type?: string;
  readonly self_id?: number;
  readonly group_id?: number;
  readonly member?: { readonly is_admin: boolean; readonly is_owner: boolean };
}

interface ActivityDestination {
  readonly account: NoticeAccount;
  readonly raw: string;
  readonly queue: readonly number[];
  readonly groupId: number;
  readonly selected: ReadonlySet<ActivityGame>;
}

function activityQueue(raw: string, date: string, defaults: readonly number[]): number[] {
  if (!raw) return [...defaults];
  const entry = JSON.parse(raw) as { date?: unknown; GroupList?: unknown };
  if (!entry || typeof entry !== "object" || typeof entry.date !== "string") throw new Error("旧活动队列无效");
  if (entry.date !== date) return [...defaults];
  if (!Array.isArray(entry.GroupList)) throw new Error("旧活动队列无效");
  const groups = entry.GroupList.map(numberId);
  if (groups.some(id=>!id)) throw new Error("旧活动队列含无效群号");
  return [...new Set(groups)] as number[];
}

function expiryMessage(game: ActivityGame, event: UpcomingExpiry, now: number): NoticeReply {
  const initial = `【${names[game]}活动即将结束通知】\n活动 ${event.subtitle}`;
  const remaining = Math.max(0, Math.floor((event.end-now)/1000));
  const days = Math.floor(remaining/86400), hours = Math.floor(remaining/3600)%24;
  const minutes = Math.floor(remaining/60)%60;
  const body = `\n描述 ${event.title}\n活动剩余时间 ${days}天${hours}小时${minutes}分钟${remaining%60}秒\n活动结束时间 ${chinaTime(event.end)}`;
  return event.image ? [{type:"text",text:initial},{type:"image",file:event.image},{type:"text",text:body}] : initial+body;
}

export function createActivityExpiryNotices(
  getRedis: () => NoticeRedis | undefined, host: NoticeDeliveryHost, config: AnnouncementConfig,
  signal?: AbortSignal, feed = createActivityExpirySource(), now = Date.now,
  whenActive?: (start: () => void) => () => void,
  wait = (active:AbortSignal) => delay(5000,undefined,{signal:active,ref:false}),
) {
  const lifecycle = new AbortController();
  const active = signal ? AbortSignal.any([signal,lifecycle.signal]) : lifecycle.signal;
  let pending: Promise<void> | undefined, startup: Promise<void> | undefined;
  let ready = !whenActive;
  let armed = false;
  const job = new Job(() => { void run(); });
  function arm() {
    if (ready && !active.aborted && !armed && getRedis()) {
      armed = Boolean(job.schedule(config.cron));
      if (!armed) console.warn("[notice] 活动到期推送定时配置无效。");
    }
  }
  function start() {
    if (active.aborted) return;
    ready = true;
    if (games.some(game => config.activityTargets[game].length)) {
      arm();
      return;
    }
    startup = (async () => {
      const redis = getRedis();
      if (!redis) return;
      for (const game of games) {
        if (active.aborted) return;
        if ((await effectiveAnnouncementTargets(redis,config.activityTargets[game],targetKey(game))).length) {
          arm();
          return;
        }
      }
    })().catch(() => { if (!active.aborted) console.warn("[notice] 无法读取活动到期推送目标。"); });
  }
  const cancelActivation = whenActive?.(start);
  if (!whenActive) start();
  function cancel() { job.cancel(); }
  active.addEventListener("abort",cancel,{once:true});

  async function poll() {
    const redis = getRedis(), at = now();
    if (!redis || active.aborted || local(at).getUTCHours() < 10) return;
    const date = chinaDay(at);
    const online = new Map(noticeAccounts(host).map(account=>[account.botId,account]));
    const routes = new Map<number,Map<number,Set<ActivityGame>>>();
    for (const game of games) {
      if (active.aborted) return;
      const gameTargets = await effectiveAnnouncementTargets(redis, config.activityTargets[game], targetKey(game)).catch(() => {
        if (!active.aborted) console.warn(`[notice] 无法读取${names[game]}活动到期推送目标。`);
        return [];
      });
      for (const { botId, groupId } of gameTargets) {
        if (!online.has(botId)) continue;
        const botGroups = routes.get(botId) ?? new Map<number, Set<ActivityGame>>();
        const selected = botGroups.get(groupId) ?? new Set<ActivityGame>();
        selected.add(game);
        botGroups.set(groupId, selected);
        routes.set(botId, botGroups);
      }
    }
    const destinations: ActivityDestination[] = [];
    for (const [botId, groups] of routes) {
      if (active.aborted) return;
      const account = online.get(botId)!;
      try {
        const raw = await redis.get(legacyQueue(botId)) ?? "";
        const queue = activityQueue(raw,date,[...groups.keys()]);
        const configured = queue.filter(id=>groups.has(id));
        if (!configured.length) continue;
        const current = new Set((await account.listGroups(active)).map(({id})=>id));
        const groupId = configured.find(id=>current.has(id));
        if (groupId !== undefined) destinations.push({account,raw,queue,groupId,selected:groups.get(groupId)!});
      } catch {
        if (!active.aborted) console.warn("[notice] 活动到期队列或群列表不可用。");
      }
    }
    const sources = new Map<ActivityGame,readonly UpcomingExpiry[]>();
    for (const game of games) {
      if (active.aborted) return;
      if (!destinations.some(({selected})=>selected.has(game))) continue;
      try { sources.set(game,await feed(game,active,at)); }
      catch { if (!active.aborted) console.warn(`[notice] 无法读取${names[game]}活动结束时间。`); }
    }
    for (const target of destinations) {
      if (active.aborted || chinaDay(now()) !== date) return;
      await notifyTarget(redis,target,date,sources);
    }
  }

  async function notifyTarget(redis: NoticeRedis, target:ActivityDestination, date:string, sources: Map<ActivityGame,readonly UpcomingExpiry[]>) {
    const {account, groupId, raw, queue, selected} = target;
    const botId = account.botId, oldKey = legacyQueue(botId);
    const at = now();
    const events = [...selected].flatMap(game=>(sources.get(game) ?? []).filter(event=>event.end>at).map(event=>({game,event})));
    if (!events.length) return;
    let retry = [...selected].some(game=>!sources.has(game));
    for (const {game,event} of events) {
      if (active.aborted) return;
      const hash = createHash("sha256").update(JSON.stringify([event.title,event.end])).digest("hex");
      const receipt = `lotus-yunzai:notice:mys:expiry:${date}:${game}:${groupId}:${hash}`;
      const token = JSON.stringify({state:"pending",token:crypto.randomUUID(),botId});
      const claimArgs = {
        keys:[oldKey,receipt,targetKey(game)], arguments:[raw,`${botId}:${groupId}`,token],
      };
      const claim = await redis.eval(claimActivity,claimArgs);
      if (claim === -1) return;
      if (claim === activityDisabled) retry = true;
      if (claim !== 1) continue;
      let result = "";
      let dispatched = false;
      if (!active.aborted) {
        try {
          await wait(active);
          active.throwIfAborted();
          const currentClaim = await redis.eval(verifyActivityClaim,claimArgs);
          if (currentClaim === activityDisabled) {
            retry = true;
            continue;
          }
          if (currentClaim !== 1) return;
          active.throwIfAborted();
          const deliveryAt = now();
          if (event.end <= deliveryAt || chinaDay(deliveryAt) !== date) {
            await redis.eval(settleActivity,{keys:[receipt],arguments:[token,result]});
            return;
          }
          dispatched = true;
          const id = await account.sendGroup(groupId,expiryMessage(game,event,deliveryAt),active);
          const confirmed = Number.isSafeInteger(id) && (account.adapter !== "milky" || id >= 0);
          result = JSON.stringify({state:confirmed ? "confirmed" : "unknown",botId,...(confirmed && {messageId:id})});
        } catch (error) {
          if (dispatched && !(error instanceof Error && "delivery" in error && error.delivery === "not-sent")) {
            result = JSON.stringify({state:"unknown",botId});
          } else retry = true;
        }
      }
      await redis.eval(settleActivity,{keys:[receipt],arguments:[token,result]});
    }
    if (!active.aborted && !retry) await redis.eval(advanceQueue,{
      keys:[oldKey], arguments:[raw,JSON.stringify({date,GroupList:queue.filter(id=>id!==groupId)})],
    });
  }

  function run() {
    if (!ready || active.aborted || pending) return pending;
    pending = poll().catch(() => {
      if (!active.aborted) console.warn("[notice] 活动到期推送未完成。");
    }).finally(() => { pending = undefined; });
    return pending;
  }

  const commands: Record<string,(argument:string,context:Context)=>Promise<NoticeReply>> = {};
  for (const game of games) for (const [label,value] of [["开启","on"],["关闭","off"]] as const) {
    const prefix = `#${names[game]}${label}到期活动`;
    const change = async (argument:string, context:Context) => {
      if (argument.trim()) return `用法 ${prefix}推送`;
      if (context.message_type !== "group") return "活动到期推送请在群聊中设置。";
      if (!context.isMaster && !context.member?.is_admin && !context.member?.is_owner) return "只有群管理员或机器人主人可以设置到期活动推送。";
      const botId = numberId(context.self_id), groupId = numberId(context.group_id);
      if (!botId || !groupId || !noticeAccounts(host).some(account=>account.botId===botId)) return "无法确认当前机器人和群聊。";
      const redis = getRedis();
      if (!redis) return "公告存储未连接。";
      try {
        await redis.eval("return redis.call('HSET',KEYS[1],ARGV[1],ARGV[2])",{
          keys:[targetKey(game)],arguments:[`${botId}:${groupId}`,value],
        });
        if (value === "on") arm();
        return `${names[game]}活动到期推送已${label}。`;
      } catch { return "无法保存活动推送设置，请稍后重试。"; }
    };
    for (const ending of ["","预警","推送","预警推送"]) commands[prefix+ending] = change;
  }
  return {
    commands, run,
    async dispose() {
      lifecycle.abort();
      cancelActivation?.();
      cancel();
      active.removeEventListener("abort",cancel);
      await Promise.all([pending,startup]);
    },
  };
}
