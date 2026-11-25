import { expect, test } from "bun:test";

test("translated announcement copy never changes registered command names", async () => {
  const runtime = new URL("../../packages/i18n/index.ts", import.meta.url).href;
  const catalog = new URL("./i18n/zh-CN.json", import.meta.url).href;
  const commands = new URL("./target-commands.ts", import.meta.url).href;
  const source = `
    const {registerLanguage,setLanguage}=await import(${JSON.stringify(runtime)});
    const c=(await Bun.file(new URL(${JSON.stringify(catalog)})).json()).messages;
    registerLanguage('en',{notice:Object.fromEntries(Object.keys(c).map(k=>[k,'rewritten']))});setLanguage('en');
    const {createTargetCommands}=await import(${JSON.stringify(commands)});
    const handlers=createTargetCommands(()=>undefined);
    console.log(JSON.stringify({keys:Object.keys(handlers),reply:await handlers['#公告全局白名单添加']('',{isMaster:false})}));
  `;
  const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  const errors = await new Response(child.stderr).text();
  expect(await child.exited, errors).toBe(0);
  const result = JSON.parse(output);
  expect(result.keys).toContain("#公告全局白名单添加");
  expect(result.keys).toContain("#公告账号黑名单删除");
  expect(result.keys.some((key: string) => key.includes("rewritten"))).toBe(false);
  expect(result.reply).toBe("rewritten");
});
