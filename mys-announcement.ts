import { Job } from "node-schedule";
import { noticeAccounts, noticeAdapter, type NoticeAccount, type NoticeDeliveryHost, type NoticeDeliveryReply, type NoticeDeliverySegment } from "./delivery.ts";
import { numberId, type AnnouncementConfig, type AnnouncementTarget } from "./mys-announcement-config.ts";
import { announcementArticleLink, announcementGames, announcementLabels, createAnnouncementSource, type AnnouncementGame,
  type AnnouncementKind, type AnnouncementPushKind, type OfficialAnnouncement } from "./mys-announcement-source.ts";
import type { NoticeRedis } from "./store.ts";
import { isPrivateMysCommand, parseMysArticleLink, parseMysSearch, parsePublicAnnouncementQuery } from "./mys-public-query.ts";
import { createMysSearchSource } from "./mys-search-source.ts";

interface Context {
  readonly isMaster: boolean;
  readonly message_type?: string;
  readonly self_id?: number;
  readonly group_id?: number;
  readonly member?: { readonly is_admin: boolean; readonly is_owner: boolean };
}

const games = Object.keys(announcementGames) as AnnouncementGame[];
const kinds = ["notice", "info"] as const;
const keyFor = (game: AnnouncementGame, kind: AnnouncementPushKind) =>
  `lotus-yunzai:notice:mys:${game}:${kind === "info" ? "info-targets" : "targets"}`;
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
const verifyClaim = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[3]) ~= ARGV[1] then return 0 end
if redis.call('HGET', KEYS[2], ARGV[2]) == 'off' then return 0 end
for i = 4, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end
end
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

function message(game: AnnouncementGame, post: OfficialAnnouncement, kind: AnnouncementKind = "notice"): NoticeDeliveryReply {
  const body = [`【${announcementGames[game].name}${announcementLabels[kind]}】${post.title}`,
    ...(post.summary ? [post.summary] : []), announcementArticleLink(game, post.id)].join("\n");
  return post.image ? [{ type: "text", text: body }, { type: "image", file: post.image }] : body;
}

function notSent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "delivery" in error && error.delivery === "not-sent";
}

async function targetsFor(redis: NoticeRedis, game: AnnouncementGame, kind: AnnouncementPushKind, config: AnnouncementConfig) {
  const targets = (kind === "notice" ? config.targets : config.infoTargets)[game];
  return effectiveAnnouncementTargets(redis, targets, keyFor(game, kind));
}

export async function effectiveAnnouncementTargets(redis: Pick<NoticeRedis, "hGetAll">, targets: readonly AnnouncementTarget[], hashKey: string) {
  const result = new Map(targets.map((target) => [keyForTarget(target), target]));
  for (const [key, state] of Object.entries(await redis.hGetAll(hashKey))) {
    const [bot, group, extra] = key.split(":");
    const botId = numberId(bot);
    const groupId = numberId(group);
    if (!botId || !groupId || extra !== undefined) continue;
    if (state === "on") result.set(key, { botId, groupId });
    else if (state === "off") result.delete(key);
  }
  return [...result.values()];
}

interface AnnouncementDestination {
  groupId: number;
  account: NoticeAccount;
  botIds: number[];
}

type PresentArticle = (
  game: AnnouncementGame, id: string, url: string, signal: AbortSignal,
) => Promise<{ readonly title: string; readonly pictures: readonly NoticeDeliverySegment[] } | undefined>;

type PresentList = (game: AnnouncementGame, kind: AnnouncementKind, posts: readonly OfficialAnnouncement[],
  signal: AbortSignal) => Promise<NoticeDeliverySegment | undefined>;

