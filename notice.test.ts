import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNoticePlugin } from "./index.ts";
import { createNoticeStore, type NoticeRedis } from "./store.ts";
import { createNoticeDelivery, type NoticeDeliveryHost } from "./delivery.ts";
import { createTargetStore, selectNoticeGroups } from "./targets.ts";

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
  expect(replies.every((reply) => /公告已发布，编号 \d{5}[A-Z]{3}/u.test(reply))).toBe(true);
  const currentId = await exec("GET", "notice:current") as string;
  expect(replies.some((reply) => reply.includes(currentId))).toBe(true);
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
  const sent: Array<{ groupId: number; content: string }> = [];
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
