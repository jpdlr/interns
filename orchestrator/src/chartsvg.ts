/**
 * Server-side twin of app/src/ui/Chart.tsx: the same ```chart JSON spec,
 * the same palette and mark rules, rendered to an SVG string so surfaces
 * without the app's renderer (Discord) can get a PNG via render.ts. Kept
 * deliberately simple — static, no hover, dark surface — and lenient about
 * the spec the same way the app is.
 */
export type ChartType = "bar" | "line" | "area" | "pie" | "donut" | "scatter";

export interface ChartSpec {
  type: ChartType;
  title?: string;
  subtitle?: string;
  labels: string[];
  series: { name: string; data: number[] | [number, number][] }[];
  stacked?: boolean;
  format?: "number" | "percent" | "currency";
  unit?: string;
  currency?: string;
  horizontal?: boolean;
}

const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const TYPES: ChartType[] = ["bar", "line", "area", "pie", "donut", "scatter"];
const FONT = "Liberation Sans, DejaVu Sans, Arial, sans-serif";

export interface Theme {
  surface: string;
  text: string;
  muted: string;
  grid: string;
}
export const DARK: Theme = { surface: "#1a1a19", text: "#ffffff", muted: "#898781", grid: "#2c2c2a" };

export function normalizeChartSpec(raw: unknown): ChartSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  let type = String(o.type ?? o.kind ?? "bar").toLowerCase().replace(/[\s_-]?chart$/, "");
  if (["column", "columns", "bars", "stacked-bar", "stacked_bar", "stackedbar"].includes(type)) type = "bar";
  if (type === "lines") type = "line";
  if (type === "ring") type = "donut";
  if (!TYPES.includes(type as ChartType)) return null;
  const stacked = Boolean(o.stacked) || /stacked/.test(String(o.type ?? ""));
  const toNums = (arr: unknown[]) => arr.map((v) => Number(v)).map((v) => (Number.isFinite(v) ? v : 0));
  let labels: string[] = Array.isArray(o.labels) ? (o.labels as unknown[]).map(String) : Array.isArray(o.categories) ? (o.categories as unknown[]).map(String) : Array.isArray(o.x) ? (o.x as unknown[]).map(String) : [];
  let series: ChartSpec["series"] = [];
  const rawSeries = Array.isArray(o.series) ? o.series : Array.isArray(o.datasets) ? o.datasets : null;
  const pointObjects = (values: unknown[]) => values.every((v) => v && typeof v === "object" && !Array.isArray(v));
  if (rawSeries) {
    series = (rawSeries as unknown[]).flatMap((entry, i): ChartSpec["series"] => {
      if (Array.isArray(entry)) return [{ name: `Series ${i + 1}`, data: toNums(entry) }];
      if (!entry || typeof entry !== "object") return [];
      const e = entry as Record<string, unknown>;
      const values = Array.isArray(e.data) ? e.data : Array.isArray(e.values) ? e.values : Array.isArray(e.y) ? e.y : null;
      if (!values) return [];
      const name = String(e.name ?? e.label ?? `Series ${i + 1}`);
      if (type === "scatter") {
        const pairs = (values as unknown[])
          .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : p && typeof p === "object" ? [Number((p as any).x), Number((p as any).y)] : null))
          .filter((p): p is [number, number] => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        return [{ name, data: pairs }];
      }
      if (pointObjects(values as unknown[])) {
        const pts = values as Record<string, unknown>[];
        if (labels.length === 0) labels = pts.map((p) => String(p.label ?? p.name ?? p.x ?? ""));
        return [{ name, data: toNums(pts.map((p) => p.value ?? p.y ?? p.v)) }];
      }
      return [{ name, data: toNums(values as unknown[]) }];
    });
  } else if (Array.isArray(o.data) || Array.isArray(o.values) || Array.isArray(o.y)) {
    const values = (o.data ?? o.values ?? o.y) as unknown[];
    if (pointObjects(values)) {
      const pts = values as Record<string, unknown>[];
      if (labels.length === 0) labels = pts.map((p) => String(p.label ?? p.name ?? p.x ?? ""));
      series = [{ name: String(o.name ?? o.series_name ?? "Value"), data: toNums(pts.map((p) => p.value ?? p.y ?? p.v)) }];
    } else if (type === "scatter") {
      series = [{ name: String(o.name ?? "Points"), data: values.map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : null)).filter((p): p is [number, number] => !!p) }];
    } else {
      series = [{ name: String(o.name ?? o.series_name ?? "Value"), data: toNums(values) }];
    }
  } else if (o.data && typeof o.data === "object") {
    const entries = Object.entries(o.data as Record<string, unknown>);
    labels = entries.map(([k]) => k);
    series = [{ name: String(o.name ?? "Value"), data: toNums(entries.map(([, v]) => v)) }];
  }
  series = series.filter((s) => s.data.length > 0).slice(0, 8);
  if (series.length === 0) return null;
  if (type !== "scatter") {
    const n = Math.max(...series.map((s) => s.data.length));
    while (labels.length < n) labels.push(String(labels.length + 1));
    labels = labels.slice(0, n);
  }
  const format = ["number", "percent", "currency"].includes(String(o.format)) ? (o.format as ChartSpec["format"]) : undefined;
  return {
    type: type as ChartType,
    title: typeof o.title === "string" ? o.title : undefined,
    subtitle: typeof o.subtitle === "string" ? o.subtitle : undefined,
    labels,
    series,
    stacked,
    format,
    unit: typeof o.unit === "string" ? o.unit : undefined,
    currency: typeof o.currency === "string" ? o.currency : undefined,
    horizontal: Boolean(o.horizontal),
  };
}

