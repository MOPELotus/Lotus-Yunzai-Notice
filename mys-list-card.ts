import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderPng } from "@lotus-yunzai/skia";
import { Canvas, FontLibrary, loadImage, type CanvasRenderingContext2D, type Image } from "skia-canvas";
import { announcementGames, type AnnouncementGame, type AnnouncementKind, type OfficialAnnouncement } from "./mys-announcement-source.ts";
import { dateFormat, readImage, sizeFont, text, wrapped } from "./mys-card-draw.ts";
import type { NoticeDeliverySegment } from "./delivery.ts";

const width = 700;
const left = 30;
const cardWidth = width - left * 2;
const headY = 35;
const headHeight = 106;
const listY = headY + headHeight + 20;
const rowHeight = 169;
const thumbWidth = 242;
const thumbHeight = 124;
const labels = { notice: "公告", info: "资讯" };
const gameNames = { gs: "原神", sr: "崩坏星穹铁道", zzz: "绝区零" };

async function background(root: URL, game: AnnouncementGame) {
  const paths = [new URL(`data/notice/miyoushe/${game}/header.png`, root)];
  if (game === "gs") {
    paths.push(new URL("data/genshin/resources/html/mysNews-list/蒙德.png", root),
      new URL("plugins/genshin/resources/html/mysNews-list/蒙德.png", root));
  }
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size > 4 * 1024 * 1024) continue;
      const image = await loadImage(Buffer.from(await Bun.file(path).arrayBuffer()));
      if (image.width && image.height && image.width * image.height <= 12_000_000) return image;
    } catch {
      // The unillustrated header uses the white base of the original list.
    }
  }
}

async function loadNumberFont(root: URL) {
  const choices = [
    new URL("data/genshin/resources/font/tttgbnumber.ttf", root),
    new URL("plugins/genshin/resources/font/tttgbnumber.ttf", root),
  ];
  for (const path of choices) {
    try {
      if (!await Bun.file(path).exists()) continue;
      return Boolean(FontLibrary.use("NoticeListNumbers", [fileURLToPath(path)]));
    } catch {
      // Use the shared CJK and number fonts if the original is unavailable.
    }
  }
  return false;
}

function clippedText(ctx: CanvasRenderingContext2D, input: string, rowWidth: number, size: number, bold: boolean, count = 1) {
  const lines = wrapped(ctx, input, rowWidth, size, bold);
  if (lines.length <= count) return lines;
  const result = lines.slice(0, count);
  const last = [...(result[count - 1] ?? "")];
  while (last.length && ctx.measureText(last.join("") + "…").width > rowWidth) last.pop();
  result[count - 1] = last.join("") + "…";
  return result;
}

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius: number | number[]) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, radius);
  ctx.fillStyle = "#fff";
  ctx.shadowColor = "rgba(0,0,0,0.15)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 5;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

function drawThumbnail(ctx: CanvasRenderingContext2D, image: Image | undefined, x: number, y: number) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, thumbWidth, thumbHeight, 8);
  ctx.clip();
  ctx.fillStyle = "#f6f6f6";
  ctx.fillRect(x, y, thumbWidth, thumbHeight);
  if (image) {
    const ratio = Math.max(thumbWidth / image.width, thumbHeight / image.height);
    const w = image.width * ratio;
    const h = image.height * ratio;
    ctx.drawImage(image, x + (thumbWidth - w) / 2, y + (thumbHeight - h) / 2, w, h);
  }
  ctx.restore();
}

export function createAnnouncementListRenderer(root: URL, transport: typeof fetch = fetch,
  onRendered?: (engine: Awaited<ReturnType<typeof renderPng>>["engine"]) => void) {
  let listFontReady: Promise<boolean> | undefined;
  return async (game: AnnouncementGame, kind: AnnouncementKind, input: readonly OfficialAnnouncement[],
    active: AbortSignal): Promise<NoticeDeliverySegment | undefined> => {
    const posts = input.slice(0, 5);
    if (!posts.length) return;
    const imageSignal = AbortSignal.any([active, AbortSignal.timeout(5_000)]);
    const [header, originalFont, thumbnails] = await Promise.all([
      background(root, game),
      listFontReady ??= loadNumberFont(root),
      Promise.all(posts.map((post) => {
        const url = post.listPreview?.image ?? post.image;
        return url && readImage(url, imageSignal, transport);
      })),
    ]);
    active.throwIfAborted();
    const intro = `米游社·${gameNames[game]}${labels[kind]}列表`;
    const command = `#${announcementGames[game].name}${labels[kind]}`;
    const scale = 1.2;
    const listHeight = 20 + rowHeight * posts.length;
    const height = listY + listHeight + 68;
    const metrics = new Canvas(1, 1).getContext("2d");
    const textX = left + 74;
    const thumbX = left + cardWidth - 20 - thumbWidth;
    const textWidth = thumbX - textX - 14;
    const rowText = posts.map((post) => ({
      headline: clippedText(metrics, post.title, textWidth, 22, true)[0] ?? "",
      lines: clippedText(metrics, post.listPreview?.text ?? post.summary ?? "", textWidth, 18, false, 3),
      time: dateFormat.format(post.created * 1000),
    }));
    const configured = process.env.LOTUS_SKIA_MODE;
    const mode = configured === "gpu" || configured === "cpu" ? configured : "auto";
    const rendered = await renderPng(Math.round(width * scale), Math.ceil(height * scale), (ctx) => {
      ctx.scale(scale, scale);
      ctx.fillStyle = "#f5f6fb";
      ctx.fillRect(0, 0, width, height);

      panel(ctx, left, headY, cardWidth, headHeight, [15, 50, 50, 15]);
      if (header) {
        ctx.save();
        ctx.clip();
        ctx.drawImage(header, left, headY, cardWidth, header.height * cardWidth / header.width);
        ctx.restore();
      }
      text(ctx, intro, left + 40, headY + 33, 30, "#333", "left", true);

      panel(ctx, left, listY, cardWidth, listHeight, 15);
      for (const [index, row] of rowText.entries()) {
        const y = listY + 10 + index * rowHeight;
        if (index) {
          ctx.fillStyle = "#ddd";
          ctx.fillRect(left, y, cardWidth, 1);
        }
        ctx.font = originalFont ? '26px "NoticeListNumbers", sans-serif' : sizeFont(26);
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillStyle = "#333";
        ctx.fillText(String(index + 1), left + 40, y + rowHeight / 2);
        text(ctx, row.headline, textX, y + 23, 22, "#333", "left", true);
        for (const [line, snippet] of row.lines.entries()) text(ctx, snippet, textX, y + 59 + line * 24, 18, "#999");
        text(ctx, row.time, textX, y + 139, 16, "#999");
        drawThumbnail(ctx, thumbnails[index] || undefined, thumbX, y + 24);
      }
      text(ctx, `详情内容使用 ${command} 加上序号查看，如 ${command}2`, width / 2, height - 43, 14, "#7994a7", "center");
    }, mode);
    onRendered?.(rendered.engine);
    return { type: "image", file: rendered.png };
  };
}
