import { decorateNotice, parseNoticeInput, type InboundNoticeSegment, type NoticeReply } from "./content.ts";
import { createNoticeDelivery, type DeliveryReceipt, type NoticeDeliveryHost } from "./delivery.ts";
import { createActivityExpiryNotices } from "./mys-activity.ts";
import { configuredAnnouncements } from "./mys-announcement-config.ts";
import { createOfficialAnnouncements } from "./mys-announcement.ts";
import { configuredNoticeSchedule, startNoticeScheduler } from "./schedule.ts";
import { createTargetCommands } from "./target-commands.ts";
import { createNoticeStore, type Notice, type NoticeRedis } from "./store.ts";

interface CommandContext {
  readonly isMaster: boolean;
  readonly user_id?: number;
  readonly message?: string | readonly InboundNoticeSegment[];
  readonly raw_message?: string;
}

type Handler = (argument: string, context: CommandContext) => NoticeReply | Promise<NoticeReply>;
type Store = ReturnType<typeof createNoticeStore>;

const pageSize = 5;
const memberHelp = [
  "#公告 查看当前公告",
  "#历史公告 [编号] 查看历史公告",
  "#全部历史公告 [页码] 分页查看历史",
].join("\n");
const ownerHelp = [
  "#发布公告 <内容>",
  "#编辑公告 <内容>",
  "#撤回公告",
  "#公告全局白名单/黑名单 添加/删除/查看",
  "#公告账号白名单/黑名单 [机器人QQ] 添加/删除/查看",
].join("\n");
const ownerDeliveryHelp = [
  "#推送公告",
  "#公告推送回执 [编号] [页码]",
  "#撤回已发公告 [编号] [群号]",
  "#公告账号列表/状态/统计/启用/禁用",
  "#公告账号配置 [机器人QQ 启用/禁用/间隔/重试 值]",
].join("\n");

function format(item: Notice, title: string): NoticeReply {
  const heading = [`【${title}】 ${item.id}`, item.timestamp];
  if (item.status) heading.push(`状态 ${item.status}`);
  heading.push(`发布者 ${item.creator}`);
  return decorateNotice(item.content, item.segments, heading.join("\n") + "\n");
}

function owner(handler: Handler): Handler {
  return (argument, context) => context?.isMaster === true ? handler(argument, context) : "仅机器人主人可管理公告。";
}

function hostRedis() {
  return (globalThis as { redis?: NoticeRedis }).redis;
}

