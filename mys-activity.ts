import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Job } from "node-schedule";
import type { NoticeReply } from "./content.ts";
import { noticeAccounts, type NoticeAccount, type NoticeDeliveryHost } from "./delivery.ts";
import { numberId, type AnnouncementConfig, type AnnouncementConfigReader } from "./mys-announcement-config.ts";
import { effectiveAnnouncementTargets } from "./mys-announcement.ts";
import { createActivityExpirySource, type ActivityGame, type UpcomingExpiry } from "./mys-activity-source.ts";
import type { NoticeRedis } from "./store.ts";

const games = ["sr","gs"] as const;
const names = { gs:$t("mys-activity.text_d1597c51ed"), sr:$t("mys-activity.text_a2927891f0") };
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
  if (!entry || typeof entry !== "object" || typeof entry.date !== "string") throw new Error($t("mys-activity.text_189e615869"));
  if (entry.date !== date) return [...defaults];
  if (!Array.isArray(entry.GroupList)) throw new Error($t("mys-activity.text_189e615869"));
  const groups = entry.GroupList.map(numberId);
  if (groups.some(id=>!id)) throw new Error($t("mys-activity.text_c62ae5831c"));
  return [...new Set(groups)] as number[];
}

function expiryMessage(game: ActivityGame, event: UpcomingExpiry, now: number): NoticeReply {
  const initial = $t("mys-activity.text_750034ad8a", { "value1": names[game], "subtitle": event.subtitle });
  const remaining = Math.max(0, Math.floor((event.end-now)/1000));
  const days = Math.floor(remaining/86400), hours = Math.floor(remaining/3600)%24;
  const minutes = Math.floor(remaining/60)%60;
  const body = $t("mys-activity.text_caa83a5821", { "title": event.title, "days": days, "hours": hours, "minutes": minutes, "value5": remaining%60, "value6": chinaTime(event.end) });
  return event.image ? [{type:"text",text:initial},{type:"image",file:event.image},{type:"text",text:body}] : initial+body;
}

