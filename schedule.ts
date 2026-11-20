import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createNoticeDelivery, noticeAccounts, type NoticeDeliveryHost } from "./delivery.ts";
import { createNoticeStore, type NoticeRedis } from "./store.ts";

const dayFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
const minute = 60_000;
const accountRetryDelay = 5_000;
const day = 1_440 * minute;
const stateKey = (date: string) => `notice:schedule:${date}`;

interface Window {
  readonly start: number;
  readonly end: number;
}

interface Clock {
  now(): number;
  schedule(callback: () => void, delay: number): () => void;
}

const clock: Clock = {
  now: Date.now,
  schedule(callback, delay) {
    const timer = setTimeout(callback, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

function scheduleMapping(yaml: string, allowEmpty = false): Record<string, unknown> {
  const parsed: unknown = Bun.YAML.parse(yaml);
  if (allowEmpty && parsed == null) return {};
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("公告定时配置须为 YAML 映射");
  }
  return parsed as Record<string, unknown>;
}

function scheduleWindow(config: Record<string, unknown>): Window | undefined {
  const { enableSchedule, scheduleTime = "8:00-8:30" } = config;
  if (enableSchedule === false) return;
  if (enableSchedule !== undefined && enableSchedule !== true) {
    throw new Error("enableSchedule 须为布尔值");
  }
  const hours = typeof scheduleTime === "string"
    ? /^(\d{1,2}):(\d{2})\s*-\s*(?:(\d{1,2}):)?(\d{1,2})$/u.exec(scheduleTime.trim())
    : null;
  if (!hours) throw new Error("scheduleTime 格式须为 HH:mm-HH:mm");

  const startHour = Number(hours[1]);
  const startMinute = Number(hours[2]);
  const endHour = hours[3] === undefined ? startHour : Number(hours[3]);
  const endMinute = Number(hours[4]);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59 || end < start) {
    throw new Error("公告定时窗口无效");
  }
  return { start, end };
}

export function parseNoticeSchedule(yaml: string): Window | undefined {
  return scheduleWindow(scheduleMapping(yaml));
}

function optionalScheduleFile(path: URL): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export function configuredNoticeSchedule(
  root = new URL("../../", import.meta.url),
  explicit = Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG,
): Window | undefined {
  if (explicit) return parseNoticeSchedule(readFileSync(explicit, "utf8"));
  const current = optionalScheduleFile(new URL("config/notice.yaml", root));
  if (current !== undefined) return parseNoticeSchedule(current);

  let foundLegacy = false;
  let window: Window | undefined;
  for (const name of ["Notice-plugin", "notice-plugin"]) {
    const legacy = new URL(`plugins/${name}/config/`, root);
    const settings = optionalScheduleFile(new URL("config.yaml", legacy));
    const defaults = optionalScheduleFile(new URL("config_default.yaml", legacy));
    if (settings === undefined && defaults === undefined) continue;
    const candidate = scheduleWindow({
      ...scheduleMapping(defaults ?? "{}", true),
      ...scheduleMapping(settings ?? "{}", true),
    });
    if (foundLegacy && (candidate?.start !== window?.start || candidate?.end !== window?.end)) {
      throw new Error("两处旧公告定时配置不一致，请在 config/notice.yaml 指定使用的窗口");
    }
    window = candidate;
    foundLegacy = true;
  }
  return window;
}

function nextSlot(now: number, window: Window) {
  const slotFor = (date: string) => {
    // China Standard Time has been UTC+08:00 since 1991.
    const midnight = Date.parse(`${date}T00:00:00+08:00`);
    const offset = createHash("sha256").update(date).digest().readUInt32BE(0) % (window.end - window.start + 1);
    return { date, at: midnight + (window.start + offset) * minute };
  };

  const today = slotFor(dayFormat.format(now));
  return now < today.at + minute ? today : slotFor(dayFormat.format(now + day));
}

const claimDay = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if ARGV[1] == '' or redis.call('GET', KEYS[2]) ~= ARGV[1] or
  redis.call('HGET', KEYS[3], 'content') ~= ARGV[2] or
  (redis.call('HGET', KEYS[3], 'segments') or '') ~= ARGV[4] or
  redis.call('HGET', KEYS[3], 'status') ~= '当前' or
  redis.call('HGET', KEYS[3], 'push') ~= '未推送' then
  redis.call('SET', KEYS[1], '{"state":"skipped"}', 'EX', 3024000)
  return -1
end
redis.call('SET', KEYS[1], ARGV[3], 'EX', 3024000)
return 1
`;

const finishDay = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1
`;

async function deliverScheduled(
  redis: NoticeRedis, host: NoticeDeliveryHost, date: string, signal: AbortSignal, inSlot: () => boolean,
): Promise<"awaiting-account" | undefined> {
  const notice = await createNoticeStore(redis).current(true);
  if (signal.aborted || !inSlot()) return;
  const accounts = noticeAccounts(host);
  if (!accounts.length) return "awaiting-account";

  const noticeId = notice?.id ?? "";
  const key = stateKey(date);
  const started = JSON.stringify({ state: "started", noticeId });
  const claim = await redis.eval(claimDay, {
    keys: [key, "notice:current", `notice:ann:${noticeId}`],
    arguments: [noticeId, notice?.content ?? "", started, notice?.segmentSource ?? ""],
  });
  if (claim !== 1 || !notice) return;

  let state = "error";
  try {
    const result = await createNoticeDelivery(redis, host).push(signal, notice, accounts);
    state = result.stopped ?? (result.selected ? "completed" : "no-targets");
  } finally {
    await redis.eval(finishDay, {
      keys: [key], arguments: [started, JSON.stringify({ state, noticeId })],
    });
  }
}

export function startNoticeScheduler(
  getRedis: () => NoticeRedis | undefined,
  host: NoticeDeliveryHost,
  window: Window,
  signal?: AbortSignal,
  timer: Clock = clock,
): () => Promise<void> {
  const controller = new AbortController();
  let cancelTimer: (() => void) | undefined;
  let active: Promise<void> | undefined;

  function stop() {
    controller.abort();
    cancelTimer?.();
  }

  function arm(earliest = timer.now()) {
    if (controller.signal.aborted) return;
    const slot = nextSlot(Math.max(earliest, timer.now()), window);
    const attemptAt = Math.max(slot.at, earliest);
    const end = slot.at + minute;
    const inSlot = () => timer.now() < end;
    cancelTimer = timer.schedule(() => {
      if (controller.signal.aborted) return;
      if (timer.now() < attemptAt) {
        arm(attemptAt);
        return;
      }
      const redis = getRedis();
      active = (redis && inSlot()
        ? deliverScheduled(redis, host, slot.date, controller.signal, inSlot)
        : Promise.resolve()).catch(() => {
        console.warn("[notice] 定时公告执行未完成。");
      }).then((result) => {
        arm(result === "awaiting-account" ? Math.min(end, timer.now() + accountRetryDelay) : end);
      });
    }, Math.max(0, attemptAt - timer.now()));
  }

  if (signal?.aborted) stop();
  else {
    signal?.addEventListener("abort", stop, { once: true });
    arm();
  }
  return async () => {
    stop();
    signal?.removeEventListener("abort", stop);
    await active;
  };
}
