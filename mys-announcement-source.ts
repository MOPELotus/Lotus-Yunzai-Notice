export const announcementGames = {
  gs: { id: 2, name: "原神", slug: "ys" },
  sr: { id: 6, name: "星铁", slug: "sr" },
  zzz: { id: 8, name: "绝区零", slug: "zzz" },
} as const;

export type AnnouncementGame = keyof typeof announcementGames;

export interface OfficialAnnouncement {
  readonly id: string;
  readonly created: number;
  readonly title: string;
  readonly summary?: string;
  readonly image?: string;
}

function mapping(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") return;
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ").trim().slice(0, limit) || undefined;
}

const imageHosts = new Set(["upload-bbs.miyoushe.com", "upload-bbs.mihoyo.com", "bbs-static.miyoushe.com", "bbs-static.mihoyo.com"]);

function image(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return;
  const url = URL.parse(value);
  if (url?.protocol === "https:" && !url.username && !url.password && !url.port && imageHosts.has(url.hostname)) return url.href;
}

export function readAnnouncementFeed(value: unknown): readonly OfficialAnnouncement[] {
  const response = mapping(value);
  const list = mapping(response.data).list;
  if (response.retcode !== 0 || !Array.isArray(list)) throw new Error("米游社公告接口返回无效。");
  const posts = new Map<string, OfficialAnnouncement>();
  for (const row of list.slice(0, 10)) {
    const entry = mapping(row);
    const post = mapping(entry.post);
    const id = post.post_id;
    const created = post.created_at;
    const title = text(post.subject, 200);
    if (typeof id !== "string" || !/^[1-9]\d{0,19}$/u.test(id) || typeof created !== "number" ||
        !Number.isSafeInteger(created) || created <= 0 || !title || post.is_deleted === true || post.is_deleted === 1) continue;
    const preview = Array.isArray(entry.image_list) ? entry.image_list[0] : undefined;
    posts.set(id, {
      id, created, title, summary: text(post.summary, 300) ?? text(entry.text_summary, 300),
      image: image(post.cover) ?? image(mapping(entry.cover).url) ?? image(mapping(preview).url),
    });
  }
  return [...posts.values()].sort((left, right) => left.created - right.created || left.id.length - right.id.length || left.id.localeCompare(right.id));
}

export function createAnnouncementSource(transport: typeof fetch = fetch) {
  return async (game: AnnouncementGame, signal: AbortSignal): Promise<readonly OfficialAnnouncement[]> => {
    const url = new URL("https://bbs-api-static.miyoushe.com/painter/wapi/getNewsList");
    url.search = new URLSearchParams({ gids: String(announcementGames[game].id), page_size: "10", type: "1" }).toString();
    const response = await transport(url, {
      method: "GET", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
      headers: { Accept: "application/json", Referer: "https://www.miyoushe.com/", "User-Agent": "Mozilla/5.0" },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error("米游社公告接口不可用。");
    }
    return readAnnouncementFeed(await response.json());
  };
}
