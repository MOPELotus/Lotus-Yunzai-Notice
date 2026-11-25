import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
import { Job } from "node-schedule";
import type { CommandForward } from "../../lib/commands.ts";
import { noticeAccounts, noticeAdapter, type NoticeAccount, type NoticeDeliveryHost, type NoticeDeliveryReply, type NoticeDeliverySegment } from "./delivery.ts";
import { numberId, type AnnouncementConfig, type AnnouncementConfigReader, type AnnouncementTarget } from "./mys-announcement-config.ts";
import { announcementArticleLink, announcementGameKeys, announcementGames, announcementLabels, createAnnouncementSource, type AnnouncementGame,
  type AnnouncementKind, type AnnouncementPushKind, type OfficialAnnouncement } from "./mys-announcement-source.ts";
import type { NoticeRedis } from "./store.ts";
import { isPrivateMysCommand, legacyMysSubscription, parseMysArticleLink, parseMysEstimate, parseMysSearch, parsePublicAnnouncementQuery } from "./mys-public-query.ts";
import { createMysEstimateSource, createMysSearchSource } from "./mys-search-source.ts";
import { maxMysReplyBytes, readImageAsset } from "./mys-card-draw.ts";

export type OfficialNoticeReply = NoticeDeliveryReply | CommandForward;

interface Context {
  readonly isMaster: boolean;
  readonly isDelegated?: boolean;
  readonly authorizeOfficialNoticePush?: () => boolean;
  readonly message_type?: string;
  readonly self_id?: number;
  readonly group_id?: number;
  readonly member?: { readonly is_admin: boolean; readonly is_owner: boolean };
}