function trim(v: number): string {
  return String(Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10);
}

function fmt(v: number, spec: ChartSpec, compact = true): string {
  if (spec.format === "percent") return `${trim(v)}%`;
  const abs = Math.abs(v);
  let body = compact && abs >= 1_000_000 ? `${trim(v / 1_000_000)}M` : compact && abs >= 10_000 ? `${trim(v / 1_000)}K` : abs >= 1000 ? Math.round(v).toLocaleString("en-US") : trim(v);
  if (spec.format === "currency") body = `${spec.currency ?? "R"}${body}`;
  return spec.unit ? `${body} ${spec.unit}` : body;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (max === min) max = min + 1;
  const rough = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let t = Math.floor(min / step) * step; t <= Math.ceil(max / step) * step + step / 2; t += step) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const text = (x: number, y: number, s: string, opts: { size?: number; fill: string; anchor?: string; weight?: string }) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${opts.size ?? 11}" fill="${opts.fill}" text-anchor="${opts.anchor ?? "start"}"${opts.weight ? ` font-weight="${opts.weight}"` : ""}>${esc(s)}</text>`;

export function chartToSvg(spec: ChartSpec, theme: Theme = DARK, width = 720): string {
  const pad = 20;
  const titleH = spec.title ? 30 : 0;
  const legend = spec.series.length > 1 || spec.type === "pie" || spec.type === "donut";
  const legendEntries = spec.type === "pie" || spec.type === "donut" ? spec.labels.map((l, i) => ({ name: l, color: SERIES[i % SERIES.length]! })) : spec.series.map((s, i) => ({ name: s.name, color: SERIES[i]! }));
  const legendH = legend ? 26 : 0;
  const plotTop = pad + titleH;
  const parts: string[] = [];
  let plotH: number;
  let plotSvg: string;
  if (spec.type === "pie" || spec.type === "donut") {
    plotH = 260;
    plotSvg = pie(spec, width, plotTop, plotH, theme);
  } else if (spec.type === "scatter") {
    plotH = 260;
    plotSvg = scatter(spec, width, pad, plotTop, plotH, theme);
  } else {
    plotH = spec.horizontal ? Math.max(140, spec.labels.length * 28 + 30) : 260;
    plotSvg = xy(spec, width, pad, plotTop, plotH, theme);
  }
  const height = plotTop + plotH + legendH + pad;
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`);
  parts.push(`<rect width="${width}" height="${height}" fill="${theme.surface}"/>`);
  if (spec.title) parts.push(text(pad, pad + 16, spec.title, { size: 15, fill: theme.text, weight: "600" }));
  parts.push(plotSvg);
  if (legend) {
    let lx = pad;
    const ly = plotTop + plotH + 16;
    for (const entry of legendEntries) {
      parts.push(`<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${entry.color}"/>`);
      parts.push(text(lx + 15, ly, entry.name, { fill: theme.muted }));
      lx += 15 + entry.name.length * 6.4 + 16;
    }
  }
  parts.push("</svg>");
  return parts.join("");
}