export function createActivityExpiryNotices(
  getRedis: () => NoticeRedis | undefined, host: NoticeDeliveryHost, configuration: AnnouncementConfig | AnnouncementConfigReader,
  signal?: AbortSignal, feed = createActivityExpirySource(), now = Date.now,
  whenActive?: (start: () => void) => () => void,
  wait = (active:AbortSignal) => delay(5000,undefined,{signal:active,ref:false}),
) {
  const readConfig = typeof configuration === "function" ? configuration : () => configuration;
  const initial = readConfig();
  const lifecycle = new AbortController();
  const active = signal ? AbortSignal.any([signal,lifecycle.signal]) : lifecycle.signal;
  let pending: Promise<void> | undefined, startup: Promise<void> | undefined;
  let ready = !whenActive;
  let armed = false;
  const job = new Job(() => { void run(); });
  function arm() {
    if (ready && !active.aborted && !armed && getRedis()) {
      armed = Boolean(job.schedule(initial.cron));
      if (!armed) console.warn($t("mys-activity.text_c5ff14e7be"));
    }
  }
  function start() {
    if (active.aborted) return;
    ready = true;
    if (typeof configuration === "function" || games.some(game => initial.activityTargets[game].length)) {
      arm();
      return;
    }
    startup = (async () => {
      const redis = getRedis();
      if (!redis) return;
      for (const game of games) {
        if (active.aborted) return;
        if ((await effectiveAnnouncementTargets(redis,initial.activityTargets[game],targetKey(game))).length) {
          arm();
          return;
        }
      }
    })().catch(() => { if (!active.aborted) console.warn($t("mys-activity.text_7b176cfaf3")); });
  }
  const cancelActivation = whenActive?.(start);
  if (!whenActive) start();
  function cancel() { job.cancel(); }
  active.addEventListener("abort",cancel,{once:true});

  async function poll() {
    const redis = getRedis(), at = now();
    if (!redis || active.aborted || local(at).getUTCHours() < 10) return;
    const config = readConfig();
    const date = chinaDay(at);
    const online = new Map(noticeAccounts(host).map(account=>[account.botId,account]));
    const routes = new Map<number,Map<number,Set<ActivityGame>>>();
    for (const game of games) {
      if (active.aborted) return;
      const gameTargets = await effectiveAnnouncementTargets(redis, config.activityTargets[game], targetKey(game)).catch(() => {
        if (!active.aborted) console.warn($t("mys-activity.text_e03f3b9e17", { "value1": names[game] }));
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
        if (!active.aborted) console.warn($t("mys-activity.text_c4b1d6d798"));
      }
    }
    const sources = new Map<ActivityGame,readonly UpcomingExpiry[]>();
    for (const game of games) {
      if (active.aborted) return;
      if (!destinations.some(({selected})=>selected.has(game))) continue;
      try { sources.set(game,await feed(game,active,at)); }
      catch { if (!active.aborted) console.warn($t("mys-activity.text_447cc117f7", { "value1": names[game] })); }
    }
    for (const target of destinations) {
      if (active.aborted || chinaDay(now()) !== date) return;
      await notifyTarget(redis,target,date,sources,config);
    }
  }

  async function notifyTarget(redis: NoticeRedis, target:ActivityDestination, date:string, sources: Map<ActivityGame,readonly UpcomingExpiry[]>,
    config: AnnouncementConfig) {
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
          const current = readConfig();
          if (current !== config && !(await effectiveAnnouncementTargets(redis, current.activityTargets[game], targetKey(game)))
            .some(target => target.botId === botId && target.groupId === groupId)) {
            retry = true;
            await redis.eval(settleActivity,{keys:[receipt],arguments:[token,result]});
            continue;
          }
          const currentClaim = await redis.eval(verifyActivityClaim,claimArgs);
          if (currentClaim === activityDisabled) {
            retry = true;
            continue;
          }
          if (currentClaim !== 1) return;
          active.throwIfAborted();
          if (current !== readConfig()) {
            retry = true;
            await redis.eval(settleActivity,{keys:[receipt],arguments:[token,result]});
            continue;
          }
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
      if (!active.aborted) console.warn($t("mys-activity.text_f746555b58"));
    }).finally(() => { pending = undefined; });
    return pending;
  }

  const commands: Record<string,(argument:string,context:Context)=>Promise<NoticeReply>> = {};
  for (const game of games) for (const [label,value] of [[$t("mys-activity.text_8da97ddda9"),"on"],[$t("mys-activity.text_3fd47edce4"),"off"]] as const) {
    const prefix = `#${names[game]}${label}到期活动`;
    const change = async (argument:string, context:Context) => {
      if (argument.trim()) return $t("mys-activity.text_8c8773a26b", { "prefix": prefix });
      if (context.message_type !== "group") return $t("mys-activity.text_f03714ff7b");
      if (!context.isMaster && !context.member?.is_admin && !context.member?.is_owner) return $t("mys-activity.text_d8b6e222d2");
      const botId = numberId(context.self_id), groupId = numberId(context.group_id);
      if (!botId || !groupId || !noticeAccounts(host).some(account=>account.botId===botId)) return $t("mys-activity.text_ae2bd2f2c0");
      const redis = getRedis();
      if (!redis) return $t("mys-activity.text_9579dede53");
      try {
        await redis.eval("return redis.call('HSET',KEYS[1],ARGV[1],ARGV[2])",{
          keys:[targetKey(game)],arguments:[`${botId}:${groupId}`,value],
        });
        if (value === "on") arm();
        return $t("mys-activity.text_b193168ee7", { "value1": names[game], "label": label });
      } catch { return $t("mys-activity.text_df10a97a31"); }
    };
    for (const ending of ["",$t("mys-activity.text_75d5781e08"),$t("mys-activity.text_c757c9cc2d"),$t("mys-activity.text_ff0954485e")]) commands[prefix+ending] = change;
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
