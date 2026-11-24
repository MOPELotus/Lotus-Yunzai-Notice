import { builtinResourceDirectory } from "../../lib/builtin-resources.ts";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import type { PngRender } from "@lotus-yunzai/skia";
import { drawInfoText, infoCardColors, measureInfoText, renderInfoCard } from "@lotus-yunzai/skia/info-card";
import { loadImage, type CanvasRenderingContext2D, type Image } from "skia-canvas";
import { announcementGames, announcementLabels, type AnnouncementGame, type AnnouncementKind, type OfficialAnnouncement } from "./mys-announcement-source.ts";
import { dateFormat, maxMysReplyBytes, readImage, renderMode } from "./mys-card-draw.ts";
import type { NoticeDeliverySegment } from "./delivery.ts";

const rowHeight = 169;
const thumbWidth = 242;
const thumbHeight = 124;

async function listBanner(root: URL, game: AnnouncementGame) {
  const paths = [new URL(`data/notice/miyoushe/${game}/header.png`, root)];
  if (game === "gs") {
    paths.push(new URL("data/genshin/resources/html/mysNews-list/蒙德.png", root),
      new URL("plugins/genshin/resources/html/mysNews-list/蒙德.png", root));
    paths.push(Bun.pathToFileURL(join(builtinResourceDirectory("social/notice", root), "gs-header.png")));
  }
  for (const path of paths) {
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size <= 0 || info.size > 4 * 1024 * 1024) continue;
      const image = await loadImage(Buffer.from(await Bun.file(path).arrayBuffer()));
      if (image.width && image.height && image.width * image.height <= 12_000_000) return image;
    } catch {
      // The common card supplies the background when a game banner was never installed.
    }
  }
}

function clippedText(ctx: CanvasRenderingContext2D, input: string, width: number, size: number, count: number) {
  const lines = measureInfoText(ctx, input, width, size);
  if (lines.length <= count) return lines;
  const result = lines.slice(0, count);
  const last = Array.from(result[count - 1] ?? "");
  while (last.length && ctx.measureText(last.join("") + "…").width > width) last.pop();
  result[count - 1] = last.join("") + "…";
  return result;
}

function cover(ctx: CanvasRenderingContext2D, image: Image | undefined, x: number, y: number,
  width: number, height: number) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 8);
  ctx.clip();
  ctx.fillStyle = infoCardColors.tile;
  ctx.fillRect(x, y, width, height);
  if (image) {
    const ratio = Math.max(width / image.width, height / image.height);
    const w = image.width * ratio;
    const h = image.height * ratio;
    ctx.drawImage(image, x + (width - w) / 2, y + (height - h) / 2, w, h);
  }
  ctx.restore();
}

export function createAnnouncementListRenderer(root: URL, transport: typeof fetch = fetch,
  onRendered?: (engine: PngRender["engine"]) => void) {
  return async (game: AnnouncementGame, kind: AnnouncementKind, input: readonly OfficialAnnouncement[],
    active: AbortSignal): Promise<NoticeDeliverySegment | undefined> => {
    const posts = input.slice(0, 5);
    if (!posts.length) return;
    const imageSignal = AbortSignal.any([active, AbortSignal.timeout(5_000)]);
    const [banner, thumbnails] = await Promise.all([
      listBanner(root, game),
      Promise.all(posts.map((post) => {
        const url = post.listPreview?.image ?? post.image;
        return url ? readImage(url, imageSignal, transport) : undefined;
      })),
    ]);
    active.throwIfAborted();
    const name = game === "sr" ? "崩坏星穹铁道" : announcementGames[game].name;
    const title = `米游社·${name}${announcementLabels[kind]}列表`;
    const command = `#${announcementGames[game].name}${announcementLabels[kind]}`;
    const footer = `详情内容使用 ${command} 加上序号查看，如 ${command}2`;
    const bannerHeight = banner ? 118 : 0;
    const paint = (scale: 4 | 2) => renderInfoCard({ title }, ({ x, y, width, measure }) => {
      const imageX = x + width - 20 - thumbWidth;
      const textX = x + 70;
      const textWidth = imageX - textX - 22;
      const rows = posts.map((post) => ({
        headline: clippedText(measure, post.title, textWidth, 24, 2),
        summary: clippedText(measure, post.listPreview?.text ?? post.summary ?? "", textWidth, 18, 3),
        date: dateFormat.format(post.created * 1000),
      }));
      const listTop = y + bannerHeight;
      return { height: bannerHeight + rowHeight * posts.length + 36, draw(ctx) {
        if (banner) cover(ctx, banner, x, y, width, bannerHeight - 10);
        for (const [index, row] of rows.entries()) {
          const top = listTop + index * rowHeight;
          if (index) {
            ctx.fillStyle = infoCardColors.rule;
            ctx.fillRect(x, top, width, 1);
          }
          drawInfoText(ctx, [String(index + 1)], x + 28, top + 63, { size: 29, align: "center", color: infoCardColors.gold });
          drawInfoText(ctx, row.headline, textX, top + 17, { size: 24, leading: 30 });
          drawInfoText(ctx, row.summary, textX, top + 76, { size: 18, leading: 19, color: infoCardColors.muted });
          drawInfoText(ctx, [row.date], textX, top + 137, { size: 16, color: infoCardColors.gold });
          cover(ctx, thumbnails[index], imageX, top + 22, thumbWidth, thumbHeight);
        }
        const end = listTop + rowHeight * posts.length;
        ctx.fillStyle = infoCardColors.rule;
        ctx.fillRect(x, end, width, 1);
        drawInfoText(ctx, [footer], x + width / 2, end + 13, { size: 16, align: "center", color: infoCardColors.gold });
      } };
    }, { mode: renderMode(), scale });
    let rendered = await paint(4);
    if (rendered.png.byteLength > maxMysReplyBytes && !rendered.reducedScaleReason) {
      active.throwIfAborted();
      rendered = await paint(2);
    }
    active.throwIfAborted();
    if (rendered.png.byteLength > maxMysReplyBytes) return;
    onRendered?.(rendered.engine);
    return { type: "image", file: rendered.png };
  };
}
