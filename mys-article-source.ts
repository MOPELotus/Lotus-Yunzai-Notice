import { load } from "cheerio";
import { announcementGames, postImage, type AnnouncementGame } from "./mys-announcement-source.ts";

type ArticleBlock =
  | { readonly type: "text"; readonly text: string; readonly heading: boolean; readonly align: "left" | "center" | "right" }
  | { readonly type: "image"; readonly url: string; readonly alt?: string };

export interface OfficialArticle {
  readonly title: string;
  readonly author?: string;
  readonly avatar?: string;
  readonly certification?: string;
  readonly level?: number;
  readonly forum?: string;
  readonly created: number;
  readonly counts: readonly [number | undefined, number | undefined, number | undefined];
  readonly topics: readonly string[];
  readonly blocks: readonly ArticleBlock[];
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const label = (value: unknown, length: number) =>
  typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, " ").trim().slice(0, length) || undefined : undefined;
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function articleBlocks(content: string): ArticleBlock[] {
  if (content.startsWith("{")) {
    try {
      const gallery = record(JSON.parse(content));
      const images = list(gallery.imgs).flatMap((value): ArticleBlock[] => {
        const url = postImage(value) ?? postImage(record(value).url);
        return url ? [{ type: "image", url }] : [];
      });
      const text = label(gallery.text ?? gallery.content, 10_000);
      return text ? [{ type: "text", text, heading: false, align: "left" }, ...images] : images;
    } catch {
      // 普通正文也可能以大括号开头。
    }
  }

  const $ = load(content, {}, false);
  $("script,style,noscript,iframe,object,template,svg").remove();
  const blocks: ArticleBlock[] = [];
  let pending = "";
  let heading = false;
  let align: "left" | "center" | "right" = "left";
  function flush() {
    const text = pending.replace(/[^\S\n]+/gu, " ").trim();
    if (text) blocks.push({ type: "text", text, heading, align });
    pending = "";
  }
  type Node = ReturnType<typeof $.root>[0]["children"][number];
  function walk(node: Node, depth: number) {
    if (depth > 60 || blocks.length >= 160) return;
    if (node.type === "text") { pending += node.data; return; }
    if (node.type !== "tag") return;
    if (node.name === "br") { flush(); return; }
    if (node.name === "img") {
      flush();
      const url = postImage(node.attribs.src) ?? postImage(node.attribs["data-src"]);
      const alt = label(node.attribs.alt, 120);
      if (url) blocks.push({ type: "image", url, alt });
      else if (alt) blocks.push({ type: "text", text: alt, heading: false, align });
      return;
    }
    const block = /^(?:p|h[1-6]|div|li|blockquote|pre|tr|section|article|ul|ol)$/u.test(node.name);
    const savedHeading = heading;
    const savedAlign = align;
    if (block) {
      flush();
      heading ||= /^h[1-6]$/u.test(node.name);
      const classes = node.attribs.class ?? "";
      if (/\bql-align-center\b/u.test(classes)) align = "center";
      if (/\bql-align-right\b/u.test(classes)) align = "right";
      if (node.name === "li") pending = "• ";
    }
    for (const child of node.children) walk(child, depth + 1);
    if (block) { flush(); heading = savedHeading; align = savedAlign; }
  }
  for (const node of $.root()[0]?.children ?? []) walk(node, 0);
  flush();
  return blocks;
}

export function readOfficialArticle(value: unknown, expectedId: string): OfficialArticle | undefined {
  const response = record(value);
  const detail = record(record(response.data).post);
  const post = record(detail.post);
  if (response.retcode !== 0 || post.post_id !== expectedId || post.is_deleted === true || post.is_deleted === 1 ||
      typeof post.content !== "string" || post.content.length > 500_000) return;
  const title = label(post.subject, 200);
  const created = integer(post.created_at);
  if (!title || !created || created > 253402300799) return;
  const blocks = articleBlocks(post.content.trim());
  if (!blocks.length) return;
  const user = record(detail.user);
  const stats = record(detail.stat);
  const topics = list(detail.topics).slice(0, 15).flatMap((topic) => label(record(topic).name, 32) ?? []);
  return {
    title, created, blocks, topics, author: label(user.nickname, 80), avatar: postImage(user.avatar_url),
    certification: label(record(user.certification).label, 80), level: integer(record(user.level_exp).level),
    forum: label(record(detail.forum).name, 50),
    counts: [integer(stats.view_num), integer(stats.like_num), integer(stats.reply_num)],
  };
}

export function createArticleSource(transport: typeof fetch = fetch) {
  return async (game: AnnouncementGame, id: string, signal: AbortSignal) => {
    if (!/^[1-9]\d{0,19}$/u.test(id)) return;
    const url = new URL("https://bbs-api.miyoushe.com/post/wapi/getPostFull");
    url.search = new URLSearchParams({ gids: String(announcementGames[game].id), read: "1", post_id: id }).toString();
    const response = await transport(url, {
      method: "GET", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
      headers: { Accept: "application/json", Referer: "https://www.miyoushe.com/", "User-Agent": "Mozilla/5.0" },
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return;
    }
    return readOfficialArticle(await response.json(), id);
  };
}
