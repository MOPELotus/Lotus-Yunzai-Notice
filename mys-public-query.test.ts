import { expect, test } from "bun:test";
import { CommandRegistry } from "../../lib/commands.ts";
import { normalizeGameCommand } from "../../lib/command-prefix.ts";
import type { MessageEvent } from "../../lib/messages.ts";
import { createModule, createNoticePlugin } from "./index.ts";
import { createOfficialAnnouncements } from "./mys-announcement.ts";
import { parseAnnouncementConfig } from "./mys-announcement-config.ts";
import { createAnnouncementSource } from "./mys-announcement-source.ts";
import { parseMysArticleLink, parseMysSearch, publicMysFeatureNames } from "./mys-public-query.ts";
import { readOfficialArticle } from "./mys-article-source.ts";
import { createMysEstimateSource, createMysSearchSource } from "./mys-search-source.ts";
import type { NoticeRedis } from "./store.ts";

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

test("资源预估按原作者和官方顺序查询三游戏，跳过错作者和错区帖子", async () => {
  const requests: string[] = [];
  const host = {
    onlineBots: () => [], listGroups: async () => [],
    sendGroup: async () => { throw new Error("公开查询不得推送"); },
    deleteMessage: async () => { throw new Error("公开查询不得撤回"); },
  };
  const estimate = createMysEstimateSource(async (url, init) => {
    expect(url.pathname).toBe("/painter/api/user_instant/search/list");
    expect(init.credentials).toBe("omit");
    expect(new Headers(init.headers).has("Cookie")).toBe(false);
    const keyword = url.searchParams.get("keyword")!;
    requests.push(keyword);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      keyword, uid: "137101761", size: "20", offset: "0", sort_type: "2",
    });
    const game = keyword.startsWith("星") ? 6 : keyword.startsWith("菲") ? 8 : 2;
    const post = (post_id: string, game_id = game, uid = "137101761", created_at = 12_345) => ({
      post: { post: { post_id, game_id, uid, created_at, subject: keyword + post_id } },
    });
    return Response.json({ retcode: 0, data: { list: [
      post("23", game, "999"), post("24", 1), post("20"), post("21", game, "137101761", 20_000),
    ] } });
  });
  const official = createOfficialAnnouncements(() => undefined, host, parseAnnouncementConfig(), undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, estimate);
  try {
    expect(await official.fallback("#原石预估")).toBe("原石统计汇总20\nhttps://www.miyoushe.com/ys/article/20");
    expect(await official.fallback("盘点")).toBe("原石统计汇总20\nhttps://www.miyoushe.com/ys/article/20");
    expect(await official.fallback("#星铁盘点")).toBe("星琼统计汇总20\nhttps://www.miyoushe.com/sr/article/20");
    expect(await official.fallback("#星琼盘点")).toBe("星琼统计汇总20\nhttps://www.miyoushe.com/sr/article/20");
    expect(await official.fallback("#菲林预估")).toBe("菲林统计汇总20\nhttps://www.miyoushe.com/zzz/article/20");
    expect(await official.fallback("zzz预估")).toBe("菲林统计汇总20\nhttps://www.miyoushe.com/zzz/article/20");
    for (const input of ["#水晶估算", "#崩坏三预估", "#原石统计", "#原石预估2"]) {
      expect(await official.fallback(input)).toBeUndefined();
    }
    expect(requests).toEqual(["原石统计汇总", "原石统计汇总", "星琼统计汇总", "星琼统计汇总", "菲林统计汇总", "菲林统计汇总"]);
  } finally {
    await official.dispose();
  }
});

