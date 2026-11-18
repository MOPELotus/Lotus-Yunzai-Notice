import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NoticeReply } from "./content.ts";
import { createModule, createNoticePlugin } from "./index.ts";
import { createNoticeStore, type NoticeRedis } from "./store.ts";
import { createNoticeDelivery, type NoticeDeliveryHost } from "./delivery.ts";
import { createTargetStore, selectNoticeGroups } from "./targets.ts";
import { parseNoticeSchedule, startNoticeScheduler } from "./schedule.ts";

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
    { type: "text", text: `【当前公告】 ${current.id}\n${current.timestamp}\n` }, ...body,
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
    { type: "text", text: `【当前公告】 ${current.id}\n${current.timestamp}\n` },
    { type: "image", file: inline },
  ]);
  expect(await commands["#发布公告"]("已切换到普通文字", owner)).toContain("公告已发布");
  expect(await commands["#历史公告"](current.id)).toEqual([
    { type: "text", text: `【历史公告】 ${current.id}\n${current.timestamp}\n` },
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
