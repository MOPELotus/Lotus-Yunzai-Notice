import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
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
    if (context?.isMaster !== true) return $t("target-commands.text_915de97163");
    const redis = getRedis();
    if (!redis) return $t("target-commands.text_9579dede53");
    const accounts = online();
    const ids = accounts.map(({ botId }) => String(botId));
    const input = argument.trim();
    if (input && action !== "配置") return $t("target-commands.text_19095cd9f3", { "action": action });
    if (!ids.length) return $t("target-commands.text_a0ea4a353a");
    const store = createTargetStore(redis);

    try {
      if (action === "启用" || action === "禁用") {
        const changed = await store.setAccounts(ids, "enabled", action === "启用");
        return $t("target-commands.text_4f7084b2e7", { "action": action, "changed": changed, "length": ids.length });
      }
      if (action === "配置" && input) {
        const [account, setting, raw, ...extra] = input.split(/\s+/u);
        if (!account || !ids.includes(account)) return $t("target-commands.text_e2ee5c6801");
        if (!setting || !raw || extra.length) return $t("target-commands.text_9b199b04a8");
        if (setting === "启用" || setting === "禁用") {
          const choice = /^(true|是|启用)$/iu.test(raw);
          if (!choice && !/^(false|否|禁用)$/iu.test(raw)) return $t("target-commands.text_7b0380bcab");
          await store.setAccounts([account], "enabled", setting === "启用" ? choice : !choice);
        } else if (setting === "间隔" || setting === "重试") {
          const value = /^\d+$/u.test(raw) ? Number(raw) : NaN;
          const [low, high] = setting === "间隔" ? [500, 10_000] : [0, 10];
          if (!Number.isInteger(value) || value < low || value > high) {
            return setting === "间隔" ? $t("target-commands.text_4eda866eb1") : $t("target-commands.text_7b7ff0558a");
          }
          await store.setAccounts([account], setting === "间隔" ? "pushInterval" : "retryCount", value);
        } else return $t("target-commands.text_c30c5a839c");
        const saved = $t("target-commands.text_71b2703fe8", { "account": account });
        return setting === "重试" ? $t("target-commands.text_5d193810f3", { "saved": saved }) : saved;
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
        const pushable = groups && action === "统计" ? selectNoticeGroups(settings, groups.map(({ id }) => id)).length : undefined;
        if (groups) {
          memberships += groups.length;
          available += pushable ?? 0;
        }
        const fields = [String(account.botId), account.adapter === "milky" ? "Milky" : "OneBot", config.enabled ? $t("target-commands.text_f4f0ead111") : $t("target-commands.text_7df5c456c7")];
        if (action !== "配置") fields.push(groups ? $t("target-commands.text_b0149e6b27", { "length": groups.length }) : $t("target-commands.text_72a56e2569"));
        if (pushable !== undefined) fields.push($t("target-commands.text_d87997a2cf", { "pushable": pushable }));
        if (action === "列表" || action === "配置") fields.push($t("target-commands.text_9a995fe04d", { "value1": config.pushInterval ?? 2000 }));
        if (action === "配置") fields.push($t("target-commands.text_5d710ee899", { "value1": config.retryCount ?? 3 }));
        if (action === "配置" || action === "状态") fields.push($t("target-commands.text_15d1928903", { "length": config.whitelist.length, "value2": config.blacklist.length }));
        rows.push(fields.join(" · "));
      }
      const lines = [$t("target-commands.text_6f945a35e6", { "action": action, "length": ids.length })];
      if (action === "配置" || action === "状态") lines.push($t("target-commands.text_6ce3d07fc5", { "length": global.whitelist.length, "value2": global.blacklist.length }));
      if (action === "统计") {
        lines.push($t("target-commands.text_b1144c60f3", { "enabled": enabled, "memberships": memberships, "available": available }));
        if (failures) lines.push($t("target-commands.text_99daac5d8c", { "failures": failures }));
      }
      return [...lines, ...rows].join("\n");
    } catch {
      return $t("target-commands.text_23bb57de0f");
    }
  }

  async function manage(list: GroupList, scope: "全局" | "账号", argument: string, context: Context) {
    if (context?.isMaster !== true) return $t("target-commands.text_0cd46e0310");

    const words = argument.trim().split(/\s+/u);
    let account: string | undefined;
    if (scope === "账号") {
      const first = words[0];
      account = first && validTargetId(first) ? words.shift() : contextId(context.self_id);
      if (!account) return $t("target-commands.text_5fbe79c153");
    }
    const action = words.shift() as Action | undefined;
    if (!action || !actions.includes(action)) return $t("target-commands.text_41ae31f021");

    const redis = getRedis();
    if (!redis) return $t("target-commands.text_9579dede53");
    const store = createTargetStore(redis);
    const title = `${scope}${list === "whitelist" ? $t("target-commands.text_27e2d9e2d9") : $t("target-commands.text_174ec5a4ab")}`;
    try {
      if (action === "查看") {
        const page = words.length === 0 ? 1 : Number(words[0]);
        if (words.length > 1 || !Number.isSafeInteger(page) || page < 1) return $t("target-commands.text_93cd7d8402");
        const settings = await store.settings(account);
        const ids = [...(settings.account ?? settings.global)[list]].sort((a, b) =>
          a.length - b.length || a.localeCompare(b));
        if (!ids.length) return $t("target-commands.text_55c65780b8", { "title": title });
        const pages = Math.ceil(ids.length / groupsPerPage);
        if (page > pages) return $t("target-commands.text_5cab27540e", { "title": title, "pages": pages });
        return $t("target-commands.text_40c70ab82a", { "title": title, "page": page, "pages": pages, "length": ids.length, "value5": ids.slice((page - 1) * groupsPerPage, page * groupsPerPage).join("、") });
      }

      if (words.length === 1 && words[0]?.toUpperCase() === "ALL") {
        if (!host || scope !== "全局") return $t("target-commands.text_1f673f53fe");
        const groups = await Promise.all(online().map((bot) => bot.listGroups()));
        const ids = [...new Set(groups.flatMap((entries) =>
          entries.map(({ id }) => contextId(id)).filter((id): id is string => id !== undefined)))];
        if (!ids.length) return $t("target-commands.text_860101a471");
        const affected = await store.change(list, action === "添加" ? "add" : "remove", ids);
        return $t("target-commands.text_d4363e1d93", { "title": title, "action": action, "affected": affected });
      }
      const ids = words.join(" ").split(/[\s,，、]+/u).filter(Boolean);
      if (!ids.length && context.message_type === "group") {
        const group = contextId(context.group_id);
        if (group) ids.push(group);
      }
      if (!ids.length || !ids.every(validTargetId)) return $t("target-commands.text_932fbd78e8");
      if (ids.length > 200) return $t("target-commands.text_dfe9ccba64");

      const affected = await store.change(list, action === "添加" ? "add" : "remove", ids, account);
      return $t("target-commands.text_9a53ab89f7", { "title": title, "action": action, "affected": affected });
    } catch {
      return $t("target-commands.text_a339af3054");
    }
  }
}
