import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CommandRegistry } from "../../lib/commands.ts";
import type { MessageEvent } from "../../lib/messages.ts";
import { createModule, createNoticePlugin } from "./index.ts";
import { createNoticeStore, type NoticeRedis } from "./store.ts";
import { configuredAnnouncements, parseAnnouncementConfig } from "./mys-announcement-config.ts";
import { createAnnouncementSource, readAnnouncementFeed, type AnnouncementGame, type AnnouncementKind } from "./mys-announcement-source.ts";
import { readImage } from "./mys-card-draw.ts";
import { readPublicMys } from "./mys-public-request.ts";
import { createArticleSource, readOfficialArticle } from "./mys-article-source.ts";
import { createOfficialAnnouncements } from "./mys-announcement.ts";
import { createActivityExpiryNotices } from "./mys-activity.ts";
import { readUpcomingExpiry, type ActivityGame } from "./mys-activity-source.ts";
import { createNoticeDelivery, type NoticeDeliveryHost, type NoticeDeliveryReply } from "./delivery.ts";
import { createTargetStore, selectNoticeGroups } from "./targets.ts";
import { configuredNoticeLogLevel, configuredNoticeSchedule, noticeLogger, parseNoticeSchedule, startNoticeScheduler } from "./schedule.ts";

test("米游社详情保留官方图文顺序并排除无法信任的内容", () => {
  const base = "https://upload-bbs.miyoushe.com/";
  const id = "11003";
  const raw = {
    retcode: 0, data: { post: {
      post: { post_id: id, subject: "公告标题", created_at: 1_790_000_000,
        content: `<h2 class="ql-align-center">正文 &amp; 前言</h2><script>不展示</script><p>第一段</p><img src="${base}a.png"><p>第二段</p><img src="http://127.0.0.1/forbidden"><img src="${base}b.png">` },
      user: { nickname: "作者", avatar_url: `${base}portrait.jpg`, certification: { label: "认证" }, level_exp: { level: 6 } },
      forum: { name: "活动公告" }, stat: { view_num: 350, like_num: 10, reply_num: 2 }, topics: [{ name: "原神" }],
    } },
  };
  const article = readOfficialArticle(raw, id);
  expect(article?.author).toBe("作者");
  expect(article?.forum).toBe("活动公告");
  expect(article?.counts).toEqual([350, 10, 2]);
  expect(article?.blocks).toEqual([
    { type: "text", text: "正文 & 前言", heading: true, align: "center" },
    { type: "text", text: "第一段", heading: false, align: "left" },
    { type: "image", url: `${base}a.png` },
    { type: "text", text: "第二段", heading: false, align: "left" },
    { type: "image", url: `${base}b.png` },
  ]);
  expect(readOfficialArticle(raw, "11004")).toBeUndefined();
  raw.data.post.post.content = JSON.stringify({ imgs: [`${base}a.png`, `${base}b.png`] });
  expect(readOfficialArticle(raw, id)?.blocks.map((block) => block.type === "image" && block.url))
    .toEqual([`${base}a.png`, `${base}b.png`]);
});

test("米游社查询继承详情编号、五条列表、三游戏资讯和摘要兜底", async () => {
  const card = Uint8Array.of(1, 2);
  const calls: [AnnouncementGame, AnnouncementKind | undefined, number | undefined][] = [];
  const details: string[] = [];
  const host: NoticeDeliveryHost = {
    onlineBots: () => [], listGroups: async () => [], sendGroup: async () => { throw new Error("离线夹具不可发送"); },
    deleteMessage: async () => { throw new Error("离线夹具不可撤回"); },
  };
  const service = createOfficialAnnouncements(() => undefined, host, parseAnnouncementConfig(), undefined,
    async (game, _signal, kind, limit) => {
      calls.push([game, kind, limit]);
      return Array.from({ length: 7 }, (_, index) => ({
        id: String(210 + index), created: 1790000000 + index, title: `条目 ${index + 1}`, summary: "摘要",
      }));
    }, undefined, undefined, async (_game, id) => {
      details.push(id);
      if (id === "211") return { title: "详情标题", pictures: [{ type: "image", file: card }] };
    });
  try {
    const context = { isMaster: false };
    expect(service.aliases["#公告2"]).toBe("#原神公告2");
    expect(service.aliases["#官方公告"]).toBe("#原神公告");
    expect(service.aliases["#公告"]).toBeUndefined();
    expect(await service.commands["#绝区零资讯2"]!("", context)).toEqual([
      { type: "text", text: "绝区零资讯：详情标题\nhttps://www.miyoushe.com/zzz/article/211" },
      { type: "image", file: card },
    ]);
    expect(await service.commands["#原神公告"]!("1", context)).toContain("摘要");
    const list = await service.commands["#星铁资讯列表"]!("", context);
    expect(list).toContain("5. 条目 5");
    expect(list).not.toContain("条目 6");
    expect(await service.commands["#原神公告"]!("21", context)).toContain("1-20");
    expect(details).toEqual(["211", "210"]);
    expect(calls).toEqual([["zzz", "info", 20], ["gs", "notice", 20], ["sr", "info", 5]]);
  } finally {
    await service.dispose();
  }
});

test("米游社列表保持五条来源次序、原首图与可点击回退", async () => {
  const card = Uint8Array.of(3, 4);
  const raw = Array.from({ length: 6 }, (_, index) => ({ post: {
    post_id: String(355 + index), created_at: 1_790_000_000 + index, subject: `原顺序 ${index + 1}`,
    content: "<p>公示正文</p><br>甲 &amp; 乙<script>丢弃内容</script>",
    cover: "https://upload-bbs.miyoushe.com/cover.png", images: ["https://upload-bbs.miyoushe.com/first.png"],
  } }));
  const posts = readAnnouncementFeed({ retcode: 0, data: { list: raw } }, 5, true);
  expect(posts.map(({ id }) => id)).toEqual(["355", "356", "357", "358", "359"]);
  expect(posts[0]?.listPreview).toEqual({ text: "公示正文 甲 & 乙", image: "https://upload-bbs.miyoushe.com/first.png" });
  const host: NoticeDeliveryHost = {
    onlineBots: () => [], listGroups: async () => [], sendGroup: async () => { throw new Error("离线夹具不可发送"); },
    deleteMessage: async () => { throw new Error("离线夹具不可撤回"); },
  };
  let fail = false;
  const service = createOfficialAnnouncements(() => undefined, host, parseAnnouncementConfig(), undefined,
    async () => posts, undefined, undefined, undefined, async (game, kind, selected) => {
      expect([game, kind, selected.length]).toEqual(["sr", "info", 5]);
      if (fail) throw new Error("PNG 暂不可用");
      return { type: "image", file: card };
    });
  try {
    const list = service.commands["#星铁资讯列表"]!;
    const text = "星铁资讯列表\n" + posts.map((post, index) =>
      `${index + 1}. ${post.title}\nhttps://www.miyoushe.com/sr/article/${post.id}`).join("\n");
    expect(await list("", { isMaster: false })).toEqual([{ type: "image", file: card }, { type: "text", text }]);
    fail = true;
    expect(await list("", { isMaster: false })).toBe(text);
  } finally {
    await service.dispose();
  }
});

test("米游社详情保留内联强调，公开别名仅在接口不可用时接续", async () => {
  const value = {
    retcode: 0, data: { post: { post: {
      post_id: "765", subject: "版块公告", created_at: 1_790_000_000,
      content: '<p>第一段 <span style="color: rgb(173, 114, 14);"><strong>限定</strong></span> 与 <a href="https://www.miyoushe.com/ys/article/5">站内活动</a></p>' +
        '<p><span style="color: url(https://fixture.invalid/x)">普通</span><a href="javascript:doNotRun()">链接</a></p>',
    } } },
  };
  const calls: string[] = [];
  const source = createArticleSource((async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.hostname);
    expect(url.searchParams.get("gids")).toBe("2");
    expect(url.searchParams.get("post_id")).toBe("765");
    expect(init?.credentials).toBe("omit");
    expect(init?.redirect).toBe("error");
    if (calls.length === 1) return new Response(null, { status: 503 });
    return Response.json(value);
  }) as typeof fetch);
  const result = await source("gs", "765", new AbortController().signal);
  expect(calls).toEqual(["bbs-api.miyoushe.com", "bbs-api.mihoyo.com"]);
  expect(result?.blocks[0]).toEqual({
    type: "text", text: "第一段 限定 与 站内活动", align: "left", heading: false,
    spans: [
      { text: "第一段 " }, { text: "限定", bold: true, color: "#ad720e" }, { text: " 与 " },
      { text: "站内活动", color: "#0066cc", underline: true },
    ],
  });
  expect(result?.blocks[1]).toEqual({ type: "text", text: "普通链接", align: "left", heading: false });
});

test("米游社列表仅对已核公开域回退并保留请求参数", async () => {
  const calls: URL[] = [];
  const empty = { retcode: 0, data: { list: [] } };
  const ok = { retcode: 0, data: { list: [{ post: { post_id: "18", created_at: 1_790_000_000, subject: "公告" } }] } };
  for (const [game, kind, gids, type] of [["gs", "notice", "2", "1"], ["sr", "info", "6", "3"], ["zzz", "notice", "8", "1"]] as const) {
    calls.length = 0;
    const source = createAnnouncementSource((async (input, init) => {
      const url = new URL(String(input));
      calls.push(url);
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      if (calls.length === 1) throw new TypeError("TLS");
      return Response.json(ok);
    }));
    expect((await source(game, new AbortController().signal, kind, 5)).map((value) => value.id)).toEqual(["18"]);
    expect(calls.map((url) => url.hostname)).toEqual(["bbs-api-static.miyoushe.com", "bbs-api.mihoyo.com"]);
    expect(calls.map((url) => [url.pathname, url.search])).toEqual(
      Array(2).fill(["/painter/wapi/getNewsList", `?gids=${gids}&page_size=5&type=${type}`]),
    );
  }

  let contacted = 0;
  for (const reply of [
    new Response(null, { status: 401 }), new Response(null, { status: 403 }), new Response(null, { status: 429 }),
    new Response(null, { status: 302, headers: { Location: "https://outside.invalid/" } }),
    Response.json({ retcode: -100, message: "权限" }), new Response("损坏 JSON"),
  ]) {
    contacted = 0;
    const source = createAnnouncementSource((async () => { contacted++; return reply; }));
    await expect(source("gs", new AbortController().signal, "notice", 5)).rejects.toThrow();
    expect(contacted).toBe(1);
  }

  contacted = 0;
  const emptySource = createAnnouncementSource((async () => { contacted++; return Response.json(empty); }));
  expect(await emptySource("gs", new AbortController().signal, "notice", 5)).toEqual([]);
  expect(contacted).toBe(1);

  const cancel = new AbortController();
  contacted = 0;
  const cancelled = createAnnouncementSource((async () => { contacted++; cancel.abort(); throw new TypeError("TLS"); }));
  await expect(cancelled("gs", cancel.signal)).rejects.toThrow();
  expect(contacted).toBe(1);
});

