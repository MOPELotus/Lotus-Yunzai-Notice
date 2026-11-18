import type { NoticeRedis } from "./store.ts";
import { createTargetStore, validTargetId, type GroupList } from "./targets.ts";

interface Context {
  readonly isMaster: boolean;
  readonly message_type?: "group" | "private" | "terminal";
  readonly group_id?: number;
  readonly self_id?: number;
}
type Handler = (argument: string, context: Context) => string | Promise<string>;
type Action = "添加" | "删除" | "查看";
const actions = ["添加", "删除", "查看"] as const;
const groupsPerPage = 40;

function contextId(value: number | undefined): string | undefined {
  return value && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
}

export function createTargetCommands(getRedis: () => NoticeRedis | undefined): Record<string, Handler> {
  const commands: Record<string, Handler> = {};

  for (const [kind, label] of [["whitelist", "白名单"], ["blacklist", "黑名单"]] as const) {
    for (const scope of ["全局", "账号"] as const) {
      const command = `#公告${scope}${label}`;
      const invoke: Handler = (argument, context) => manage(kind, scope, argument, context);
      commands[command] = invoke;
      for (const action of actions) {
        commands[command + action] = (argument, context) => invoke(`${action} ${argument}`, context);
      }
    }
  }
  return commands;

  async function manage(list: GroupList, scope: "全局" | "账号", argument: string, context: Context) {
    if (context?.isMaster !== true) return "仅机器人主人可管理公告目标群。";

    const words = argument.trim().split(/\s+/u);
    let account: string | undefined;
    if (scope === "账号") {
      const first = words[0];
      account = first && validTargetId(first) ? words.shift() : contextId(context.self_id);
      if (!account) return "请输入账号 QQ，或通过已连接的机器人发送指令。";
    }
    const action = words.shift() as Action | undefined;
    if (!action || !actions.includes(action)) return "请指定操作：添加、删除或查看。";

    const redis = getRedis();
    if (!redis) return "公告存储未连接。";
    const store = createTargetStore(redis);
    const title = `${scope}${list === "whitelist" ? "白名单" : "黑名单"}`;
    try {
      if (action === "查看") {
        const page = words.length === 0 ? 1 : Number(words[0]);
        if (words.length > 1 || !Number.isSafeInteger(page) || page < 1) return "请提供有效页码。";
        const settings = await store.settings(account);
        const ids = [...(settings.account ?? settings.global)[list]].sort((a, b) =>
          a.length - b.length || a.localeCompare(b));
        if (!ids.length) return `${title}当前为空。`;
        const pages = Math.ceil(ids.length / groupsPerPage);
        if (page > pages) return `${title}共有 ${pages} 页。`;
        return `${title}（${page}/${pages} 页，共 ${ids.length} 个群）\n${ids.slice((page - 1) * groupsPerPage, page * groupsPerPage).join("、")}`;
      }

      if (words.some((word) => word.toUpperCase() === "ALL")) return "请明确填写目标群号。";
      const ids = words.join(" ").split(/[\s,，、]+/u).filter(Boolean);
      if (!ids.length && context.message_type === "group") {
        const group = contextId(context.group_id);
        if (group) ids.push(group);
      }
      if (!ids.length || !ids.every(validTargetId)) return "请填写有效群号，用空格或逗号分开。";
      if (ids.length > 200) return "每次最多操作 200 个群号。";

      const affected = await store.change(list, action === "添加" ? "add" : "remove", ids, account);
      return `${title}已${action} ${affected} 个群。`;
    } catch {
      return "公告目标群操作失败，请检查存储与名单格式。";
    }
  }
}
