import type { PngRender } from "@lotus-yunzai/skia";
import { renderInfoCard, type InfoCardBodyLayout } from "@lotus-yunzai/skia/info-card";
import QRCode from "qrcode";
import type { CanvasRenderingContext2D, Image } from "skia-canvas";
import type { NoticeDeliverySegment } from "./delivery.ts";
import { dateFormat, maxMysReplyBytes, readImage, readImageAsset, renderMode, sizeFont, text, wrapped } from "./mys-card-draw.ts";
import { drawStyledLine, emoticonSize, styledLines } from "./mys-article-spans.ts";
import type { OfficialArticle } from "./mys-article-source.ts";

const paperPadding = 18;
const maxPageHeight = 2_200;
const maxImages = 18;
const maxEmoticonImages = 24;
const maxPages = 10;
const countLabel = (value: number | undefined) =>
  value === undefined ? "—" : value > 10_000 ? `${(value / 10_000).toFixed(2)}万` : String(value);

interface DrawRow {
  readonly height: number;
  draw(ctx: CanvasRenderingContext2D, y: number): void;
}

function qr(ctx: CanvasRenderingContext2D, url: string, x: number, y: number) {
  const matrix = QRCode.create(url, { errorCorrectionLevel: "H" }).modules;
  const module = 130 / (matrix.size + 8);
  const origin = x + 4 * module;
  const top = y + 4 * module;
  ctx.fillStyle = "#000";
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (!matrix.get(row, col)) continue;
      ctx.fillRect(Math.floor(origin + col * module), Math.floor(top + row * module),
        Math.floor(origin + (col + 1) * module) - Math.floor(origin + col * module),
        Math.floor(top + (row + 1) * module) - Math.floor(top + row * module));
    }
  }
}