test("米游社公开图仅切换已核 CDN 同路径，权限、重定向和异常媒体均终止", async () => {
  const addr = "https://upload-bbs.miyoushe.com/upload/2/same.png?x-oss-process=z%3D1";
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGYktHRAD/AP8A/6C9p5MAAAAWSURBVAjXY3yzxImBgYGJgYGBgYEBABasAdZTeLQfAAAAAElFTkSuQmCC", "base64");
  const calls: URL[] = [];
  const decoded = await readImage(addr, new AbortController().signal, (async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    expect(init?.credentials).toBe("omit");
    expect(new Headers(init?.headers).has("Cookie")).toBe(false);
    if (calls.length === 1) return new Response(null, { status: 503 });
    return new Response(png, { headers: { "Content-Type": "image/png" } });
  }));
  expect([decoded?.width, decoded?.height]).toEqual([2, 2]);
  expect(calls.map((call) => call.href)).toEqual([addr, addr.replace("miyoushe.com", "mihoyo.com")]);

  for (const reply of [
    new Response(null, { status: 401 }), new Response(null, { status: 403 }), new Response(null, { status: 429 }),
    new Response(null, { status: 302, headers: { Location: "https://outside.invalid/" } }),
    new Response(png, { headers: { "Content-Type": "text/html" } }),
  ]) {
    let count = 0;
    expect(await readImage(addr, new AbortController().signal, (async () => { count++; return reply; }))).toBeUndefined();
    expect(count).toBe(1);
  }
  let count = 0;
  const fail = async () => { count++; throw new TypeError("TLS"); };
  expect(await readImage("https://outside.invalid/tile.png", new AbortController().signal, fail)).toBeUndefined();
  expect(count).toBe(0);
  expect(await readImage("https://bbs-static.miyoushe.com/tile.png", new AbortController().signal, fail)).toBeUndefined();
  expect(count).toBe(1);
});

test("公开源的单域超时独立于外部取消", async () => {
  const first = new URL("https://bbs-api-static.miyoushe.com/");
  const second = new URL("https://bbs-api.mihoyo.com/");
  const contacted: string[] = [];
  const result = await readPublicMys({ url: first, alternate: second, phaseMs: 8, signal: AbortSignal.timeout(1_000) },
    ((input, init) => {
      contacted.push(String(input));
      if (String(input) === second.href) return Promise.resolve(new Response("ok"));
      return new Promise((_resolve, reject) => {
        const active = init!.signal!;
        active.addEventListener("abort", () => reject(active.reason), { once: true });
      });
    }), (response) => response.text());
  expect(result).toBe("ok");
  expect(contacted).toEqual([first.href, second.href]);
});

const serverPath = Bun.which("valkey-server");
const cliPath = Bun.which("valkey-cli");
const available = Boolean(serverPath && cliPath);
let temp: string | undefined;
let socket = "";
let daemon: ReturnType<typeof Bun.spawn> | undefined;
let redis: NoticeRedis | undefined;

async function exec(...arguments_: string[]): Promise<unknown> {
  const child = Bun.spawn([cliPath!, "-s", socket, "--json", ...arguments_], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code || err || out.startsWith("error:")) throw new Error("测试 Valkey 命令失败");
  return JSON.parse(out);
}

beforeAll(async () => {
  if (!available) return;
  temp = await mkdtemp(join(tmpdir(), "lotus-notice-"));
  socket = join(temp, "valkey.sock");
  daemon = Bun.spawn([serverPath!, "--port", "0", "--unixsocket", socket,
    "--save", "", "--appendonly", "no", "--dir", temp], {
    stdout: "ignore", stderr: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await exec("PING").catch(() => null) === "PONG") break;
    if (attempt === 49) throw new Error("测试 Valkey 未启动");
    await Bun.sleep(40);
  }
  redis = {
    get: async (...args) => await exec("GET", ...args) as string | null,
    hGetAll: async (...args) => await exec("HGETALL", ...args) as Record<string, string>,
    lRange: async (key, first, last) => await exec("LRANGE", key, String(first), String(last)) as string[],
    eval: (script, { keys, arguments: args }) => exec("EVAL", script, String(keys.length), ...keys, ...args),
  };
});

beforeEach(async () => {
  if (available) await exec("FLUSHDB");
});

afterAll(async () => {
  redis = undefined;
  daemon?.kill();
  await daemon?.exited;
  if (temp) await rm(temp, { recursive: true, force: true });
});

test("公告自动推送读取旧目录的默认和覆盖配置，显式文件与当前配置优先", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "lotus-notice-config-"));
  const root = new URL("./", pathToFileURL(join(fixture, "app.ts")));
  const legacy = join(fixture, "plugins/Notice-plugin/config");
  const lower = join(fixture, "plugins/notice-plugin/config");
  const current = join(fixture, "config/notice.yaml");
  const explicit = join(fixture, "explicit.yaml");
  const defaults = 'enableSchedule: true\r\nscheduleTime: "8:00-8:30"\r\nlogger: debug\r\n';
  try {
    expect(configuredNoticeSchedule(root, "")).toBeUndefined();
    await Promise.all([mkdir(legacy, { recursive: true }), mkdir(lower, { recursive: true }),
      mkdir(join(fixture, "config"))]);
    await writeFile(join(legacy, "config_default.yaml"), defaults);
    expect(configuredNoticeSchedule(root, "")).toEqual({ start: 480, end: 510 });
    expect(configuredNoticeLogLevel(root, "")).toBe("debug");
    await writeFile(join(legacy, "config.yaml"), 'scheduleTime: "11:10-11:12"\n');
    expect(configuredNoticeSchedule(root, "")).toEqual({ start: 670, end: 672 });
    await writeFile(join(legacy, "config.yaml"), "enableSchedule: false\n");
    expect(configuredNoticeSchedule(root, "")).toBeUndefined();
    await writeFile(join(lower, "config.yaml"), 'scheduleTime: "11:10-11:12"\n');
    expect(() => configuredNoticeSchedule(root, "")).toThrow("两处旧公告定时配置不一致");
    expect(() => configuredNoticeLogLevel(root, "")).toThrow("两处旧公告日志级别不一致");
    await writeFile(current, "enableSchedule: false\n");
    expect(configuredNoticeSchedule(root, "")).toBeUndefined();
    expect(configuredNoticeLogLevel(root, "")).toBe("info");
    expect(() => configuredNoticeSchedule(root, explicit)).toThrow("ENOENT");
    await writeFile(explicit, 'scheduleTime: "2:05-2:05"\nlogger: error\n');
    expect(configuredNoticeSchedule(root, explicit)).toEqual({ start: 125, end: 125 });
    expect(configuredNoticeLogLevel(root, explicit)).toBe("error");
    expect(await readFile(join(legacy, "config_default.yaml"), "utf8")).toBe(defaults);
    await rm(current);
    await rm(legacy, { recursive: true });
    expect(configuredNoticeSchedule(root, "")).toEqual({ start: 670, end: 672 });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("独立公告日志等级过滤低等级消息且继续使用宿主日志", () => {
  const info = spyOn(console, "info").mockImplementation(() => {});
  const warning = spyOn(console, "warn").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  try {
    const log = noticeLogger("warn");
    log("info", "开始推送");
    log("warn", "目标发现异常");
    log("error", "投递记录写入异常");
    expect(info).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith("[notice] 目标发现异常");
    expect(error).toHaveBeenCalledWith("[notice] 投递记录写入异常");
  } finally { info.mockRestore(); warning.mockRestore(); error.mockRestore(); }
});

test.skipIf(!available)("公告账号管理沿用旧哈希，只处理在线账号与可核实的 ALL 目标", async () => {
  let missingGroups = false;
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001, 20002],
    async listGroups(bot) {
      if (bot === 20002 && missingGroups) throw new Error("offline");
      return (bot === 20001 ? [7701, 7702] : [7702, 7703]).map(id => ({ id }));
    },
    async sendGroup() { throw new Error("management cannot send a notice"); },
    async deleteMessage() { throw new Error("management cannot recall a notice"); },
  };
  const { commands } = createNoticePlugin(() => redis, host);
  const command = (name: string, argument = "", isMaster = true) => commands[name]!(argument, { isMaster });
  const one = "notice:account:20001:config", other = "notice:account:20002:config";
  const offline = "notice:account:20003:config";
  await exec("HSET", one, "enabled", "true", "pushInterval", "1500", "blacklist", '["7701"]', "lastPushTime", "123");
  await exec("HSET", offline, "enabled", "false");
  await exec("SADD", "notice:blacklist", "7799");
  expect(await command("#公告账号列表")).toContain("20001 · OneBot · 启用 · 2 个群 · 间隔 1500 毫秒");
  expect(await command("#公告账号统计")).toContain("启用 2 · 群数 4 · 可推送 3");
  expect(await command("#公告账号禁用", "", false)).toContain("仅机器人主人");
  expect(await command("#公告账号禁用")).toContain("已禁用 2/2");
  expect(await command("#公告账号状态")).toContain("20001 · OneBot · 禁用");
  expect(await command("#公告账号配置", "20002 启用 是")).toContain("已保存");
  expect(await command("#公告账号配置", "20001 间隔 500")).toContain("已保存");
  expect(await command("#公告账号配置", "20001 重试 0")).toContain("已保存");
  expect(await command("#公告账号配置", "20002 间隔 499")).toContain("500 至 10000");
  expect(await command("#公告账号配置", "20003 启用 是")).toContain("未连接");
  expect(await command("#公告账号配置")).toContain("间隔 500 毫秒 · 重试 0");
  expect(await exec("HGETALL", one)).toEqual({
    enabled: "false", pushInterval: "500", retryCount: "0", blacklist: '["7701"]', lastPushTime: "123",
  });
  expect(await exec("HGET", offline, "enabled")).toBe("false");
  await exec("DEL", other);
  await exec("SET", other, "保留无效旧值");
  expect(await command("#公告账号启用")).toContain("操作失败");
  expect(await exec("HGET", one, "enabled")).toBe("false");
  expect(await exec("GET", other)).toBe("保留无效旧值");
  await exec("DEL", other);
  expect(await command("#公告账号启用")).toContain("已启用 2/2");
  expect(await command("#公告全局黑名单添加", "ALL")).toContain("已添加 3");
  expect(await command("#公告全局黑名单删除", "all")).toContain("已删除 3");
  missingGroups = true;
  expect(await command("#公告全局黑名单添加", "ALL")).toContain("操作失败");
  expect(await exec("SMEMBERS", "notice:blacklist")).toEqual(["7799"]);
  expect(await command("#公告账号统计")).toContain("1 个账号的群数未计入");
});

test.skipIf(!available)("公告历史保留完整正文、十条批次和按页查询", async () => {
  const { commands } = createNoticePlugin(() => redis);
  expect(await commands["#全部历史公告"]("")).toBe("没有历史公告。");
  const records = Array.from({ length:23 }, (_,index) => String(10001 + index) + "ABC");
  const full = "全文，".repeat(75) + "[CQ:at,qq=all] 结尾";
  const timestamp = "2026-11-20 10:00:00";
  await exec("RPUSH","notice:history",...records);
  for (const id of records) await exec("HSET","notice:ann:"+id,"content",full,
    "creator","42","timestamp",timestamp,"status","已归档");
  const whole = await commands["#全部历史公告"]("");
  const page = await commands["#全部历史公告"]("2");
  const last = await commands["#全部历史公告"]("3");
  const makeNode = (id:string) => [
    {type:"text",text:`ID: ${id}\n状态: 已归档\n发布者: 42\n时间: ${timestamp}\n----------\n`},
    {type:"text",text:full},
  ] as const;
  expect(whole).toEqual({type:"forward",batchSize:10,senderName:"历史公告",nodes:records.map(makeNode)});
  expect(page).toEqual({type:"forward",batchSize:10,senderName:"历史公告",nodes:records.slice(10,20).map(makeNode)});
  expect(last).toEqual({type:"forward",batchSize:10,senderName:"历史公告",nodes:records.slice(20).map(makeNode)});
  expect(await commands["#全部历史公告"]("4")).toBe("历史公告共有 3 页，每页十条。");
  expect(await commands["#全部历史公告"]("0")).toContain("用法");
  expect(await commands["#全部历史公告"]("2.0")).toContain("用法");
});

