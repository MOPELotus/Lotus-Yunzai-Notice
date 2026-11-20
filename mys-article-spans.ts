import type { CanvasRenderingContext2D } from "skia-canvas";
import type { ArticleSpan } from "./mys-article-source.ts";
import { sizeFont } from "./mys-card-draw.ts";

interface MeasuredSpan extends ArticleSpan {
  readonly width: number;
}

interface MeasuredLine {
  readonly spans: readonly MeasuredSpan[];
  readonly width: number;
}

export function styledLines(ctx: CanvasRenderingContext2D, spans: readonly ArticleSpan[], maxWidth: number,
  size: number, heading: boolean): MeasuredLine[] {
  const lines: MeasuredLine[] = [];
  let line: MeasuredSpan[] = [];
  let width = 0;

  function finish() {
    const last = line.at(-1);
    if (last) {
      const text = last.text.trimEnd();
      ctx.font = sizeFont(size, heading || last.bold === true);
      const measured = ctx.measureText(text).width;
      width += measured - last.width;
      line[line.length - 1] = { ...last, text, width: measured };
      lines.push({ spans: line, width });
    }
    line = [];
    width = 0;
  }

  for (const span of spans) {
    const font = sizeFont(size, heading || span.bold === true);
    ctx.font = font;
    for (const word of span.text.match(/[A-Za-z0-9_.:/%+-]+|./gu) ?? []) {
      const parts = ctx.measureText(word).width <= maxWidth ? [word] : [...word];
      for (const part of parts) {
        if (width + ctx.measureText(part).width > maxWidth && line.length) {
          finish();
          ctx.font = font;
        }
        const text = line.length ? part : part.trimStart();
        if (!text) continue;
        const last = line.at(-1);
        if (last && last.bold === span.bold && last.color === span.color && last.underline === span.underline) {
          const joined = last.text + text;
          const measured = ctx.measureText(joined).width;
          line[line.length - 1] = { ...last, text: joined, width: measured };
          width += measured - last.width;
        } else {
          const measured = ctx.measureText(text).width;
          line.push({ ...span, text, width: measured });
          width += measured;
        }
      }
    }
  }
  finish();
  return lines;
}

export function drawStyledLine(ctx: CanvasRenderingContext2D, line: MeasuredLine, x: number, y: number,
  size: number, heading: boolean) {
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  for (const span of line.spans) {
    ctx.font = sizeFont(size, heading || span.bold === true);
    ctx.fillStyle = span.color ?? "#333";
    ctx.fillText(span.text, x, y);
    if (span.underline && span.width > 0) ctx.fillRect(x, y + size + 2, span.width, 1);
    x += span.width;
  }
}
