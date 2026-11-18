import { createNoticeStore, type Notice, type NoticeRedis } from "./store.ts";

interface CommandContext {
  readonly isMaster: boolean;
  readonly user_id?: number;
}

type Handler = (argument: string, context: CommandContext) => string | Promise<string>;
type Store = ReturnType<typeof createNoticeStore>;

const pageSize = 5;
const maxContent = 2_000;
const memberHelp = [
  "#公告 查看当前公告",
  "#历史公告 [编号] 查看历史公告",
  "#全部历史公告 [页码] 分页查看历史",
].join("\n");
const ownerHelp = [
  "#发布公告 <内容>",
  "#编辑公告 <内容>",
  "#撤回公告",
].join("\n");

function format(item: Notice, title: string): string {
  return `【${title}】 ${item.id}\n${item.timestamp}\n${item.content}`;
}

function owner(handler: Handler): Handler {
  return (argument, context) => context?.isMaster === true ? handler(argument, context) : "仅机器人主人可管理公告。";
}

function contentError(content: string): string | undefined {
  if (!content.trim()) return "请输入公告内容。";
  if ([...content].length > maxContent) return `公告内容最多 ${maxContent} 个字符。`;
}

export function createNoticePlugin(
  getRedis: () => NoticeRedis | undefined = () => (globalThis as { redis?: NoticeRedis }).redis,
) {
  function withStore(handler: (store: Store) => Promise<string>): Promise<string> | string {
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
            return format({ ...item, content: preview }, "公告");
          }),
          "发送 #历史公告 <编号> 查看全文。",
        ].join("\n\n");
      });
    },

    "#公告帮助": (_argument: string, context: CommandContext) =>
      context?.isMaster === true ? `${memberHelp}\n${ownerHelp}` : memberHelp,

    "#发布公告": owner((content, context) => {
      const creator = context.user_id;
      if (!creator || !Number.isSafeInteger(creator) || creator < 1) return "无法确认发布者身份。";
      return contentError(content) ?? withStore(async (store) => {
        const id = await store.publish(content, String(creator));
        return id ? `公告已发布，编号 ${id}。发送 #公告 查看。` : "公告发布失败。";
      });
    }),

    "#编辑公告": owner((content) => contentError(content) ?? withStore(async (store) =>
      await store.edit(content) ? "公告已更新。" : "当前没有可编辑的公告。")),

    "#撤回公告": owner(() => withStore(async (store) =>
      await store.recall() ? "当前公告已撤回。" : "当前没有可撤回的公告。")),
  } satisfies Record<string, Handler>;

  return { commands };
}

export default createNoticePlugin();