export function createOfficialAnnouncements(
  getRedis: () => NoticeRedis | undefined, host: NoticeDeliveryHost, config: AnnouncementConfig, signal?: AbortSignal,
  feed = createAnnouncementSource(), now = Date.now, whenActive?: (start: () => void) => () => void, presentArticle?: PresentArticle, presentList?: PresentList, search = createMysSearchSource(),
) {
  const lifecycle = new AbortController();
  const active = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
  let pending: ReturnType<typeof poll> | undefined;
  const timer = new Job(() => { void run()?.catch(() => console.warn("[notice] 米游社公告推送失败。")); });

  async function present(game: AnnouncementGame, post: OfficialAnnouncement, kind: AnnouncementKind, push = false): Promise<NoticeDeliveryReply> {
    const url = announcementArticleLink(game, post.id);
    if (!presentArticle || active.aborted) return message(game, post, kind);
    try {
      const article = await presentArticle(game, post.id, url, active);
      if (article?.pictures.length) {
        const title = `${announcementGames[game].name}${announcementLabels[kind]}${push ? "推送" : ""}：${article.title}`;
        return [{ type: "text", text: `${title}\n${url}` }, ...article.pictures];
      }
    } catch {
      // 详情或图片服务暂不可用时，保留列表摘要和原文链接。
    }
    return message(game, post, kind);
  }

  async function poll(selected: readonly AnnouncementGame[], channels: readonly AnnouncementPushKind[]) {
    const report = { confirmed: 0, rejected: 0, unknown: 0, skipped: 0, failed: 0 };
    const redis = getRedis();
    if (!redis || active.aborted || config.maxNum === 0) return report;
    const online = new Map(noticeAccounts(host).map((account) => [account.botId, account]));
    const groupLists = new Map<number, ReadonlySet<number>>();
    const wall = Math.floor(now() / 1000);
    for (const game of selected) {
      if (active.aborted) break;
      try {
        const entries: { post:OfficialAnnouncement; kind:AnnouncementPushKind; destinations:AnnouncementDestination[] }[] = [];
        for (const kind of channels) {
          if (active.aborted) break;
          try {
            const groups = new Map<number, number[]>();
            for (const { botId, groupId } of await targetsFor(redis, game, kind, config)) {
              const group = groups.get(groupId) ?? [];
              group.push(botId);
              groups.set(groupId, group);
            }
            const destinations: AnnouncementDestination[] = [];
            for (const [groupId, botIds] of groups) {
              if (active.aborted) return report;
              for (const botId of botIds.sort((a, b) => a - b)) {
                const account = online.get(botId);
                if (!account) continue;
                let allowed = groupLists.get(botId);
                if (!allowed) {
                  try { allowed = new Set((await account.listGroups(active)).map(({ id }) => id)); }
                  catch { report.failed++; allowed = new Set(); }
                  groupLists.set(botId, allowed);
                }
                if (!allowed.has(groupId)) continue;
                destinations.push({ groupId, account, botIds });
                break;
              }
            }
            if (!destinations.length || active.aborted) continue;
            for (const post of await feed(game, active, kind)) entries.push({ post, kind, destinations });
          } catch {
            if (!active.aborted) report.failed++;
          }
        }
        const counts = new Map<number, number>();
        for (const { post, kind, destinations } of entries.sort((a,b) => a.post.id.localeCompare(b.post.id))) {
          if (post.created < wall - 7_200 || post.created > wall || config.ban[game]?.test(post.title)) continue;
          let presentation: NoticeDeliveryReply | undefined;
          for (const { groupId, account, botIds } of destinations) {
            if (active.aborted) return report;
            const count = counts.get(groupId) ?? 0;
            if (count >= config.maxNum) continue;
            const { botId } = account;
            const sender = { botId, ...noticeAdapter(account) };
            const key = `lotus-yunzai:notice:mys:${game}:delivery:${groupId}:${post.id}`;
            const legacy = legacyReceipt(game, botId, groupId, post.id);
            const token = JSON.stringify({ state: "pending", token: crypto.randomUUID(), ...sender });
            const claimArgs = {
              keys: [key, keyFor(game, kind), legacy, ...botIds.filter((id) => id !== botId).map((id) => legacyReceipt(game, id, groupId, post.id))],
              arguments: [token, keyForTarget({ botId, groupId })],
            };
            if (await redis.eval(claim, claimArgs) !== 1) { report.skipped++; continue; }
            if (!active.aborted) presentation ??= await present(game, post, kind, true);
            const discard = { keys: [key, legacy], arguments: [token, ""] };
            let currentClaim: unknown;
            try {
              if (!active.aborted) currentClaim = await redis.eval(verifyClaim, claimArgs);
            } catch (error) {
              // Delivery has not started, so a transient storage error can still release this claim.
              await redis.eval(settle, discard).catch(() => undefined);
              throw error;
            }
            if (active.aborted || currentClaim !== 1) {
              await redis.eval(settle, discard);
              if (active.aborted) return report;
              report.skipped++;
              continue;
            }
            counts.set(groupId, count + 1);
            let state: string;
            try {
              const id = await account.sendGroup(groupId, presentation ?? message(game, post, kind), active);
              if (!Number.isSafeInteger(id) || (account.adapter === "milky" && id < 0)) throw new Error();
              state = JSON.stringify({ state: "confirmed", ...sender, messageId: id });
              report.confirmed++;
            } catch (error) {
              if (notSent(error)) {
                state = "";
                report.rejected++;
              } else {
                state = JSON.stringify({ state: "unknown", ...sender });
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

  function run(selected = games, channels: readonly AnnouncementPushKind[] = kinds) {
    if (pending || active.aborted) return;
    pending = poll(selected, channels).finally(() => { pending = undefined; });
    return pending;
  }

  async function dispose() {
    lifecycle.abort();
    cancelActivation?.();
    timer.cancel();
    active.removeEventListener("abort", cancel);
    await pending;
  }

  function startTimer() {
    if (getRedis() && !active.aborted && !timer.schedule(config.cron)) throw new Error("米游社公告推送 cron 无效。");
  }

  function cancel() { timer.cancel(); }
  active.addEventListener("abort", cancel, { once: true });
  const cancelActivation = whenActive?.(() => {
    try {
      startTimer();
    } catch {
      console.warn("[notice] 米游社公告推送 cron 无效。");
    }
  });
  if (!whenActive) {
    try {
      startTimer();
    } catch (error) {
      void dispose();
      throw error;
    }
  }

  async function query(game: AnnouncementGame, kind: AnnouncementKind, argument: string, fixedPage?: number): Promise<NoticeDeliveryReply> {
    const input = argument.trim();
    const { name } = announcementGames[game];
    const label = announcementLabels[kind];
    const page = fixedPage ?? (input ? Number(input) : 1);
    if ((fixedPage !== undefined && input) || (fixedPage === undefined && input && !/^[1-9]\d*$/u.test(input)) ||
      !Number.isInteger(page) || page < 1 || page > 20) {
      return `用法 #${name}${label} [1-20]`;
    }
    try {
      const posts = await feed(game, active, kind, 20);
      const post = posts[page - 1];
      if (!posts.length) return `暂无${name}${label}。`;
      return post ? await present(game, post, kind) : `仅有 ${posts.length} 条${name}${label}，请输入 1-${posts.length}。`;
    } catch {
      return `米游社${label}暂不可用。`;
    }
  }
  async function list(game: AnnouncementGame, kind: AnnouncementKind, argument: string): Promise<NoticeDeliveryReply> {
    const { name } = announcementGames[game];
    const label = announcementLabels[kind];
    if (argument.trim()) return `用法 #${name}${label}列表`;
    try {
      const posts = (await feed(game, active, kind, 5)).slice(0, 5);
      if (!posts.length) return `暂无${name}${label}。`;
      const links = [`${name}${label}列表`, ...posts.flatMap((post, index) => [
        `${index + 1}. ${post.title}`, announcementArticleLink(game, post.id),
      ])].join("\n");
      try {
        const image = await presentList?.(game, kind, posts, active);
        if (image) return [image, { type: "text", text: links }];
      } catch {
        // Keep the links visible when list rendering is unavailable.
      }
      return links;
    } catch {
      return `米游社${label}暂不可用。`;
    }
  }
  async function articleReply(game: AnnouncementGame, id: string, title?: string): Promise<NoticeDeliveryReply | undefined> {
    if (active.aborted) return;
    const url = announcementArticleLink(game, id);
    let article: Awaited<ReturnType<PresentArticle>> | undefined;
    try {
      article = await presentArticle?.(game, id, url, active);
    } catch {
      // Preserve the original link when the article or the card cannot be loaded.
    }
    if (active.aborted) return;
    const text = `${article?.title ?? title ?? "米游社文章暂无法展开。"}\n${url}`;
    return article?.pictures.length ? [{ type: "text", text }, ...article.pictures] : text;
  }

  async function fallback(normalizedMessage: string) {
    if (active.aborted) return;
    const target = parsePublicAnnouncementQuery(normalizedMessage);
    if (target) return target.list ? list(target.game, target.kind, target.argument)
      : query(target.game, target.kind, target.argument, target.page);

    if (isPrivateMysCommand(normalizedMessage)) return;
    const link = parseMysArticleLink(normalizedMessage);
    if (link) return articleReply(link.game, link.id);

    const request = parseMysSearch(normalizedMessage);
    if (!request) return;
    if ("error" in request) return request.error;
    try {
      const posts = await search(request.keyword, active);
      if (!posts.length) return "没有搜到米游社文章，请换个关键词。";
      const post = posts[request.offset];
      return post ? articleReply("gs", post.id, post.title) : `仅有 ${posts.length} 条搜索结果。请输入第1到第${posts.length}条。`;
    } catch {
      if (!active.aborted) return "米游社搜索暂不可用。";
    }
  }

  const commands: Record<string, (argument: string, context: Context) => Promise<NoticeDeliveryReply>> = {};
  const aliases: Record<string, string> = {};
  for (const game of games) {
    const { name } = announcementGames[game];
    for (const kind of kinds) {
      const label = announcementLabels[kind];
      for (const [action, value] of [["开启", "on"], ["关闭", "off"]] as const) {
        const configure = async (argument: string, context: Context) => {
          if (argument.trim()) return `用法 #${name}${action}${label}推送`;
          if (context.message_type !== "group") return "推送请在群聊中设置。";
          if (context.isMaster !== true && context.member?.is_admin !== true && context.member?.is_owner !== true) {
            return `只有群管理员或机器人主人可以设置${label}推送。`;
          }
          const botId = numberId(context.self_id);
          const groupId = numberId(context.group_id);
          if (!botId || !groupId || !noticeAccounts(host).some((account) => account.botId === botId)) return "无法确认当前机器人和群聊。";
          const redis = getRedis();
          if (!redis) return "公告存储未连接。";
          try {
            await redis.eval("return redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])", {
              keys: [keyFor(game, kind)], arguments: [keyForTarget({ botId, groupId }), value],
            });
            return `${name}${label}推送已${action}。`;
          } catch {
            return `无法保存${label}推送设置，请稍后重试。`;
          }
        };
        const command = `${name}${action}${label}推送`;
        commands[`#${command}`] = configure;
        aliases[command] = `#${command}`;
        if (game === "gs") {
          const short = `${action}${label}推送`;
          commands[`#${short}`] = configure;
          aliases[short] = `#${short}`;
        }
      }
      const push = async (argument: string, context: Context) => {
        if (argument.trim()) return `用法 #${name}推送${label}`;
        if (context.isMaster !== true) return `仅机器人主人可触发${label}推送。`;
        if (!getRedis()) return "公告存储未连接。";
        const report = await run([game], [kind]);
        if (!report) return `${label}推送正在处理或已停止。`;
        return `已确认 ${report.confirmed} 条，未发出 ${report.rejected} 条，结果未确认 ${report.unknown} 条，已去重 ${report.skipped} 条，异常 ${report.failed} 次。`;
      };
      commands[`#${name}推送${label}`] = push;
      if (game === "gs" && kind === "info") commands["#推送资讯"] = push;

      const canonical = `${name}${label}`;
      commands[`#${canonical}`] = (argument) => query(game, kind, argument);
      commands[`#${canonical}列表`] = (argument) => list(game, kind, argument);
      for (let page = 1; page <= 20; page++) commands[`#${canonical}${page}`] = (argument) => query(game, kind, argument, page);
      for (const spelling of game === "gs" ? [name, "官方", ""] : [name]) {
        const short = `${spelling}${label}`;
        if (short !== canonical) {
          if (short !== "公告") aliases[`#${short}`] = `#${canonical}`;
          aliases[`#${short}列表`] = `#${canonical}列表`;
          for (let page = 1; page <= 20; page++) aliases[`#${short}${page}`] = `#${canonical}${page}`;
        }
      }
    }
  }
  return { commands, aliases, fallback, run, dispose };
}
