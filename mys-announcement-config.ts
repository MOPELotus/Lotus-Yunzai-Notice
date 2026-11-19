import { readFileSync } from "node:fs";
import { announcementGames, type AnnouncementGame } from "./mys-announcement-source.ts";

export interface AnnouncementTarget {
  readonly botId: number;
  readonly groupId: number;
}

export interface AnnouncementConfig {
  readonly cron: string;
  readonly maxNum: number;
  readonly ban: Readonly<Partial<Record<AnnouncementGame, RegExp>>>;
  readonly targets: Readonly<Record<AnnouncementGame, readonly AnnouncementTarget[]>>;
}

const defaultBan = {
  gs: "冒险助力礼包|纪行|预下载|脚本外挂|集中反馈|已开奖|云·原神|魔神任务|传说任务|线下赛|晋级赛|战绩更新|海选赛|邀请赛|积分赛|战绩工具|交流平台|首日赛|线上赛|社区内容|个人专访|全民赛|决赛|总决赛|半决赛|淘汰赛|作品展示|同人|大别野",
  sr: "预下载|脚本外挂|集中反馈|已开奖|问题说明|意见反馈|账号封禁|工具|直播预告|获奖名单|大别野",
  zzz: "作品展示|已开奖|大别野",
};

export function numberId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
}

function mapping(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("米游社推送配置须为 YAML 映射。");
  return value as Record<string, unknown>;
}

export function parseAnnouncementConfig(yaml = "{}"): AnnouncementConfig {
  const config = mapping(Bun.YAML.parse(yaml));
  const cron = config.pushTime ?? "0 0/5 * * * ?";
  const maxNum = config.maxNum ?? 1;
  if (typeof cron !== "string" || typeof maxNum !== "number" || !Number.isSafeInteger(maxNum) || maxNum < 0) {
    throw new Error("米游社推送定时或条数配置无效。");
  }

  const words = mapping(config.banWord);
  const ban: Partial<Record<AnnouncementGame, RegExp>> = {};
  const targets: Record<AnnouncementGame, AnnouncementTarget[]> = { gs: [], sr: [], zzz: [] };
  for (const game of Object.keys(announcementGames) as AnnouncementGame[]) {
    const pattern = words[game] ?? defaultBan[game];
    if (typeof pattern === "string" && pattern) ban[game] = new RegExp(pattern, "u");
    for (const [bot, groups] of Object.entries(mapping(config[`${game}announceGroup`]))) {
      const botId = numberId(bot);
      if (!botId || !Array.isArray(groups)) throw new Error("米游社推送目标格式无效。");
      for (const groupId of new Set(groups.map(numberId))) {
        if (!groupId) throw new Error("米游社推送群号无效。");
        targets[game].push({ botId, groupId });
      }
    }
  }
  return { cron, maxNum, ban, targets };
}

export function configuredAnnouncements(root: URL): AnnouncementConfig {
  for (const path of ["config/mys.pushNews.yaml", "config/config/mys.pushNews.yaml", "plugins/genshin/config/mys.pushNews.yaml"]) {
    try {
      return parseAnnouncementConfig(readFileSync(new URL(path, root), "utf8"));
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return parseAnnouncementConfig();
}
