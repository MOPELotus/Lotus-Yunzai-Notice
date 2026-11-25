import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
import { decorateNotice, parseNoticeInput, type InboundNoticeSegment, type NoticeReply } from "./content.ts";
import { createNoticeDelivery, type DeliveryReceipt, type NoticeDeliveryHost } from "./delivery.ts";
import { createActivityExpiryNotices } from "./mys-activity.ts";
import { configuredAnnouncements } from "./mys-announcement-config.ts";
import { createAnnouncementListRenderer } from "./mys-list-card.ts";
import { createArticleSource } from "./mys-article-source.ts";
import { renderOfficialArticle } from "./mys-article-card.ts";
import { createOfficialAnnouncements, type OfficialNoticeReply } from "./mys-announcement.ts";
import { legacyMysSubscription, publicMysFeatureNames } from "./mys-public-query.ts";
import { configuredNoticeLogLevel, configuredNoticeSchedule, noticeLogger, startNoticeScheduler } from "./schedule.ts";
import { createTargetCommands } from "./target-commands.ts";
import { createNoticeStore, type Notice, type NoticeRedis } from "./store.ts";

interface CommandContext {
  readonly isMaster: boolean;
  readonly user_id?: number;
  readonly message?: string | readonly InboundNoticeSegment[];
  readonly raw_message?: string;
  readonly isDelegated?: boolean;
  readonly reply?: (message: string, quote?: boolean) => boolean | Promise<boolean>;
}

type Handler = (argument: string, context: CommandContext) => NoticeReply | Promise<NoticeReply>;
type NoticeFallbackContext = CommandContext & { readonly normalizedMessage: string };
type NoticeFallback = (message: string, context: NoticeFallbackContext) =>
  OfficialNoticeReply | Promise<OfficialNoticeReply | undefined> | undefined;
type Store = ReturnType<typeof createNoticeStore>;
interface HistoryForward {
  readonly type: "forward";
  readonly nodes: readonly NoticeReply[];
  readonly batchSize: 10;
  readonly senderName: string;
}

const historyBatchSize = 10;
const failedGroupLimit = 10;
const publishCommand = "#发布公告";
const memberHelp = [
  $t("index.text_c6b5b4ce3d"),
  $t("index.text_1d929f55ba"),
  $t("index.text_be37624ff9"),
].join("\n");
const ownerHelp = [
  $t("index.text_c9c98bd5cf"),
  $t("index.text_3782d8a59e"),
  "#撤回公告",
  $t("index.text_21213a9551"),
  $t("index.text_6d8a248e15"),
].join("\n");
const ownerDeliveryHelp = [
  "#推送公告",
  $t("index.text_89c69f5bc2"),
  $t("index.text_30762d3660"),
  "#公告账号列表/状态/统计/启用/禁用",
  $t("index.text_ed2f75835d"),
].join("\n");

function format(item: Notice, title: string, prefix = ""): NoticeReply {
  const heading = [`【${title}】 ${item.id}`, item.timestamp];
  if (item.status) heading.push($t("index.text_7ca7f03d80", { "status": item.status }));
  heading.push($t("index.text_3ae64658f7", { "creator": item.creator }));
  return decorateNotice(item.content, item.segments, prefix + heading.join("\n") + "\n");
}

function historyNode(item: Notice): NoticeReply {
  const heading = [`ID: ${item.id}`];
  if (item.status) heading.push($t("index.text_2b70c269ae", { "status": item.status }));
  heading.push($t("index.text_55a1d9bcb5", { "creator": item.creator }), $t("index.text_a294d065ef", { "timestamp": item.timestamp }), "----------");
  return [
    { type: "text", text: heading.join("\n") + "\n" },
    ...(item.segments ?? [{ type: "text", text: item.content } as const]),
  ];
}

function owner(handler: Handler): Handler {
  return (argument, context) => context?.isMaster === true ? handler(argument, context) : $t("index.text_2a41f2574e");
}