test.skipIf(!available)("兼容旧公告键，主人可原子发布、编辑和撤回", async () => {
  const { commands } = createNoticePlugin(() => redis);
  const ordinary = { isMaster: false, user_id: 10001 };
  const owner = { isMaster: true, user_id: 10002 };
  const oldId = "12345ABC";
  const content = "旧公告，[CQ:at,qq=all]\n欢迎使用";
  await exec("SET", "notice:current", oldId);
  await exec("HSET", `notice:ann:${oldId}`, "content", content,
    "creator", "10003", "timestamp", "2026-11-19 08:10:00", "status", "当前");
  await exec("LPUSH", "notice:history", "99999AAA");

  expect(await commands["#公告"]()).toContain(content);
  expect(await commands["#公告"]()).toContain("状态 当前\n发布者 10003");
  expect(await commands["#发布公告"]("冒充", ordinary)).toContain("仅机器人主人");
  expect(await commands["#编辑公告"]("冒充", ordinary)).toContain("仅机器人主人");
  expect(await commands["#撤回公告"]("", ordinary)).toContain("仅机器人主人");
  expect(await exec("GET", "notice:current")).toBe(oldId);

  const replies = await Promise.all([
    commands["#发布公告"]("初次发布", owner),
    commands["#发布公告"]("并行发布", owner),
  ]);
  expect(replies.every((reply) => typeof reply === "string" && /公告已发布，编号 \d{5}[A-Z]{3}/u.test(reply))).toBe(true);
  const currentId = await exec("GET", "notice:current") as string;
  expect(replies.some((reply) => typeof reply === "string" && reply.includes(currentId))).toBe(true);
  expect(await exec("HGET", `notice:ann:${oldId}`, "status")).toBe("已归档");
  expect(await commands["#历史公告"](oldId)).toContain(content);
  expect(await commands["#历史公告"](oldId)).toContain("状态 已归档\n发布者 10003");
  expect(JSON.stringify(await commands["#全部历史公告"]("1"))).toContain(oldId);
  expect(JSON.stringify(await commands["#全部历史公告"]("1"))).not.toContain("99999AAA");

  expect(await commands["#编辑公告"]("编辑后的公告", owner)).toBe("公告已更新。");
  expect(await commands["#公告"]()).toContain("编辑后的公告");
  expect(await commands["#撤回公告"]("", owner)).toBe("当前公告已撤回。");
  expect(await commands["#公告"]()).toBe("当前没有公告。");
  expect(await commands["#历史公告"](currentId)).toBe("没有找到对应的历史公告。");
  expect(JSON.stringify(await commands["#全部历史公告"]("1"))).not.toContain(currentId);
});

test.skipIf(!available)("旧发布口令可连写正文，保留图文且与带空格指令共用权限", async () => {
  const registry = new CommandRegistry();
  registry.registerModule({ name: "@lotus-yunzai/notice", ...createNoticePlugin(() => redis) });
  const compact = "#发布公告首行\n正文";
  const file = "https://images.example.invalid/notice.png";
  const event: MessageEvent = {
    msg: compact, raw_message: compact, post_type: "message", message_type: "private",
    isGroup: false, isPrivate: true, isMaster: true, user_id: 20001, reply: () => true,
    message: [{ type: "text", text: "#发布" }, { type: "text", text: "公告首行\n正文" },
      { type: "image", file }, { type: "text", text: "图后文字" }],
  };
  const fallback = (input: MessageEvent, allowed = true) => registry.dispatchFallback(input, () => allowed, () => true);
  expect(await registry.dispatch(compact, event)).toBeUndefined();
  expect(await fallback({ ...event, isMaster: false })).toBe("仅机器人主人可管理公告。");
  expect(await fallback(event, false)).toBeUndefined();
  expect(await exec("GET", "notice:current")).toBeNull();
  expect(await fallback(event)).toContain("公告已发布");
  expect(await createNoticeStore(redis!).current()).toMatchObject({ content: "首行\n正文[图片]图后文字", segments: [
    { type: "text", text: "首行\n正文" }, { type: "image", file }, { type: "text", text: "图后文字" },
  ] });
  const spaced = "#发布公告 带空格的正文";
  const direct = { ...event, msg: spaced, raw_message: spaced, message: spaced };
  expect(await registry.dispatch(spaced, direct)).toContain("公告已发布");
  expect(await fallback(direct)).toBeUndefined();
  expect(await exec("LRANGE", "notice:history", "0", "-1")).toHaveLength(1);
  expect(await fallback({ ...direct, msg: "#编辑公告紧连正文" })).toBeUndefined();
});

test.skipIf(!available)("沿用旧全局名单和账号配置，筛选真实群列表且并发编辑不丢项", async () => {
  const { commands } = createNoticePlugin(() => redis);
  const store = createTargetStore(redis!);
  const account = "20001";
  const accountKey = "notice:account:" + account + ":config";
  const owner = { isMaster: true, message_type: "group" as const, group_id: 10004, self_id: 20001 };
  const admin = { ...owner, isMaster: false };

  await exec("SADD", "notice:whitelist", "10001", "10002", "10003");
  await exec("SADD", "notice:blacklist", "10002");
  await exec("HSET", accountKey, "whitelist", '["10001","10002",10003]',
    "blacklist", '["10003"]', "enabled", "1", "pushInterval", "2500");
  await exec("SADD", "notice:account:" + account + ":groups", "10001", "10006");

  const original = await store.settings(account);
  expect(selectNoticeGroups(original, ["10002", "10001", "10001", "10003", "10004"])).toEqual(["10001"]);
  expect(selectNoticeGroups(original, ["10006"])).toEqual([]);
  expect(selectNoticeGroups({
    ...original,
    account: { enabled: true, whitelist: ["10001", "10004"], blacklist: [] },
  }, ["10001", "10003", 10004])).toEqual(["10001"]);
  expect(await exec("HGET", accountKey, "whitelist")).toBe('["10001","10002",10003]');
  expect(selectNoticeGroups(await store.settings("20002"), ["10001", "10006"])).toEqual(["10001"]);
  await exec("HSET", "notice:account:20002:config", "enabled", "false");
  expect(selectNoticeGroups(await store.settings("20002"), ["10001"])).toEqual([]);

  expect(await commands["#公告全局白名单添加"]!("10008", admin)).toContain("仅机器人主人");
  expect(await commands["#公告全局白名单"]!("删除 ALL", owner)).toContain("明确填写目标群号");
  expect(await commands["#公告全局白名单添加"]!("", owner)).toContain("已添加 1 个群");
  expect(await commands["#公告全局白名单查看"]!("", owner)).toContain("共 4 个群");
  expect(await commands["#公告全局白名单"]!("删除 10004", owner)).toContain("已删除 1 个群");

  const edits = await Promise.all([
    commands["#公告账号白名单"]!("20001 添加 10005", owner),
    commands["#公告账号白名单添加"]!("10006，10005", owner),
  ]);
  expect(edits.every((reply) => reply.includes("账号白名单已添加"))).toBe(true);
  expect([...(await store.settings(account)).account!.whitelist].sort()).toEqual(["10001", "10002", "10003", "10005", "10006"]);
  expect(await exec("HGET", accountKey, "pushInterval")).toBe("2500");
  expect(await commands["#公告账号白名单"]!("20001 删除 10001", owner)).toContain("已删除 1 个群");

  await exec("HSET", accountKey, "whitelist", '{"unexpected":true}');
  await expect(store.settings(account)).rejects.toThrow("名单格式无效");
  expect(await commands["#公告账号白名单添加"]!("10007", owner)).toContain("名单格式");
  expect(await exec("HGET", accountKey, "whitelist")).toBe('{"unexpected":true}');
});

test.skipIf(!available)("即时推送记录逐群确认，只重试明确未发出的请求", async () => {
  const store = createNoticeStore(redis!);
  const noticeId = (await store.publish("正文 [CQ:at,qq=all]\n第二行", "20001"))!;
  await exec("SADD", "notice:whitelist", "10001", "10002", "10003", "10004");
  const attempts: Array<readonly [number, number]> = [];
  let resumableError = true;
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001, 20002, 20003],
    async listGroups(botId) {
      if (botId === 20003) throw new Error("不可读取群列表");
      return (botId === 20001 ? [10001, 10002, 10003, 10004] : [10001, 10005]).map((id) => ({ id }));
    },
    async sendGroup(botId, groupId, content) {
      expect(content).toContain("正文 [CQ:at,qq=all]\n第二行");
      attempts.push([botId, groupId]);
      if (groupId === 10002 && resumableError) {
        throw Object.assign(new Error("未发送"), { delivery: "not-sent" });
      }
      if (groupId === 10003) throw new Error("超时");
      if (groupId === 10004) return Number.NaN;
      return -groupId;
    },
    async deleteMessage() { throw new Error("即时推送不删除消息"); },
  };
  const waits: number[] = [];
  const create = () => createNoticeDelivery(redis!, host, async (ms) => { waits.push(ms); });
  await exec("HSET", "notice:account:20001:config", "pushInterval", "500");
  const first = await create().push();
  expect(first).toMatchObject({ noticeId, selected: 4, alreadyClaimed: 0, discoveryFailures: 1 });
  expect(first.receipts.map(({ state }) => state)).toEqual(["confirmed", "not-sent", "unknown", "unknown"]);
  expect(attempts).toEqual([[20001, 10001], [20001, 10002], [20001, 10003], [20001, 10004]]);
  expect(waits).toHaveLength(3);
  expect(waits.every((ms) => ms > 0 && ms <= 500)).toBe(true);
  expect(await exec("HGET", "notice:ann:" + noticeId, "push")).toBe("已推送");
  expect(Number(await exec("TTL", "notice:delivery:" + noticeId))).toBeGreaterThan(
    Number(await exec("TTL", "notice:ann:" + noticeId)),
  );

  resumableError = false;
  const second = await create().push();
  expect(second).toMatchObject({ alreadyClaimed: 3, receipts: [
    { state: "confirmed", botId: 20001, groupId: 10002, messageId: -10002 },
  ] });
  expect(attempts).toHaveLength(5);

  const { commands } = createNoticePlugin(() => redis, host);
  expect(await commands["#推送公告"]!("", { isMaster: false })).toContain("仅机器人主人");
  expect(await commands["#公告推送回执"]!(noticeId, { isMaster: false })).toContain("仅机器人主人");
  const receipts = await commands["#公告推送回执"]!(noticeId, { isMaster: true });
  expect(receipts).toContain("群 10002 · 机器人 20001 · 确认送达 · 消息 -10002");
  expect(receipts).toContain("群 10003 · 机器人 20001 · 发出结果未确认");
});

