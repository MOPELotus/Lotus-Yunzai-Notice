import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
// Public game announcement list shapes from TRSS Genshin 0290a17, model/mysNews.js.
const urls = {
  gs: "https://hk4e-api.mihoyo.com/common/hk4e_cn/announcement/api/getAnnList?game=hk4e&game_biz=hk4e_cn&lang=zh-cn&bundle_id=hk4e_cn&platform=pc&region=cn_gf01&level=55&uid=100000000",
  sr: "https://hkrpg-api.mihoyo.com/common/hkrpg_cn/announcement/api/getAnnList?game=hkrpg&game_biz=hkrpg_cn&lang=zh-cn&auth_appid=announcement&authkey_ver=1&bundle_id=hkrpg_cn&channel_id=1&level=65&platform=pc&region=prod_gf_cn&sdk_presentation_style=fullscreen&sdk_screen_transparent=true&sign_type=2&uid=100000000",
};

export type ActivityGame = keyof typeof urls;

export interface UpcomingExpiry {
  readonly title: string;
  readonly subtitle: string;
  readonly end: number;
  readonly image?: string;
}

const imageHosts = new Set(["sdk-webstatic.mihoyo.com", "uploadstatic.mihoyo.com", "sdkstatic.mihoyo.com"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
}

function rows(value: unknown) {
  return Array.isArray(value) ? value.map(record) : [];
}

function label(value: unknown, limit = 200) {
  return typeof value === "string" ? value.replace(/<[^>]+>|[\u0000-\u001f\u007f-\u009f]/gu," ")
    .trim().slice(0,limit).toWellFormed() : "";
}

function officialImage(value: unknown) {
  if (typeof value !== "string" || value.length > 4096) return;
  const url = URL.parse(value);
  if (url?.protocol === "https:" && imageHosts.has(url.hostname) && !url.username && !url.password && !url.port) return url.href;
}

function chinaDate(value: unknown) {
  if (typeof value !== "string") return;
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s(\d{1,2}):(\d{2})(?::(\d{2}))?$/u.exec(value.trim());
  if (!match) return;
  const [year, month, day, hour, minute, second] = match.slice(1).map(part=>Number(part ?? 0)) as [number,number,number,number,number,number];
  if (year < 2023 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return;
  const time = Date.UTC(year, month-1, day, hour, minute, second);
  if (new Date(time).getUTCDate() === day) return time - 8*3_600_000;
}

export function readUpcomingExpiry(game: ActivityGame, value: unknown, now: number): UpcomingExpiry[] {
  const result = record(value), data = record(result.data);
  const list = game === "gs" ? rows(data.list)[1]?.list : rows(rows(data.pic_list)[0]?.type_list)[0]?.list;
  if (result.retcode !== 0 || !Array.isArray(list)) throw new Error($t("mys-activity-source.text_c7312bc51e"));
  const events: UpcomingExpiry[] = [];
  for (const item of rows(list)) {
    const title = label(item.title);
    const end = chinaDate(item.end_time);
    if (!title || end === undefined || end <= now || end - now >= 48*3_600_000) continue;
    if (game === "gs" && (!label(item.tag_label).includes("活动") || /传说任务|游戏公告/u.test(title))) continue;
    const subtitle = game === "gs" ? label(item.subtitle) || title : title;
    const image = officialImage(game === "gs" ? item.banner : item.img);
    events.push({ title, subtitle, end, image });
  }
  return events;
}

export function createActivityExpirySource(transport: typeof fetch = fetch) {
  return async (game: ActivityGame, signal: AbortSignal, now: number) => {
    const response = await transport(urls[game], {
      method:"GET", redirect:"error", signal:AbortSignal.any([signal,AbortSignal.timeout(10_000)]),
      headers:{ Accept:"application/json" },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error($t("mys-activity-source.text_b8eabededa"));
    }
    return readUpcomingExpiry(game,await response.json(),now);
  };
}
