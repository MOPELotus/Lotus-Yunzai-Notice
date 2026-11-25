import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
import { announcementGames, postImage, type AnnouncementGame } from "./mys-announcement-source.ts";
import { readPublicMys, type PublicMysTransport } from "./mys-public-request.ts";

const catalogueLimit = 2 * 1024 * 1024;
const cacheTime = 60 * 60_000;
const retryTime = 30_000;
const validName = /^[^()<>\p{Cc}\p{Cf}]{1,80}$/u;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function* emoticonTokens(text: string) {
  let cursor = 0;
  for (;;) {
    const start = text.indexOf("_(", cursor);
    if (start < 0) return;
    const end = text.indexOf(")", start + 2);
    if (end < 0) return;
    cursor = end + 1;
    const name = text.slice(start + 2, end);
    if (validName.test(name)) yield { start, end: cursor, name };
  }
}

async function decodeCatalogue(response: Response) {
  if (!response.ok || response.redirected || !response.body || Number(response.headers.get("Content-Length")) > catalogueLimit) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error($t("mys-emoticon-source.text_7431368a24"));
  }
  const reader = response.body.getReader();
  const utf8 = new TextDecoder();
  let bytes = 0;
  let json = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > catalogueLimit) {
        await reader.cancel();
        throw new Error($t("mys-emoticon-source.text_728b033fab"));
      }
      json += utf8.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  const result = record(JSON.parse(json + utf8.decode()));
  const groups = record(result.data).list;
  if (result.retcode !== 0 || !Array.isArray(groups)) throw new Error($t("mys-emoticon-source.text_d0e43a0917"));
  const icons = new Map<string, string>();
  for (const entry of groups) {
    const group = record(entry);
    if (!postImage(group.icon)) continue;
    for (const value of list(group.list)) {
      const { name, icon } = record(value);
      const url = postImage(icon);
      if (url && typeof name === "string" && validName.test(name)) icons.set(name, url);
    }
  }
  return icons;
}

export function createEmoticonSource(transport: PublicMysTransport, now = Date.now) {
  const current = new Map<AnnouncementGame, { until: number; catalogue?: ReadonlyMap<string, string> }>();
  const pending = new Map<AnnouncementGame, Promise<ReadonlyMap<string, string> | undefined>>();
  return async (game: AnnouncementGame) => {
    const cached = current.get(game);
    if (cached && cached.until > now()) return cached.catalogue;
    const underway = pending.get(game);
    if (underway) return underway;
    const url = new URL("https://bbs-api.miyoushe.com/misc/api/emoticon_set");
    url.searchParams.set("gids", String(announcementGames[game].id));
    const alternate = new URL(url.href);
    alternate.hostname = "bbs-api.mihoyo.com";
    const request = readPublicMys({ url, alternate, accept: "application/json", phaseMs: 2_200, signal: AbortSignal.timeout(4_500) },
      transport, decodeCatalogue).then(catalogue => {
      current.set(game, { until: now() + cacheTime, catalogue });
      return catalogue;
    }, () => {
      current.set(game, { until: now() + retryTime });
      return undefined;
    }).finally(() => { pending.delete(game); });
    pending.set(game, request);
    return request;
  };
}