test.skipIf(!available)("手动公告在投递前回复、分段报进度并限量列出失败群", async () => {
  const client = redis!;
  const id = await createNoticeStore(client).publish("隔离公告", "20001");
  const bots = Array.from({ length: 13 }, (_, index) => 20001 + index);
  await exec("SADD", "notice:whitelist", ...bots.map(botId => String(botId - 10000)));
  const events: string[] = [];
  const host: NoticeDeliveryHost = {
    onlineBots: () => bots,
    async listGroups(botId) { return [{ id: botId - 10000 }]; },
    async sendGroup(_botId, groupId) {
      events.push(`发往 ${groupId}`);
      if (groupId === 10001) return 50001;
      if (groupId === 10002) throw Object.assign(new Error("未发送"), { delivery: "not-sent" });
      throw new Error("网关超时");
    },
    async deleteMessage() {},
  };
  const push = createNoticePlugin(() => client, host).commands["#推送公告"]!;
  const context = { isMaster: true, reply(message: string, quote?: boolean) {
    expect(quote).toBe(true);
    events.push(message);
    if (message.includes("3/13")) throw new Error("回执发送失败");
    return true;
  } };
  const delegated = { ...context, isDelegated: true };
  expect(await push("", delegated)).toContain("请直接发送");
  expect(events).toEqual([]);
  const result = await push("", context);
  expect(events[0]).toContain(`公告 ${id} 开始推送，共 13 个账号、13 个目标群`);
  expect(events[1]).toBe("发往 10001");
  expect(events.filter(value => value.startsWith("推送进度"))).toEqual([3, 6, 9, 12].map(count =>
    `推送进度 ${count}/13 · 确认送达 1。`));
  expect(result).toContain("机器人 20001 · 1/1");
  expect(result).toContain("机器人 20013 · 0/1");
  expect(result).toContain("20002:10002（确认未发出）");
  expect(result).toContain("20011:10011（发出结果未确认）");
  expect(result).not.toContain("20012:10012");
  expect(result).toContain("其余 2 个群见逐群回执");
});

test.skipIf(!available)("投递回执写入失败后停止，下一轮跳过无法确认的目标", async () => {
  const client = redis!;
  const noticeId = (await createNoticeStore(client).publish("模拟断开", "20001"))!;
  const attempts: number[] = [];
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001],
    listGroups: async () => [{ id: 10001 }, { id: 10002 }],
    async sendGroup(_botId, groupId) {
      attempts.push(groupId);
      return groupId + 100;
    },
    async deleteMessage() {},
  };
  const fault: NoticeRedis = {
    ...client,
    async eval(script, options) {
      if (options.keys.length === 2 && options.keys[0] === `notice:delivery:${noticeId}`) {
        throw new Error("模拟写入失败");
      }
      return client.eval(script, options);
    },
  };
  expect(await createNoticeDelivery(fault, host, async () => {}).push()).toMatchObject({
    stopped: "storage-error", receipts: [],
  });
  expect(attempts).toEqual([10001]);
  expect((await createNoticeDelivery(client, host).receipts())?.receipts).toEqual([
    { state: "pending", botId: 20001, groupId: 10001 },
  ]);
  expect(await createNoticeDelivery(client, host, async () => {}).push()).toMatchObject({
    alreadyClaimed: 1, receipts: [{ state: "confirmed", botId: 20001, groupId: 10002, messageId: 10102 }],
  });
  expect(attempts).toEqual([10001, 10002]);
});

test.skipIf(!available)("并发推送只发一次，公告改动和调用方中断会停止后续发送", async () => {
  const client = redis!;
  const store = createNoticeStore(client);
  await store.publish("初版内容", "20001");
  const sent: Array<{ groupId: number; content: NoticeDeliveryReply }> = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  let mode: "hold" | "edit" | "abort" = "hold";
  let list = [10001];
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001],
    listGroups: async () => list.map((id) => ({ id })),
    async sendGroup(_botId, groupId, content) {
      sent.push({ groupId, content });
      if (mode === "hold") {
        started.resolve();
        await release.promise;
      } else if (mode === "edit") {
        await store.edit("新版内容");
      } else {
        abort.abort();
      }
      return groupId;
    },
    async deleteMessage() {},
  };
  const create = () => createNoticeDelivery(client, host, async () => {});
  const first = create().push();
  await started.promise;
  try {
    expect(await create().push()).toMatchObject({ alreadyClaimed: 1, receipts: [] });
  } finally {
    release.resolve();
    await first;
  }
  expect(sent.map(({ groupId }) => groupId)).toEqual([10001]);
  list = [10001, 10002, 10003];
  mode = "edit";
  expect(await create().push()).toMatchObject({ stopped: "notice-changed", receipts: [{ groupId: 10002 }] });
  mode = "abort";
  expect(await create().push(abort.signal)).toMatchObject({ stopped: "cancelled", receipts: [{ groupId: 10003 }] });
  expect(sent[1]?.content).toContain("初版内容");
  expect(sent[2]?.content).toContain("新版内容");
  expect((await create().receipts())?.receipts.map(({ state }) => state)).toEqual([
    "confirmed", "confirmed", "confirmed",
  ]);
});

test.skipIf(!available)("宿主停止信号沿推送命令传递，已确认回执保留且不再发送下一群", async () => {
  const client = redis!;
  const noticeId = (await createNoticeStore(client).publish("停止信号测试", "20001"))!;
  const controller = new AbortController();
  const groups: number[] = [];
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001],
    listGroups: async () => [{ id: 10001 }, { id: 10002 }],
    async sendGroup(_botId, groupId) {
      groups.push(groupId);
      controller.abort();
      return 70001;
    },
    async deleteMessage() {},
  };
  const { commands } = createNoticePlugin(() => client, host, controller.signal);
  const owner = { isMaster: true, user_id: 20001 };

  expect(await commands["#推送公告"]!("", owner)).toContain("推送已中断");
  expect(groups).toEqual([10001]);
  const receipts = await createNoticeDelivery(client, host).receipts(noticeId);
  expect(receipts?.receipts).toEqual([
    { state: "confirmed", botId: 20001, groupId: 10001, messageId: 70001 },
  ]);
  expect(await commands["#推送公告"]!("", owner)).toBe("推送已中断。");
  expect(groups).toEqual([10001]);
});

test.skipIf(!available)("主人可按历史回执撤回指定群，保留原发送账号及结果", async () => {
  const client = redis!;
  const store = createNoticeStore(client);
  const oldId = (await store.publish("历史公告", "20001"))!;
  const deletions: Array<readonly [number, number]> = [];
  let connected = false;
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001, 20002],
    listGroups: async (botId) => (botId === 20001 ? [10001, 10002] : [10003, 10004]).map((id) => ({ id })),
    async sendGroup(_botId, groupId) {
      if (groupId === 10004) throw new Error("消息发送未获确认");
      return groupId === 10002 ? -81 : 889;
    },
    async deleteMessage(botId, messageId) {
      deletions.push([botId, messageId]);
      if (botId === 20002 && !connected) {
        throw Object.assign(new Error("原账号未连接"), { delivery: "not-sent" });
      }
      if (messageId === -81) throw new Error("撤回发出后断线");
    },
  };

  await createNoticeDelivery(client, host, async () => {}).push();
  const { commands } = createNoticePlugin(() => client, host);
  const owner = { isMaster: true, user_id: 20001 };
  const guest = { isMaster: false, user_id: 20002 };
  const recall = commands["#撤回已发公告"]!;

  expect(await commands["#撤回公告"]("", owner)).toBe("当前公告已撤回。");
  expect(deletions).toEqual([]);
  const newId = (await store.publish("新公告", "20001"))!;
  expect(await recall("", owner)).toContain(`公告 ${newId} 没有可撤回`);
  expect(await recall(oldId, guest)).toContain("仅机器人主人");
  expect(await recall(`${oldId} 10001`, owner)).toContain("撤回已确认 1");
  expect(deletions).toEqual([[20001, 889]]);

  const batch = await recall(oldId, owner);
  expect(batch).toContain("撤回已确认 0 · 撤回未发出 1 · 撤回未确认 1");
  expect(batch).toContain("已跳过 1");
  expect(deletions).toEqual([[20001, 889], [20001, -81], [20002, 889]]);
  connected = true;
  expect(await recall(oldId, owner)).toContain("撤回已确认 1");
  expect(deletions).toEqual([[20001, 889], [20001, -81], [20002, 889], [20002, 889]]);

  const replies = await commands["#公告推送回执"]!(oldId, owner);
  expect(replies).toContain("机器人 20001 · 确认送达 · 消息 889 · 撤回已确认");
  expect(replies).toContain("机器人 20001 · 确认送达 · 消息 -81 · 撤回结果未确认");
  expect(replies).toContain("机器人 20002 · 确认送达 · 消息 889 · 撤回已确认");
  expect(replies).toContain("群 10004 · 机器人 20002 · 发出结果未确认");
  expect((await store.current())?.id).toBe(newId);
});

test.skipIf(!available)("并发撤回、宿主取消和回执落盘失败均保留最多一次尝试", async () => {
  const client = redis!;
  const noticeId = (await createNoticeStore(client).publish("撤回操作测试", "20001"))!;
  const deletions: number[] = [];
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = new AbortController();
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001],
    listGroups: async () => [{ id: 10001 }, { id: 10002 }, { id: 10003 }],
    sendGroup: async (_botId, groupId) => groupId,
    async deleteMessage(_botId, messageId) {
      deletions.push(messageId);
      if (messageId === 10001) {
        started.resolve();
        await release.promise;
        abort.abort();
      }
    },
  };
  const create = () => createNoticeDelivery(client, host, async () => {});
  await create().push();
  const first = create().recall({ noticeId, signal: abort.signal });
  await started.promise;
  try {
    expect(await create().recall({ noticeId, groupId: 10001 })).toMatchObject({
      selected: 1, alreadyClaimed: 1, receipts: [],
    });
  } finally {
    release.resolve();
    expect(await first).toMatchObject({
      stopped: "cancelled", receipts: [{ groupId: 10001, recall: "confirmed" }],
    });
  }
  expect(deletions).toEqual([10001]);

  const fault: NoticeRedis = {
    ...client,
    async eval(script, options) {
      if (options.arguments[1]?.includes('"recall":"pending"') && options.keys[0] === `notice:delivery:${noticeId}`) {
        throw new Error("模拟撤回结果写入失败");
      }
      return client.eval(script, options);
    },
  };
  expect(await createNoticeDelivery(fault, host).recall({ noticeId })).toMatchObject({
    stopped: "storage-error", alreadyClaimed: 1, receipts: [],
  });
  expect(deletions).toEqual([10001, 10002]);
  expect((await create().receipts(noticeId))?.receipts[1]).toMatchObject({ groupId: 10002, recall: "pending" });

  expect(await create().recall({ noticeId })).toMatchObject({
    alreadyClaimed: 2, receipts: [{ groupId: 10003, recall: "confirmed" }],
  });
  expect(deletions).toEqual([10001, 10002, 10003]);
});

function fakeScheduleClock(iso: string) {
  let current = Date.parse(iso);
  const callbacks = new Map<() => void, number>();
  return {
    now: () => current,
    get planned() { return [...callbacks.values()]; },
    schedule(callback: () => void, delay: number) {
      callbacks.set(callback, current + delay);
      return () => { callbacks.delete(callback); };
    },
    advance(to: string) {
      current = Date.parse(to);
      for (const [callback, due] of callbacks.entries()) {
        if (due > current) continue;

        callbacks.delete(callback);
        callback();
      }
    },
  };
}

async function waitFor(assertion: () => unknown | Promise<unknown>) {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await assertion();
      return;
    } catch (error) {
      failure = error;
      await Bun.sleep(25);
    }
  }
  throw failure;
}

test("沿用旧定时字段，兼容默认窗口与旧短写法", () => {
  expect(parseNoticeSchedule("enableSchedule: false\nscheduleTime: 无效")).toBeUndefined();
  expect(parseNoticeSchedule("enableSchedule: true")).toEqual({ start: 480, end: 510 });
  expect(parseNoticeSchedule("enableSchedule: true\nscheduleTime: '8:00-30'")).toEqual({ start: 480, end: 510 });
  expect(parseNoticeSchedule("scheduleTime: '8:55-9:05'")).toEqual({ start: 535, end: 545 });
  expect(() => parseNoticeSchedule("scheduleTime: '8:60-8:30'")).toThrow("无效");
  expect(() => parseNoticeSchedule("enableSchedule: 'false'")).toThrow("布尔值");
});