const games = announcementGameKeys;
const kinds = ["notice", "info"] as const;
const pushAllCommand = "#推送米游社全部";
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
  getRedis: () => NoticeRedis | undefined, host: NoticeDeliveryHost, configuration: AnnouncementConfig | AnnouncementConfigReader, signal?: AbortSignal,
  feed = createAnnouncementSource(), now = Date.now, whenActive?: (start: () => void) => () => void, presentArticle?: PresentArticle, presentList?: PresentList, search = createMysSearchSource(),
  estimate = createMysEstimateSource(), estimateImage = async (url: string, active: AbortSignal) =>
    (await readImageAsset(url, active, fetch))?.bytes,
) {
  const readConfig = typeof configuration === "function" ? configuration : () => configuration;
  const initial = readConfig();
  const lifecycle = new AbortController();
  const active = signal ? AbortSignal.any([signal, lifecycle.signal]) : lifecycle.signal;
  let pending: ReturnType<typeof poll> | undefined;
  const timer = new Job(() => { void run()?.catch(() => console.warn($t("mys-announcement.text_1abf8a7618"))); });

  async function present(game: AnnouncementGame, post: OfficialAnnouncement, kind: AnnouncementKind, push = false): Promise<NoticeDeliveryReply> {
    const url = announcementArticleLink(game, post.id);
    if (!presentArticle || active.aborted) return message(game, post, kind);
    try {
      const article = await presentArticle(game, post.id, url, active);
      if (article?.pictures.length) {
        const title = `${announcementGames[game].name}${announcementLabels[kind]}${push ? $t("mys-announcement.text_c757c9cc2d") : ""}：${article.title}`;
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
    if (!redis || active.aborted) return report;
    let config: AnnouncementConfig;
    try {
      config = readConfig();
    } catch {
      console.warn($t("mys-announcement.text_d1c882d00d"));
      report.failed++;
      return report;
    }
    if (config.maxNum === 0) return report;
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
              if (!active.aborted) {
                const current = readConfig();
                const stillConfigured = current === config || (count < current.maxNum && !current.ban[game]?.test(post.title) &&
                  (await targetsFor(redis, game, kind, current)).some(target => target.botId === botId && target.groupId === groupId));
                if (stillConfigured) {
                  currentClaim = await redis.eval(verifyClaim, claimArgs);
                  if (currentClaim === 1 && current !== readConfig()) currentClaim = undefined;
                }
              }
            } catch (error) {
              // Delivery has not started, so a configuration or storage error can release this claim.
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

  function run(selected = games, channels: readonly AnnouncementPushKind[] = kinds, before?: () => Promise<void> | undefined) {
    if (pending || active.aborted) return;
    const current = before ? Promise.resolve().then(before).then(() => poll(selected, channels)) : poll(selected, channels);
    pending = current.finally(() => { pending = undefined; });
    return pending;
  }

  function pushCommand(command: string, label: string, selected = games, channels: readonly AnnouncementPushKind[] = kinds,
    before?: () => Promise<void> | undefined) {
    return async (argument: string, context: Context) => {
      if (argument.trim()) return $t("mys-announcement.text_f40e1d7191", { "command": command });
      if (context.isDelegated) return $t("mys-announcement.text_69effc2871", { "command": command });
      const authorized = context.authorizeOfficialNoticePush?.() ?? context.isMaster;
      if (authorized !== true) return $t("mys-announcement.text_c6fe4f2b60", { "label": label });
      if (!getRedis()) return $t("mys-announcement.text_9579dede53");
      const report = await run(selected, channels, before);
      if (!report || active.aborted) return $t("mys-announcement.text_eea71bdc52", { "label": label });
      const summary = $t("mys-announcement.text_247ba41fa0", { "confirmed": report.confirmed, "rejected": report.rejected, "unknown": report.unknown, "skipped": report.skipped, "failed": report.failed });
      return before ? $t("mys-announcement.text_3ab11af5c4", { "summary": summary }) : summary;
    };
  }

  async function dispose() {
    lifecycle.abort();
    cancelActivation?.();
    timer.cancel();
    active.removeEventListener("abort", cancel);
    await pending;
  }

  function startTimer() {
    if (getRedis() && !active.aborted && !timer.schedule(initial.cron)) throw new Error($t("mys-announcement.text_134d89ae1f"));
  }

  function cancel() { timer.cancel(); }
  active.addEventListener("abort", cancel, { once: true });
  const cancelActivation = whenActive?.(() => {
    try {
      startTimer();
    } catch {
      console.warn($t("mys-announcement.text_14111e3a0d"));
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
      return $t("mys-announcement.text_03670a06f8", { "name": name, "label": label });
    }
    try {
      const posts = await feed(game, active, kind, 20);
      const post = posts[page - 1];
      if (!posts.length) return $t("mys-announcement.text_d21d2863c5", { "name": name, "label": label });
      return post ? await present(game, post, kind) : $t("mys-announcement.text_7f0f5d6847", { "length": posts.length, "name": name, "label": label, "value4": posts.length });
    } catch {
      return $t("mys-announcement.text_b655331797", { "label": label });
    }
  }
  async function list(game: AnnouncementGame, kind: AnnouncementKind, argument: string): Promise<NoticeDeliveryReply> {
    const { name } = announcementGames[game];
    const label = announcementLabels[kind];
    if (argument.trim()) return $t("mys-announcement.text_b33d6a8d75", { "name": name, "label": label });
    try {
      const posts = (await feed(game, active, kind, 5)).slice(0, 5);
      if (!posts.length) return $t("mys-announcement.text_d21d2863c5", { "name": name, "label": label });
      const links = [$t("mys-announcement.text_e20a1fa7a4", { "name": name, "label": label }), ...posts.flatMap((post, index) => [
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
      return $t("mys-announcement.text_b655331797", { "label": label });
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
    const text = `${article?.title ?? title ?? $t("mys-announcement.text_cc1c3b535e")}
${url}`;
    return article?.pictures.length ? [{ type: "text", text }, ...article.pictures] : text;
  }

  async function estimateGallery(post: OfficialAnnouncement & { readonly gallery?: readonly string[] }): Promise<CommandForward | undefined> {
    if (!post.gallery?.length) return;
    const heading = `${post.title}\n${announcementArticleLink("sr", post.id)}`;
    const nodes: CommandForward["nodes"][number][] = [heading];
    let totalBytes = 0;
    let missing = 0;
    const signal = AbortSignal.any([active, AbortSignal.timeout(10_000)]);
    for (let start = 0; start < post.gallery.length && !signal.aborted; start += 3) {
      const files = await Promise.all(post.gallery.slice(start, start + 3).map(url => estimateImage(url, signal).catch(() => undefined)));
      for (const file of files) {
        if (!file || totalBytes + file.byteLength > maxMysReplyBytes) {
          missing++;
          continue;
        }
        totalBytes += file.byteLength;
        nodes.push({ type: "image", file });
      }
    }
    if (active.aborted || nodes.length === 1) return;
    if (missing || signal.aborted) nodes.push($t("mys-announcement.text_2f1366c8c5"));
    return { type: "forward", senderName: $t("mys-announcement.text_5100350548"), nodes, batchSize: 3 };
  }

  async function fallback(normalizedMessage: string, context?: Context) {
    if (active.aborted) return;
    const subscription = legacyMysSubscription(normalizedMessage);
    if (subscription && context) return commands[aliases[subscription] ?? subscription]?.("", context);
    const target = parsePublicAnnouncementQuery(normalizedMessage);
    if (target) return target.list ? list(target.game, target.kind, target.argument)
      : query(target.game, target.kind, target.argument, target.page);

    const estimateGame = parseMysEstimate(normalizedMessage);
    if (estimateGame) {
      try {
        const post = await estimate(estimateGame, active);
        if (active.aborted) return;
        if (!post) return $t("mys-announcement.text_ef3763ae26");
        if (estimateGame === "sr" && /预估$/u.test(normalizedMessage.trim())) {
          const gallery = await estimateGallery(post);
          if (gallery) return gallery;
        }
        return articleReply(estimateGame, post.id, post.title);
      } catch {
        if (!active.aborted) return $t("mys-announcement.text_b09ca90f8f");
      }
      return;
    }

    if (isPrivateMysCommand(normalizedMessage)) return;
    const link = parseMysArticleLink(normalizedMessage);
    if (link) return articleReply(link.game, link.id);

    const request = parseMysSearch(normalizedMessage);
    if (!request) return;
    if ("error" in request) return request.error;
    try {
      const posts = await search(request.keyword, active);
      if (!posts.length) return $t("mys-announcement.text_c71389ad81");
      const post = posts[request.offset];
      return post ? articleReply("gs", post.id, post.title) : $t("mys-announcement.text_25d3a2a2ba", { "length": posts.length, "value2": posts.length });
    } catch {
      if (!active.aborted) return $t("mys-announcement.text_6c7444e966");
    }
  }

  const commands: Record<string, (argument: string, context: Context) => Promise<NoticeDeliveryReply>> = {};
  const aliases: Record<string, string> = {};
  for (const game of games) {
    const { name, aliases: alternativeNames } = announcementGames[game];
    const subscriptionNames = alternativeNames.filter(alias => alias !== "官方");
    for (const kind of kinds) {
      const label = announcementLabels[kind];
      for (const [action, value] of [[$t("mys-announcement.text_8da97ddda9"), "on"], [$t("mys-announcement.text_3fd47edce4"), "off"]] as const) {
        const configure = async (argument: string, context: Context) => {
          if (argument.trim()) return $t("mys-announcement.text_2f0664f20c", { "name": name, "action": action, "label": label });
          if (context.message_type !== "group") return $t("mys-announcement.text_3f71e29e87");
          if (context.isMaster !== true && context.member?.is_admin !== true && context.member?.is_owner !== true) {
            return $t("mys-announcement.text_48d1700d89", { "label": label });
          }
          const botId = numberId(context.self_id);
          const groupId = numberId(context.group_id);
          if (!botId || !groupId || !noticeAccounts(host).some((account) => account.botId === botId)) return $t("mys-announcement.text_ae2bd2f2c0");
          const redis = getRedis();
          if (!redis) return $t("mys-announcement.text_9579dede53");
          try {
            await redis.eval("return redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])", {
              keys: [keyFor(game, kind)], arguments: [keyForTarget({ botId, groupId }), value],
            });
            return $t("mys-announcement.text_be4486aad5", { "name": name, "label": label, "action": action });
          } catch {
            return $t("mys-announcement.text_9b9101dcd6", { "label": label });
          }
        };
        const command = $t("mys-announcement.text_c1d233aaef", { "name": name, "action": action, "label": label });
        commands[`#${command}`] = configure;
        aliases[command] = `#${command}`;
        for (const alternative of subscriptionNames) {
          const spelling = $t("mys-announcement.text_db2b052b10", { "alternative": alternative, "action": action, "label": label });
          aliases[`#${spelling}`] = `#${command}`;
          aliases[spelling] = `#${command}`;
        }
        if (game === "gs") {
          const short = $t("mys-announcement.text_6990de13a3", { "action": action, "label": label });
          commands[`#${short}`] = configure;
          aliases[short] = `#${short}`;
        }
      }
      const pushName = `#${name}推送${label}`;
      const push = pushCommand(pushName, label, [game], [kind]);
      commands[pushName] = push;
      for (const alternative of subscriptionNames) aliases[`#${alternative}推送${label}`] = pushName;
      if (game === "gs" && kind === "info") commands["#推送资讯"] = push;

      const canonical = `${name}${label}`;
      commands[`#${canonical}`] = (argument) => query(game, kind, argument);
      commands[`#${canonical}列表`] = (argument) => list(game, kind, argument);
      for (let page = 1; page <= 20; page++) commands[`#${canonical}${page}`] = (argument) => query(game, kind, argument, page);
      for (const spelling of game === "gs" ? [...alternativeNames, ""] : alternativeNames) {
        const short = `${spelling}${label}`;
        if (short !== "公告") aliases[`#${short}`] = `#${canonical}`;
        aliases[`#${short}列表`] = `#${canonical}列表`;
        for (let page = 1; page <= 20; page++) aliases[`#${short}${page}`] = `#${canonical}${page}`;
      }
    }
  }
  function fullPushCommand(advanceActivity: () => Promise<void> | undefined) {
    return { [pushAllCommand]: pushCommand(pushAllCommand, $t("mys-announcement.text_079f1aa96c"), games, kinds, advanceActivity) };
  }
  return { commands, aliases, fallback, run, dispose, fullPushCommand };
}