export function createNoticePlugin(
  getRedis: () => NoticeRedis | undefined = hostRedis,
  deliveryHost?: NoticeDeliveryHost,
  signal?: AbortSignal,
) {
  function withStore(handler: (store: Store) => Promise<NoticeReply>): Promise<NoticeReply> | string {
    const redis = getRedis();
    if (!redis) return "公告存储未连接。";
    return handler(createNoticeStore(redis)).catch(() => "公告存储操作失败，请稍后再试。");
  }

  const commands = {
    "#公告": () => withStore(async (store) => {
      const current = await store.current();
      return current ? format(current, "当前公告") : "当前没有公告。";
    }),

    "#历史公告": (argument: string) => withStore(async (store) => {
      const history = await store.history();
      if (!argument) return history[0] ? format(history[0], "上一条历史公告") : "没有历史公告。";

      const notice = history.find(({ id }) => id === argument.toUpperCase());
      return notice ? format(notice, "历史公告") : "没有找到对应的历史公告。";
    }),

    "#全部历史公告": (argument: string) => {
      const page = argument ? Number(argument) : 1;
      if (!Number.isSafeInteger(page) || page < 1) return "用法：#全部历史公告 [页码]";
      return withStore(async (store) => {
        const history = await store.history();
        if (!history.length) return "没有历史公告。";
        const pages = Math.ceil(history.length / pageSize);
        if (page > pages) return `历史公告共有 ${pages} 页。`;
        return [`【历史公告】第 ${page}/${pages} 页`,
          ...history.slice((page - 1) * pageSize, page * pageSize).map((item) => {
            const text = [...item.content];
            const preview = text.length > 160 ? `${text.slice(0, 160).join("")}…` : item.content;
            return `【公告】 ${item.id}\n${item.timestamp}\n${preview}`;
          }),
          "发送 #历史公告 <编号> 查看全文。",
        ].join("\n\n");
      });
    },

    "#公告帮助": (_argument: string, context: CommandContext) =>
      context?.isMaster === true ? [memberHelp, ownerHelp, ...(deliveryHost ? [ownerDeliveryHelp] : [])].join("\n") : memberHelp,

    "#发布公告": owner((argument, context) => {
      const creator = context.user_id;
      if (!creator || !Number.isSafeInteger(creator) || creator < 1) return "无法确认发布者身份。";
      const parsed = parseNoticeInput("#发布公告", argument, context.message);
      if ("error" in parsed) return parsed.error;
      return withStore(async (store) => {
        const id = await store.publish(parsed.content, String(creator));
        return id ? `公告已发布，编号 ${id}。发送 #公告 查看。` : "公告发布失败。";
      });
    }),

    "#编辑公告": owner((argument, context) => {
      const parsed = parseNoticeInput("#编辑公告", argument, context.message);
      if ("error" in parsed) return parsed.error;
      return withStore(async (store) =>
        await store.edit(parsed.content) ? "公告已更新。" : "当前没有可编辑的公告。");
    }),

    "#撤回公告": owner(() => withStore(async (store) =>
      await store.recall() ? "当前公告已撤回。" : "当前没有可撤回的公告。")),
  } satisfies Record<string, Handler>;

  const targetCommands = Object.assign(createTargetCommands(getRedis, deliveryHost), commands);
  if (!deliveryHost) return { commands: targetCommands };

  let pushing = false;
  return { commands: Object.assign(targetCommands, {
    "#推送公告": owner(async (argument) => {
      if (argument.trim()) return "用法：#推送公告";
      if (pushing) return "正在推送公告，请稍候。";
      const redis = getRedis();
      if (!redis) return "公告存储未连接。";

      pushing = true;
      try {
        const result = await createNoticeDelivery(redis, deliveryHost).push(signal);
        if (!result.noticeId) return result.stopped === "cancelled" ? "推送已中断。" : "当前没有可推送的公告。";
        const count = (state: DeliveryReceipt["state"]) =>
          result.receipts.filter((receipt) => receipt.state === state).length;
        const lines = [
          `公告 ${result.noticeId} · ${result.selected} 个目标群`,
          `确认送达 ${count("confirmed")} · 未发出 ${count("not-sent")} · 结果未确认 ${count("unknown")}`,
        ];
        if (result.alreadyClaimed) lines.push(`已跳过 ${result.alreadyClaimed} 个已有投递记录的群。`);
        if (result.discoveryFailures) lines.push(`${result.discoveryFailures} 个机器人未能读取目标群。`);
        if (result.stopped === "notice-changed") lines.push("公告发生变更，已停止后续发送。");
        if (result.stopped === "storage-error") lines.push("投递记录写入未确认，已停止后续发送。");
        if (result.stopped === "cancelled") lines.push("推送已中断。");
        lines.push(`发送 #公告推送回执 ${result.noticeId} 查看逐群回执。`);
        return lines.join("\n");
      } catch {
        return "公告推送未完成，请查看投递回执。";
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
        return "用法：#撤回已发公告 [编号] [群号]";
      }
      const redis = getRedis();
      if (!redis) return "公告存储未连接。";

      try {
        const result = await createNoticeDelivery(redis, deliveryHost).recall({ noticeId, groupId, signal });
        if (!result.noticeId) return result.stopped === "cancelled" ? "撤回已中断。" : "当前没有可撤回的公告。";
        if (!result.selected) return `公告 ${result.noticeId} 没有可撤回的已确认消息。`;
        const count = (state: "confirmed" | "not-sent" | "unknown") =>
          result.receipts.filter((receipt) => receipt.recall === state).length;
        const lines = [
          `公告 ${result.noticeId} · ${result.selected} 条已确认发送的消息`,
          `撤回已确认 ${count("confirmed")} · 撤回未发出 ${count("not-sent")} · 撤回未确认 ${count("unknown")}`,
        ];
        if (result.alreadyClaimed) lines.push(`已跳过 ${result.alreadyClaimed} 条已有撤回记录的消息。`);
        if (result.stopped === "storage-error") lines.push("撤回记录写入未确认，已停止后续撤回。");
        if (result.stopped === "cancelled") lines.push("撤回已中断。");
        lines.push(`发送 #公告推送回执 ${result.noticeId} 查看逐群结果。`);
        return lines.join("\n");
      } catch {
        return "已发公告撤回未完成，请查看回执。";
      }
    }),
    "#公告推送回执": owner(async (argument) => {
      const [first, second, ...rest] = argument.trim() ? argument.trim().split(/\s+/u) : [];
      const noticeId = first && /^\d{5}[A-Z]{3}$/u.test(first.toUpperCase()) ? first.toUpperCase() : undefined;
      const page = Number((noticeId ? second : first) ?? 1);
      if (rest.length || (!noticeId && second !== undefined) || !Number.isSafeInteger(page) || page < 1) {
        return "用法：#公告推送回执 [编号] [页码]";
      }
      const redis = getRedis();
      if (!redis) return "公告存储未连接。";

      try {
        const result = await createNoticeDelivery(redis, deliveryHost).receipts(noticeId);
        if (!result?.receipts.length) return "没有公告推送回执。";
        const receiptSize = 12;
        const pages = Math.ceil(result.receipts.length / receiptSize);
        if (page > pages) return `公告 ${result.noticeId} 的回执共有 ${pages} 页。`;
        const lines = result.receipts.slice((page - 1) * receiptSize, page * receiptSize)
          .map((receipt) => `群 ${receipt.groupId} · 机器人 ${receipt.botId} · ${describeReceipt(receipt)}`);
        return [`公告 ${result.noticeId} 推送回执（${page}/${pages} 页）`, ...lines].join("\n");
      } catch {
        return "无法读取公告推送回执。";
      }
    }),
  }) };
}

