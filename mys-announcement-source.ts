import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
import { load } from "cheerio";
import { readPublicMys, type PublicMysTransport } from "./mys-public-request.ts";

export const announcementGames = {
  bbb: { id: 1, name: $t("mys-announcement-source.text_6d3d8653d7"), slug: "bh3", aliases: [$t("mys-announcement-source.text_e3173a70bd"), $t("mys-announcement-source.text_df43f0569d")] },
  gs: { id: 2, name: $t("mys-announcement-source.text_d1597c51ed"), slug: "ys", aliases: [$t("mys-announcement-source.text_e73e38c1f6")] },
  bb: { id: 3, name: $t("mys-announcement-source.text_e5b1fba52e"), slug: "bh2", aliases: [$t("mys-announcement-source.text_b89bc676bd"), $t("mys-announcement-source.text_7b370b8094"), $t("mys-announcement-source.text_a84dd5bd1b")] },
  wd: { id: 4, name: $t("mys-announcement-source.text_a6e4fbed57"), slug: "wd", aliases: [$t("mys-announcement-source.text_4b20dcc35a")] },
  sr: { id: 6, name: $t("mys-announcement-source.text_a2927891f0"), slug: "sr", aliases: [] },
  zzz: { id: 8, name: $t("mys-announcement-source.text_b1110352c9"), slug: "zzz", aliases: [] },
} as const;

export type AnnouncementGame = keyof typeof announcementGames;
export const announcementGameKeys = Object.keys(announcementGames) as AnnouncementGame[];
export type AnnouncementPushKind = "notice" | "info";
export type AnnouncementKind = AnnouncementPushKind | "activity";
export const announcementLabels = { notice: $t("mys-announcement-source.text_069c0ecbf8"), info: $t("mys-announcement-source.text_71d9a93075"), activity: $t("mys-announcement-source.text_9e9bead814") } as const;
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
  if (response.retcode !== 0 || !Array.isArray(list)) throw new Error($t("mys-announcement-source.text_212716b252"));
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
        throw new Error($t("mys-announcement-source.text_e23acb528a"));
      }
      return readAnnouncementFeed(await response.json(), limit, limit !== 10);
    });
  };
}
