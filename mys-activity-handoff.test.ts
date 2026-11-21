import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActivityExpiryNotices } from "./mys-activity.ts";
import { parseAnnouncementConfig } from "./mys-announcement-config.ts";
import type { NoticeRedis } from "./store.ts";

const server = Bun.which("valkey-server");
const cli = Bun.which("valkey-cli");
const date = "2026-11-21";
const now = Date.parse(`${date}T11:00:00+08:00`);
const event = { title: "临期活动", subtitle: "活动样本", end: now + 60_000 };
const queue = "Yz:apgl:70";
const initialQueue = JSON.stringify({ date, GroupList: [90] });
const receipt = `lotus-yunzai:notice:mys:expiry:${date}:gs:90:` +
  createHash("sha256").update(JSON.stringify([event.title,event.end])).digest("hex");
const settings = "lotus-yunzai:notice:mys:gs:activity-targets";
const admin = { isMaster: false, message_type: "group", self_id: 70, group_id: 90,
  member: { is_admin: true, is_owner: false } };

type Executor = (...args: string[]) => Promise<unknown>;

async function duringWait(run: (fixture: {
  exec: Executor;
  attempts: Array<[number, number]>;
  service: ReturnType<typeof createActivityExpiryNotices>;
  finish(): Promise<void>;
}) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "activity-notice-"));
  const socket = join(directory, "valkey.sock");
  const daemon = Bun.spawn([server!, "--port", "0", "--unixsocket", socket,
    "--save", "", "--appendonly", "no", "--dir", directory], { stdout: "ignore", stderr: "ignore" });
  async function exec(...args: string[]) {
    const child = Bun.spawn([cli!, "-s", socket, "--json", ...args], { stdout: "pipe", stderr: "pipe" });
    const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (code !== 0 || error || output.startsWith("error:")) throw new Error("测试 Valkey 命令失败。");
    return JSON.parse(output) as unknown;
  }
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const attempts: Array<[number, number]> = [];
  let service: ReturnType<typeof createActivityExpiryNotices> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await exec("PING").catch(() => undefined) === "PONG") break;
      if (attempt === 49) throw new Error("测试 Valkey 未启动。");
      await Bun.sleep(20);
    }
    const redis: NoticeRedis = {
      get: async key => await exec("GET", key) as string | null,
      hGetAll: async key => await exec("HGETALL", key) as Record<string, string>,
      lRange: async (key, first, last) => await exec("LRANGE", key, String(first), String(last)) as string[],
      eval: (script, { keys, arguments: args }) => exec("EVAL", script, String(keys.length), ...keys, ...args),
    };
    await exec("SET", queue, initialQueue, "EX", "7200");
    const config = parseAnnouncementConfig("pushTime: '0 0 10 1 1 *'\ngsActivityPush: { '70': [90] }\n");
    service = createActivityExpiryNotices(() => redis, {
      onlineBots: () => [70],
      async listGroups() { return [{ id: 90 }]; },
      async sendGroup(botId, groupId) { attempts.push([botId, groupId]); return 901; },
      async deleteMessage() {},
    }, config, undefined, async () => [event], () => now, undefined, async () => {
      entered.resolve();
      await released.promise;
    });
    const pending = service.run();
    await Promise.race([entered.promise, new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("活动推送未进入发送前的等待。")), 3_000);
    })]);
    clearTimeout(timeout);
    expect(JSON.parse(await exec("GET", receipt) as string)).toMatchObject({ state: "pending", botId: 70 });
    expect(attempts).toEqual([]);
    await run({ exec, attempts, service, async finish() { released.resolve(); await pending; } });
  } finally {
    clearTimeout(timeout);
    released.resolve();
    await service?.dispose();
    daemon.kill("SIGTERM");
    await daemon.exited;
    await rm(directory, { force: true, recursive: true });
  }
}

test.skipIf(!server || !cli)("群管在活动发送前关闭推送，撤销占位并保留可重新开启的群", async () => {
  await duringWait(async ({ exec, attempts, service, finish }) => {
    const expiry = await exec("PEXPIRETIME", queue);
    expect(await service.commands["#原神关闭到期活动推送"]!("", admin)).toBe("原神活动到期推送已关闭。");
    expect(await exec("HGET", settings, "70:90")).toBe("off");
    await finish();
    expect(attempts).toEqual([]);
    expect(await exec("GET", receipt)).toBeNull();
    expect(await exec("GET", queue)).toBe(initialQueue);
    expect(await exec("PEXPIRETIME", queue)).toBe(expiry);

    expect(await service.commands["#原神开启到期活动推送"]!("", admin)).toBe("原神活动到期推送已开启。");
    await service.run();
    expect(attempts).toEqual([[70, 90]]);
    expect(JSON.parse(await exec("GET", receipt) as string)).toEqual({ state: "confirmed", botId: 70, messageId: 901 });
    expect(JSON.parse(await exec("GET", queue) as string)).toEqual({ date, GroupList: [] });
  });
});

test.skipIf(!server || !cli)("活动等待时队列变更，释放自己的占位并保留新队列", async () => {
  await duringWait(async ({ exec, attempts, finish }) => {
    const updated = JSON.stringify({ date, GroupList: [91, 90] });
    await exec("SET", queue, updated, "KEEPTTL");
    await finish();
    expect(attempts).toEqual([]);
    expect(await exec("GET", receipt)).toBeNull();
    expect(await exec("GET", queue)).toBe(updated);
  });
});

test.skipIf(!server || !cli)("活动等待时占位已被替换，保留其他进程的回执且不发送", async () => {
  await duringWait(async ({ exec, attempts, finish }) => {
    const updated = JSON.stringify({ state: "confirmed", botId: 71, messageId: 902 });
    await exec("SET", receipt, updated, "KEEPTTL");
    await finish();
    expect(attempts).toEqual([]);
    expect(await exec("GET", receipt)).toBe(updated);
    expect(await exec("GET", queue)).toBe(initialQueue);
  });
});