function hostRedis() {
  return (globalThis as { redis?: NoticeRedis }).redis;
}

function adjacentPublishArgument(message: string) {
  const input = message.trimStart();
  if (!input.startsWith(publishCommand)) return;
  const argument = input.slice(publishCommand.length);
  if (argument && /^\S/u.test(argument)) return argument.trimEnd();
}

export function createNoticePlugin(
  getRedis: () => NoticeRedis | undefined = hostRedis,
  deliveryHost?: NoticeDeliveryHost,
  signal?: AbortSignal,
  log = noticeLogger("info"),
) {
  function withStore<T extends NoticeReply | HistoryForward>(handler: (store: Store) => Promise<T>): Promise<T | string> | string {
    const redis = getRedis();
    if (!redis) return $t("index.text_9579dede53");
    return handler(createNoticeStore(redis)).catch(() => $t("index.text_97f0546627"));
  }

  async function writeNotice(store: Store, content: NoticeReply, context: CommandContext, creator?: string): Promise<NoticeReply> {
    const editing = creator === undefined;
    const verb = editing ? $t("index.text_0518365699") : $t("index.text_b61f333b91");
    const result = await store.write(content, creator);
    if (result.state === "missing") return $t("index.text_be2e7e55bb");
    if (result.state === "rejected") return $t("index.text_f4505d0f9f", { "verb": verb });
    if (result.state !== "confirmed") return $t("index.text_e69631bde8", { "verb": verb });

    const notice = result.notice;
    const confirmation = editing ? $t("index.text_ae926150f0") : $t("index.text_87a9692b7d", { "id": notice.id });
    if (context.reply) {
      try {
        await context.reply(confirmation, editing);
      } catch {
        // A lost chat acknowledgement cannot undo the saved notice.
      }
      return format(notice, $t("index.text_b46f585cfc"));
    }
    return format(notice, $t("index.text_b46f585cfc"), confirmation + "\n");
  }

  const commands = {
    "#公告": () => withStore(async (store) => {
      const current = await store.current();
      return current ? format(current, $t("index.text_b46f585cfc")) : $t("index.text_f3e5dfeaee");
    }),

    "#历史公告": (argument: string) => withStore(async (store) => {
      const history = await store.history();
      if (!argument) return history[0] ? format(history[0], $t("index.text_ed47a8fe50")) : $t("index.text_7a8acdb7bb");

      const notice = history.find(({ id }) => id === argument.toUpperCase());
      return notice ? format(notice, $t("index.text_31c810e05a")) : $t("index.text_0a85ce3ac7");
    }),

    "#全部历史公告": (argument = "") => {
      const input = argument.trim();
      const page = input ? Number(input) : undefined;
      if (input && (!/^[1-9]\d*$/u.test(input) || !Number.isSafeInteger(page))) return $t("index.text_054a4c71f9");
      return withStore(async (store) => {
        const history = await store.history();
        if (!history.length) return $t("index.text_7a8acdb7bb");
        const pages = Math.ceil(history.length / historyBatchSize);
        if (page !== undefined && page > pages) return $t("index.text_bee7c78b04", { "pages": pages });
        const selected = page === undefined ? history :
          history.slice((page - 1) * historyBatchSize, page * historyBatchSize);
        return { type: "forward", nodes: selected.map(historyNode), batchSize: historyBatchSize, senderName: $t("index.text_31c810e05a") } as const;
      });
    },

    "#公告帮助": (_argument: string, context: CommandContext) =>
      context?.isMaster === true ? [memberHelp, ownerHelp, ...(deliveryHost ? [ownerDeliveryHelp] : [])].join("\n") : memberHelp,

    [publishCommand]: owner((argument, context) => {
      const creator = context.user_id;
      if (!creator || !Number.isSafeInteger(creator) || creator < 1) return $t("index.text_860106d549");
      const parsed = parseNoticeInput(publishCommand, argument, context.message, true);
      if ("error" in parsed) return parsed.error;
      return withStore((store) => writeNotice(store, parsed.content, context, String(creator)));
    }),

    "#编辑公告": owner((argument, context) => {
      const parsed = parseNoticeInput("#编辑公告", argument, context.message);
      if ("error" in parsed) return parsed.error;
      return withStore((store) => writeNotice(store, parsed.content, context));
    }),

    "#撤回公告": owner(() => withStore(async (store) =>
      await store.recall() ? $t("index.text_965eedbd5b") : $t("index.text_01a3c9774b"))),
  } satisfies Record<string, (argument: string, context: CommandContext) => NoticeReply | HistoryForward | Promise<NoticeReply | HistoryForward>>;

  const targetCommands = Object.assign(createTargetCommands(getRedis, deliveryHost), commands);
  const fallback: NoticeFallback = (_message, context) => {
    const argument = adjacentPublishArgument(context.normalizedMessage);
    if (argument === undefined || signal?.aborted) return;
    return commands[publishCommand](argument, context);
  };
  if (!deliveryHost) return { commands: targetCommands, fallback };

  let pushing = false;
  return { fallback, commands: Object.assign(targetCommands, {
    "#推送公告": owner(async (argument, context) => {
      if (argument.trim()) return $t("index.text_d5656aa9ea");
      if (context.isDelegated) return $t("index.text_51b5f40228");
      if (pushing) return $t("index.text_ccc793f94b");
      const redis = getRedis();
      if (!redis) return $t("index.text_9579dede53");

      pushing = true;
      try {
        const reply = context.reply;
        const result = await createNoticeDelivery(redis, deliveryHost).push(signal, undefined, undefined,
          async (id, processed, selected, confirmed, accounts) => {
            const text = processed === 0 ? $t("index.text_8c370436a4", { "id": id, "accounts": accounts, "selected": selected })
              : $t("index.text_79101fc7af", { "processed": processed, "selected": selected, "confirmed": confirmed });
            log(processed === 0 ? "info" : "debug", text);
            await reply?.(text, true);
          });
        if (!result.noticeId) return result.stopped === "cancelled" ? $t("index.text_bd11e940e8") : $t("index.text_4302a17289");
        const count = (state: DeliveryReceipt["state"]) =>
          result.receipts.filter((receipt) => receipt.state === state).length;
        const lines = [
          $t("index.text_6e6a706ba5", { "noticeId": result.noticeId, "selected": result.selected }),
          $t("index.text_97e92a3f7d", { "value1": count("confirmed"), "value2": count("not-sent"), "value3": count("unknown") }),
        ];
        log(result.stopped === "storage-error" ? "error" : result.stopped || result.discoveryFailures ? "warn" : "info",
          `${lines[0]}。${lines[1]}。`);
        const confirmedByAccount = new Map<number, number>();
        const failed: string[] = [];
        for (const receipt of result.receipts) {
          if (receipt.state === "confirmed") {
            confirmedByAccount.set(receipt.botId, (confirmedByAccount.get(receipt.botId) ?? 0) + 1);
          } else {
            failed.push(`${receipt.botId}:${receipt.groupId}（${describeReceipt(receipt)}）`);
          }
        }
        if (result.accountTotals.size) {
          lines.push($t("index.text_6ce2f988ae"), ...[...result.accountTotals].map(([botId, total]) =>
            $t("index.text_ea8dd79188", { "botId": botId, "value2": confirmedByAccount.get(botId) ?? 0, "total": total })));
        }
        if (failed.length) {
          lines.push($t("index.text_62acebdbf8", { "value1": failed.slice(0, failedGroupLimit).join("、") }));
          if (failed.length > failedGroupLimit) lines.push($t("index.text_4f6d3657e7", { "value1": failed.length - failedGroupLimit }));
        }
        if (result.alreadyClaimed) lines.push($t("index.text_983b7608a1", { "alreadyClaimed": result.alreadyClaimed }));
        if (result.discoveryFailures) lines.push($t("index.text_57f56b207c", { "discoveryFailures": result.discoveryFailures }));
        if (result.stopped === "notice-changed") lines.push($t("index.text_1251d3b7e5"));
        if (result.stopped === "storage-error") lines.push($t("index.text_1ecef0a69d"));
        if (result.stopped === "cancelled") lines.push($t("index.text_bd11e940e8"));
        lines.push($t("index.text_1fd24f13e1", { "noticeId": result.noticeId }));
        return lines.join("\n");
      } catch {
        log("error", $t("index.text_6d90a892e8"));
        return $t("index.text_6d90a892e8");
      } finally {
        pushing = false;
      }
    }),
    "#撤回已发公告": owner(async (argument) => {
      const [first, target, ...rest] = argument.trim() ? argument.trim().split(/\s+/u) : [];
      const noticeId = first?.toUpperCase();
      const groupId = target === undefined ? undefined : Number(target);
      if ((noticeId !== undefined && !/^\d{5}[A-Z]{3}$/u.test(noticeId)) || rest.length ||
          (target !== undefined && (!/^[1-9]\d*$/u.test(target) || !Number.isSafeInteger(groupId)))) {
        return $t("index.text_0da2c438ca");
      }
      const redis = getRedis();
      if (!redis) return $t("index.text_9579dede53");

      try {
        const result = await createNoticeDelivery(redis, deliveryHost).recall({ noticeId, groupId, signal });
        if (!result.noticeId) return result.stopped === "cancelled" ? $t("index.text_c16a288d52") : $t("index.text_01a3c9774b");
        if (!result.selected) return $t("index.text_597375fb3e", { "noticeId": result.noticeId });
        const count = (state: "confirmed" | "not-sent" | "unknown") =>
          result.receipts.filter((receipt) => receipt.recall === state).length;
        const lines = [
          $t("index.text_58bdb85875", { "noticeId": result.noticeId, "selected": result.selected }),
          $t("index.text_7388115620", { "value1": count("confirmed"), "value2": count("not-sent"), "value3": count("unknown") }),
        ];
        if (result.alreadyClaimed) lines.push($t("index.text_56e6e2ef8f", { "alreadyClaimed": result.alreadyClaimed }));
        if (result.stopped === "storage-error") lines.push($t("index.text_db1472dce7"));
        if (result.stopped === "cancelled") lines.push($t("index.text_c16a288d52"));
        lines.push($t("index.text_09ecd4d4f3", { "noticeId": result.noticeId }));
        return lines.join("\n");
      } catch {
        return $t("index.text_00b363e84f");
      }
    }),
    "#公告推送回执": owner(async (argument) => {
      const [first, second, ...rest] = argument.trim() ? argument.trim().split(/\s+/u) : [];
      const noticeId = first && /^\d{5}[A-Z]{3}$/u.test(first.toUpperCase()) ? first.toUpperCase() : undefined;
      const page = Number((noticeId ? second : first) ?? 1);
      if (rest.length || (!noticeId && second !== undefined) || !Number.isSafeInteger(page) || page < 1) {
        return $t("index.text_5c14524d87");
      }
      const redis = getRedis();
      if (!redis) return $t("index.text_9579dede53");

      try {
        const result = await createNoticeDelivery(redis, deliveryHost).receipts(noticeId);
        if (!result?.receipts.length) return $t("index.text_34cacb6dae");
        const receiptSize = 12;
        const pages = Math.ceil(result.receipts.length / receiptSize);
        if (page > pages) return $t("index.text_a24a822bfe", { "noticeId": result.noticeId, "pages": pages });
        const lines = result.receipts.slice((page - 1) * receiptSize, page * receiptSize)
          .map((receipt) => $t("index.text_0878dc62cb", { "groupId": receipt.groupId, "botId": receipt.botId, "value3": describeReceipt(receipt) }));
        return [$t("index.text_2e42d76eee", { "noticeId": result.noticeId, "page": page, "pages": pages }), ...lines].join("\n");
      } catch {
        return $t("index.text_faf15e2777");
      }
    }),
  }) };
}

