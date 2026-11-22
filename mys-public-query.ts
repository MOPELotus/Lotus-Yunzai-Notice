import type { AnnouncementGame, AnnouncementKind } from "./mys-announcement-source.ts";

export const publicMysFeatureNames = ["[notice] 米游社公开查询", "米游社公告"] as const;

const games = { "原神": "gs", "星铁": "sr", "绝区零": "zzz", "官方": "gs" } as const;
const kinds = { "公告": "notice", "资讯": "info", "活动": "activity" } as const;

export function parseMysEstimate(input: string): AnnouncementGame | undefined {
  const match = /^#?(原神|原石|星铁|星琼|绝区零|zzz|菲林)?(?:预估|盘点)$/u.exec(input.trim());
  if (!match) return;
  const game = match[1];
  if (game === "星铁" || game === "星琼") return "sr";
  if (game === "绝区零" || game === "zzz" || game === "菲林") return "zzz";
  return "gs";
}

export function parsePublicAnnouncementQuery(input: string): {
  game: AnnouncementGame; kind: AnnouncementKind; list: boolean; page?: number; argument: string;
} | undefined {
  const match = /^(#*)(官方|原神|星铁|绝区零)?(公告|资讯|活动)(列表|\d+)?(?:\s+(\d+))?$/u.exec(input.trim());
  if (!match) return;
  const [, hashes, prefix, label, selection, argument = ""] = match;
  const kind = kinds[label as keyof typeof kinds];
  // The direct command registry already owns explicit announcements and information, including #公告.
  if (hashes && kind !== "activity") return;
  const page = selection && selection !== "列表" ? Number(selection) : undefined;
  return { game: prefix ? games[prefix as keyof typeof games] : "gs", kind, list: selection === "列表", page, argument };
}

const articleHosts = new Set(["www.miyoushe.com", "miyoushe.com", "bbs.miyoushe.com", "bbs.mihoyo.com"]);
const articleGames = { ys: "gs", sr: "sr", zzz: "zzz" } as const;
const links = /https?:\/\/[^\s<>"'，。；！？、）】》]+|(?<![A-Za-z0-9._/@:=?&%\-])(?:www\.miyoushe\.com|miyoushe\.com|bbs\.miyoushe\.com|bbs\.mihoyo\.com)\/[^\s<>"'，。；！？、）】》]+/giu;

export function parseMysArticleLink(message: string): { game: AnnouncementGame; id: string } | undefined {
  for (const [match] of message.matchAll(links)) {
    const link = match.replace(/[),.!?;:]+$/u, "");
    if (link.length > 2_048) continue;
    const url = URL.parse(/^https?:\/\//iu.test(link) ? link : `https://${link}`);
    if (!url || !articleHosts.has(url.hostname) || url.username || url.password || url.port) continue;
    const path = /^\/(ys|sr|zzz)\/article\/([1-9]\d{0,19})\/?$/u.exec(url.pathname);
    if (path?.[2]) return { game: articleGames[path[1] as keyof typeof articleGames], id: path[2] };
  }
}

const searchPrefix = /^#(?:米游社|mys)/iu;
const privateCommand = /签到|^(?:原神|星铁|绝区零)?\s*(?:绑定|登录|扫码|刷新cookie|cookie|(?:全部)?更新(?:全部)?面板|(?:全部)?面板更新|获取游戏角色详情)/iu;
export function isPrivateMysCommand(message: string) {
  const input = message.trim();
  const prefix = searchPrefix.exec(input);
  return prefix !== null && privateCommand.test(input.slice(prefix[0].length).trim());
}

const searchUsage = "请输入关键词，如 #米游社 七七。可追加「第2条」选择搜索结果。";

export function parseMysSearch(message: string): { keyword: string; offset: number } | { error: string } | undefined {
  const input = message.trim();
  const prefix = searchPrefix.exec(input);
  if (!prefix || isPrivateMysCommand(input)) return;
  const body = input.slice(prefix[0].length).trim();
  const select = /^(.*?)\s*第\s*(\d{1,2})\s*条$/u.exec(body);
  // The old single trailing digit was a zero-based result offset. A version such as 7.2 is a keyword.
  const legacy = !select && /^(.*[^\d.])(\d)$/u.exec(body);
  const keyword = (select?.[1] ?? (legacy ? legacy[1] : body))?.trim();
  const offset = select ? Number(select[2]) - 1 : legacy ? Number(legacy[2]) : 0;
  if (!keyword || keyword.length > 120 || /[\p{Cc}\p{Cf}]/u.test(keyword) || offset < 0 || offset >= 20) {
    return { error: searchUsage };
  }
  return { keyword, offset };
}