function describeReceipt(receipt: DeliveryReceipt): string {
  switch (receipt.state) {
    case "confirmed": {
      const suffix = receipt.recall && {
        confirmed: "撤回已确认", "not-sent": "撤回未发出",
        unknown: "撤回结果未确认", pending: "撤回等待确认或进程中断",
      }[receipt.recall];
      return [`确认送达 · 消息 ${receipt.messageId}`, suffix].filter(Boolean).join(" · ");
    }
    case "not-sent": return "确认未发出";
    case "unknown": return "发出结果未确认";
    case "pending": return "等待确认或进程中断";
  }
}

export function createModule({ groups, noticeGroups = groups, signal, whenNoticeActive }: {
  groups: NoticeDeliveryHost; noticeGroups?: NoticeDeliveryHost; signal?: AbortSignal;
  whenNoticeActive?: (start: () => void) => () => void;
}):
  ReturnType<typeof createNoticePlugin> & { aliases?: Record<string,string>; dispose?: () => Promise<void> } {
  const module = createNoticePlugin(hostRedis, noticeGroups, signal);
  let aliases: Record<string,string> | undefined;
  const disposers: (() => Promise<void>)[] = [];
  try {
    const window = configuredNoticeSchedule();
    if (window) {
      let stop: (() => Promise<void>) | undefined;
      let disposed = false;
      const launch = () => {
        if (!disposed && !signal?.aborted) stop = startNoticeScheduler(hostRedis, noticeGroups, window, signal);
      };
      const cancel = whenNoticeActive?.(launch);
      if (!whenNoticeActive) launch();
      disposers.push(async () => { disposed = true; cancel?.(); await stop?.(); });
    }
  } catch {
    console.warn("[notice] 无法读取公告定时配置，定时推送未启动。");
  }
  try {
    const config = configuredAnnouncements(new URL("../../", import.meta.url));
    const official = createOfficialAnnouncements(hostRedis, noticeGroups, config, signal, undefined, undefined, whenNoticeActive);
    Object.assign(module.commands, official.commands);
    aliases = official.aliases;
    disposers.push(official.dispose);
    const expiry = createActivityExpiryNotices(hostRedis, noticeGroups, config, signal, undefined, undefined, whenNoticeActive);
    Object.assign(module.commands, expiry.commands);
    disposers.push(expiry.dispose);
  } catch {
    console.warn("[notice] 无法读取米游社公告推送配置。");
  }
  if (!disposers.length) return module;
  return { ...module, aliases, async dispose() { await Promise.all(disposers.map((dispose) => dispose())); } };
}

export default createNoticePlugin();
