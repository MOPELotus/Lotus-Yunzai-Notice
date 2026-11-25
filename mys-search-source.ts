import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
import { announcementGames, postImage, readAnnouncementFeed } from "./mys-announcement-source.ts";
import { readPublicMys, type PublicMysTransport } from "./mys-public-request.ts";

export function createMysSearchSource(transport: PublicMysTransport = fetch) {
  return async (keyword: string, signal: AbortSignal) => {
    const url = new URL("https://bbs-api.miyoushe.com/post/wapi/searchPosts");
    url.search = new URLSearchParams({ gids: String(announcementGames.gs.id), size: "20", keyword }).toString();
    const alternate = new URL(url);
    alternate.hostname = "bbs-api.mihoyo.com";
    return readPublicMys({
      url, alternate, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), phaseMs: 3_500, accept: "application/json",
    }, transport, async (response) => {
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error($t("mys-search-source.text_ca09c7b48c"));
      }
      const result = await response.json() as { retcode?: unknown; data?: { posts?: unknown } } | null;
      return readAnnouncementFeed({ retcode: result?.retcode, data: { list: result?.data?.posts } }, 20, true);
    });
  };
}

const estimates = {
  gs: { keyword: $t("mys-search-source.text_f5403ae1fa"), author: "137101761" },
  sr: { keyword: $t("mys-search-source.text_09b0350e68"), author: "137101761" },
  zzz: { keyword: $t("mys-search-source.text_b649504d4e"), author: "137101761" },
  bbb: { keyword: $t("mys-search-source.text_4df06196b4"), author: "80216695" },
} as const;
export type EstimateGame = keyof typeof estimates;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createMysEstimateSource(transport: PublicMysTransport = fetch) {
  return async (game: EstimateGame, signal: AbortSignal) => {
    const url = new URL("https://bbs-api.miyoushe.com/painter/api/user_instant/search/list");
    const { keyword, author } = estimates[game];
    url.search = new URLSearchParams({
      keyword, uid: author, size: "20", offset: "0", sort_type: "2",
    }).toString();
    const alternate = new URL(url);
    alternate.hostname = "bbs-api.mihoyo.com";
    return readPublicMys({
      url, alternate, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), phaseMs: 3_500, accept: "application/json",
    }, transport, async (response) => {
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error($t("mys-search-source.text_fd2d0884c4"));
      }
      const result = record(await response.json());
      const rows = record(result.data).list;
      if (result.retcode !== 0 || !Array.isArray(rows)) throw new Error($t("mys-search-source.text_eaeb1e9610"));
      const list = rows.slice(0, 20).map(row => record(record(row).post)).filter(entry => {
        const post = record(entry.post);
        return post.uid === author && post.game_id === announcementGames[game].id;
      });
      const first = readAnnouncementFeed({ retcode: 0, data: { list } }, 20, true)[0];
      if (!first) return;
      const images = record(list.find(entry => record(entry.post).post_id === first.id)?.post).images;
      const gallery = Array.isArray(images)
        ? Array.from(new Set(images.slice(0, 18).flatMap(input => postImage(input) ?? [])))
        : [];
      return { ...first, gallery };
    });
  };
}