function articleRows(article: OfficialArticle, url: string, images: ReadonlyMap<string, Image>, layout: InfoCardBodyLayout) {
  const { measure, x, width } = layout;
  const left = x + paperPadding;
  const right = x + width - paperPadding;
  const lineWidth = right - left;
  const center = x + width / 2;
  const statistics = article.counts.map((count, i) => `${["浏览", "点赞", "评论"][i]} ${countLabel(count)}`).join("    ");
  const rows: DrawRow[] = [{ height: 160, draw(ctx, y) {
    qr(ctx, url, right - 130, y);
    text(ctx, "来自版块：", left, y + 14, 22, "#555");
    const forum = wrapped(measure, article.forum ?? "", lineWidth - 275, 22, false)[0] ?? "";
    text(ctx, forum, left + 111, y + 14, 22, "#956300");
    text(ctx, statistics, left, y + 56, 21, "#555");
    text(ctx, `文章发表：${dateFormat.format(article.created * 1000)}`, left, y + 98, 22, "#555");
    ctx.fillStyle = "#ddd";
    ctx.fillRect(left, y + 142, lineWidth, 1);
  } }];
  const pushText = (value: string, size: number, leading: number, color: string,
    align: "left" | "center" | "right" = "left", bold = false) => {
    const at = align === "center" ? center : align === "right" ? right : left;
    for (const line of wrapped(measure, value, lineWidth, size, bold)) {
      rows.push({ height: leading, draw: (ctx, y) => text(ctx, line, at, y, size, color, align, bold) });
    }
  };

  for (const block of article.blocks) {
    if (block.type === "text") {
      const size = block.heading ? 27 : 24;
      const leading = block.heading ? 43 : 38;
      if (block.spans) {
        for (const line of styledLines(measure, block.spans, lineWidth, size, block.heading, images)) {
          const at = block.align === "center" ? center - line.width / 2 : block.align === "right" ? right - line.width : left;
          rows.push({ height: line.hasEmoticons ? emoticonSize + 12 : leading,
            draw: (ctx, y) => drawStyledLine(ctx, line, at, y, size, block.heading) });
        }
      } else {
        pushText(block.text, size, leading, "#333", block.align, block.heading);
      }
      continue;
    }
    const image = images.get(block.url);
    if (!image) {
      pushText(block.alt ? `[图片] ${block.alt}` : "[图片暂不可用]", 21, 34, "#777", "center");
      continue;
    }
    // Reserve space for the continuation header and footer without slicing or stretching the original image.
    const scale = Math.min(lineWidth / image.width, 1_775 / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    rows.push({ height: Math.ceil(drawHeight) + 24, draw: (ctx, y) => {
      ctx.drawImage(image, center - drawWidth / 2, y + 10, drawWidth, drawHeight);
    } });
  }

  let topicX = left;
  let topics: { lines: string[]; x: number; width: number }[] = [];
  const pushTopics = () => {
    if (!topics.length) return;
    const current = topics;
    const height = Math.max(...current.map(({ lines }) => lines.length)) * 26 + 24;
    rows.push({ height, draw(ctx, y) {
      for (const topic of current) {
        ctx.fillStyle = "#efefef";
        ctx.beginPath();
        ctx.roundRect(topic.x, y + 6, topic.width, topic.lines.length * 26 + 14, 12);
        ctx.fill();
        topic.lines.forEach((line, index) => text(ctx, line, topic.x + 11, y + 12 + index * 26, 20, "#666"));
      }
    } });
    topicX = left;
    topics = [];
  };
  for (const label of article.topics) {
    const lines = wrapped(measure, label, lineWidth - 24, 20, false);
    measure.font = sizeFont(20);
    const chipWidth = Math.ceil(Math.max(...lines.map(line => measure.measureText(line).width))) + 24;
    if (topicX + chipWidth > right) pushTopics();
    topics.push({ lines, x: topicX, width: chipWidth });
    topicX += chipWidth + 10;
  }
  pushTopics();
  return rows;
}

export async function renderOfficialArticle(article: OfficialArticle, url: string, active: AbortSignal,
  transport: typeof fetch = fetch, onRendered?: (engine: PngRender["engine"]) => void): Promise<NoticeDeliverySegment[]> {
  const signal = AbortSignal.any([active, AbortSignal.timeout(6_000)]);
  const originals = [...new Set([article.avatar, ...article.blocks.flatMap((block) => block.type === "image" ? [block.url] : [])]
    .filter((source): source is string => Boolean(source)))].slice(0, maxImages);
  const emoticons = [...new Set(article.blocks.flatMap(block => block.type === "text" ?
    block.spans?.flatMap(span => span.emoticon ? [span.emoticon] : []) ?? [] : []))].slice(0, maxEmoticonImages);
  const references = [...new Set([...originals, ...emoticons])];
  const images = new Map<string, Image>();
  let avatar: Uint8Array | undefined;
  for (let i = 0; i < references.length && !signal.aborted; i += 3) {
    await Promise.all(references.slice(i, i + 3).map(async (source) => {
      if (source === article.avatar) {
        const fetched = await readImageAsset(source, signal, transport);
        if (fetched) {
          avatar = fetched.bytes;
          images.set(source, fetched.image);
        }
      } else {
        const image = await readImage(source, signal, transport);
        if (image) images.set(source, image);
      }
    }));
  }
  active.throwIfAborted();

  const author = article.author && `${article.author}${article.level ? ` · Lv.${article.level}` : ""}`;
  const mode = renderMode();
  async function renderPages(scale: 4 | 2) {
    let total = 0;
    let cursor = 0;
    let rows: DrawRow[] | undefined;
    const pages: PngRender[] = [];
    do {
      if (pages.length === maxPages) throw new Error("米游社文章过长，请打开原文查看。");
      active.throwIfAborted();
      const header = pages.length === 0
        ? { title: article.title, eyebrow: author, metadata: article.certification, icon: avatar }
        : { title: `正文续页 · 第 ${pages.length + 1} 页` };
      const picture = await renderInfoCard(header, (layout) => {
        rows ??= articleRows(article, url, images, layout);
        const { x, y, width, bottomPadding } = layout;
        const available = maxPageHeight - y - bottomPadding;
        let height = paperPadding * 2;
        const start = cursor;
        while (cursor < rows.length && height + rows[cursor]!.height <= available) {
          height += rows[cursor++]!.height;
        }
        // The first header can span more lines than a continuation title.
        if (cursor === start && pages.length > 0) throw new Error("米游社文章分页超限，请打开原文查看。");
        const page = rows.slice(start, cursor);
        return { height, draw(ctx) {
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.roundRect(x, y, width, height, 10);
          ctx.fill();
          let top = y + paperPadding;
          for (const row of page) { row.draw(ctx, top); top += row.height; }
        } };
      }, { mode, scale });
      total += picture.png.byteLength;
      // Discard the entire unfinished batch to keep all output pages at the same resolution.
      if (total > maxMysReplyBytes || picture.reducedScaleReason) return;
      pages.push(picture);
    } while (rows && cursor < rows.length);
    return pages;
  }

  const rendered = await renderPages(4) ?? await renderPages(2);
  if (!rendered) throw new Error("米游社文章图片过大，请打开原文查看。");
  active.throwIfAborted();
  return rendered.map(({ png, engine }) => {
    onRendered?.(engine);
    return { type: "image", file: png };
  });
}
