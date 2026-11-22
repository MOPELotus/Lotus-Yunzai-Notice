import { announcementGames, readAnnouncementFeed, type AnnouncementGame } from "./mys-announcement-source.ts";
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
        throw new Error("米游社搜索接口不可用。");
      }
      const result = await response.json() as { retcode?: unknown; data?: { posts?: unknown } } | null;
      return readAnnouncementFeed({ retcode: result?.retcode, data: { list: result?.data?.posts } }, 20, true);
    });
  };
}

const estimateKeywords: Readonly<Record<AnnouncementGame, string>> = {
  gs: "原石统计汇总",
  sr: "星琼统计汇总",
  zzz: "菲林统计汇总",
};
const estimateAuthor = "137101761";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function createMysEstimateSource(transport: PublicMysTransport = fetch) {
  return async (game: AnnouncementGame, signal: AbortSignal) => {
    const url = new URL("https://bbs-api.miyoushe.com/painter/api/user_instant/search/list");
    url.search = new URLSearchParams({
      keyword: estimateKeywords[game], uid: estimateAuthor, size: "20", offset: "0", sort_type: "2",
    }).toString();
    const alternate = new URL(url);
    alternate.hostname = "bbs-api.mihoyo.com";
    return readPublicMys({
      url, alternate, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), phaseMs: 3_500, accept: "application/json",
    }, transport, async (response) => {
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new Error("米游社资源预估接口不可用。");
      }
      const result = record(await response.json());
      const rows = record(result.data).list;
      if (result.retcode !== 0 || !Array.isArray(rows)) throw new Error("米游社资源预估接口返回无效。");
      const list = rows.slice(0, 20).map(row => record(record(row).post)).filter(entry => {
        const post = record(entry.post);
        return post.uid === estimateAuthor && post.game_id === announcementGames[game].id;
      });
      return readAnnouncementFeed({ retcode: 0, data: { list } }, 20, true)[0];
    });
  };
}
