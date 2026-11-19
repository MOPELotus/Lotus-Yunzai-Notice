import { Job } from "node-schedule";
import type { NoticeReply } from "./content.ts";
import type { NoticeDeliveryHost } from "./delivery.ts";
import { numberId, type AnnouncementConfig, type AnnouncementTarget } from "./mys-announcement-config.ts";
import { announcementGames, createAnnouncementSource, type AnnouncementGame, type OfficialAnnouncement } from "./mys-announcement-source.ts";
import type { NoticeRedis } from "./store.ts";

interface Context {
  readonly isMaster: boolean;
  readonly message_type?: string;
  readonly self_id?: number;
  readonly group_id?: number;
  readonly member?: { readonly is_admin: boolean; readonly is_owner: boolean };
}

const games = Object.keys(announcementGames) as AnnouncementGame[];
const keyFor = (game: AnnouncementGame) => `lotus-yunzai:notice:mys:${game}:targets`;
const keyForTarget = ({ botId, groupId }: AnnouncementTarget) => `${botId}:${groupId}`;
const legacyReceipt = (game: AnnouncementGame, botId: number, groupId: number, id: string) =>
  `Yz:${game}:mys:newPush:${botId}:${groupId}:${id}`;
const claim = `
if redis.call('HGET', KEYS[2], ARGV[2]) == 'off' or redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
for i = 3, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', 36000)
redis.call('SET', KEYS[3], ARGV[1], 'EX', 36000)
return 1`;
const settle = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[2] == '' then
  redis.call('DEL', KEYS[1])
  if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
else
  redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
  redis.call('SET', KEYS[2], '1', 'EX', 36000)
end
return 1`;

function link(game: AnnouncementGame, id: string) {
  return `https://www.miyoushe.com/${announcementGames[game].slug}/article/${id}`;
}

function message(game: AnnouncementGame, post: OfficialAnnouncement): NoticeReply {
  const body = [`【${announcementGames[game].name}公告】${post.title}`,
    ...(post.summary ? [post.summary] : []), link(game, post.id)].join("\n");
  return post.image ? [{ type: "text", text: body }, { type: "image", file: post.image }] : body;
}

function notSent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "delivery" in error && error.delivery === "not-sent";
}

async function targetsFor(redis: NoticeRedis, game: AnnouncementGame, config: AnnouncementConfig) {
  const result = new Map(config.targets[game].map((target) => [keyForTarget(target), target]));
  for (const [key, state] of Object.entries(await redis.hGetAll(keyFor(game)))) {
    const [bot, group, extra] = key.split(":");
    const botId = numberId(bot);
    const groupId = numberId(group);
    if (!botId || !groupId || extra !== undefined) continue;
    if (state === "on") result.set(key, { botId, groupId });
    else if (state === "off") result.delete(key);
  }
  return [...result.values()];
}