function xy(spec: ChartSpec, width: number, pad: number, top: number, plotH: number, theme: Theme): string {
  const axisLeft = pad + 44;
  const plotW = width - axisLeft - pad;
  const n = spec.labels.length;
  const series = spec.series.map((s) => s.data as number[]);
  const isBar = spec.type === "bar";
  const stacked = isBar && spec.stacked && series.length > 1;
  const horizontal = isBar && spec.horizontal;
  let min = 0;
  let max = 0;
  if (stacked) {
    for (let i = 0; i < n; i++) {
      max = Math.max(max, series.reduce((a, s) => a + Math.max(0, s[i] ?? 0), 0));
      min = Math.min(min, series.reduce((a, s) => a + Math.min(0, s[i] ?? 0), 0));
    }
  } else for (const s of series) for (const v of s) {
    max = Math.max(max, v);
    min = Math.min(min, v);
  }
  const ticks = niceTicks(min, max);
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;
  const innerH = plotH - 30;
  const yFor = (v: number) => top + innerH - ((v - lo) / (hi - lo)) * innerH;
  const xFor = (v: number) => axisLeft + ((v - lo) / (hi - lo)) * plotW;
  const slot = horizontal ? innerH / Math.max(1, n) : plotW / Math.max(1, n);
  const groups = stacked || !isBar ? 1 : series.length;
  const gap = 2;
  const thick = Math.min(24, Math.max(4, (slot * 0.72 - gap * (groups - 1)) / groups));
  const groupW = thick * groups + gap * (groups - 1);
  const out: string[] = [];
  for (const t of ticks) {
    if (horizontal) {
      out.push(`<line x1="${xFor(t)}" x2="${xFor(t)}" y1="${top}" y2="${top + innerH}" stroke="${theme.grid}" stroke-width="1"/>`);
      out.push(text(xFor(t), top + innerH + 16, fmt(t, spec), { fill: theme.muted, anchor: "middle", size: 10 }));
    } else {
      out.push(`<line x1="${axisLeft}" x2="${axisLeft + plotW}" y1="${yFor(t)}" y2="${yFor(t)}" stroke="${theme.grid}" stroke-width="1"/>`);
      out.push(text(axisLeft - 6, yFor(t) + 3.5, fmt(t, spec), { fill: theme.muted, anchor: "end", size: 10 }));
    }
  }
  const every = horizontal ? 1 : Math.max(1, Math.ceil((n * 56) / plotW));
  spec.labels.forEach((label, i) => {
    if (i % every) return;
    const l = label.length > 14 ? `${label.slice(0, 13)}…` : label;
    if (horizontal) out.push(text(axisLeft - 6, top + slot * i + slot / 2 + 3.5, l.length > 7 ? `${l.slice(0, 6)}…` : l, { fill: theme.muted, anchor: "end", size: 10 }));
    else out.push(text(axisLeft + slot * i + slot / 2, top + innerH + 16, l, { fill: theme.muted, anchor: "middle", size: 10 }));
  });
  if (isBar) {
    const running = Array.from({ length: n }, () => ({ pos: 0, neg: 0 }));
    series.forEach((s, si) => {
      for (let i = 0; i < n; i++) {
        const v = s[i] ?? 0;
        let base = 0;
        if (stacked) {
          base = v >= 0 ? running[i]!.pos : running[i]!.neg;
          if (v >= 0) running[i]!.pos += v;
          else running[i]!.neg += v;
        }
        const last = !stacked || si === series.length - 1;
        if (horizontal) {
          const y = top + slot * i + (slot - groupW) / 2 + (stacked ? 0 : si * (thick + gap));
          const x0 = xFor(base);
          const x1 = xFor(base + v);
          const w = Math.max(0, Math.abs(x1 - x0) - (stacked && si > 0 ? gap : 0));
          out.push(`<rect x="${Math.min(x0, x1) + (stacked && si > 0 ? gap : 0)}" y="${y}" width="${w}" height="${thick}" rx="${last ? 4 : 0}" fill="${SERIES[si]}"/>`);
          if (series.length === 1 && n <= 12) out.push(text(Math.max(x0, x1) + 5, y + thick / 2 + 3.5, fmt(v, spec), { fill: theme.muted, size: 10 }));
        } else {
          const x = axisLeft + slot * i + (slot - groupW) / 2 + (stacked ? 0 : si * (thick + gap));
          const y0 = yFor(base);
          const y1 = yFor(base + v);
          const h = Math.max(0, Math.abs(y1 - y0) - (stacked && si > 0 ? gap : 0));
          const y = Math.min(y0, y1);
          const r = Math.min(last ? 4 : 0, thick / 2, h);
          out.push(`<path d="M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + thick - r} Q${x + thick},${y} ${x + thick},${y + r} V${y + h} Z" fill="${SERIES[si]}"/>`);
          if (series.length === 1 && n <= 12) out.push(text(x + thick / 2, y - 4, fmt(v, spec), { fill: theme.muted, anchor: "middle", size: 10 }));
        }
      }
    });
  } else {
    series.forEach((s, si) => {
      const pts = s.slice(0, n).map((v, i) => ({ x: axisLeft + slot * i + slot / 2, y: yFor(v), v }));
      if (!pts.length) return;
      const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x},${p.y}`).join(" ");
      if (spec.type === "area") {
        const baseY = yFor(Math.max(lo, Math.min(0, hi)));
        out.push(`<path d="${line} L${pts[pts.length - 1]!.x},${baseY} L${pts[0]!.x},${baseY} Z" fill="${SERIES[si]}" opacity="0.1"/>`);
      }
      out.push(`<path d="${line}" stroke="${SERIES[si]}" stroke-width="2" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`);
      if (n <= 24) for (const p of pts) out.push(`<circle cx="${p.x}" cy="${p.y}" r="4" fill="${SERIES[si]}" stroke="${theme.surface}" stroke-width="2"/>`);
      const last = pts[pts.length - 1]!;
      if (series.length <= 4) out.push(text(Math.min(last.x + 6, axisLeft + plotW), last.y + 3.5, fmt(last.v, spec), { fill: theme.muted, size: 10, anchor: last.x + 40 > axisLeft + plotW ? "end" : "start" }));
    });
  }
  return out.join("");
}

function scatter(spec: ChartSpec, width: number, pad: number, top: number, plotH: number, theme: Theme): string {
  const axisLeft = pad + 44;
  const plotW = width - axisLeft - pad;
  const all = spec.series.flatMap((s) => s.data as [number, number][]);
  const xt = niceTicks(Math.min(...all.map((p) => p[0])), Math.max(...all.map((p) => p[0])));
  const yt = niceTicks(Math.min(0, ...all.map((p) => p[1])), Math.max(...all.map((p) => p[1])));
  const innerH = plotH - 30;
  const xFor = (v: number) => axisLeft + ((v - xt[0]!) / (xt[xt.length - 1]! - xt[0]!)) * plotW;
  const yFor = (v: number) => top + innerH - ((v - yt[0]!) / (yt[yt.length - 1]! - yt[0]!)) * innerH;
  const out: string[] = [];
  for (const t of yt) {
    out.push(`<line x1="${axisLeft}" x2="${axisLeft + plotW}" y1="${yFor(t)}" y2="${yFor(t)}" stroke="${theme.grid}"/>`);
    out.push(text(axisLeft - 6, yFor(t) + 3.5, fmt(t, spec), { fill: theme.muted, anchor: "end", size: 10 }));
  }
  for (const t of xt) out.push(text(xFor(t), top + innerH + 16, fmt(t, spec), { fill: theme.muted, anchor: "middle", size: 10 }));
  spec.series.forEach((s, si) => {
    for (const p of s.data as [number, number][]) out.push(`<circle cx="${xFor(p[0])}" cy="${yFor(p[1])}" r="4.5" fill="${SERIES[si]}" stroke="${theme.surface}" stroke-width="2"/>`);
  });
  return out.join("");
}

function pie(spec: ChartSpec, width: number, top: number, plotH: number, theme: Theme): string {
  const values = (spec.series[0]!.data as number[]).map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const size = Math.min(plotH, 240);
  const cx = width / 2;
  const cy = top + plotH / 2;
  const r = size / 2 - 8;
  const inner = spec.type === "donut" ? r * 0.58 : 0;
  let angle = -Math.PI / 2;
  const out: string[] = [];
  values.forEach((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    if (sweep <= 0) return;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (a: number, rad: number) => `${cx + Math.cos(a) * rad},${cy + Math.sin(a) * rad}`;
    const d = inner > 0
      ? `M${p(a0, r)} A${r},${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, inner)} A${inner},${inner} 0 ${large} 0 ${p(a0, inner)} Z`
      : `M${cx},${cy} L${p(a0, r)} A${r},${r} 0 ${large} 1 ${p(a1, r)} Z`;
    out.push(`<path d="${d}" fill="${SERIES[i % SERIES.length]}" stroke="${theme.surface}" stroke-width="2"/>`);
    if (sweep > 0.35) {
      const mid = (a0 + a1) / 2;
      const lr = inner > 0 ? (r + inner) / 2 : r * 0.62;
      out.push(text(cx + Math.cos(mid) * lr, cy + Math.sin(mid) * lr + 3.5, `${Math.round((v / total) * 100)}%`, { fill: "#ffffff", anchor: "middle", size: 10 }));
    }
  });
  if (inner > 0) out.push(text(cx, cy + 5, fmt(total, spec), { fill: theme.text, anchor: "middle", size: 14, weight: "600" }));
  return out.join("");
}
