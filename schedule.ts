import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
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

const logLevels = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type NoticeLogLevel = keyof typeof logLevels;
type NoticeLog = (level: NoticeLogLevel, text: string) => void;

export function isNoticeLogLevel(value: unknown): value is NoticeLogLevel {
  return typeof value === "string" && Object.hasOwn(logLevels, value);
}

export function noticeLogger(minimum: NoticeLogLevel): NoticeLog {
  return (level, text) => {
    if (logLevels[level] >= logLevels[minimum]) console[level](`[notice] ${text}`);
  };
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
    throw new Error($t("schedule.text_c548323c28"));
  }
  return parsed as Record<string, unknown>;
}

function scheduleWindow(config: Record<string, unknown>): Window | undefined {
  const { enableSchedule, scheduleTime = "8:00-8:30" } = config;
  if (enableSchedule === false) return;
  if (enableSchedule !== undefined && enableSchedule !== true) {
    throw new Error($t("schedule.text_55b78ceb8a"));
  }
  const hours = typeof scheduleTime === "string"
    ? /^(\d{1,2}):(\d{2})\s*-\s*(?:(\d{1,2}):)?(\d{1,2})$/u.exec(scheduleTime.trim())
    : null;
  if (!hours) throw new Error($t("schedule.text_0d417f1d3a"));

  const startHour = Number(hours[1]);
  const startMinute = Number(hours[2]);
  const endHour = hours[3] === undefined ? startHour : Number(hours[3]);
  const endMinute = Number(hours[4]);
  const start = startHour * 60 + startMinute;
  const end = endHour * 60 + endMinute;
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59 || end < start) {
    throw new Error($t("schedule.text_a417ac2338"));
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
  return configuredNoticeValue(root, explicit, scheduleWindow, (left, right) =>
    left?.start === right?.start && left?.end === right?.end, $t("schedule.text_a25c6b407b"));
}

export function configuredNoticeLogLevel(
  root = new URL("../../", import.meta.url),
  explicit = Bun.env.LOTUS_NOTICE_SCHEDULE_CONFIG,
): NoticeLogLevel {
  return configuredNoticeValue(root, explicit, ({ logger }) => isNoticeLogLevel(logger) ? logger : "info",
    (left, right) => left === right, $t("schedule.text_7e5a6d7f20")) ?? "info";
}

function configuredNoticeValue<T>(root: URL, explicit: string | undefined, project: (config: Record<string, unknown>) => T,
  equal: (left: T | undefined, right: T | undefined) => boolean, conflict: string): T | undefined {
  if (explicit) return project(scheduleMapping(readFileSync(explicit, "utf8")));
  const current = optionalScheduleFile(new URL("config/notice.yaml", root));
  if (current !== undefined) return project(scheduleMapping(current));

  let foundLegacy = false;
  let value: T | undefined;
  for (const name of ["Notice-plugin", "notice-plugin"]) {
    const legacy = new URL(`plugins/${name}/config/`, root);
    const settings = optionalScheduleFile(new URL("config.yaml", legacy));
    const defaults = optionalScheduleFile(new URL("config_default.yaml", legacy));
    if (settings === undefined && defaults === undefined) continue;
    const candidate = project({
      ...scheduleMapping(defaults ?? "{}", true),
      ...scheduleMapping(settings ?? "{}", true),
    });
    if (foundLegacy && !equal(candidate, value)) throw new Error(conflict);
    value = candidate;
    foundLegacy = true;
  }
  return value;
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

const claimDay = $t("schedule.text_e3ad87f7b8");

const finishDay = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1
`;

async function deliverScheduled(
  redis: NoticeRedis, host: NoticeDeliveryHost, date: string, signal: AbortSignal, inSlot: () => boolean, log: NoticeLog,
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
    log("info", $t("schedule.text_303afbe194", { "noticeId": noticeId }));
    const result = await createNoticeDelivery(redis, host).push(signal, notice, accounts);
    state = result.stopped ?? (result.selected ? "completed" : "no-targets");
    const confirmed = result.receipts.filter(receipt => receipt.state === "confirmed").length;
    const level = result.stopped === "storage-error" ? "error" : result.stopped || result.discoveryFailures ? "warn" : "info";
    log(level, $t("schedule.text_3782c14324", { "noticeId": noticeId, "confirmed": confirmed, "selected": result.selected, "alreadyClaimed": result.alreadyClaimed }));
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
  log = noticeLogger("info"),
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
        ? deliverScheduled(redis, host, slot.date, controller.signal, inSlot, log)
        : Promise.resolve()).catch(() => {
        log("warn", $t("schedule.text_e0583bdb59"));
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