export function createOfficialAnnouncements(
  getRedis: () => NoticeRedis | undefined, host: NoticeDeliveryHost, config: AnnouncementConfig, signal?: AbortSignal,
  feed = createAnnouncementSource(), now = Date.now,
) {
  const lifecycle = new AbortController();
  const active = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
  let pending: ReturnType<typeof poll> | undefined;
  const timer = new Job(() => { void run()?.catch(() => console.warn("[notice] 米游社公告推送失败。")); });

  async function poll(selected: readonly AnnouncementGame[]) {
    const report = { confirmed: 0, rejected: 0, unknown: 0, skipped: 0, failed: 0 };
    const redis = getRedis();
    if (!redis || active.aborted || config.maxNum === 0) return report;
    const online = new Set(host.onlineBots());
    const groupLists = new Map<number, ReadonlySet<number>>();
    const wall = Math.floor(now() / 1000);
    for (const game of selected) {
      if (active.aborted) break;
      try {
        const targets = await targetsFor(redis, game, config);
        const groups = new Map<number, number[]>();
        for (const { botId, groupId } of targets) {
          const group = groups.get(groupId) ?? [];
          group.push(botId);
          groups.set(groupId, group);
        }
        const destinations: { groupId: number; botId: number; botIds: number[]; sent: number }[] = [];
        for (const [groupId, botIds] of groups) {
          if (active.aborted) return report;
          for (const botId of botIds.sort((a, b) => a - b)) {
            if (!online.has(botId)) continue;
            let allowed = groupLists.get(botId);
            if (!allowed) {
              try {
                allowed = new Set((await host.listGroups(botId)).map(({ id }) => id));
              } catch {
                report.failed++;
                allowed = new Set();
              }
              groupLists.set(botId, allowed);
            }
            if (!allowed.has(groupId)) continue;
            destinations.push({ groupId, botId, botIds, sent: 0 });
            break;
          }
        }
        if (!destinations.length || active.aborted) continue;
        const posts = await feed(game, active);
        for (const post of posts) {
          if (post.created < wall - 7_200 || post.created > wall || config.ban[game]?.test(post.title)) continue;
          for (const target of destinations) {
            if (active.aborted) return report;
            if (target.sent >= config.maxNum) continue;
            const { groupId, botId, botIds } = target;
            const key = `lotus-yunzai:notice:mys:${game}:delivery:${groupId}:${post.id}`;
            const legacy = legacyReceipt(game, botId, groupId, post.id);
            const token = JSON.stringify({ state: "pending", token: crypto.randomUUID(), botId });
            if (await redis.eval(claim, {
              keys: [key, keyFor(game), legacy, ...botIds.filter((id) => id !== botId).map((id) => legacyReceipt(game, id, groupId, post.id))],
              arguments: [token, keyForTarget(target)],
            }) !== 1) { report.skipped++; continue; }
            if (active.aborted) {
              await redis.eval(settle, { keys: [key, legacy], arguments: [token, ""] });
              return report;
            }
            target.sent++;
            let state: string;
            try {
              const id = await host.sendGroup(botId, groupId, message(game, post));
              if (!Number.isSafeInteger(id)) throw new Error();
              state = JSON.stringify({ state: "confirmed", botId, messageId: id });
              report.confirmed++;
            } catch (error) {
              if (notSent(error)) {
                state = "";
                report.rejected++;
              } else {
                state = JSON.stringify({ state: "unknown", botId });
                report.unknown++;
              }
            }
            await redis.eval(settle, { keys: [key, legacy], arguments: [token, state] });
          }
        }
      } catch {
        if (!active.aborted) report.failed++;
      }
    }
    return report;
  }

  function run(selected = games) {
    if (pending || active.aborted) return;
    pending = poll(selected).finally(() => { pending = undefined; });
    return pending;
  }

  async function dispose() {
    lifecycle.abort();
    timer.cancel();
    active.removeEventListener("abort", cancel);
    await pending;
  }

  function cancel() { timer.cancel(); }
  active.addEventListener("abort", cancel, { once: true });
  if (getRedis() && !active.aborted && !timer.schedule(config.cron)) {
    void dispose();
    throw new Error("米游社公告推送 cron 无效。");
  }

  const commands: Record<string, (argument: string, context: Context) => Promise<NoticeReply>> = {};
  for (const game of games) {
    const { name } = announcementGames[game];
    for (const [action, value] of [["开启", "on"], ["关闭", "off"]] as const) {
      const configure = async (argument: string, context: Context) => {
        if (argument.trim()) return `用法：#${name}${action}公告推送`;
        if (context.message_type !== "group") return "推送请在群聊中设置。";
        if (context.isMaster !== true && context.member?.is_admin !== true && context.member?.is_owner !== true) {
          return "只有群管理员或机器人主人可以设置公告推送。";
        }
        const botId = numberId(context.self_id);
        const groupId = numberId(context.group_id);
        if (!botId || !groupId || !host.onlineBots().includes(botId)) return "无法确认当前机器人和群聊。";
        const redis = getRedis();
        if (!redis) return "公告存储未连接。";
        try {
          await redis.eval("return redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])", {
            keys: [keyFor(game)], arguments: [keyForTarget({ botId, groupId }), value],
          });
          return `${name}公告推送已${action}。`;
        } catch {
          return "无法保存公告推送设置，请稍后重试。";
        }
      };
      commands[`#${name}${action}公告推送`] = configure;
      if (game === "gs") commands[`#${action}公告推送`] = configure;
    }

    commands[`#${name}推送公告`] = async (argument, context) => {
      if (argument.trim()) return `用法：#${name}推送公告`;
      if (context.isMaster !== true) return "仅机器人主人可触发公告推送。";
      if (!getRedis()) return "公告存储未连接。";
      const report = await run([game]);
      if (!report) return "公告推送正在处理或已停止。";
      return `已确认 ${report.confirmed} 条，未发出 ${report.rejected} 条，结果未确认 ${report.unknown} 条，已去重 ${report.skipped} 条，异常 ${report.failed} 次。`;
    };

    commands[`#${name}公告`] = async (argument) => {
      if (argument.trim()) return `用法：#${name}公告`;
      try {
        const posts = await feed(game, active);
        const latest = posts.at(-1);
        return latest ? message(game, latest) : `暂无${name}公告。`;
      } catch {
        return "米游社公告暂不可用。";
      }
    };
  }
  return { commands, run, dispose };
}
