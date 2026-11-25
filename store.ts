import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
import { decodeNoticeSegments, encodeNoticeContent, type NoticeReply, type NoticeSegment } from "./content.ts";

const currentKey = "notice:current";
const historyKey = "notice:history";
const announcementPrefix = "notice:ann:";
const validId = /^\d{5}[A-Z]{3}$/u;

export interface NoticeRedis {
  get(key: string): Promise<string | null>;
  lRange(key: string, first: number, last: number): Promise<string[]>;
  hGetAll(key: string): Promise<Record<string, string>>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface Notice {
  readonly id: string;
  readonly content: string;
  readonly creator: string;
  readonly status?: string;
  readonly timestamp: string;
  readonly segments?: readonly NoticeSegment[];
  readonly segmentSource?: string;
}

export type NoticeWriteReceipt =
  | { readonly state: "confirmed"; readonly notice: Notice }
  | { readonly state: "missing" | "rejected" | "unknown" };

function activeNotice(id: string, entry: Record<string, string>): Notice | undefined {
  if (!entry.content?.trim() || !entry.timestamp || !entry.creator ||
      [$t("store.text_0462a8aa70"), "recalled"].includes(entry.status ?? "")) return;

  const notice = { id, content: entry.content, creator:entry.creator, status:entry.status, timestamp: entry.timestamp };
  if (!entry.segments) return notice;
  const segments = decodeNoticeSegments(entry.segments, entry.content);
  return { ...notice, segmentSource: entry.segments, ...(segments ? { segments } : {}) };
}

// All mutations are serialized by Valkey. Check key types before issuing the
// first mutation because errors during a Lua script do not roll back writes.
const mutateScript = $t("store.text_3d8bc758d0");

export function createNoticeStore(redis: NoticeRedis) {
  async function mutate(
    op: "publish" | "edit" | "recall",
    id = "",
    { text, segments } = { text: "", segments: "" },
    creator = "",
    time = new Date(),
  ) {
    const iso = new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium",
    }).format(time);
    return redis.eval(mutateScript, {
      keys: [currentKey, historyKey],
      arguments: [op, announcementPrefix, id, text, creator, iso, String(time.getTime()), segments],
    });
  }

  async function write(content: NoticeReply, creator?: string): Promise<NoticeWriteReceipt> {
    const op = creator === undefined ? "edit" : "publish";
    const { text, segments } = encodeNoticeContent(content);
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const id = op === "publish" ? newNoticeId() : "";
        const receipt = await mutate(op, id, { text, segments }, creator);
        if (receipt === "collision" && op === "publish") continue;
        if (receipt === "rejected") return { state: "rejected" };
        if ((receipt === null || receipt === false) && op === "edit") return { state: "missing" };
        if (Array.isArray(receipt) && receipt.length === 4) {
          const [savedId, savedCreator, timestamp, status] = receipt;
          if (typeof savedId === "string" && validId.test(savedId) && (!id || (id === savedId && creator === savedCreator)) &&
              typeof savedCreator === "string" && typeof timestamp === "string" && typeof status === "string") {
            const notice = activeNotice(savedId, { creator: savedCreator, timestamp, status, content: text, segments });
            if (notice) return { state: "confirmed", notice };
          }
        }
        // A missing or malformed receipt does not rule out a committed write.
        return { state: "unknown" };
      }
      return { state: "rejected" };
    } catch {
      return { state: "unknown" };
    }
  }

  function newNoticeId() {
    const bytes = crypto.getRandomValues(new Uint32Array(4));
    return String(10_000 + bytes[0]! % 90_000) + String.fromCharCode(...[...bytes.slice(1)].map((value) => 65 + value % 26));
  }

  return {
    async current(unpushedOnly = false) {
      const id = await redis.get(currentKey);
      if (!id || !validId.test(id)) return;
      const entry = await redis.hGetAll(announcementPrefix + id);
      if (unpushedOnly && (entry.status !== "当前" || entry.push !== "未推送")) return;
      return activeNotice(id, entry);
    },

    async history() {
      const ids = [...new Set(await redis.lRange(historyKey, 0, 49))].filter((id) => validId.test(id));
      const records = await Promise.all(ids.map((id) => redis.hGetAll(announcementPrefix + id)));
      return records.flatMap((record, index) => {
        const id = ids[index];
        const notice = id && activeNotice(id, record);
        return notice ? [notice] : [];
      });
    },

    write,
    async recall() {
      const receipt = await mutate("recall");
      if (receipt === "rejected") throw new Error($t("store.text_87695daea3"));
      return typeof receipt === "string" && validId.test(receipt);
    },
  };
}
