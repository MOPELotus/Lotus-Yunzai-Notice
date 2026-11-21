import { announcementGames, readAnnouncementFeed } from "./mys-announcement-source.ts";
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
