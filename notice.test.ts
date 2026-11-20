import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { NoticeReply } from "./content.ts";
import { createModule, createNoticePlugin } from "./index.ts";
import { createNoticeStore, type NoticeRedis } from "./store.ts";
import { parseAnnouncementConfig } from "./mys-announcement-config.ts";
import { createAnnouncementSource, type AnnouncementGame } from "./mys-announcement-source.ts";
import { createOfficialAnnouncements } from "./mys-announcement.ts";
import { createNoticeDelivery, type NoticeDeliveryHost } from "./delivery.ts";
import { createTargetStore, selectNoticeGroups } from "./targets.ts";
import { configuredNoticeSchedule, parseNoticeSchedule, startNoticeScheduler } from "./schedule.ts";

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
  const defaults = 'enableSchedule: true\r\nscheduleTime: "8:00-8:30"\r\n';
  try {
    expect(configuredNoticeSchedule(root, "")).toBeUndefined();
    await Promise.all([mkdir(legacy, { recursive: true }), mkdir(lower, { recursive: true }),
      mkdir(join(fixture, "config"))]);
    await writeFile(join(legacy, "config_default.yaml"), defaults);
    expect(configuredNoticeSchedule(root, "")).toEqual({ start: 480, end: 510 });
    await writeFile(join(legacy, "config.yaml"), 'scheduleTime: "11:10-11:12"\n');
    expect(configuredNoticeSchedule(root, "")).toEqual({ start: 670, end: 672 });
    await writeFile(join(legacy, "config.yaml"), "enableSchedule: false\n");
    expect(configuredNoticeSchedule(root, "")).toBeUndefined();
    await writeFile(join(lower, "config.yaml"), 'scheduleTime: "11:10-11:12"\n');
    expect(() => configuredNoticeSchedule(root, "")).toThrow("两处旧公告定时配置不一致");
    await writeFile(current, "enableSchedule: false\n");
    expect(configuredNoticeSchedule(root, "")).toBeUndefined();
    expect(() => configuredNoticeSchedule(root, explicit)).toThrow("ENOENT");
    await writeFile(explicit, 'scheduleTime: "2:05-2:05"\n');
    expect(configuredNoticeSchedule(root, explicit)).toEqual({ start: 125, end: 125 });
    expect(await readFile(join(legacy, "config_default.yaml"), "utf8")).toBe(defaults);
    await rm(current);
    await rm(legacy, { recursive: true });
    expect(configuredNoticeSchedule(root, "")).toEqual({ start: 670, end: 672 });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
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
  expect(await commands["#全部历史公告"]("1")).toContain(oldId);
  expect(await commands["#全部历史公告"]("1")).not.toContain("99999AAA");

  expect(await commands["#编辑公告"]("编辑后的公告", owner)).toBe("公告已更新。");
  expect(await commands["#公告"]()).toContain("编辑后的公告");
  expect(await commands["#撤回公告"]("", owner)).toBe("当前公告已撤回。");
  expect(await commands["#公告"]()).toBe("当前没有公告。");
  expect(await commands["#历史公告"](currentId)).toBe("没有找到对应的历史公告。");
  expect(await commands["#全部历史公告"]("1")).not.toContain(currentId);
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
  const sent: Array<{ groupId: number; content: NoticeReply }> = [];
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

  const sent: NoticeReply[] = [];
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
  expect(await commands["#全部历史公告"]("1")).toContain("[图片]");

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
  const sent: NoticeReply[] = [];
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
  const sends: { bot: number; group: number; body: NoticeReply }[] = [];
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

test.skipIf(!available)("旧 cron 实际触发米游社订阅，只从当前在线账号向订阅群发送", async () => {
  const wall = 1_800_000_000;
  const config = parseAnnouncementConfig("pushTime: '*/1 * * * * *'\nzzzannounceGroup: { '80': [90] }");
  const sent = Promise.withResolvers<NoticeReply>();
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

test.skipIf(!available)("未激活的公告模块保留同步命令，销毁时取消两种待启动日程", async () => {
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
    expect(callbacks.size).toBe(2);
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
