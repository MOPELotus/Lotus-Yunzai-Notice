import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNoticePlugin } from "./index.ts";
import type { NoticeRedis } from "./store.ts";
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
