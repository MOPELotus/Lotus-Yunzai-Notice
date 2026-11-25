import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("notice", messageCatalog.messages);
export type NoticeSegment =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly file: string };
export type NoticeReply = string | readonly NoticeSegment[];
export type InboundNoticeSegment = Readonly<{ type: string; [key: string]: unknown }>;

const maxTextCharacters = 2_000;
const maxImages = 5;
// Aggregate encoded image data, approximately 1 MiB of binary content.
const maxImageAddressLength = 1_398_104;

function imageAddress(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > maxImageAddressLength) return;
  if (value.startsWith("base64://")) {
    const data = value.slice("base64://".length);
    return data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(data) ? value : undefined;
  }
  if (value.length > 4_096 || /[\s\u0000-\u001f]/u.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password) return value;
  } catch {
    return;
  }
}

function limits(parts: readonly NoticeSegment[]): string | undefined {
  let characters = 0;
  let images = 0;
  let imageAddressLength = 0;
  let hasText = false;
  for (const part of parts) {
    if (part.type === "text") {
      characters += [...part.text].length;
      hasText ||= Boolean(part.text.trim());
    } else {
      images++;
      imageAddressLength += part.file.length;
    }
  }
  if (!hasText && !images) return $t("content.text_031866ba52");
  if (characters > maxTextCharacters) return $t("content.text_52b72bd39c", { "maxTextCharacters": maxTextCharacters });
  if (images > maxImages || imageAddressLength > maxImageAddressLength) return $t("content.text_58d7572414");
}

function fold(parts: readonly NoticeSegment[]): NoticeReply {
  return parts.some((part) => part.type === "image")
    ? parts : parts.map((part) => part.type === "text" ? part.text : "").join("");
}

export function parseNoticeInput(
  command: string,
  argument: string,
  message?: string | readonly InboundNoticeSegment[],
  allowAdjacentText = false,
): { content: NoticeReply } | { error: string } {
  if (message === undefined || typeof message === "string") {
    const error = limits([{ type: "text", text: argument }]);
    return error ? { error } : { content: argument };
  }

  let start = 0;
  while (message[start]?.type === "at" || message[start]?.type === "reply") start++;
  let leadingText = "";
  while (message[start]?.type === "text") {
    const candidate = message[start++]?.text;
    if (typeof candidate !== "string") return { error: $t("content.text_c7aa29358f") };
    leadingText += candidate;
  }
  const head = leadingText.trimStart();
  const suffix = head.slice(command.length);
  if (!head.startsWith(command) || (!allowAdjacentText && suffix && !/^\s/u.test(suffix))) {
    return { error: $t("content.text_195433889b") };
  }

  const parts: NoticeSegment[] = [];
  if (suffix.trimStart()) parts.push({ type: "text", text: suffix.trimStart() });
  for (const part of message.slice(start)) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "image") {
      const file = imageAddress(part.url) ?? imageAddress(part.file);
      if (!file) return { error: $t("content.text_b57247c2d5") };
      parts.push({ type: "image", file });
    } else {
      return { error: $t("content.text_bb1f54a745") };
    }
  }
  while (parts.at(-1)?.type === "text") {
    const last = parts.pop();
    if (last?.type !== "text") break;
    const text = last.text.trimEnd();
    if (text) {
      parts.push({ type: "text", text });
      break;
    }
  }

  const error = limits(parts);
  return error ? { error } : { content: fold(parts) };
}

function plainText(parts: readonly NoticeSegment[]): string {
  return parts.map((part) => part.type === "text" ? part.text : $t("content.text_a71f445d35")).join("");
}

export function encodeNoticeContent(content: NoticeReply): { text: string; segments: string } {
  return typeof content === "string" ? { text: content, segments: "" }
    : { text: plainText(content), segments: JSON.stringify(content) };
}

export function decodeNoticeSegments(raw: string, text: string): NoticeSegment[] | undefined {
  if (raw.length > maxImageAddressLength + maxTextCharacters * 12) return;

  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return;

    const parts: NoticeSegment[] = [];
    for (const part of value) {
      if (typeof part !== "object" || part === null) return;
      if (part.type === "text" && typeof part.text === "string") {
        parts.push({ type: "text", text: part.text });
      } else if (part.type === "image") {
        const file = imageAddress(part.file);
        if (!file) return;
        parts.push({ type: "image", file });
      } else {
        return;
      }
    }
    if (!limits(parts) && plainText(parts) === text) return parts;
  } catch {
    return;
  }
}

export function decorateNotice(content: string, segments: readonly NoticeSegment[] | undefined, header: string, footer = ""): NoticeReply {
  if (!segments) return header + content + footer;
  return [{ type: "text", text: header }, ...segments, ...(footer ? [{ type: "text" as const, text: footer }] : [])];
}
