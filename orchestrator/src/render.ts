/**
 * Rich blocks → PNG for surfaces that cannot draw them (Discord). Pulls
 * ```chart, ```svg and ```mermaid fences out of a message or card body,
 * rasterizes each with resvg (a small native binary; loaded lazily and
 * optional — without it, or on any failure, the block becomes the same
 * placeholder stripRichBlocks() would have produced) and returns the text
 * with placeholders plus the images to attach.
 */
import { chartToSvg, normalizeChartSpec } from "./chartsvg.js";
import { mermaidToSvg } from "./mermaidsvg.js";
import { plainFences } from "./fences.js";

export interface RenderedImage {
  name: string;
  png: Buffer;
  kind: "chart" | "svg" | "mermaid";
}

export interface RenderedText {
  text: string;
  images: RenderedImage[];
}

const BLOCK_RE = /```(chart|chart\.json|svg|mermaid)\s*\n([\s\S]*?)```/gi;
const PNG_SCALE = 2;
const MAX_IMAGES = 6;

type ResvgModule = typeof import("@resvg/resvg-js");
let resvgPromise: Promise<ResvgModule | null> | null = null;

async function loadResvg(): Promise<ResvgModule | null> {
  if (!resvgPromise) {
    resvgPromise = import("@resvg/resvg-js").then(
      (m) => m,
      (err) => {
        console.error("[render] @resvg/resvg-js unavailable — rich blocks stay placeholders:", err instanceof Error ? err.message : err);
        return null;
      },
    );
  }
  return resvgPromise;
}

/** Same sanitizing as the app's SvgBlock: no scripts, no event handlers, no external references. */
export function sanitizeSvg(raw: string): string {
  let xml = raw.trim().replace(/<\?xml[^>]*\?>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  xml = xml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  xml = xml.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "");
  xml = xml.replace(/\s(xlink:href|href)\s*=\s*("(?:https?:|\/\/)[^"]*"|'(?:https?:|\/\/)[^']*')/gi, "");
  if (!/xmlns=/.test(xml)) xml = xml.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return xml;
}

export async function svgToPng(svg: string, opts: { width?: number } = {}): Promise<Buffer | null> {
  const resvg = await loadResvg();
  if (!resvg) return null;
  try {
    const r = new resvg.Resvg(svg, {
      fitTo: opts.width ? { mode: "width", value: opts.width * PNG_SCALE } : { mode: "zoom", value: PNG_SCALE },
      font: { loadSystemFonts: true, defaultFontFamily: "Liberation Sans" },
      background: "#1a1a19",
    });
    return Buffer.from(r.render().asPng());
  } catch (err) {
    console.error("[render] rasterize failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** One block → PNG, or null when it cannot be drawn. */
export async function renderBlock(lang: string, source: string): Promise<RenderedImage | null> {
  const kind = lang.toLowerCase().startsWith("chart") ? "chart" : (lang.toLowerCase() as "svg" | "mermaid");
  let svg: string | null = null;
  if (kind === "chart") {
    try {
      const spec = normalizeChartSpec(JSON.parse(source));
      if (spec) svg = chartToSvg(spec);
    } catch {
      svg = null;
    }
  } else if (kind === "svg") {
    svg = sanitizeSvg(source);
  } else {
    const result = mermaidToSvg(source);
    if (result && "svg" in result) svg = result.svg;
    else if (result && "pie" in result) svg = chartToSvg(result.pie);
  }
  if (!svg) return null;
  const png = await svgToPng(svg, kind === "svg" ? { width: 640 } : {});
  return png ? { name: `${kind}.png`, png, kind } : null;
}

/**
 * Replace every rich block in `text` with a short placeholder and collect
 * the rendered images. Images are numbered when there is more than one so
 * the placeholder ("see chart 2") lines up with the attachment name.
 */
export async function renderRichBlocks(input: string): Promise<RenderedText> {
  // Page/rule/quick-reply/checklist fences have no picture — they become text.
  const text = plainFences(input, "discord");
  const matches = [...text.matchAll(BLOCK_RE)];
  if (matches.length === 0) return { text, images: [] };
  const images: RenderedImage[] = [];
  let out = "";
  let last = 0;
  let n = 0;
  for (const m of matches) {
    out += text.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    const lang = m[1]!;
    const label = lang.startsWith("chart") ? "chart" : lang === "svg" ? "drawing" : "diagram";
    const image = images.length < MAX_IMAGES ? await renderBlock(lang, m[2]!) : null;
    if (image) {
      n += 1;
      image.name = `${label}-${n}.png`;
      images.push(image);
      out += `(${label} ${n} attached)`;
    } else {
      out += `(${label} — open the app)`;
    }
  }
  out += text.slice(last);
  return { text: out.replace(/\n{3,}/g, "\n\n").trim(), images };
}
