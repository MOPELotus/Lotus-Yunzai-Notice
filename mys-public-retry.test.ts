import { expect, test } from "bun:test";
import { readPublicMys } from "./mys-public-request.ts";
const url = new URL("https://bbs-api.miyoushe.com/fixture");
const alternate = new URL("https://bbs-api.mihoyo.com/fixture");
const signal = () => new AbortController().signal;

test("公开接口单源总三次，主备切换共享三次预算", async () => {
  for (const backup of [undefined, alternate]) {
    const calls: string[] = [];
    const result = await readPublicMys({ url, alternate: backup, signal: signal() }, async address => {
      calls.push(address.hostname);
      if (calls.length === 1) return new Response(null, { status: 502 });
      if (calls.length === 2) throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
      return Response.json({ value: 42 });
    }, response => response.json());
    expect(result).toEqual({ value: 42 });
    expect(calls).toEqual(backup ? [url.hostname, backup.hostname, backup.hostname] : Array(3).fill(url.hostname));
  }
});

test("公开接口永久拒绝、Retry-After、解码失败和取消不被重放", async () => {
  for (const response of [new Response(null, { status: 403 }),
    new Response(null, { status: 503, headers: { "Retry-After": "60" } })]) {
    let calls = 0;
    expect(await readPublicMys({ url, alternate, signal: signal() }, async () => { calls++; return response; },
      async response => response.status)).toBe(response.status);
    expect(calls).toBe(1);
  }
  let calls = 0;
  await expect(readPublicMys({ url, alternate, signal: signal() }, async () => {
    calls++; return new Response("invalid-json");
  }, response => response.json())).rejects.toThrow();
  expect(calls).toBe(1);
  const controller = new AbortController(); calls = 0;
  await expect(readPublicMys({ url, alternate, signal: controller.signal }, async () => {
    calls++; controller.abort(); throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
  }, response => response.json())).rejects.toThrow();
  expect(calls).toBe(1);
});