test.skipIf(!available)("北京时间触发实际定时投递，并发和同分钟重启只执行一次", async () => {
  const client = redis!;
  const store = createNoticeStore(client);
  const noticeId = (await store.publish("工作日定时推送", "20001"))!;
  const timer = fakeScheduleClock("2026-11-19T07:59:00+08:00");
  const window = parseNoticeSchedule("enableSchedule: true\nscheduleTime: '8:00-8:00'")!;
  const requests: number[] = [];
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001],
    listGroups: async () => [{ id: 10001 }],
    async sendGroup(_bot, group, content) {
      expect(content).toContain("工作日定时推送");
      requests.push(group);
      return 70001;
    },
    async deleteMessage() {},
  };
  const first = startNoticeScheduler(() => client, host, window, undefined, timer);
  const second = startNoticeScheduler(() => client, host, window, undefined, timer);
  let restarted: (() => Promise<void>) | undefined;
  try {
    expect(timer.planned).toEqual([Date.parse("2026-11-19T00:00:00Z"), Date.parse("2026-11-19T00:00:00Z")]);
    expect(requests).toEqual([]);
    timer.advance("2026-11-19T08:00:00+08:00");
    await waitFor(async () => {
      expect(JSON.parse(await exec("GET", "notice:schedule:2026-11-19") as string)).toEqual({
        state: "completed", noticeId,
      });
      expect(timer.planned).toHaveLength(2);
    });
    expect((await createNoticeDelivery(client, host).receipts(noticeId))?.receipts).toEqual([
      { botId: 20001, groupId: 10001, state: "confirmed", messageId: 70001 },
    ]);
    await Promise.all([first(), second()]);
    restarted = startNoticeScheduler(() => client, host, window, undefined, timer);
    timer.advance("2026-11-19T08:00:30+08:00");
    await waitFor(() => expect(timer.planned).toEqual([Date.parse("2026-11-20T08:00:00+08:00")]));
    expect(requests).toEqual([10001]);
  } finally {
    await Promise.all([first(), second(), restarted?.()]);
  }
});

test.skipIf(!available)("启动不会补跑错过的窗口，公告换版不会替换已选择的定时快照", async () => {
  const client = redis!;
  const store = createNoticeStore(client);
  await store.publish("定时目标", "20001");
  const now = fakeScheduleClock("2026-11-19T08:01:00+08:00");
  const window = parseNoticeSchedule("scheduleTime: '8:00-8:00'")!;
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001],
    listGroups: async () => [{ id: 10001 }],
    async sendGroup() { throw new Error("不能推送非计划公告"); },
    async deleteMessage() {},
  };
  let swapped = false;
  const fault: NoticeRedis = {
    ...client,
    async eval(script, options) {
      if (!swapped && options.keys[0] === "notice:schedule:2026-11-20") {
        await store.publish("新的非计划公告", "20001");
        swapped = true;
      }
      return client.eval(script, options);
    },
  };
  const dispose = startNoticeScheduler(() => fault, host, window, undefined, now);
  try {
    expect(now.planned).toEqual([Date.parse("2026-11-20T08:00:00+08:00")]);
    expect(await exec("GET", "notice:schedule:2026-11-19")).toBeNull();
    now.advance("2026-11-20T08:00:00+08:00");
    await waitFor(async () => expect(await exec("GET", "notice:schedule:2026-11-20")).toBe('{"state":"skipped"}'));
    expect(swapped).toBe(true);
    expect((await createNoticeDelivery(client, host).receipts())?.receipts).toEqual([]);
  } finally {
    await dispose();
  }
});

test.skipIf(!available)("定时槽内等待网关绑定，不提前占用当天投递，过期后不补发", async () => {
  const client = redis!;
  const noticeId = (await createNoticeStore(client).publish("冷启动公告", "20001"))!;
  const window = parseNoticeSchedule("scheduleTime: '8:00-8:00'")!;
  const timer = fakeScheduleClock("2026-11-19T08:00:00+08:00");
  const firstDay = "notice:schedule:2026-11-19";
  const secondDay = "notice:schedule:2026-11-20";
  const requests: number[] = [];
  let bound = false;
  let groups = [{ id: 10001 }];
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001],
    async listGroups() { throw new Error("应使用已绑定快照"); },
    async sendGroup() { throw new Error("应使用已绑定快照"); },
    async deleteMessage() {},
    noticeAccounts: () => bound ? [{
      botId: 20001,
      adapter: "milky",
      async listGroups() { return groups; },
      async sendGroup(groupId) { requests.push(groupId); return 15; },
    }] : [],
  };
  const first = startNoticeScheduler(() => client, host, window, undefined, timer);
  const second = startNoticeScheduler(() => client, host, window, undefined, timer);
  try {
    timer.advance("2026-11-19T08:00:00+08:00");
    await waitFor(() => expect(timer.planned).toEqual(Array(2).fill(Date.parse("2026-11-19T08:00:05+08:00"))));
    expect(await exec("GET", firstDay)).toBeNull();
    expect(requests).toEqual([]);

    bound = true;
    timer.advance("2026-11-19T08:00:05+08:00");
    await waitFor(async () => {
      expect(await exec("GET", firstDay)).toBe(JSON.stringify({ state: "completed", noticeId }));
      expect(timer.planned).toEqual(Array(2).fill(Date.parse("2026-11-20T08:00:00+08:00")));
    });
    expect(requests).toEqual([10001]);

    const nextNoticeId = (await createNoticeStore(client).publish("下一天公告", "20001"))!;
    bound = false;
    timer.advance("2026-11-20T08:00:00+08:00");
    await waitFor(() => expect(timer.planned).toEqual(Array(2).fill(Date.parse("2026-11-20T08:00:05+08:00"))));
    bound = true;
    timer.advance("2026-11-20T08:01:00+08:00");
    await waitFor(() => expect(timer.planned).toEqual(Array(2).fill(Date.parse("2026-11-21T08:00:00+08:00"))));
    expect(await exec("GET", secondDay)).toBeNull();
    expect(requests).toEqual([10001]);

    groups = [];
    timer.advance("2026-11-21T08:00:00+08:00");
    await waitFor(async () => {
      expect(await exec("GET", "notice:schedule:2026-11-21")).toBe(JSON.stringify({ state: "no-targets", noticeId: nextNoticeId }));
      expect(timer.planned).toEqual(Array(2).fill(Date.parse("2026-11-22T08:00:00+08:00")));
    });
    expect(requests).toEqual([10001]);
  } finally {
    await Promise.all([first(), second()]);
  }
});

test.skipIf(!available)("关闭时等待在途确认，重启跳过状态已开始的同一计划", async () => {
  const client = redis!;
  const noticeId = (await createNoticeStore(client).publish("关闭定时测试", "20001"))!;
  const timer = fakeScheduleClock("2026-11-19T08:00:00+08:00");
  const window = parseNoticeSchedule("scheduleTime: '8:00-8:00'")!;
  const started = Promise.withResolvers<void>();
  const gateway = Promise.withResolvers<number>();
  const controller = new AbortController();
  const requests: number[] = [];
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001],
    listGroups: async () => [{ id: 10001 }, { id: 10002 }],
    async sendGroup(_botId, groupId) {
      requests.push(groupId);
      started.resolve();
      return gateway.promise;
    },
    async deleteMessage() {},
  };
  const dispose = startNoticeScheduler(() => client, host, window, controller.signal, timer);
  timer.advance("2026-11-19T08:00:00+08:00");
  await started.promise;
  expect(JSON.parse(await exec("GET", "notice:schedule:2026-11-19") as string)).toEqual({ state: "started", noticeId });
  const restart = startNoticeScheduler(() => client, host, window, undefined, timer);
  try {
    timer.advance("2026-11-19T08:00:20+08:00");
    await waitFor(() => expect(timer.planned).toEqual([Date.parse("2026-11-20T08:00:00+08:00")]));
    expect(requests).toEqual([10001]);
    controller.abort();
    let disposed = false;
    const close = dispose().then(() => { disposed = true; });
    await Promise.resolve();
    expect(disposed).toBe(false);

    gateway.resolve(70001);
    await close;
    expect(JSON.parse(await exec("GET", "notice:schedule:2026-11-19") as string)).toEqual({ state: "cancelled", noticeId });
    expect((await createNoticeDelivery(client, host).receipts(noticeId))?.receipts).toEqual([
      { botId: 20001, groupId: 10001, state: "confirmed", messageId: 70001 },
    ]);
    expect(requests).toEqual([10001]);

    const file = join(temp!, "old-notice.yaml");
    await writeFile(file, "enableSchedule: true\nscheduleTime: '8:00-8:30'\n");
    const previous = Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG;
    try {
      Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG = file;
      const module = createModule({ groups: host, signal: controller.signal });
      expect(module.dispose).toBeFunction();
      await module.dispose?.();
    } finally {
      if (previous === undefined) delete Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG;
      else Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG = previous;
    }
  } finally {
    gateway.resolve(70001);
    await Promise.all([dispose(), restart()]);
  }
});

test.skipIf(!available)("发布、读取、推送和编辑按顺序保留公告文字与图片", async () => {
  const client = redis!;
  const { commands } = createNoticePlugin(() => client);
  const catalog = createNoticeStore(client);
  const owner = { isMaster: true, user_id: 20001 };
  const prefix = "首行\n[CQ:at,qq=all] & <公告> 😀\n";
  const caption = "\n尾行，[字样]";
  const https = "https://images.example.invalid/notice.png?x=1&y=2";
  const inline = "base64://AQI=";
  const body = [
    { type: "text", text: prefix },
    { type: "image", file: https },
    { type: "text", text: caption },
  ] as const;
  const mixed = {
    ...owner,
    message: [
      { type: "reply", id: 7 },
      { type: "at", qq: "20001" },
      { type: "text", text: "#发布" },
      { type: "text", text: "公告 " + prefix },
      { type: "image", url: https, file: "gateway-temporary-file" },
      { type: "text", text: caption },
    ],
  };

  expect(await commands["#发布公告"]("", { ...mixed, isMaster: false })).toContain("仅机器人主人");
  expect(await commands["#发布公告"](prefix + caption, mixed)).toContain("公告已发布");
  const current = (await catalog.current())!;
  expect(current.content).toBe(prefix + "[图片]" + caption);
  expect(await exec("HGET", "notice:ann:" + current.id, "content")).toBe(current.content);
  expect(JSON.parse(await exec("HGET", "notice:ann:" + current.id, "segments") as string)).toEqual([...body]);
  expect(await commands["#公告"]()).toEqual([
    { type: "text", text: `【当前公告】 ${current.id}\n${current.timestamp}\n状态 当前\n发布者 20001\n` }, ...body,
  ]);

  const sent: NoticeDeliveryReply[] = [];
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001],
    listGroups: async () => [{ id: 10001 }],
    async sendGroup(_bot, _group, value) { sent.push(value); return 70001; },
    async deleteMessage() {},
  };
  expect(await createNoticeDelivery(client, host).push()).toMatchObject({
    receipts: [{ state: "confirmed", messageId: 70001 }],
  });
  expect(sent[0]).toEqual([
    { type: "text", text: "【公告通知】\n" }, ...body, { type: "text", text: "\n" + current.timestamp },
  ]);

  expect(await commands["#编辑公告"]("", {
    ...owner,
    message: [{ type: "text", text: "#编辑公告" }, { type: "image", file: inline }],
  })).toBe("公告已更新。");
  expect(await commands["#公告"]()).toEqual([
    { type: "text", text: `【当前公告】 ${current.id}\n${current.timestamp}\n状态 当前\n发布者 20001\n` },
    { type: "image", file: inline },
  ]);
  expect(await commands["#发布公告"]("已切换到普通文字", owner)).toContain("公告已发布");
  expect(await commands["#历史公告"](current.id)).toEqual([
    { type: "text", text: `【历史公告】 ${current.id}\n${current.timestamp}\n状态 已归档\n发布者 20001\n` },
    { type: "image", file: inline },
  ]);
  expect(await commands["#全部历史公告"]("1")).toEqual({ type:"forward", batchSize:10, senderName:"历史公告", nodes:[[
    { type:"text", text:`ID: ${current.id}\n状态: 已归档\n发布者: 20001\n时间: ${current.timestamp}\n----------\n` },
    { type:"image", file:inline },
  ]] });

  const plain = (await catalog.current())!;
  expect(await commands["#编辑公告"]("等号 = 逗号 , & []\n尾行", owner)).toBe("公告已更新。");
  expect(await exec("HGET", "notice:ann:" + plain.id, "segments")).toBeNull();
  expect(await commands["#公告"]()).toContain("等号 = 逗号 , & []\n尾行");
});

