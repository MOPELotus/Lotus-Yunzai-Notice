import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
import { readFileSync } from "node:fs";
import type { ActivityGame } from "./mys-activity-source.ts";
import { announcementGameKeys, type AnnouncementGame } from "./mys-announcement-source.ts";

export interface AnnouncementTarget {
  readonly botId: number;
  readonly groupId: number;
}

export interface AnnouncementConfig {
  readonly cron: string;
  readonly maxNum: number;
  readonly ban: Readonly<Partial<Record<AnnouncementGame, RegExp>>>;
  readonly targets: Readonly<Record<AnnouncementGame, readonly AnnouncementTarget[]>>;
  readonly infoTargets: Readonly<Record<AnnouncementGame, readonly AnnouncementTarget[]>>;
  readonly activityTargets: Readonly<Record<ActivityGame, readonly AnnouncementTarget[]>>;
}

export type AnnouncementConfigReader = () => AnnouncementConfig;
export const announcementConfigPaths = ["config/mys.pushNews.yaml", "config/config/mys.pushNews.yaml",
  "plugins/genshin/config/mys.pushNews.yaml"] as const;

const defaultBan = {
  gs: $t("mys-announcement-config.text_33fdfe8eac"),
  sr: $t("mys-announcement-config.text_24feea59e9"),
  zzz: $t("mys-announcement-config.text_e97f29d854"),
  bbb: $t("mys-announcement-config.text_806ef05927"),
  bb: $t("mys-announcement-config.text_7e65230203"),
  wd: $t("mys-announcement-config.text_0cbb0c83be"),
};

export function numberId(value: unknown): number | undefined {
  const id = typeof value === "string" && /^[1-9]\d*$/u.test(value) ? Number(value) : value;
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return id;
}

function mapping(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error($t("mys-announcement-config.text_367402e74f"));
  return value as Record<string, unknown>;
}

export function configuredTargets(value: unknown): AnnouncementTarget[] {
  const targets: AnnouncementTarget[] = [];
  for (const [bot, groups] of Object.entries(mapping(value))) {
    const botId = numberId(bot);
    if (!botId || !Array.isArray(groups)) throw new Error($t("mys-announcement-config.text_5a55715852"));
    for (const groupId of new Set(groups.map(numberId))) {
      if (!groupId) throw new Error($t("mys-announcement-config.text_f5b8efe05f"));
      targets.push({ botId, groupId });
    }
  }
  return targets;
}

export function parseAnnouncementConfig(yaml = "{}"): AnnouncementConfig {
  const config = mapping(Bun.YAML.parse(yaml));
  const cron = config.pushTime ?? "0 0/5 * * * ?";
  const maxNum = config.maxNum ?? 1;
  if (typeof cron !== "string" || typeof maxNum !== "number" || !Number.isSafeInteger(maxNum) || maxNum < 0) {
    throw new Error($t("mys-announcement-config.text_47bc57916c"));
  }

  const words = mapping(config.banWord);
  const ban: Partial<Record<AnnouncementGame, RegExp>> = {};
  for (const game of announcementGameKeys) {
    const pattern = words[game] ?? defaultBan[game];
    if (typeof pattern === "string" && pattern) ban[game] = new RegExp(pattern, "u");
  }
  const targets = groupedTargets("announceGroup");
  const infoTargets = groupedTargets("infoGroup");
  function groupedTargets(suffix: "announceGroup" | "infoGroup") {
    return Object.fromEntries(announcementGameKeys.map(game => [game, configuredTargets(config[game + suffix])])) as
      Record<AnnouncementGame, AnnouncementTarget[]>;
  }
  const activityTargets: Record<ActivityGame, AnnouncementTarget[]> = { gs: [], sr: [] };
  for (const game of ["gs", "sr"] as const) {
    try {
      activityTargets[game] = configuredTargets(config[`${game}ActivityPush`]);
    } catch {
      console.warn($t("mys-announcement-config.text_5d53a57803", { "value1": game === "gs" ? $t("mys-announcement-config.text_d1597c51ed") : $t("mys-announcement-config.text_a2927891f0") }));
    }
  }
  return { cron, maxNum, ban, targets, infoTargets, activityTargets };
}

function readAnnouncementYaml(root: URL): string {
  for (const path of announcementConfigPaths) {
    try {
      return readFileSync(new URL(path, root), "utf8");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return "{}";
}

export function configuredAnnouncements(root: URL): AnnouncementConfigReader {
  let previous: { yaml: string; config: AnnouncementConfig } | undefined;
  return () => {
    const yaml = readAnnouncementYaml(root);
    if (previous?.yaml === yaml) return previous.config;
    const config = parseAnnouncementConfig(yaml);
    previous = { yaml, config };
    return config;
  };
}
