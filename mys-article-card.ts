import { renderPng } from "@lotus-yunzai/skia";
import QRCode from "qrcode";
import { Canvas, type CanvasRenderingContext2D, type Image } from "skia-canvas";
import type { NoticeSegment } from "./content.ts";
import { dateFormat, readImage, sizeFont, text, wrapped } from "./mys-card-draw.ts";
import { drawStyledLine, styledLines } from "./mys-article-spans.ts";
import type { OfficialArticle } from "./mys-article-source.ts";

const width = 900;
const margin = 30;
const maxPageHeight = 2_200;
const maxImages = 18;
const maxReplyBytes = 8 * 1024 * 1024;

const countLabel = (value: number | undefined) =>
  value === undefined ? "—" : value > 10_000 ? `${(value / 10_000).toFixed(2)}万` : String(value);

interface DrawRow {
  readonly height: number;
  readonly draw: (ctx: CanvasRenderingContext2D, y: number) => void;
}

function qr(ctx: CanvasRenderingContext2D, url: string) {
  const matrix = QRCode.create(url, { errorCorrectionLevel: "H" }).modules;
  const size = 130;
  const module = size / (matrix.size + 8);
  const origin = width - margin - size - 20 + 4 * module;
  const top = 40 + 4 * module;
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

export async function renderOfficialArticle(article: OfficialArticle, url: string, active: AbortSignal,
  transport: typeof fetch = fetch, onRendered?: (engine: Awaited<ReturnType<typeof renderPng>>["engine"]) => void): Promise<NoticeSegment[]> {
  const signal = AbortSignal.any([active, AbortSignal.timeout(6_000)]);
  const references = [...new Set([article.avatar, ...article.blocks.flatMap((block) => block.type === "image" ? [block.url] : [])]
    .filter((source): source is string => Boolean(source)))].slice(0, maxImages);
  const images = new Map<string, Image>();
  for (let i = 0; i < references.length && !signal.aborted; i += 3) {
    await Promise.all(references.slice(i, i + 3).map(async (src) => {
      const picture = await readImage(src, signal, transport);
      if (picture) images.set(src, picture);
    }));
  }
  active.throwIfAborted();

  const metrics = new Canvas(1, 1).getContext("2d");
  const rows: DrawRow[] = [
    { height: 170, draw(ctx) {
      const avatar = article.avatar ? images.get(article.avatar) : undefined;
      const authorX = avatar ? 143 : 35;
      if (avatar) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(80, 105, 45, 0, Math.PI * 2);
        ctx.clip();
        const ratio = Math.max(90 / avatar.width, 90 / avatar.height);
        const drawWidth = avatar.width * ratio;
        const drawHeight = avatar.height * ratio;
        ctx.drawImage(avatar, 80 - drawWidth / 2, 105 - drawHeight / 2, drawWidth, drawHeight);
        ctx.restore();
      }
      if (article.author) {
        const author = wrapped(metrics, article.author, 500, 30, false)[0] ?? "";
        text(ctx, author, authorX, 78, 30, "#404040");
        if (article.level) {
          metrics.font = sizeFont(30);
          text(ctx, `Lv.${article.level}`, authorX + metrics.measureText(author).width + 12, 85, 18, "#999");
        }
      }
      if (article.certification) {
        const certification = wrapped(metrics, article.certification, 500, 22, false)[0] ?? "";
        text(ctx, certification, authorX, 122, 22, "#999");
      }
      qr(ctx, url);
    } },
  ];
  const pushText = (value: string, size: number, leading: number, color: string,
    align: "left" | "center" | "right" = "left", bold = false) => {
    const x = align === "center" ? width / 2 : align === "right" ? width - margin : margin;
    for (const line of wrapped(metrics, value, width - margin * 2, size, bold)) {
      rows.push({ height: leading, draw: (ctx, y) => text(ctx, line, x, y, size, color, align, bold) });
    }
  };
  pushText(article.title, 44, 60, "#303030");
  rows.push({ height: 110, draw(ctx, y) {
    ctx.fillStyle = "#efefef";
    ctx.fillRect(margin, y + 15, width - 2 * margin, 50);
    text(ctx, "来自版块：", margin + 15, y + 26, 22, "#999");
    const forum = wrapped(metrics, article.forum ?? "", 280, 22, false)[0] ?? "";
    text(ctx, forum, margin + 126, y + 26, 22, "#ffaa00");
    const statistics = article.counts.map((count, i) => `${["浏览", "点赞", "评论"][i]} ${countLabel(count)}`).join("    ");
    text(ctx, statistics, width - margin - 15, y + 26, 21, "#999", "right");
    text(ctx, `文章发表：${dateFormat.format(article.created * 1000)}`, width / 2, y + 85, 22, "#999", "center");
  } });
  rows.push({ height: 20, draw() {} });

  for (const block of article.blocks) {
    if (block.type === "text") {
      const size = block.heading ? 27 : 24;
      const leading = block.heading ? 43 : 38;
      if (block.spans) {
        for (const line of styledLines(metrics, block.spans, width - margin * 2, size, block.heading)) {
          const x = block.align === "center" ? (width - line.width) / 2 : block.align === "right" ? width - margin - line.width : margin;
          rows.push({ height: leading, draw: (ctx, at) => drawStyledLine(ctx, line, x, at, size, block.heading) });
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
    const scale = Math.min((width - 2 * margin) / image.width, (maxPageHeight - 130) / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    rows.push({ height: Math.ceil(drawHeight) + 24, draw: (ctx, y) => {
      ctx.drawImage(image, (width - drawWidth) / 2, y + 10, drawWidth, drawHeight);
    } });
  }

  let topicX = margin;
  let topics: { label: string; x: number; width: number }[] = [];
  const pushTopics = () => {
    if (!topics.length) return;
    const current = topics;
    rows.push({ height: 50, draw(ctx, y) {
      for (const topic of current) {
        ctx.fillStyle = "#efefef";
        ctx.beginPath();
        ctx.roundRect(topic.x, y + 6, topic.width, 40, 12);
        ctx.fill();
        text(ctx, topic.label, topic.x + 11, y + 12, 20, "#666");
      }
    } });
    topicX = margin;
    topics = [];
  };
  metrics.font = sizeFont(20);
  for (const label of article.topics) {
    const chipWidth = Math.ceil(metrics.measureText(label).width) + 24;
    if (topicX + chipWidth > width - margin) pushTopics();
    topics.push({ label, x: topicX, width: chipWidth });
    topicX += chipWidth + 10;
  }
  pushTopics();

  const pages: { rows: DrawRow[]; height: number }[] = [];
  let page = { rows: [] as DrawRow[], height: 80 };
  for (const row of rows) {
    if (page.height + row.height > maxPageHeight) {
      pages.push(page);
      page = { rows: [], height: 80 };
    }
    page.rows.push(row);
    page.height += row.height;
  }
  pages.push(page);
  if (pages.length > 10) throw new Error("米游社文章过长，请打开原文查看。");

  let total = 0;
  const result: NoticeSegment[] = [];
  const configured = process.env.LOTUS_SKIA_MODE;
  const mode = configured === "gpu" || configured === "cpu" ? configured : "auto";
  for (const { rows: pageRows, height } of pages) {
    active.throwIfAborted();
    const { png, engine } = await renderPng(width, height, (ctx) => {
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      let y = 40;
      for (const row of pageRows) { row.draw(ctx, y); y += row.height; }
    }, mode);
    onRendered?.(engine);
    total += png.byteLength;
    if (total > maxReplyBytes) throw new Error("米游社文章图片过大，请打开原文查看。");
    result.push({ type: "image", file: "base64://" + png.toString("base64") });
  }
  return result;
}
