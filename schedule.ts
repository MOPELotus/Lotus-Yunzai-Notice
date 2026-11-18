import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createNoticeDelivery, type NoticeDeliveryHost } from "./delivery.ts";
import { createNoticeStore, type NoticeRedis } from "./store.ts";

const dayFormat = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
});
const minute = 60_000;
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

export function parseNoticeSchedule(yaml: string): Window | undefined {
  const parsed: unknown = Bun.YAML.parse(yaml);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("公告定时配置须为 YAML 映射");
  }
  const { enableSchedule, scheduleTime = "8:00-8:30" } = parsed as Record<string, unknown>;
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

export function configuredNoticeSchedule(): Window | undefined {
  const explicit = Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG;
  const source = explicit || new URL("../../config/notice.yaml", import.meta.url);
  let yaml: string;
  try {
    yaml = readFileSync(source, "utf8");
  } catch (error) {
    if (!explicit && error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  return parseNoticeSchedule(yaml);
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

async function deliverScheduled(redis: NoticeRedis, host: NoticeDeliveryHost, date: string, signal: AbortSignal) {
  const notice = await createNoticeStore(redis).current(true);
  if (signal.aborted) return;

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
    const result = await createNoticeDelivery(redis, host).push(signal, notice);
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
    cancelTimer = timer.schedule(() => {
      if (controller.signal.aborted) return;
      if (timer.now() < slot.at) {
        arm(slot.at);
        return;
      }
      const redis = getRedis();
      active = (redis && timer.now() < slot.at + minute
        ? deliverScheduled(redis, host, slot.date, controller.signal)
        : Promise.resolve()).catch(() => {
        console.warn("[notice] 定时公告执行未完成。");
      }).finally(() => arm(slot.at + minute));
    }, Math.max(0, slot.at - timer.now()));
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
