import type { NoticeRedis } from "./store.ts";
import { noticeAccounts, type NoticeDeliveryHost } from "./delivery.ts";
import { createTargetStore, selectNoticeGroups, validTargetId, type GroupList } from "./targets.ts";

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

export function createTargetCommands(getRedis: () => NoticeRedis | undefined, host?: NoticeDeliveryHost): Record<string, Handler> {
  const commands: Record<string, Handler> = {};
  const online = () => host ? [...noticeAccounts(host)].sort((a, b) => a.botId - b.botId) : [];

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
  if (host) for (const action of ["列表", "状态", "启用", "禁用", "配置", "统计"] as const) {
    commands[`#公告账号${action}`] = (argument, context) => manageAccounts(action, argument, context);
  }
  return commands;

  async function manageAccounts(action: "列表" | "状态" | "启用" | "禁用" | "配置" | "统计", argument: string, context: Context) {
    if (context?.isMaster !== true) return "仅机器人主人可管理公告账号。";
    const redis = getRedis();
    if (!redis) return "公告存储未连接。";
    const accounts = online();
    const ids = accounts.map(({ botId }) => String(botId));
    const input = argument.trim();
    if (input && action !== "配置") return `用法 #公告账号${action}`;
    if (!ids.length) return "当前没有登录的公告账号。";
    const store = createTargetStore(redis);

    try {
      if (action === "启用" || action === "禁用") {
        const changed = await store.setAccounts(ids, "enabled", action === "启用");
        return `已${action} ${changed}/${ids.length} 个在线账号的公告推送。`;
      }
      if (action === "配置" && input) {
        const [account, setting, raw, ...extra] = input.split(/\s+/u);
        if (!account || !ids.includes(account)) return "指定的公告账号未连接。";
        if (!setting || !raw || extra.length) return "用法 #公告账号配置 QQ 启用/禁用/间隔/重试 值";
        if (setting === "启用" || setting === "禁用") {
          const choice = /^(true|是|启用)$/iu.test(raw);
          if (!choice && !/^(false|否|禁用)$/iu.test(raw)) return "请填写 true/false 或 是/否。";
          await store.setAccounts([account], "enabled", setting === "启用" ? choice : !choice);
        } else if (setting === "间隔" || setting === "重试") {
          const value = /^\d+$/u.test(raw) ? Number(raw) : NaN;
          const [low, high] = setting === "间隔" ? [500, 10_000] : [0, 10];
          if (!Number.isInteger(value) || value < low || value > high) {
            return setting === "间隔" ? "推送间隔须为 500 至 10000 毫秒。" : "重试次数须为 0 至 10。";
          }
          await store.setAccounts([account], setting === "间隔" ? "pushInterval" : "retryCount", value);
        } else return "配置项可选启用、禁用、间隔或重试。";
        const saved = `公告账号 ${account} 的配置已保存。`;
        return setting === "重试" ? `${saved}重试次数保留供旧配置读取，推送由逐群回执决定。` : saved;
      }

      const global = (await store.settings()).global;
      const rows: string[] = [];
      let enabled = 0, memberships = 0, available = 0, failures = 0;
      for (const account of accounts) {
        const settings = await store.settings(String(account.botId));
        const config = settings.account!;
        if (config.enabled) enabled++;
        const groups = action === "配置" ? undefined : await account.listGroups().catch(() => {
          failures++;
          return undefined;
        });
        if (groups) {
          memberships += groups.length;
          available += selectNoticeGroups(settings, groups.map(({ id }) => id)).length;
        }
        const fields = [String(account.botId), account.adapter === "milky" ? "Milky" : "OneBot", config.enabled ? "启用" : "禁用"];
        if (action !== "配置") fields.push(groups ? `${groups.length} 个群` : "群列表不可用");
        if (action === "列表" || action === "配置") fields.push(`间隔 ${config.pushInterval ?? 2000} 毫秒`);
        if (action === "配置") fields.push(`重试 ${config.retryCount ?? 3}（旧配置）`);
        if (action === "配置" || action === "状态") fields.push(`白名单 ${config.whitelist.length} · 黑名单 ${config.blacklist.length}`);
        rows.push(fields.join(" · "));
      }
      const lines = [`公告账号${action} · ${ids.length} 个在线账号`];
      if (action === "配置" || action === "状态") lines.push(`全局白名单 ${global.whitelist.length} · 全局黑名单 ${global.blacklist.length}`);
      if (action === "统计") {
        lines.push(`启用 ${enabled} · 群数 ${memberships} · 可推送 ${available}`);
        if (failures) lines.push(`${failures} 个账号的群数未计入。`);
      }
      return [...lines, ...rows].join("\n");
    } catch {
      return "公告账号操作失败，请检查存储与账号配置。";
    }
  }

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

      if (words.length === 1 && words[0]?.toUpperCase() === "ALL") {
        if (!host || scope !== "全局") return "请明确填写目标群号。";
        const groups = await Promise.all(online().map((bot) => bot.listGroups()));
        const ids = [...new Set(groups.flatMap((entries) =>
          entries.map(({ id }) => contextId(id)).filter((id): id is string => id !== undefined)))];
        if (!ids.length) return "当前在线账号没有可核实的群。";
        const affected = await store.change(list, action === "添加" ? "add" : "remove", ids);
        return `${title}已${action} ${affected} 个在线账号所在的群。`;
      }
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
