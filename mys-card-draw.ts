import { loadImage, type CanvasRenderingContext2D, type Image } from "skia-canvas";

const maxImageBytes = 6 * 1024 * 1024;
const fontFamily = '"Noto Sans CJK SC", MiSans, Arial, sans-serif';
export const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit",
  minute: "2-digit", second: "2-digit", hour12: false,
});

export async function readImage(url: string, signal: AbortSignal, transport: typeof fetch): Promise<Image | undefined> {
  try {
    const result = await transport(url, { redirect: "error", signal, headers: { Referer: "https://www.miyoushe.com/" } });
    if (!result.ok || !/^image\/(?:png|jpe?g|webp|gif|avif)(?:\s*;|$)/iu.test(result.headers.get("Content-Type") ?? "") ||
        Number(result.headers.get("Content-Length")) > maxImageBytes || !result.body) {
      void result.body?.cancel().catch(() => undefined);
      return;
    }
    const reader = result.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxImageBytes) {
          await reader.cancel();
          return;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const image = await loadImage(Buffer.concat(chunks));
    if (image.width > 0 && image.height > 0 && image.width * image.height <= 30_000_000) return image;
  } catch {
    return;
  }
}

export const sizeFont = (size: number, bold = false) => `${bold ? "bold " : ""}${size}px ${fontFamily}`;
export function text(ctx: CanvasRenderingContext2D, value: string, x: number, y: number, size: number, color: string,
  align: "left" | "center" | "right" = "left", bold = false) {
  ctx.font = sizeFont(size, bold);
  ctx.textBaseline = "top";
  ctx.textAlign = align;
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}

export function wrapped(ctx: CanvasRenderingContext2D, value: string, maxWidth: number, size: number, bold: boolean) {
  ctx.font = sizeFont(size, bold);
  const lines: string[] = [];
  for (const paragraph of value.split("\n")) {
    let line = "";
    for (const word of paragraph.match(/[A-Za-z0-9_.:/%+-]+|./gu) ?? []) {
      const chunks = ctx.measureText(word).width > maxWidth ? [...word] : [word];
      for (const chunk of chunks) {
        if (line && ctx.measureText(line + chunk).width > maxWidth) { lines.push(line.trimEnd()); line = ""; }
        line += line ? chunk : chunk.trimStart();
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}