function describeReceipt(receipt: DeliveryReceipt): string {
  switch (receipt.state) {
    case "confirmed": {
      const suffix = receipt.recall && {
        confirmed: $t("index.text_3d2ef05af4"), "not-sent": $t("index.text_692c05335e"),
        unknown: $t("index.text_ea4a50ce05"), pending: $t("index.text_fc8f225fd5"),
      }[receipt.recall];
      return [$t("index.text_008627ff5f", { "messageId": receipt.messageId }), suffix].filter(Boolean).join(" · ");
    }
    case "not-sent": return $t("index.text_48e31ef421");
    case "unknown": return $t("index.text_dd7831b4a6");
    case "pending": return $t("index.text_1075a9178b");
  }
}

export function createModule({ groups, noticeGroups = groups, signal, whenNoticeActive }: {
  groups: NoticeDeliveryHost; noticeGroups?: NoticeDeliveryHost; signal?: AbortSignal;
  whenNoticeActive?: (start: () => void) => () => void;
}):
  ReturnType<typeof createNoticePlugin> & { aliases?: Record<string,string>; dispose?: () => Promise<void>;
    fallbackFeatures?: (context: NoticeFallbackContext) => readonly string[];
  } {
  let log = noticeLogger("info");
  try { log = noticeLogger(configuredNoticeLogLevel()); }
  catch { log("warn", $t("index.text_45aa3ff05f")); }
  const module = createNoticePlugin(hostRedis, noticeGroups, signal, log);
  let aliases: Record<string,string> | undefined;
  let officialFallback: ((message: string, context: NoticeFallbackContext) => Promise<OfficialNoticeReply | undefined>) | undefined;
  const disposers: (() => Promise<void>)[] = [];
  try {
    const window = configuredNoticeSchedule();
    if (window) {
      let stop: (() => Promise<void>) | undefined;
      let disposed = false;
      const launch = () => {
        if (!disposed && !signal?.aborted) stop = startNoticeScheduler(hostRedis, noticeGroups, window, signal, undefined, log);
      };
      const cancel = whenNoticeActive?.(launch);
      if (!whenNoticeActive) launch();
      disposers.push(async () => { disposed = true; cancel?.(); await stop?.(); });
    }
  } catch {
    log("warn", $t("index.text_068c588dde"));
  }
  try {
    const root = new URL("../../", import.meta.url);
    const config = configuredAnnouncements(root);
    const articleSource = createArticleSource();
    const official = createOfficialAnnouncements(hostRedis, noticeGroups, config, signal, undefined, undefined, whenNoticeActive,
      async (game, id, url, active) => {
        const article = await articleSource(game, id, active);
        if (article) return { title: article.title, pictures: await renderOfficialArticle(article, url, active) };
      }, createAnnouncementListRenderer(root));
    Object.assign(module.commands, official.commands);
    aliases = official.aliases;
    officialFallback = official.fallback;
    disposers.push(official.dispose);
    const expiry = createActivityExpiryNotices(hostRedis, noticeGroups, config, signal, undefined, undefined, whenNoticeActive);
    Object.assign(module.commands, expiry.commands, official.fullPushCommand(expiry.run));
    disposers.push(expiry.dispose);
  } catch {
    console.warn($t("index.text_969d375f07"));
  }
  if (!disposers.length) return module;
  return {
    ...module, aliases, ...(officialFallback && {
      fallback: (message: string, context: NoticeFallbackContext) =>
        module.fallback(message, context) ?? officialFallback?.(context.normalizedMessage, context),
      fallbackFeatures: (context: NoticeFallbackContext) =>
        adjacentPublishArgument(context.normalizedMessage) !== undefined || legacyMysSubscription(context.normalizedMessage)
          ? [] : publicMysFeatureNames,
    }),
    async dispose() { await Promise.all(disposers.map((dispose) => dispose())); },
  };
}

export default createNoticePlugin();