test.skipIf(!available)("不可重放的图片不会覆盖公告，旧文字和已损坏结构仍可按原文查看", async () => {
  const client = redis!;
  const current = await createNoticeStore(client).publish("旧文字 [CQ:image,file=legacy]", "20001");
  const { commands } = createNoticePlugin(() => client);
  const owner = { isMaster: true, user_id: 20001 };

  for (const file of ["file:///home/user/private.png", "http://images.example.invalid/a.png",
    "https://name:token@images.example.invalid/a.png", "base64://bad padding="]) {
    expect(await commands["#编辑公告"]("", {
      ...owner, message: [{ type: "text", text: "#编辑公告" }, { type: "image", file }],
    })).toContain("需要 HTTPS");
  }
  expect(await commands["#编辑公告"]("说明", {
    ...owner,
    message: [{ type: "text", text: "#编辑公告 说明" }, { type: "at", qq: "all" }],
  })).toContain("只支持文字和图片");

  await exec("HSET", "notice:ann:" + current, "segments", '[{"type":"image","file":"https://images.example.invalid/stale.png"}]');
  expect(await commands["#公告"]()).toContain("旧文字 [CQ:image,file=legacy]");
  expect(await commands["#编辑公告"]("清理旧结构", owner)).toBe("公告已更新。");
  expect(await exec("HGET", "notice:ann:" + current, "segments")).toBeNull();
});

test.skipIf(!available)("图片替换不改变文字预览时，定时器和投递队列仍不会发送旧图片", async () => {
  const client = redis!;
  const store = createNoticeStore(client);
  const original = "https://images.example.invalid/old.png";
  const replacement = "https://images.example.invalid/new.png";
  const id = (await store.publish([{ type: "image", file: original }], "20001"))!;
  const scheduled = fakeScheduleClock("2026-11-19T07:59:00+08:00");
  const window = parseNoticeSchedule("scheduleTime: '8:00-8:00'")!;
  const sent: NoticeDeliveryReply[] = [];
  const host: NoticeDeliveryHost = {
    onlineBots: () => [20001],
    listGroups: async () => [{ id: 10001 }, { id: 10002 }],
    async sendGroup(_bot, _group, value) {
      sent.push(value);
      await store.edit([{ type: "image", file: original }]);
      return 70001;
    },
    async deleteMessage() {},
  };
  let swapped = false;
  const fault: NoticeRedis = {
    ...client,
    async eval(script, options) {
      if (!swapped && options.keys[0] === "notice:schedule:2026-11-19") {
        expect(await store.edit([{ type: "image", file: replacement }])).toBe(id);
        swapped = true;
      }
      return client.eval(script, options);
    },
  };
  const dispose = startNoticeScheduler(() => fault, host, window, undefined, scheduled);
  try {
    scheduled.advance("2026-11-19T08:00:00+08:00");
    await waitFor(async () => expect(await exec("GET", "notice:schedule:2026-11-19")).toBe('{"state":"skipped"}'));
    expect(sent).toEqual([]);

    const result = await createNoticeDelivery(client, host, async () => {}).push();
    expect(result).toMatchObject({ stopped: "notice-changed", receipts: [{ groupId: 10001 }] });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContainEqual({ type: "image", file: replacement });
    expect((await store.current())?.content).toBe("[图片]");
  } finally {
    await dispose();
  }
});

test("米游社官方列表只接受可用的旧公告字段，保留摘要和官方图片", async () => {
  const queries: URL[] = [];
  const source = createAnnouncementSource((async (input: URL, options: RequestInit) => {
    queries.push(input);
    expect(new Headers(options.headers).has("Cookie")).toBe(false);
    return Response.json({ retcode: 0, data: { list: [
      { post: { post_id: "12", created_at: 100, subject: "  三行\n公告  ", summary: "官方摘要",
        cover: "https://upload-bbs.miyoushe.com/example.png", uid: "0" } },
      { post: { post_id: "11", created_at: 99, subject: "旧公告", cover: "https://invalid.test/1.png" },
        image_list: [{ url: "https://upload-bbs.miyoushe.com/fallback.png" }] },
      { post: { post_id: "13", created_at: 101, subject: "已删内容", is_deleted: 1 } },
      { post: { post_id: "13/evil", created_at: 101, subject: "无效链接" } },
    ] } });
  }) as typeof fetch);
  expect(await source("zzz", new AbortController().signal)).toEqual([
    { id: "11", created: 99, title: "旧公告", image: "https://upload-bbs.miyoushe.com/fallback.png" },
    { id: "12", created: 100, title: "三行 公告", summary: "官方摘要", image: "https://upload-bbs.miyoushe.com/example.png" },
  ]);
  expect(queries[0]?.searchParams.get("gids")).toBe("8");
  expect(queries[0]?.searchParams.get("type")).toBe("1");
});

test.skipIf(!available)("旧米游社公告群和 Redis 去重键重跑不重复，分开处理确认、未发出与结果未知", async () => {
  const wall = 1_800_000_000;
  const config = parseAnnouncementConfig(`
pushTime: '0 0/5 * * * ?'
maxNum: 1
banWord: { gs: '测试过滤' }
gsannounceGroup:
  '70': [90, '90', 94]
  '71': [90, 91, 92, 93]
`);
  await exec("SET", "Yz:gs:mys:newPush:71:90:1000", "1", "EX", "36000");
  const sends: { bot: number; group: number; body: NoticeDeliveryReply }[] = [];
  let reject = true;
  const host: NoticeDeliveryHost = {
    onlineBots: () => [70, 71],
    async listGroups(bot) { return (bot === 70 ? [90, 94] : [90, 91, 92]).map((id) => ({ id })); },
    async sendGroup(bot, group, body) {
      sends.push({ bot, group, body });
      if (group === 91 && reject) throw Object.assign(new Error(), { delivery: "not-sent" });
      if (group === 92) throw new Error("回执断开");
      return -123;
    },
    async deleteMessage() {},
  };
  const feed = async () => [
    { id: "999", created: wall - 7201, title: "过时公告" },
    { id: "1000", created: wall - 4, title: "新公告", summary: "摘要", image: "https://upload-bbs.miyoushe.com/preview.png" },
    { id: "1001", created: wall - 3, title: "测试过滤" },
  ];
  const service = () => createOfficialAnnouncements(() => redis, host, config, undefined, feed, () => wall * 1000);
  const first = service();
  try {
    expect(await first.run(["gs"])).toMatchObject({ confirmed: 1, rejected: 1, unknown: 1, skipped: 1 });
    expect(sends.map(({ bot, group }) => [bot, group])).toEqual([[70, 94], [71, 91], [71, 92]]);
    expect(sends[0]?.body).toEqual([
      { type: "text", text: "【原神公告】新公告\n摘要\nhttps://www.miyoushe.com/ys/article/1000" },
      { type: "image", file: "https://upload-bbs.miyoushe.com/preview.png" },
    ]);
    expect(await exec("GET", "Yz:gs:mys:newPush:70:94:1000")).toBe("1");
    expect(await exec("GET", "Yz:gs:mys:newPush:71:92:1000")).toBe("1");
    expect(await exec("GET", "Yz:gs:mys:newPush:71:91:1000")).toBeNull();
  } finally {
    await first.dispose();
  }
  reject = false;
  sends.length = 0;
  const second = service();
  try {
    expect(await second.run(["gs"])).toMatchObject({ confirmed: 1, rejected: 0, unknown: 0, skipped: 3 });
    expect(sends.map(({ group }) => group)).toEqual([91]);
  } finally {
    await second.dispose();
  }
});

test.skipIf(!available)("米游社公告每轮读取 YAML，发送前复核新目标与过滤词，配置错误后可恢复", async () => {
  const folder = await mkdtemp(join(tmpdir(), "lotus-live-mys-notice-"));
  const path = join(folder, "config", "mys.pushNews.yaml");
  const root = pathToFileURL(folder + "/");
  await mkdir(join(folder, "config", "config"), { recursive: true });
  await writeFile(join(folder, "config", "config", "mys.pushNews.yaml"), "gsannounceGroup: { '70': [90] }");
  const source = configuredAnnouncements(root);
  expect(source()).toBe(source());
  const prepared = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const sent: [number, number, NoticeDeliveryReply][] = [];
  const host: NoticeDeliveryHost = {
    onlineBots: () => [70], listGroups: async () => [{id: 90}, {id: 91}],
    async sendGroup(bot, group, message) { sent.push([bot, group, message]); return 901; },
    async deleteMessage() {},
  };
  const now = 1_800_000_000;
  const service = createOfficialAnnouncements(() => redis, host, source, undefined,
    async () => [{ id: "2201", created: now - 2, title: "改后过滤" }, { id: "2202", created: now - 1, title: "保留条目" }],
    () => now * 1000, undefined, async () => { prepared.resolve(); await release.promise; return undefined; });
  try {
    const first = service.run(["gs"], ["notice"]);
    await prepared.promise;
    await writeFile(path, "gsannounceGroup: { '70': [91] }\nbanWord: { gs: '改后过滤' }\n");
    release.resolve();
    expect(await first).toMatchObject({ confirmed: 0, skipped: 2 });
    expect(sent).toEqual([]);
    expect(await exec("GET", "lotus-yunzai:notice:mys:gs:delivery:90:2201")).toBeNull();
    expect(await service.run(["gs"], ["notice"])).toMatchObject({ confirmed: 1, failed: 0 });
    expect(sent.map(([bot, group, message]) => [bot, group, String(message).includes("保留条目")])).toEqual([[70, 91, true]]);
    await writeFile(path, "gsannounceGroup: [");
    expect(await service.run(["gs"], ["notice"])).toMatchObject({ confirmed: 0, failed: 1 });
    expect(sent).toHaveLength(1);
    await writeFile(path, "gsannounceGroup: { '70': [90] }");
    expect(await service.run(["gs"], ["notice"])).toMatchObject({ confirmed: 1, failed: 0 });
    expect(sent[1]?.[1]).toBe(90);
  } finally {
    release.resolve();
    await service.dispose();
    await rm(folder, { recursive: true });
  }
});

