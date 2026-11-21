import type { AnnouncementGame, AnnouncementKind } from "./mys-announcement-source.ts";

export const publicMysFeatureNames = ["[notice] 米游社公开查询", "米游社公告"] as const;

const games = { "原神": "gs", "星铁": "sr", "绝区零": "zzz", "官方": "gs" } as const;
const kinds = { "公告": "notice", "资讯": "info", "活动": "activity" } as const;

export function parsePublicAnnouncementQuery(input: string): {
  game: AnnouncementGame; kind: AnnouncementKind; list: boolean; page?: number; argument: string;
} | undefined {
  const match = /^(#*)(官方|原神|星铁|绝区零)?(公告|资讯|活动)(列表|\d+)?(?:\s+(\S[^\r\n]*))?$/u.exec(input.trim());
  if (!match) return;
  const [, hashes, prefix, label, selection, argument = ""] = match;
  const kind = kinds[label as keyof typeof kinds];
  // The direct command registry already owns explicit announcements and information, including #公告.
  if (hashes && kind !== "activity") return;
  const page = selection && selection !== "列表" ? Number(selection) : undefined;
  return { game: prefix ? games[prefix as keyof typeof games] : "gs", kind, list: selection === "列表", page, argument };
}
