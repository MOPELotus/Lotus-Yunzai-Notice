import { expect, test } from "bun:test";
import { createOfficialAnnouncements } from "./mys-announcement.ts";
import { parseAnnouncementConfig } from "./mys-announcement-config.ts";
import { createAnnouncementSource } from "./mys-announcement-source.ts";
import { publicMysFeatureNames } from "./mys-public-query.ts";

test("旧公开查询恢复三游戏活动和无井号原神入口，保持公告管理、订阅和登录分流", async () => {
  const calls: [string | null, string | null, string | null][] = [];
  const reads: [string, string][] = [];
  const groups = {
    onlineBots: () => [], listGroups: async () => [],
    sendGroup: async () => { throw new Error("公开查询不得推送"); },
    deleteMessage: async () => { throw new Error("公开查询不得撤回"); },
  };
  const source = createAnnouncementSource(async (url) => {
    const p = url.searchParams;
    calls.push([p.get("gids"), p.get("type"), p.get("page_size")]);
    return Response.json({ retcode: 0, data: { list: [{ post: {
      post_id: "21", subject: "第一条", created_at: 1790000000,
    } }, { post: { post_id: "22", subject: "第二条", created_at: 1790000001 } }] } });
  });
  const official = createOfficialAnnouncements(() => undefined, groups, parseAnnouncementConfig(), undefined,
    source, undefined, undefined, async (game, id) => {
      reads.push([game, id]);
      return { title: id, pictures: [{ type: "image", file: Uint8Array.of(1) }] };
    });
  try {
    expect(publicMysFeatureNames).toContain("米游社公告");
    expect(await official.fallback("原神公告列表")).toContain("原神公告列表");
    expect(await official.fallback("资讯")).toEqual([
      { type: "text", text: "原神资讯：21\nhttps://www.miyoushe.com/ys/article/21" },
      { type: "image", file: Uint8Array.of(1) },
    ]);
    expect(await official.fallback("#原神活动列表")).toContain("原神活动列表");
    expect(await official.fallback("#星铁活动2")).toEqual([
      { type: "text", text: "星铁活动：22\nhttps://www.miyoushe.com/sr/article/22" },
      { type: "image", file: Uint8Array.of(1) },
    ]);
    expect(await official.fallback("#绝区零活动")).toEqual([
      { type: "text", text: "绝区零活动：21\nhttps://www.miyoushe.com/zzz/article/21" },
      { type: "image", file: Uint8Array.of(1) },
    ]);
    expect(await official.fallback("#绝区零活动21")).toContain("1-20");
    for (const input of ["#公告", "#官方公告", "#星铁资讯2", "#发布公告", "#推送公告",
      "#星铁开启到期活动", "#开启活动推送", "这次活动", "活动结束"]) {
      expect(await official.fallback(input)).toBeUndefined();
    }
    expect(calls).toEqual([["2","1","5"],["2","3","20"],["2","2","5"],["6","2","20"],["8","2","20"]]);
    expect(reads).toEqual([["gs","21"],["sr","22"],["zzz","21"]]);
  } finally {
    await official.dispose();
  }
  expect(await official.fallback("#原神活动")).toBeUndefined();
});