test.skipIf(!available)("米游社订阅命令持久覆盖旧名单，停止后取消正在读取的公告", async () => {
  const config = parseAnnouncementConfig("gsannounceGroup: { '70': [90] }");
  const host: NoticeDeliveryHost = {
    onlineBots: () => [70],
    async listGroups() { return [{ id: 90 }]; },
    async sendGroup() { throw new Error("该夹具不应发群消息"); },
    async deleteMessage() {},
  };
  const entered = Promise.withResolvers<void>();
  let polls = 0;
  const feed = async (_game: AnnouncementGame, signal: AbortSignal) => {
    polls++;
    entered.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return [];
  };
  const service = createOfficialAnnouncements(() => redis, host, config, undefined, feed);
  const context = { isMaster: false, message_type: "group", self_id: 70, group_id: 90 };
  const admin = { ...context, member: { is_admin: true, is_owner: false } };
  try {
    expect(await service.commands["#关闭公告推送"]!("", context)).toContain("管理员");
    expect(await service.commands["#关闭公告推送"]!("", admin)).toBe("原神公告推送已关闭。");
    expect(await service.run(["gs"])).toMatchObject({ confirmed: 0 });
    expect(polls).toBe(0);
    expect(await service.commands["#原神开启公告推送"]!("", admin)).toBe("原神公告推送已开启。");
    const pending = service.run(["gs"]);
    await entered.promise;
    await service.dispose();
    expect(await pending).toMatchObject({ confirmed: 0 });
    expect(service.run(["gs"])).toBeUndefined();
  } finally {
    await service.dispose();
  }
});

test.skipIf(!available)("资讯延用三游戏原配置、类型请求、公告共用额度和旧去重键", async () => {
  const wall = 1_800_000_000;
  const config = parseAnnouncementConfig(`
maxNum: 1
gsannounceGroup: { '70': [90] }
gsinfoGroup: { '70': [90] }
srinfoGroup: { '70': [91] }
zzzinfoGroup: { '71': [92] }
`);
  const calls: [AnnouncementGame, AnnouncementKind][] = [];
  const sent: [number, NoticeDeliveryReply][] = [];
  const remote = createAnnouncementSource((async input => {
    const url = new URL(input as URL);
    expect(url.searchParams.get("type")).toBe("3");
    return Response.json({ retcode:0, data:{list:[]} });
  }) as typeof fetch);
  await remote("sr", new AbortController().signal, "info");
  const host: NoticeDeliveryHost = {
    onlineBots:()=>[70],
    async listGroups() { return [{id:90},{id:91}]; },
    async sendGroup(_bot, group, body) { sent.push([group,body]); return 501; },
    async deleteMessage() {},
  };
  const feed = async (game: AnnouncementGame, _signal: AbortSignal, kind: AnnouncementKind = "notice") => {
    calls.push([game,kind]);
    const id = game === "sr" ? "1020" : kind === "info" ? "1000" : "1001";
    return [{id,created:wall - (kind === "info" ? 2 : 3), title:kind === "info" ? "资讯样本" : "公告样本"}];
  };
  const service = createOfficialAnnouncements(() => redis, host, config, undefined, feed, () => wall * 1000);
  const group = {isMaster:false,message_type:"group",self_id:70,group_id:90,member:{is_admin:true,is_owner:false}};
  try {
    await exec("SET","Yz:sr:mys:newPush:70:91:1020","1","EX","36000");
    expect(await service.run()).toMatchObject({confirmed:1,skipped:1});
    expect(calls).toEqual([["gs","notice"],["gs","info"],["sr","info"]]);
    expect(sent).toEqual([[90,"【原神资讯】资讯样本\nhttps://www.miyoushe.com/ys/article/1000"]]);
    expect(await exec("GET","Yz:gs:mys:newPush:70:90:1000")).toBe("1");
    expect(await exec("GET","Yz:gs:mys:newPush:70:90:1001")).toBeNull();
    expect(await service.commands["#关闭资讯推送"]!("",group)).toBe("原神资讯推送已关闭。");
    calls.length = 0;
    expect(await service.run(["gs"])).toMatchObject({confirmed:1});
    expect(calls).toEqual([["gs","notice"]]);
    expect(sent[1]).toEqual([90,"【原神公告】公告样本\nhttps://www.miyoushe.com/ys/article/1001"]);
    expect(await service.commands["#推送资讯"]!("",{isMaster:false})).toContain("机器人主人");
    expect(await service.commands["#原神开启资讯推送"]!("",group)).toBe("原神资讯推送已开启。");
    calls.length = 0;
    expect(await service.commands["#原神推送资讯"]!("",{isMaster:true})).toContain("已去重 1");
    expect(calls).toEqual([["gs","info"]]);
  } finally { await service.dispose(); }
});

test.skipIf(!available)("旧 cron 实际触发米游社订阅，只从当前在线账号向订阅群发送", async () => {
  const wall = 1_800_000_000;
  const config = parseAnnouncementConfig("pushTime: '*/1 * * * * *'\nzzzannounceGroup: { '80': [90] }");
  const sent = Promise.withResolvers<NoticeDeliveryReply>();
  const host: NoticeDeliveryHost = {
    onlineBots: () => [],
    async listGroups() { throw new Error("不能使用旧群列表"); },
    async sendGroup() { throw new Error("不能使用旧发送入口"); },
    async deleteMessage() {},
    noticeAccounts: () => [{
      botId: 80, adapter: "milky",
      async listGroups() { return [{ id: 90 }, { id: 91 }]; },
      async sendGroup(group, body) {
        expect(group).toBe(90);
        expect(await exec("GET", "Yz:zzz:mys:newPush:80:90:1010")).not.toBeNull();
        sent.resolve(body);
        return 70;
      },
    }],
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const service = createOfficialAnnouncements(() => redis, host, config, undefined, async (game) => {
    expect(game).toBe("zzz");
    return [{ id: "1010", created: wall - 3, title: "自动投递" }];
  }, () => wall * 1000);
  try {
    timeout = setTimeout(() => sent.reject(new Error("米游社旧 cron 未触发。")), 2500);
    expect(await sent.promise).toBe("【绝区零公告】自动投递\nhttps://www.miyoushe.com/zzz/article/1010");
  } finally {
    clearTimeout(timeout);
    await service.dispose();
  }
  expect(await exec("GET", "Yz:zzz:mys:newPush:80:90:1010")).toBe("1");
  expect(JSON.parse(await exec("GET", "lotus-yunzai:notice:mys:zzz:delivery:90:1010") as string))
    .toEqual({ state: "confirmed", botId: 80, adapter: "milky", messageId: 70 });
});

test.skipIf(!available)("公告和资讯准备详情时关闭推送，新旧占位释放且重新开启只投递一次", async () => {
  const now = 1_800_000_000;
  const config = parseAnnouncementConfig(`
pushTime: '0 0 10 1 1 *'
gsannounceGroup: { '70': [90] }
gsinfoGroup: { '70': [90] }
`);
  const admin = { isMaster: false, message_type: "group", self_id: 70, group_id: 90,
    member: { is_admin: true, is_owner: false } };
  for (const [kind, label, id, adapter] of [["notice", "公告", "1601", "onebot"], ["info", "资讯", "1602", "milky"]] as const) {
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const attempts: number[] = [];
    const detailCard = Uint8Array.of(1, 2);
    const host: NoticeDeliveryHost = {
      onlineBots: () => [],
      async listGroups() { throw new Error("测试应走已选协议账号"); },
      async sendGroup() { throw new Error("测试应走已选协议账号"); },
      async deleteMessage() {},
      noticeAccounts: () => [{
        botId: 70, adapter,
        async listGroups() { return [{ id: 90 }]; },
        async sendGroup(groupId, content) {
          if (typeof content === "string" || content[1]?.type !== "image") throw new Error("详情图片未到达投递");
          expect(content[1].file).toBe(detailCard);
          attempts.push(groupId);
          return 901;
        },
      }],
    };
    const service = createOfficialAnnouncements(() => redis, host, config, undefined,
      async () => [{ id, created: now - 1, title: "图文合成样本" }], () => now * 1000, undefined, async () => {
        entered.resolve();
        await released.promise;
        return { title: "图文合成样本", pictures: [{ type: "image", file: detailCard }] };
      });
    const receipt = `lotus-yunzai:notice:mys:gs:delivery:90:${id}`;
    const legacy = `Yz:gs:mys:newPush:70:90:${id}`;
    const targets = kind === "notice" ? "targets" : "info-targets";
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const polling = service.run(["gs"], [kind]);
      await Promise.race([entered.promise, new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("公告未进入详情准备。")), 2_000);
      })]);
      clearTimeout(timeout);
      const owned = await exec("GET", receipt);
      expect(JSON.parse(owned as string)).toMatchObject({ state: "pending", botId: 70 });
      expect(await exec("GET", legacy)).toBe(owned);
      expect(await service.commands[`#原神关闭${label}推送`]!("", admin)).toBe(`原神${label}推送已关闭。`);
      expect(await exec("HGET", `lotus-yunzai:notice:mys:gs:${targets}`, "70:90")).toBe("off");

      released.resolve();
      expect(await polling).toMatchObject({ confirmed: 0, skipped: 1 });
      expect(attempts).toEqual([]);
      expect(await exec("GET", receipt)).toBeNull();
      expect(await exec("GET", legacy)).toBeNull();

      expect(await service.commands[`#原神开启${label}推送`]!("", admin)).toBe(`原神${label}推送已开启。`);
      expect(await service.run(["gs"], [kind])).toMatchObject({ confirmed: 1 });
      expect(attempts).toEqual([90]);
      expect(JSON.parse(await exec("GET", receipt) as string)).toEqual({
        state: "confirmed", botId: 70, ...(adapter === "milky" ? { adapter } : {}), messageId: 901,
      });
      expect(await exec("GET", legacy)).toBe("1");
      expect(await service.run(["gs"], [kind])).toMatchObject({ confirmed: 0, skipped: 1 });
      expect(attempts).toEqual([90]);
    } finally {
      clearTimeout(timeout);
      released.resolve();
      await service.dispose();
    }
  }
});

test.skipIf(!available)("公告准备详情时收到旧账号的投递记录，保留旧回执且不重复发送", async () => {
  const now = 1_800_000_000;
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const config = parseAnnouncementConfig("pushTime: '0 0 10 1 1 *'\ngsannounceGroup: { '70': [90], '71': [90] }\n");
  const attempts: number[] = [];
  const host: NoticeDeliveryHost = {
    onlineBots: () => [70, 71],
    async listGroups() { return [{ id: 90 }]; },
    async sendGroup(botId) { attempts.push(botId); return 901; },
    async deleteMessage() {},
  };
  const service = createOfficialAnnouncements(() => redis, host, config, undefined,
    async () => [{ id: "1603", created: now - 1, title: "已投递公告" }], () => now * 1000, undefined, async () => {
      entered.resolve();
      await released.promise;
      return undefined;
    });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const polling = service.run(["gs"], ["notice"]);
    await Promise.race([entered.promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("公告未进入详情准备。")), 2_000);
    })]);
    clearTimeout(timeout);
    await exec("SET", "Yz:gs:mys:newPush:71:90:1603", "1", "EX", "36000");
    released.resolve();
    expect(await polling).toMatchObject({ confirmed: 0, skipped: 1 });
    expect(attempts).toEqual([]);
    expect(await exec("GET", "lotus-yunzai:notice:mys:gs:delivery:90:1603")).toBeNull();
    expect(await exec("GET", "Yz:gs:mys:newPush:70:90:1603")).toBeNull();
    expect(await exec("GET", "Yz:gs:mys:newPush:71:90:1603")).toBe("1");
  } finally {
    clearTimeout(timeout);
    released.resolve();
    await service.dispose();
  }
});