test("星铁旧预估转发同一作者的原图，盘点仍保留正文链接", async () => {
  const first = "https://upload-bbs.miyoushe.com/first.png";
  const second = "https://upload-bbs.miyoushe.com/second.png";
  const missing = "https://upload-bbs.miyoushe.com/missing.png";
  const estimate = createMysEstimateSource(async () => Response.json({ retcode: 0, data: { list: [
    { post: { post: { post_id: "42", game_id: 6, uid: "137101761", created_at: 1,
      subject: "星琼预估", images: [first, "https://invalid.example/image.png", second, first, missing] } } },
  ] } }));
  const requested: string[] = [];
  const firstBytes = Buffer.from("first");
  const secondBytes = Buffer.from("second");
  const official = createOfficialAnnouncements(() => undefined, {} as Parameters<typeof createOfficialAnnouncements>[1],
    parseAnnouncementConfig(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, estimate,
    async url => {
      requested.push(url);
      return url === first ? firstBytes : url === second ? secondBytes : undefined;
    });
  try {
    const heading = "星琼预估\nhttps://www.miyoushe.com/sr/article/42";
    expect(await official.fallback("#星铁预估")).toEqual({
      type: "forward", senderName: "星铁星琼预估", batchSize: 3, nodes: [
        heading, { type: "image", file: firstBytes }, { type: "image", file: secondBytes },
        "部分原图暂不可用，可通过链接查看完整原文。",
      ],
    });
    expect(await official.fallback("#星铁盘点")).toBe(heading);
    expect(requested).toEqual([first, second, missing]);
  } finally {
    await official.dispose();
  }
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

test("旧多井号、前导零与列表尾号经宿主派发沿用同游戏原资讯查询", async () => {
  const groups = {
    onlineBots: () => [], listGroups: async () => [],
    sendGroup: async () => { throw new Error("公开查询不得推送"); },
    deleteMessage: async () => { throw new Error("公开查询不得撤回"); },
  };
  const calls: Array<[string, string | undefined, number | undefined]> = [];
  const official = createOfficialAnnouncements(() => undefined, groups, parseAnnouncementConfig(), undefined,
    async (game, _signal, kind, count) => {
      calls.push([game, kind, count]);
      return [{ id: "21", title: "第一条", created: 100 }, { id: "22", title: "第二条", created: 90 }];
    });
  const base = createNoticePlugin(() => undefined, groups);
  const registry = new CommandRegistry();
  registry.registerModule({ name: "@lotus-yunzai/notice", aliases: official.aliases,
    commands: { ...base.commands, ...official.commands },
    fallback: (message, context) => base.fallback(message, context) ?? official.fallback(context.normalizedMessage, context),
  });
  async function dispatch(message: string, allowed = () => true) {
    const event = normalizeGameCommand({ post_type: "message", msg: message, raw_message: message, message, message_type: "group",
      isGroup: true, isPrivate: false, isMaster: false, user_id: 42, group_id: 90, self_id: 70,
      reply: async () => true });
    return await registry.dispatch(event.msg, event, allowed) ?? await registry.dispatchFallback(event, allowed, () => false);
  }
  try {
    expect(await dispatch("#公告")).toBe("公告存储未连接。");
    expect(await dispatch("##公告")).toContain("原神公告");
    expect(await dispatch("##原神公告")).toContain("第一条");
    expect(await dispatch("###星铁资讯2")).toContain("第二条");
    expect(await dispatch("#原神公告01")).toContain("第一条");
    expect(await dispatch("#原神公告列表2")).toContain("原神公告列表");
    expect(await dispatch("##%活动列表")).toBeUndefined();
    expect(await dispatch("%活动列表")).toContain("绝区零活动列表");
    expect(await dispatch("#原神公告2abc")).toBeUndefined();
    expect(await dispatch("##发布公告")).toBeUndefined();
    expect(await dispatch("##推送公告")).toBeUndefined();
    expect(await dispatch("##原神公告", () => false)).toBeUndefined();
    expect(calls).toEqual([["gs", "notice", 20], ["gs", "notice", 20], ["sr", "info", 20],
      ["gs", "notice", 20], ["gs", "notice", 5], ["zzz", "activity", 5]]);
  } finally {
    await official.dispose();
  }
});

test("旧多井号订阅复用群管理、同会话目标和现有功能开关", async () => {
  const groups = {
    onlineBots: () => [70], listGroups: async () => [{ id: 90 }],
    sendGroup: async () => { throw new Error("订阅设置不得推送"); },
    deleteMessage: async () => { throw new Error("订阅设置不得撤回"); },
  };
  const writes: unknown[] = [];
  const redis: NoticeRedis = {
    get: async () => null, hGetAll: async () => ({}), lRange: async () => [],
    eval: async (_script, options) => { writes.push(options); return 1; },
  };
  const official = createOfficialAnnouncements(() => redis, groups, parseAnnouncementConfig(), undefined,
    undefined, undefined, () => () => {});
  const registered = createModule({ groups, whenNoticeActive: () => () => {} });
  const registry = new CommandRegistry();
  registry.registerModule({ name: "@lotus-yunzai/notice", commands: official.commands, aliases: official.aliases,
    fallback: (_message, context) => official.fallback(context.normalizedMessage, context),
    fallbackFeatures: registered.fallbackFeatures,
  });
  const base: MessageEvent = { post_type: "message", msg: "", raw_message: "", message: "", message_type: "group", isGroup: true, isPrivate: false,
    isMaster: false, user_id: 42, group_id: 90, self_id: 70, reply: async () => true };
  const admin = { ...base, member: { is_admin: true, is_owner: false } };
  async function dispatch(message: string, event = base, allowed: (names: readonly string[]) => boolean = () => true) {
    const normalized = normalizeGameCommand({ ...event, msg: message, raw_message: message, message });
    return await registry.dispatch(normalized.msg, normalized, allowed) ??
      await registry.dispatchFallback(normalized, allowed, () => false);
  }
  try {
    expect(await dispatch("##开启公告推送")).toContain("只有群管理员");
    expect(await dispatch("##开启公告推送", { ...admin, message_type: "private", isGroup: false, isPrivate: true })).toContain("请在群聊");
    expect(await dispatch("##开启公告推送", { ...admin, self_id: 71 })).toContain("无法确认");
    expect(await dispatch("##开启公告推送", admin, () => false)).toBeUndefined();
    expect(await dispatch("##开启公告推送 90", admin)).toBeUndefined();
    expect(writes).toEqual([]);
    const onlyNotice = (names: readonly string[]) => !names.includes("[notice] 米游社公开查询");
    expect(await dispatch("##开启公告推送", admin, onlyNotice)).toBe(await dispatch("#开启公告推送", admin, onlyNotice));
    expect(await dispatch("###星铁关闭资讯推送", admin, onlyNotice)).toBe("星铁资讯推送已关闭。");
    expect(writes).toEqual([
      { keys: ["lotus-yunzai:notice:mys:gs:targets"], arguments: ["70:90", "on"] },
      { keys: ["lotus-yunzai:notice:mys:gs:targets"], arguments: ["70:90", "on"] },
      { keys: ["lotus-yunzai:notice:mys:sr:info-targets"], arguments: ["70:90", "off"] },
    ]);
  } finally {
    await Promise.all([official.dispose(), registered.dispose?.()]);
  }
});
