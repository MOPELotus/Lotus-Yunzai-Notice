import { load } from "cheerio";
import { readPublicMys, type PublicMysTransport } from "./mys-public-request.ts";

export const announcementGames = {
  bbb: { id: 1, name: "崩坏3", slug: "bh3", aliases: ["崩坏三", "崩三"] },
  gs: { id: 2, name: "原神", slug: "ys", aliases: ["官方"] },
  bb: { id: 3, name: "崩坏学园2", slug: "bh2", aliases: ["崩坏学园二", "崩坏二", "崩二"] },
  wd: { id: 4, name: "未定事件簿", slug: "wd", aliases: ["未定"] },
  sr: { id: 6, name: "星铁", slug: "sr", aliases: [] },
  zzz: { id: 8, name: "绝区零", slug: "zzz", aliases: [] },
} as const;

export type AnnouncementGame = keyof typeof announcementGames;
export const announcementGameKeys = Object.keys(announcementGames) as AnnouncementGame[];
export type AnnouncementPushKind = "notice" | "info";
export type AnnouncementKind = AnnouncementPushKind | "activity";
export const announcementLabels = { notice: "公告", info: "资讯", activity: "活动" } as const;
const sourceChannel = { notice: "1", activity: "2", info: "3" } as const;

export function announcementArticleLink(game: AnnouncementGame, id: string) {
  return `https://www.miyoushe.com/${announcementGames[game].slug}/article/${id}`;
}

export interface OfficialAnnouncement {
  readonly id: string;
  readonly created: number;
  readonly title: string;
  readonly summary?: string;
  readonly image?: string;
  readonly listPreview?: { readonly text?: string; readonly image?: string };
}

function mapping(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return;
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ").trim().slice(0, limit) || undefined;
}

const imageHosts = new Set([
  "upload-bbs.miyoushe.com", "upload-bbs.mihoyo.com", "bbs-static.miyoushe.com", "bbs-static.mihoyo.com",
  "img-static.mihoyo.com", "img-static.miyoushe.com",
]);

export function postImage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  const url = URL.parse(value);
  if (url?.protocol === "https:" && !url.username && !url.password && !url.port && imageHosts.has(url.hostname)) return url.href;
}

function previewText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim() || value.trimStart().startsWith("{")) return;
  const $ = load(value.slice(0, 16_000), { scriptingEnabled: false }, false);
  $("script,style,template,iframe,object,svg").remove();
  $("br").replaceWith(" ");
  return text($.root().text().replace(/\s+/gu, " "), 300);
}

export function readAnnouncementFeed(value: unknown, limit = 10, sourceOrder = false): readonly OfficialAnnouncement[] {
  const response = mapping(value);
  const list = mapping(response.data).list;
  if (response.retcode !== 0 || !Array.isArray(list)) throw new Error("米游社公告接口返回无效。");
  const posts = new Map<string, OfficialAnnouncement>();
  for (const row of list.slice(0, limit)) {
    const entry = mapping(row);
    const post = mapping(entry.post);
    const id = post.post_id;
    const created = post.created_at;
    const title = text(post.subject, 200);
    if (typeof id !== "string" || !/^[1-9]\d{0,19}$/u.test(id) || typeof created !== "number" ||
        !Number.isSafeInteger(created) || created <= 0 || created > 253402300799 || !title || post.is_deleted === true || post.is_deleted === 1) continue;
    const preview = Array.isArray(entry.image_list) ? entry.image_list[0] : undefined;
    const summary = text(post.summary, 300) ?? text(entry.text_summary, 300);
    const image = postImage(post.cover) ?? postImage(mapping(entry.cover).url) ?? postImage(mapping(preview).url);
    const listPreview = limit === 5 ? {
      text: previewText(post.content) ?? summary,
      image: postImage(Array.isArray(post.images) ? post.images[0] : undefined) ?? image,
    } : undefined;
    posts.set(id, { id, created, title, summary, image, ...(listPreview && { listPreview }) });
  }
  return sourceOrder ? [...posts.values()] : [...posts.values()].sort((left, right) => left.created - right.created || left.id.length - right.id.length || left.id.localeCompare(right.id));
}

export function createAnnouncementSource(transport: PublicMysTransport = fetch) {
  return async (game: AnnouncementGame, signal: AbortSignal, kind: AnnouncementKind = "notice", limit: 5 | 10 | 20 = 10): Promise<readonly OfficialAnnouncement[]> => {
    const url = new URL("https://bbs-api-static.miyoushe.com/painter/wapi/getNewsList");
    url.search = new URLSearchParams({ gids: String(announcementGames[game].id), page_size: String(limit), type: sourceChannel[kind] }).toString();
    const alternate = new URL(url.href);
    alternate.hostname = "bbs-api.mihoyo.com";
    return readPublicMys({
      url, alternate, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), phaseMs: 4_000, accept: "application/json",
    }, transport, async (response) => {
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("米游社公告接口不可用。");
      }
      return readAnnouncementFeed(await response.json(), limit, limit !== 10);
    });
  };
}