test("活动到期读取原游戏列表格式，过滤已过期、两天外和错误分类", () => {
  const now = Date.parse("2026-11-20T10:00:00+08:00");
  const gs = {retcode:0,data:{list:[{}, {list:[
    {title:"有效活动",subtitle:"合成副标题",tag_label:"活动",end_time:"2026-11-22 09:59:59",banner:"https://sdk-webstatic.mihoyo.com/p.png"},
    {title:"两天后",tag_label:"活动",end_time:"2026-11-22 10:00:00"},
    {title:"已过期",tag_label:"活动",end_time:"2026-11-19 10:00:00"},
    {title:"传说任务",tag_label:"活动",end_time:"2026-11-21 10:00:00"},
    {title:"非活动",tag_label:"说明",end_time:"2026-11-21 10:00:00"},
  ]}]}};
  expect(readUpcomingExpiry("gs",gs,now)).toEqual([{title:"有效活动",subtitle:"合成副标题",
    end:Date.parse("2026-11-22T09:59:59+08:00"),image:"https://sdk-webstatic.mihoyo.com/p.png"}]);
  const sr = {retcode:0,data:{pic_list:[{type_list:[{list:[
    {title:"星铁活动",img:"https://untrusted.example/p.png",end_time:"2026-11-20 10:00:01"},
    {title:"已结束",end_time:"2026-11-20 10:00:00"},
  ]}]}]}};
  expect(readUpcomingExpiry("sr",sr,now)).toEqual([{title:"星铁活动",subtitle:"星铁活动",end:now+1000,image:undefined}]);
  expect(()=>readUpcomingExpiry("sr",gs,now)).toThrow("响应无效");
});

test.skipIf(!available)("活动到期续用原群队列顺序，结果未知去重，明确未发出才在下轮补", async () => {
  let wall = Date.parse("2026-11-20T09:59:59+08:00");
  const finish = Date.parse("2026-11-21T20:00:00+08:00");
  const config = parseAnnouncementConfig(`
pushTime: "0 0 10 1 1 *"
gsActivityPush: { '70': [90,91] }
srActivityPush: { '70': [91] }
`);
  const key = "Yz:apgl:70";
  const original = JSON.stringify({date:"2026-11-20",GroupList:[91,90]});
  await exec("SET",key,original,"EX","7200");
  const ttl = await exec("PEXPIRETIME",key);
  const calls: ActivityGame[] = [];
  const messages: [number,NoticeDeliveryReply][] = [];
  let listCalls = 0, rejecting = true, start: (() => void) | undefined;
  const host: NoticeDeliveryHost = {
    onlineBots:()=>[70],
    async listGroups() { listCalls++;return [{id:90},{id:91}]; },
    async sendGroup(_bot,group,body) {
      messages.push([group,body]);
      if (String(body).includes("星铁")) throw new Error("未确认");
      if (rejecting) throw Object.assign(new Error(),{delivery:"not-sent"});
      return 1001;
    },
    async deleteMessage() {},
  };
  const source = async (game:ActivityGame) => {
    calls.push(game);
    return [{title:`即将结束 ${game}`,subtitle:`标题 ${game}`,end:finish}];
  };
  const service = createActivityExpiryNotices(()=>redis,host,config,undefined,source,()=>wall,
    callback=>{start=callback;return ()=>{start=undefined;};},async()=>{});
  const group = {isMaster:false,message_type:"group",self_id:70,group_id:90};
  const admin = {...group,member:{is_admin:true,is_owner:false}};
  try {
    await service.run();
    expect(calls).toEqual([]);
    start?.();
    await service.run();
    expect(listCalls).toBe(0);
    wall += 2000;
    await service.run();
    expect(calls).toEqual(["sr","gs"]);
    expect(messages.map(([group])=>group)).toEqual([91,91]);
    expect(String(messages[0]?.[1])).toContain("【星铁活动即将结束通知】");
    expect(await exec("GET",key)).toBe(original);
    rejecting = false;
    await service.run();
    expect(messages.map(([group])=>group)).toEqual([91,91,91]);
    expect(await exec("GET",key)).toBe(JSON.stringify({date:"2026-11-20",GroupList:[90]}));
    expect(await exec("PEXPIRETIME",key)).toBe(ttl);
    await service.run();
    expect(messages.map(([group])=>group)).toEqual([91,91,91,90]);
    expect(await exec("GET",key)).toBe(JSON.stringify({date:"2026-11-20",GroupList:[]}));
    const previous = calls.length;
    await service.run();
    expect(calls).toHaveLength(previous);
    expect(await service.commands["#原神关闭到期活动预警推送"]!("",group)).toContain("管理员");
    expect(await service.commands["#原神关闭到期活动预警推送"]!("",admin)).toContain("已关闭");
    expect(await service.commands["#原神开启到期活动"]!("",admin)).toContain("已开启");
  } finally { await service.dispose(); }
});

test.skipIf(!available)("活动到期从空配置启动，读取新加目标并取消已删除的待发目标", async () => {
  const folder = await mkdtemp(join(tmpdir(), "lotus-live-mys-expiry-"));
  const path = join(folder, "config", "mys.pushNews.yaml");
  await mkdir(join(folder, "config"));
  const sent: number[] = [];
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const host: NoticeDeliveryHost = {
    onlineBots: () => [70], listGroups: async () => [{id: 90}, {id: 91}],
    async sendGroup(_bot, group) { sent.push(group); return 901; },
    async deleteMessage() {},
  };
  const now = Date.parse("2026-11-20T11:00:00+08:00");
  const service = createActivityExpiryNotices(() => redis, host, configuredAnnouncements(pathToFileURL(folder + "/")), undefined,
    async () => [{ title: "到期活动", subtitle: "到期测试", end: now + 3_600_000 }], () => now,
    undefined, async () => { waiting.resolve(); await release.promise; });
  try {
    await service.run();
    expect(sent).toEqual([]);
    await writeFile(path, "gsActivityPush: { '70': [90] }");
    const first = service.run();
    await waiting.promise;
    await writeFile(path, "gsActivityPush: { '70': [91] }");
    release.resolve();
    await first;
    expect(sent).toEqual([]);
    expect(await exec("KEYS", "lotus-yunzai:notice:mys:expiry:*")).toEqual([]);
    await service.run();
    expect(sent).toEqual([91]);
  } finally {
    release.resolve();
    await service.dispose();
    await rm(folder, { recursive: true });
  }
});

test.skipIf(!available)("公告会话快照优先同号 OneBot，Milky 回执绑定原协议和群", async () => {
  const client = redis!;
  const noticeId = (await createNoticeStore(client).publish("通知", "20001"))!;
  await exec("SADD", "notice:whitelist", "10001", "10002", "10003");
  const attempts: string[] = [];
  const recalls: unknown[][] = [];
  const signal = new AbortController().signal;
  let accounts: ReturnType<NonNullable<NoticeDeliveryHost["noticeAccounts"]>>;
  const oneBot = {
    botId: 20001, adapter: "onebot" as const,
    async listGroups(received?: AbortSignal) { expect(received).toBe(signal); return [{ id: 10001 }]; },
    async sendGroup(group: number) { attempts.push(`onebot:${group}`); return -15; },
  };
  const nextOneBot = {
    ...oneBot, botId: 20002,
    async listGroups() { return [{ id: 10002 }, { id: 10003 }]; },
  };
  accounts = [
    { ...oneBot, adapter: "milky", async listGroups() { throw new Error("同号 Milky 不应查询"); } },
    oneBot,
    {
      botId: 20002, adapter: "milky",
      async listGroups(received) {
        expect(received).toBe(signal);
        accounts = [oneBot, nextOneBot];
        return [{ id: 10001 }, { id: 10002 }, { id: 10003 }];
      },
      async sendGroup(group, message, received) {
        expect(received).toBe(signal);
        expect(message).toContain("通知");
        attempts.push(`milky:${group}`);
        if (group === 10003) throw new Error("发出后断开");
        return 15;
      },
    },
  ];
  const host: NoticeDeliveryHost = {
    onlineBots() { throw new Error("应使用快照账号"); },
    async listGroups() { throw new Error("应使用快照成员查询"); },
    async sendGroup() { throw new Error("应使用快照发送"); },
    async deleteMessage() { throw new Error("应使用明确的适配器撤回"); },
    noticeAccounts: () => accounts,
    async recallGroupMessage(...args) { recalls.push(args); },
  };
  const delivery = createNoticeDelivery(client, host, async () => {});
  expect(await delivery.push(signal)).toMatchObject({ selected: 3, receipts: [
    { botId: 20001, groupId: 10001, state: "confirmed", messageId: -15 },
    { adapter: "milky", botId: 20002, groupId: 10002, state: "confirmed", messageId: 15 },
    { adapter: "milky", botId: 20002, groupId: 10003, state: "unknown" },
  ] });
  expect(attempts).toEqual(["onebot:10001", "milky:10002", "milky:10003"]);
  const readStored = async (group: number) =>
    JSON.parse(await exec("HGET", `notice:delivery:${noticeId}`, String(group)) as string);
  expect(await readStored(10001)).toEqual({ botId: 20001, groupId: 10001, state: "confirmed", messageId: -15 });
  const milkyConfirmed = await readStored(10002);
  expect(milkyConfirmed).toEqual({
    adapter: "milky", botId: 20002, groupId: 10002, state: "unknown", milkyState: "confirmed", messageId: 15,
  });
  expect(await readStored(10003)).toEqual({ adapter: "milky", botId: 20002, groupId: 10003, state: "unknown" });
  // The legacy recall filter and Redis claim script inspect only `state`.
  expect(milkyConfirmed.state === "confirmed" && Number.isSafeInteger(milkyConfirmed.messageId)).toBe(false);
  expect(milkyConfirmed.state === "not-sent").toBe(false);
  expect(await delivery.push(signal)).toMatchObject({ alreadyClaimed: 3, receipts: [] });
  expect(attempts).toHaveLength(3);
  expect(await delivery.recall({ noticeId, signal })).toMatchObject({ selected: 2 });
  expect(recalls).toEqual([
    ["onebot", 20001, 10001, -15, signal], ["milky", 20002, 10002, 15, signal],
  ]);
  expect(await readStored(10002)).toEqual({ ...milkyConfirmed, recall: "confirmed" });
  const reopened = createNoticeDelivery(client, host, async () => {});
  expect((await reopened.receipts(noticeId))?.receipts[1]).toEqual({
    adapter: "milky", botId: 20002, groupId: 10002, state: "confirmed", messageId: 15, recall: "confirmed",
  });
  expect(await reopened.recall({ noticeId, signal })).toMatchObject({ selected: 2, alreadyClaimed: 2 });
  expect(recalls).toHaveLength(2);
});

test.skipIf(!available)("未激活的公告模块保留同步命令，销毁时取消所有待启动日程", async () => {
  const file = join(temp!, "held-notice.yaml");
  await writeFile(file, "enableSchedule: true\nscheduleTime: '0:00-23:59'\n");
  const previous = Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG;
  const callbacks = new Set<() => void>();
  const oldHost: NoticeDeliveryHost = {
    onlineBots: () => [],
    async listGroups() { return []; },
    async sendGroup() { throw new Error("不应调用旧路径"); },
    async deleteMessage() {},
  };
  try {
    Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG = file;
    const module = createModule({
      groups: oldHost,
      noticeGroups: { ...oldHost, noticeAccounts() { return []; } },
      whenNoticeActive(start) {
        callbacks.add(start);
        return () => { callbacks.delete(start); };
      },
    });
    expect(callbacks.size).toBe(3);
    expect(typeof (module.commands as Record<string, unknown>)["#星铁推送公告"]).toBe("function");
    try {
      expect(await exec("KEYS", "notice:schedule:*")).toEqual([]);
    } finally {
      await module.dispose?.();
    }
    expect(callbacks.size).toBe(0);
  } finally {
    if (previous === undefined) delete Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG;
    else Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG = previous;
  }
});
