import { expect, test } from "bun:test";
import { createOfficialAnnouncements } from "./mys-announcement.ts";
import { parseAnnouncementConfig } from "./mys-announcement-config.ts";
import { createAnnouncementSource } from "./mys-announcement-source.ts";
import { parseMysArticleLink, parseMysSearch, publicMysFeatureNames } from "./mys-public-query.ts";
import { readOfficialArticle } from "./mys-article-source.ts";
import { createMysSearchSource } from "./mys-search-source.ts";

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

test("旧米游社文章直链只取确切来源与文章 ID", () => {
  expect(parseMysArticleLink("看看 2026 年这篇（https://bbs.mihoyo.com/ys/article/79329515?share=1）"))
    .toEqual({ game: "gs", id: "79329515" });
  expect(parseMysArticleLink("www.miyoushe.com/sr/article/79674024")).toEqual({ game: "sr", id: "79674024" });
  expect(parseMysArticleLink("正文 https://www.miyoushe.com/zzz/article/79678537#anchor。"))
    .toEqual({ game: "zzz", id: "79678537" });
  for (const input of ["https://www.miyoushe.com.example.org/ys/article/79329515",
    "https://evil.example/?url=https://www.miyoushe.com/ys/article/79329515",
    "https://other@www.miyoushe.com/ys/article/79329515", "https://www.miyoushe.com:81/ys/article/79329515",
    "https://www.miyoushe.com/bh3/article/79329515", "https://www.miyoushe.com/ys/article/79329515extra",
    "evil-miyoushe.com/ys/article/79329515"]) expect(parseMysArticleLink(input)).toBeUndefined();
  const article = { retcode: 0, data: { post: { post: {
    post_id: "79329515", game_id: 2, subject: "原神活动",
    content: "<p>活动正文</p>", created_at: 1_790_000_000,
  } } } };
  expect(readOfficialArticle(article, "79329515", "gs")?.title).toBe("原神活动");
  expect(readOfficialArticle(article, "79329515", "sr")).toBeUndefined();
});

test("米游社搜索维持原排序和旧结果偏移，登录、签到与面板由原功能处理", async () => {
  const calls: Array<[string, string | null, string | null, string | null, RequestInit["credentials"]]> = [];
  const details: [string, string][] = [];
  const groups = {
    onlineBots: () => [], listGroups: async () => [],
    sendGroup: async () => { throw new Error("公开查询不得推送"); },
    deleteMessage: async () => { throw new Error("公开查询不得撤回"); },
  };
  const search = createMysSearchSource(async (url, init) => {
    calls.push([url.hostname, url.searchParams.get("gids"), url.searchParams.get("size"), url.searchParams.get("keyword"), init.credentials]);
    if (url.hostname === "bbs-api.miyoushe.com") return new Response(null, { status: 503 });
    const ids = url.searchParams.get("keyword") === "空结果" ? [] : ["765", "432", "123"];
    return Response.json({ retcode: 0, data: { posts: ids.map((id) => ({
      post: { post_id: id, created_at: 12_345, subject: "标题 " + id },
    })) } });
  });
  const official = createOfficialAnnouncements(() => undefined, groups, parseAnnouncementConfig(),
    undefined, undefined, undefined, undefined,
    async (game, id) => {
      details.push([game, id]);
      if (id === "432") return { title: "正文", pictures: [{ type: "image", file: Uint8Array.of(1) }] };
    }, undefined, search);
  try {
    expect(await official.fallback("#米游社 七七2")).toBe("标题 123\nhttps://www.miyoushe.com/ys/article/123");
    expect(await official.fallback("#mys 七七 第2条")).toEqual([
      { type: "text", text: "正文\nhttps://www.miyoushe.com/ys/article/432" },
      { type: "image", file: Uint8Array.of(1) },
    ]);
    expect(await official.fallback("#米游社 空结果")).toContain("没有搜到");
    expect(await official.fallback("#米游社 七七 第4条")).toContain("仅有 3 条");
    expect(await official.fallback("#米游社")).toContain("请输入关键词");
    expect(await official.fallback("看这篇：https://bbs.mihoyo.com/ys/article/432")).toEqual([
      { type: "text", text: "正文\nhttps://www.miyoushe.com/ys/article/432" },
      { type: "image", file: Uint8Array.of(1) },
    ]);
    expect(await official.fallback("https://www.miyoushe.com/sr/article/765"))
      .toBe("米游社文章暂无法展开。\nhttps://www.miyoushe.com/sr/article/765");
    expect(parseMysSearch("#米游社 7.2")).toEqual({ keyword: "7.2", offset: 0 });
    for (const input of ["#米游社签到", "#mys星铁更新面板123456789", "#mys cookie secret",
      "#mys签到 https://www.miyoushe.com/ys/article/432", "原神公告 待会看看"]) {
      expect(await official.fallback(input)).toBeUndefined();
    }
    expect(calls).toEqual(["七七", "七七", "空结果", "七七"].flatMap((keyword) =>
      ["bbs-api.miyoushe.com", "bbs-api.mihoyo.com"].map((hostname): (typeof calls)[number] => [hostname, "2", "20", keyword, "omit"])));
    expect(details).toEqual([["gs", "123"], ["gs", "432"], ["gs", "432"], ["sr", "765"]]);
  } finally {
    await official.dispose();
  }
});
