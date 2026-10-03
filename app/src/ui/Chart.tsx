/**
 * Native chart renderer for the ```chart fenced block interns write. One
 * spec, six forms (bar, stacked bar, line, area, pie/donut, scatter), drawn
 * with react-native-svg so it is identical on web and native and needs no
 * WebView. Design rules follow the data-viz method: fixed categorical hue
 * order (never cycled), thin marks with a 2px surface gap, one axis only,
 * hairline recessive grid, legend for two or more series, selective direct
 * labels, and a table view for accessibility. Tap a mark for its value.
 *
 * Spec (lenient — see normalizeChartSpec):
 *   { "type": "bar", "title": "…", "labels": ["a","b"],
 *     "series": [{ "name": "Open", "data": [4, 9] }],
 *     "stacked": false, "format": "number" | "percent" | "currency", "unit": "h" }
 * Pie/donut use labels + the first series. Scatter series data is [[x,y],…].
 */
import React, { useMemo, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from "react-native-svg";
import { radius, space, useAppTheme } from "../theme";
import { ChartIcon, CopyIcon, DownloadIcon, TableIcon } from "./Icons";
import { Text } from "./Text";

export type ChartType = "bar" | "line" | "area" | "pie" | "donut" | "scatter";

export interface ChartSeries {
  name: string;
  /** y values aligned to labels, or [x, y] pairs for scatter */
  data: number[] | [number, number][];
  /** pin a colour (e.g. an intern's own); otherwise the palette assigns one */
  color?: string;
}

export interface ChartSpec {
  type: ChartType;
  title?: string;
  subtitle?: string;
  labels: string[];
  series: ChartSeries[];
  stacked?: boolean;
  format?: "number" | "percent" | "currency";
  unit?: string;
  currency?: string;
  y_label?: string;
  x_label?: string;
  /** horizontal bars (bar only) */
  horizontal?: boolean;
}

/** Validated default categorical palette (dataviz reference), stepped per surface. */
export const SERIES_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
export const SERIES_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

function hueOf(hex: string): number | null {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((v) => parseInt(v!, 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 0.12) return null; // greys have no useful hue
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/**
 * Give each entity the validated palette colour nearest its own colour (an
 * intern's face), without two sharing one. Identity carries over from the
 * faces while contrast stays the palette's. Null entries take what is left.
 */
export function nearestPaletteColors(ownColors: (string | null | undefined)[], scheme: "light" | "dark"): string[] {
  const palette = scheme === "dark" ? SERIES_DARK : SERIES_LIGHT;
  const taken = new Set<number>();
  const out: (string | null)[] = ownColors.map(() => null);
  ownColors.forEach((own, i) => {
    const hue = own ? hueOf(own) : null;
    if (hue === null) return;
    let best = -1;
    let bestDistance = Infinity;
    palette.forEach((candidate, pi) => {
      if (taken.has(pi)) return;
      const ph = hueOf(candidate);
      if (ph === null) return;
      const distance = Math.min(Math.abs(ph - hue), 360 - Math.abs(ph - hue));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = pi;
      }
    });
    if (best >= 0) {
      taken.add(best);
      out[i] = palette[best]!;
    }
  });
  return out.map((color) => {
    if (color) return color;
    const free = palette.findIndex((_, pi) => !taken.has(pi));
    const pick = free >= 0 ? free : 0;
    taken.add(pick);
    return palette[pick]!;
  });
}
const MAX_SERIES = 8;

const TYPES: ChartType[] = ["bar", "line", "area", "pie", "donut", "scatter"];

/**
 * Accept the shapes an LLM plausibly emits and reduce them to ChartSpec.
 * Returns null (render as code) when nothing usable can be recovered.
 */
export function normalizeChartSpec(raw: unknown): ChartSpec | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  let type = String(o.type ?? o.kind ?? "bar").toLowerCase().replace(/[\s_-]?chart$/, "");
  if (type === "column" || type === "stacked-bar" || type === "stacked_bar" || type === "stackedbar") type = "bar";
  if (type === "columns" || type === "bars") type = "bar";
  if (type === "lines") type = "line";
  if (type === "ring") type = "donut";
  if (!TYPES.includes(type as ChartType)) return null;
  const stacked = Boolean(o.stacked) || /stacked/.test(String(o.type ?? ""));

  let labels: string[] = Array.isArray(o.labels) ? (o.labels as unknown[]).map(String) : Array.isArray(o.categories) ? (o.categories as unknown[]).map(String) : Array.isArray(o.x) ? (o.x as unknown[]).map(String) : [];
  let series: ChartSeries[] = [];

  const toNums = (arr: unknown[]): number[] => arr.map((v) => (typeof v === "number" ? v : Number(v))).map((v) => (Number.isFinite(v) ? v : 0));
  const rawSeries = Array.isArray(o.series) ? o.series : Array.isArray(o.datasets) ? o.datasets : null;
  if (rawSeries) {
    series = (rawSeries as unknown[]).flatMap((entry, i): ChartSeries[] => {
      if (Array.isArray(entry)) return [{ name: `Series ${i + 1}`, data: toNums(entry) }];
      if (!entry || typeof entry !== "object") return [];
      const e = entry as Record<string, unknown>;
      const values = Array.isArray(e.data) ? e.data : Array.isArray(e.values) ? e.values : Array.isArray(e.y) ? e.y : null;
      if (!values) return [];
      if (type === "scatter") {
        const pairs = (values as unknown[])
          .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : p && typeof p === "object" ? [Number((p as any).x), Number((p as any).y)] : null))
          .filter((p): p is [number, number] => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
        return [{ name: String(e.name ?? e.label ?? `Series ${i + 1}`), data: pairs as [number, number][] }];
      }
      // {label, value} point objects
      if ((values as unknown[]).every((v) => v && typeof v === "object" && !Array.isArray(v))) {
        const pts = values as Record<string, unknown>[];
        if (labels.length === 0) labels = pts.map((p) => String(p.label ?? p.name ?? p.x ?? ""));
        return [{ name: String(e.name ?? e.label ?? `Series ${i + 1}`), data: toNums(pts.map((p) => p.value ?? p.y ?? p.v)) }];
      }
      return [{ name: String(e.name ?? e.label ?? `Series ${i + 1}`), data: toNums(values as unknown[]) }];
    });
  } else if (Array.isArray(o.data) || Array.isArray(o.values) || Array.isArray(o.y)) {
    const values = (o.data ?? o.values ?? o.y) as unknown[];
    if (values.every((v) => v && typeof v === "object" && !Array.isArray(v))) {
      const pts = values as Record<string, unknown>[];
      if (labels.length === 0) labels = pts.map((p) => String(p.label ?? p.name ?? p.x ?? ""));
      series = [{ name: String(o.name ?? o.series_name ?? o.title ?? "Value"), data: toNums(pts.map((p) => p.value ?? p.y ?? p.v)) }];
    } else if (type === "scatter") {
      const pairs = values
        .map((p) => (Array.isArray(p) ? [Number(p[0]), Number(p[1])] : null))
        .filter((p): p is [number, number] => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
      series = [{ name: String(o.name ?? "Points"), data: pairs }];
    } else {
      series = [{ name: String(o.name ?? o.series_name ?? "Value"), data: toNums(values) }];
    }
  } else if (o.data && typeof o.data === "object") {
    // {"A": 1, "B": 2}
    const entries = Object.entries(o.data as Record<string, unknown>);
    labels = entries.map(([k]) => k);
    series = [{ name: String(o.name ?? "Value"), data: toNums(entries.map(([, v]) => v)) }];
  }

  series = series.filter((s) => s.data.length > 0).slice(0, MAX_SERIES);
  if (series.length === 0) return null;
  if (type !== "scatter") {
    const n = Math.max(...series.map((s) => s.data.length));
    if (labels.length < n) labels = [...labels, ...Array.from({ length: n - labels.length }, (_, i) => String(labels.length + i + 1))];
    labels = labels.slice(0, n);
  }
  const format = ["number", "percent", "currency"].includes(String(o.format)) ? (o.format as ChartSpec["format"]) : undefined;
  return {
    type: type as ChartType,
    title: typeof o.title === "string" ? o.title : undefined,
    subtitle: typeof o.subtitle === "string" ? o.subtitle : typeof o.description === "string" ? o.description : undefined,
    labels,
    series,
    stacked,
    format,
    unit: typeof o.unit === "string" ? o.unit : undefined,
    currency: typeof o.currency === "string" ? o.currency : undefined,
    y_label: typeof o.y_label === "string" ? o.y_label : typeof o.yLabel === "string" ? o.yLabel : undefined,
    x_label: typeof o.x_label === "string" ? o.x_label : typeof o.xLabel === "string" ? o.xLabel : undefined,
    horizontal: Boolean(o.horizontal),
  };
}

export function parseChartBlock(source: string): ChartSpec | null {
  try {
    return normalizeChartSpec(JSON.parse(source));
  } catch {
    return null;
  }
}

function formatValue(v: number, spec: Pick<ChartSpec, "format" | "unit" | "currency">, compact = true): string {
  if (spec.format === "percent") return `${trim(v)}%`;
  const abs = Math.abs(v);
  let body: string;
  if (compact && abs >= 1_000_000) body = `${trim(v / 1_000_000)}M`;
  else if (compact && abs >= 10_000) body = `${trim(v / 1_000)}K`;
  else body = abs >= 1000 ? Math.round(v).toLocaleString("en-US") : trim(v);
  if (spec.format === "currency") return `${spec.currency ?? "R"}${body}`;
  return spec.unit ? `${body} ${spec.unit}` : body;
}

function trim(v: number): string {
  const rounded = Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
  return String(rounded);
}

/** Round axis ticks to clean numbers (0 / 1,000 / 2,000). */
function niceTicks(min: number, max: number, count = 4): number[] {
  if (max === min) max = min + 1;
  const span = max - min;
  const rough = span / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = start; t <= end + step / 2; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
  return ticks;
}

/** SVG text does not inherit the app font; pin the system sans so ticks never fall back to serif. */
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/**
 * Web export: serialize the rendered <svg> (plus a title and a solid
 * background so it pastes cleanly into mail/Slack), rasterize on a canvas at
 * 2x, then download — or copy to the clipboard when `copy` is set and the
 * browser allows image clipboard writes. Native has no canvas; the button is
 * hidden there.
 */
async function exportChartPng(root: HTMLElement | null, opts: { title?: string; legend: { name: string; color: string }[]; surface: string; ink: string; fileName: string; copy?: boolean }): Promise<boolean> {
  if (!root) return false;
  const svg = root.querySelector("svg");
  if (!svg) return false;
  const w = Number(svg.getAttribute("width")) || svg.clientWidth;
  const h = Number(svg.getAttribute("height")) || svg.clientHeight;
  const titleH = opts.title ? 28 : 0;
  const legendH = opts.legend.length > 1 ? 24 : 0;
  const pad = 16;
  const totalW = w + pad * 2;
  const totalH = h + titleH + legendH + pad * 2;
  const inner = new XMLSerializer().serializeToString(svg).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  let legend = "";
  let lx = pad;
  for (const entry of opts.legend.length > 1 ? opts.legend : []) {
    legend += `<rect x="${lx}" y="${totalH - pad - 14}" width="10" height="10" rx="2" fill="${entry.color}"/><text x="${lx + 15}" y="${totalH - pad - 5}" font-size="11" font-family="${FONT}" fill="${opts.ink}">${esc(entry.name)}</text>`;
    lx += 15 + entry.name.length * 6.6 + 14;
  }
  const doc =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${totalH}" viewBox="0 0 ${totalW} ${totalH}">` +
    `<rect width="${totalW}" height="${totalH}" fill="${opts.surface}"/>` +
    (opts.title ? `<text x="${pad}" y="${pad + 16}" font-size="14" font-weight="600" font-family="${FONT}" fill="${opts.ink}">${esc(opts.title)}</text>` : "") +
    `<g transform="translate(${pad},${pad + titleH})">${inner}</g>${legend}</svg>`;
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc)}`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("svg rasterize failed"));
    img.src = url;
  });
  const canvas = document.createElement("canvas");
  canvas.width = totalW * 2;
  canvas.height = totalH * 2;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.scale(2, 2);
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return false;
  if (opts.copy && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = opts.fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return true;
}

const PLOT_HEIGHT = 200;
const AXIS_LEFT = 44;
const AXIS_BOTTOM = 26;
const PAD_TOP = 14;
const PAD_RIGHT = 12;

export interface ChartProps {
  spec: ChartSpec;
  /** the bubble/card background the chart sits on — used for the surface gaps and rings */
  surface: string;
}

function ChartImpl({ spec, surface }: ChartProps) {
  const { colors, scheme } = useAppTheme();
  const [width, setWidth] = useState(0);
  const [showTable, setShowTable] = useState(false);
  const [active, setActive] = useState<{ series: number; index: number } | null>(null);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const plotRef = useRef<View>(null);
  const palette = scheme === "dark" ? SERIES_DARK : SERIES_LIGHT;
  const ink = { primary: colors.text, secondary: colors.textDim, muted: colors.textFaint, grid: colors.border, axis: colors.border };

  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w !== width) setWidth(w);
  };

  const legend = spec.series.length > 1 || spec.type === "pie" || spec.type === "donut";
  const legendEntries = spec.type === "pie" || spec.type === "donut" ? spec.labels.map((l, i) => ({ name: l, color: palette[i % palette.length]! })) : spec.series.map((s, i) => ({ name: s.name, color: s.color ?? palette[i]! }));

  const activeText = useMemo(() => {
    if (!active) return null;
    const s = spec.series[active.series];
    if (!s) return null;
    if (spec.type === "scatter") {
      const p = s.data[active.index] as [number, number] | undefined;
      return p ? `${s.name}: ${formatValue(p[0], spec, false)}, ${formatValue(p[1], spec, false)}` : null;
    }
    const v = s.data[active.index] as number | undefined;
    if (v === undefined) return null;
    const label = spec.labels[active.index] ?? "";
    const who = spec.type === "pie" || spec.type === "donut" || spec.series.length === 1 ? label : `${label} · ${s.name}`;
    return `${who}: ${formatValue(v, spec, false)}`;
  }, [active, spec]);

  const doExport = async (copy: boolean) => {
    const node = plotRef.current as unknown as HTMLElement | null;
    try {
      const ok = await exportChartPng(node, {
        title: spec.title,
        legend: legendEntries,
        surface,
        ink: ink.primary,
        fileName: `${(spec.title ?? "chart").replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "chart"}.png`,
        copy,
      });
      setExportNote(ok ? (copy ? "Copied image" : "Saved PNG") : "Export failed");
    } catch {
      setExportNote(copy ? "Copy not allowed here — saved PNG instead" : "Export failed");
      if (copy) void exportChartPng(node, { title: spec.title, legend: legendEntries, surface, ink: ink.primary, fileName: "chart.png" }).catch(() => {});
    }
    setTimeout(() => setExportNote(null), 1600);
  };

  return (
    <View style={styles.wrap} onLayout={onLayout}>
      {spec.title ? (
        <Text variant="subtle" color={ink.primary} style={styles.title}>
          {spec.title}
        </Text>
      ) : null}
      {spec.subtitle ? <Text variant="caption">{spec.subtitle}</Text> : null}
      {width > 0 ? (
        showTable ? (
          <ChartTable spec={spec} />
        ) : (
          <View ref={plotRef} collapsable={false}>
            {spec.type === "pie" || spec.type === "donut" ? (
              <PieChart spec={spec} width={width} palette={palette} surface={surface} ink={ink} active={active} onActive={setActive} />
            ) : spec.type === "scatter" ? (
              <ScatterChart spec={spec} width={width} palette={palette} surface={surface} ink={ink} active={active} onActive={setActive} />
            ) : (
              <XYChart spec={spec} width={width} palette={palette} surface={surface} ink={ink} active={active} onActive={setActive} />
            )}
          </View>
        )
      ) : null}
      <View style={styles.footer}>
        {legend && !showTable ? (
          <View style={styles.legend} accessibilityRole="list">
            {legendEntries.map((entry) => (
              <View key={entry.name} style={styles.legendItem}>
                <View style={[styles.swatch, { backgroundColor: entry.color }]} />
                <Text variant="caption" color={ink.secondary}>
                  {entry.name}
                </Text>
              </View>
            ))}
          </View>
        ) : (
          <View style={styles.legendSpacer} />
        )}
        <View style={styles.actions}>
          {Platform.OS === "web" && !showTable ? (
            <>
              <Pressable onPress={() => void doExport(true)} accessibilityRole="button" accessibilityLabel="Copy chart as image" hitSlop={8} style={styles.iconButton}>
                <CopyIcon size={16} color={ink.secondary} />
              </Pressable>
              <Pressable onPress={() => void doExport(false)} accessibilityRole="button" accessibilityLabel="Save chart as PNG" hitSlop={8} style={styles.iconButton}>
                <DownloadIcon size={16} color={ink.secondary} />
              </Pressable>
            </>
          ) : null}
          <Pressable onPress={() => setShowTable((v) => !v)} accessibilityRole="button" accessibilityLabel={showTable ? "Show chart" : "Show data table"} hitSlop={8} style={styles.iconButton}>
            {showTable ? <ChartIcon size={16} color={ink.secondary} /> : <TableIcon size={16} color={ink.secondary} />}
          </Pressable>
        </View>
      </View>
      {exportNote ? (
        <Text variant="caption" color={ink.secondary}>
          {exportNote}
        </Text>
      ) : null}
      {activeText ? (
        <View style={[styles.tooltip, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text variant="caption" color={ink.primary}>
            {activeText}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export const Chart = React.memo(ChartImpl);

interface InnerProps {
  spec: ChartSpec;
  width: number;
  palette: string[];
  surface: string;
  ink: { primary: string; secondary: string; muted: string; grid: string; axis: string };
  active: { series: number; index: number } | null;
  onActive: (next: { series: number; index: number } | null) => void;
}

function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  if (h <= 0) return "";
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

function roundedRightRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, h / 2, w);
  if (w <= 0) return "";
  return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
}

/** Bars, stacked bars, lines, areas — anything with categories on one axis and values on the other. */
function XYChart({ spec, width, palette, surface, ink, active, onActive }: InnerProps) {
  const n = spec.labels.length;
  const series = spec.series.map((s) => s.data as number[]);
  const isBar = spec.type === "bar";
  const stacked = isBar && spec.stacked && series.length > 1;
  const horizontal = isBar && spec.horizontal;

  // Value domain: stacked totals, else max across series; include 0 so bars grow from a baseline.
  let min = 0;
  let max = 0;
  if (stacked) {
    for (let i = 0; i < n; i++) {
      const pos = series.reduce((acc, s) => acc + Math.max(0, s[i] ?? 0), 0);
      const neg = series.reduce((acc, s) => acc + Math.min(0, s[i] ?? 0), 0);
      max = Math.max(max, pos);
      min = Math.min(min, neg);
    }
  } else {
    for (const s of series) for (const v of s) {
      max = Math.max(max, v);
      min = Math.min(min, v);
    }
  }
  const ticks = niceTicks(min, max);
  const lo = ticks[0]!;
  const hi = ticks[ticks.length - 1]!;

  // Horizontal bars carry their category labels in the left gutter, so size it to the longest one.
  const longest = horizontal ? Math.max(0, ...spec.labels.map((l) => Math.min(l.length, 18))) : 0;
  const axisLeft = horizontal ? Math.min(140, 12 + longest * 6.4) : AXIS_LEFT;
  const directLabels = isBar && series.length === 1 && n <= 12 && !stacked;
  const padRight = horizontal && directLabels ? 52 : PAD_RIGHT;
  const plotH = horizontal ? Math.max(120, n * 28 + 8) : PLOT_HEIGHT;
  const plotW = Math.max(40, width - axisLeft - padRight);
  const svgH = plotH + PAD_TOP + AXIS_BOTTOM;
  const yFor = (v: number) => PAD_TOP + plotH - ((v - lo) / (hi - lo)) * plotH;
  const xFor = (v: number) => axisLeft + ((v - lo) / (hi - lo)) * plotW;
  const slot = horizontal ? plotH / Math.max(1, n) : plotW / Math.max(1, n);
  const groupCount = stacked || !isBar ? 1 : series.length;
  const gap = 2; // the surface gap
  const barThickness = Math.min(24, Math.max(4, (slot * 0.72 - gap * (groupCount - 1)) / groupCount));
  const groupWidth = barThickness * groupCount + gap * (groupCount - 1);

  const labelEvery = horizontal ? 1 : Math.max(1, Math.ceil((n * 56) / plotW));

  const nodes: React.ReactNode[] = [];

  // Gridlines + tick labels (recessive), baseline slightly stronger.
  for (const t of ticks) {
    if (horizontal) {
      const x = xFor(t);
      nodes.push(<Line key={`g${t}`} x1={x} x2={x} y1={PAD_TOP} y2={PAD_TOP + plotH} stroke={t === 0 ? ink.axis : ink.grid} strokeWidth={1} />);
      nodes.push(
        <SvgText fontFamily={FONT} key={`t${t}`} x={x} y={PAD_TOP + plotH + 16} fontSize={10} fill={ink.muted} textAnchor="middle">
          {formatValue(t, spec)}
        </SvgText>,
      );
    } else {
      const y = yFor(t);
      nodes.push(<Line key={`g${t}`} x1={axisLeft} x2={axisLeft + plotW} y1={y} y2={y} stroke={t === 0 ? ink.axis : ink.grid} strokeWidth={1} />);
      nodes.push(
        <SvgText fontFamily={FONT} key={`t${t}`} x={axisLeft - 6} y={y + 3.5} fontSize={10} fill={ink.muted} textAnchor="end">
          {formatValue(t, spec)}
        </SvgText>,
      );
    }
  }

  // Category labels
  spec.labels.forEach((label, i) => {
    if (i % labelEvery !== 0) return;
    const text = label.length > (horizontal ? 18 : 14) ? `${label.slice(0, horizontal ? 17 : 13)}…` : label;
    if (horizontal) {
      nodes.push(
        <SvgText fontFamily={FONT} key={`l${i}`} x={axisLeft - 6} y={PAD_TOP + slot * i + slot / 2 + 3.5} fontSize={10} fill={ink.secondary} textAnchor="end">
          {text}
        </SvgText>,
      );
    } else {
      nodes.push(
        <SvgText fontFamily={FONT} key={`l${i}`} x={axisLeft + slot * i + slot / 2} y={PAD_TOP + plotH + 16} fontSize={10} fill={ink.secondary} textAnchor="middle">
          {text}
        </SvgText>,
      );
    }
  });

  if (isBar) {
    const running = Array.from({ length: n }, () => ({ pos: 0, neg: 0 }));
    series.forEach((s, si) => {
      const color = spec.series[si]?.color ?? palette[si]!;
      for (let i = 0; i < n; i++) {
        const v = s[i] ?? 0;
        const isActive = active?.series === si && active.index === i;
        let path = "";
        let hit: { x: number; y: number; w: number; h: number };
        if (horizontal) {
          const y = PAD_TOP + slot * i + (slot - groupWidth) / 2 + (stacked ? 0 : si * (barThickness + gap));
          let x0 = xFor(0);
          let x1 = xFor(v);
          if (stacked) {
            const base = v >= 0 ? running[i]!.pos : running[i]!.neg;
            x0 = xFor(base);
            x1 = xFor(base + v);
            if (v >= 0) running[i]!.pos += v;
            else running[i]!.neg += v;
          }
          const left = Math.min(x0, x1);
          const w = Math.max(0, Math.abs(x1 - x0) - (stacked && si > 0 ? gap : 0));
          path = roundedRightRect(left + (stacked && si > 0 ? gap : 0), y, w, barThickness, stacked && si < series.length - 1 ? 0 : 4);
          hit = { x: left, y, w: Math.max(w, 8), h: barThickness };
        } else {
          const x = axisLeft + slot * i + (slot - groupWidth) / 2 + (stacked ? 0 : si * (barThickness + gap));
          let y0 = yFor(0);
          let y1 = yFor(v);
          if (stacked) {
            const base = v >= 0 ? running[i]!.pos : running[i]!.neg;
            y0 = yFor(base);
            y1 = yFor(base + v);
            if (v >= 0) running[i]!.pos += v;
            else running[i]!.neg += v;
          }
          const top = Math.min(y0, y1);
          const h = Math.max(0, Math.abs(y1 - y0) - (stacked && si > 0 ? gap : 0));
          path = roundedTopRect(x, top, barThickness, h, stacked && si < series.length - 1 ? 0 : 4);
          hit = { x, y: top, w: barThickness, h: Math.max(h, 8) };
        }
        nodes.push(<Path key={`b${si}-${i}`} d={path} fill={color} opacity={active && !isActive ? 0.55 : 1} />);
        nodes.push(
          <Rect
            key={`h${si}-${i}`}
            x={hit.x - 4}
            y={hit.y - 4}
            width={hit.w + 8}
            height={hit.h + 8}
            fill="transparent"
            onPress={() => onActive(isActive ? null : { series: si, index: i })}
          />,
        );
        if (directLabels && !horizontal) {
          nodes.push(
            <SvgText fontFamily={FONT} key={`v${i}`} x={hit.x + barThickness / 2} y={hit.y - 4} fontSize={10} fill={ink.secondary} textAnchor="middle">
              {formatValue(v, spec)}
            </SvgText>,
          );
        }
        if (directLabels && horizontal) {
          nodes.push(
            <SvgText fontFamily={FONT} key={`v${i}`} x={hit.x + hit.w + 5} y={hit.y + barThickness / 2 + 3.5} fontSize={10} fill={ink.secondary} textAnchor="start">
              {formatValue(v, spec)}
            </SvgText>,
          );
        }
      }
    });
  } else {
    // line / area
    const xAt = (i: number) => axisLeft + slot * i + slot / 2;
    series.forEach((s, si) => {
      const color = spec.series[si]?.color ?? palette[si]!;
      const pts = s.slice(0, n).map((v, i) => ({ x: xAt(i), y: yFor(v), v, i }));
      if (pts.length === 0) return;
      const line = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
      if (spec.type === "area") {
        const base = yFor(Math.max(lo, Math.min(0, hi)));
        nodes.push(<Path key={`a${si}`} d={`${line} L${pts[pts.length - 1]!.x},${base} L${pts[0]!.x},${base} Z`} fill={color} opacity={0.1} />);
      }
      nodes.push(<Path key={`p${si}`} d={line} stroke={color} strokeWidth={2} fill="none" strokeLinejoin="round" strokeLinecap="round" />);
      pts.forEach((p) => {
        const isActive = active?.series === si && active.index === p.i;
        const showMarker = n <= 24 || isActive || p.i === pts.length - 1;
        if (showMarker) {
          nodes.push(<Circle key={`r${si}-${p.i}`} cx={p.x} cy={p.y} r={isActive ? 6 : 4} fill={color} stroke={surface} strokeWidth={2} />);
        }
        nodes.push(
          <Rect key={`h${si}-${p.i}`} x={p.x - Math.max(8, slot / 2)} y={p.y - 12} width={Math.max(16, slot)} height={24} fill="transparent" onPress={() => onActive(isActive ? null : { series: si, index: p.i })} />,
        );
      });
      // End label: the one direct label a line gets.
      const last = pts[pts.length - 1]!;
      if (series.length <= 4) {
        nodes.push(
          <SvgText fontFamily={FONT} key={`e${si}`} x={Math.min(last.x + 6, axisLeft + plotW)} y={last.y + 3.5} fontSize={10} fill={ink.secondary} textAnchor={last.x + 40 > axisLeft + plotW ? "end" : "start"}>
            {formatValue(last.v, spec)}
          </SvgText>,
        );
      }
    });
  }

  return (
    <View>
      {spec.y_label ? <Text variant="caption">{spec.y_label}</Text> : null}
      <Svg width={width} height={svgH} accessibilityLabel={spec.title ?? "chart"}>
        <G>{nodes}</G>
      </Svg>
      {spec.x_label ? (
        <Text variant="caption" center>
          {spec.x_label}
        </Text>
      ) : null}
    </View>
  );
}

function ScatterChart({ spec, width, palette, surface, ink, active, onActive }: InnerProps) {
  const all = spec.series.flatMap((s) => s.data as [number, number][]);
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  const xt = niceTicks(Math.min(...xs), Math.max(...xs));
  const yt = niceTicks(Math.min(0, ...ys), Math.max(...ys));
  const plotW = Math.max(40, width - AXIS_LEFT - PAD_RIGHT);
  const svgH = PLOT_HEIGHT + PAD_TOP + AXIS_BOTTOM;
  const xFor = (v: number) => AXIS_LEFT + ((v - xt[0]!) / (xt[xt.length - 1]! - xt[0]!)) * plotW;
  const yFor = (v: number) => PAD_TOP + PLOT_HEIGHT - ((v - yt[0]!) / (yt[yt.length - 1]! - yt[0]!)) * PLOT_HEIGHT;
  const nodes: React.ReactNode[] = [];
  for (const t of yt) {
    nodes.push(<Line key={`gy${t}`} x1={AXIS_LEFT} x2={AXIS_LEFT + plotW} y1={yFor(t)} y2={yFor(t)} stroke={ink.grid} strokeWidth={1} />);
    nodes.push(
      <SvgText fontFamily={FONT} key={`ty${t}`} x={AXIS_LEFT - 6} y={yFor(t) + 3.5} fontSize={10} fill={ink.muted} textAnchor="end">
        {formatValue(t, spec)}
      </SvgText>,
    );
  }
  for (const t of xt) {
    nodes.push(
      <SvgText fontFamily={FONT} key={`tx${t}`} x={xFor(t)} y={PAD_TOP + PLOT_HEIGHT + 16} fontSize={10} fill={ink.muted} textAnchor="middle">
        {formatValue(t, spec)}
      </SvgText>,
    );
  }
  spec.series.forEach((s, si) => {
    (s.data as [number, number][]).forEach((p, i) => {
      const isActive = active?.series === si && active.index === i;
      nodes.push(
        <Circle key={`c${si}-${i}`} cx={xFor(p[0])} cy={yFor(p[1])} r={isActive ? 6 : 4.5} fill={spec.series[si]?.color ?? palette[si]!} stroke={surface} strokeWidth={2} opacity={active && !isActive ? 0.6 : 1} onPress={() => onActive(isActive ? null : { series: si, index: i })} />,
      );
    });
  });
  return (
    <Svg width={width} height={svgH} accessibilityLabel={spec.title ?? "scatter chart"}>
      <G>{nodes}</G>
    </Svg>
  );
}

function PieChart({ spec, width, palette, surface, ink, active, onActive }: InnerProps) {
  const values = (spec.series[0]!.data as number[]).map((v) => Math.max(0, v));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const size = Math.min(width, 220);
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 8;
  const inner = spec.type === "donut" ? r * 0.58 : 0;
  let angle = -Math.PI / 2;
  const nodes: React.ReactNode[] = [];
  values.forEach((v, i) => {
    const sweep = (v / total) * Math.PI * 2;
    if (sweep <= 0) return;
    const a0 = angle;
    const a1 = angle + sweep;
    angle = a1;
    const large = sweep > Math.PI ? 1 : 0;
    const p = (a: number, rad: number) => `${cx + Math.cos(a) * rad},${cy + Math.sin(a) * rad}`;
    const d =
      inner > 0
        ? `M${p(a0, r)} A${r},${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, inner)} A${inner},${inner} 0 ${large} 0 ${p(a0, inner)} Z`
        : `M${cx},${cy} L${p(a0, r)} A${r},${r} 0 ${large} 1 ${p(a1, r)} Z`;
    const isActive = active?.index === i;
    nodes.push(
      <Path key={`s${i}`} d={d} fill={palette[i % palette.length]!} stroke={surface} strokeWidth={2} opacity={active && !isActive ? 0.55 : 1} onPress={() => onActive(isActive ? null : { series: 0, index: i })} />,
    );
    // Direct label on slices big enough to hold it.
    if (sweep > 0.35) {
      const mid = (a0 + a1) / 2;
      const lr = inner > 0 ? (r + inner) / 2 : r * 0.62;
      nodes.push(
        <SvgText fontFamily={FONT} key={`t${i}`} x={cx + Math.cos(mid) * lr} y={cy + Math.sin(mid) * lr + 3.5} fontSize={10} fill="#ffffff" textAnchor="middle">
          {`${Math.round((v / total) * 100)}%`}
        </SvgText>,
      );
    }
  });
  // The centre says something: the tapped slice, else the total — or, for
  // shares that always add up to 100%, the biggest slice and its name.
  const largest = values.reduce((best, v, i) => (v > (values[best] ?? -1) ? i : best), 0);
  const focus = active ? active.index : spec.format === "percent" ? largest : null;
  const centreValue = focus !== null ? formatValue(values[focus] ?? 0, spec) : formatValue(total, spec);
  const centreLabel = focus !== null ? spec.labels[focus] ?? "" : "total";
  return (
    <View style={styles.pieRow}>
      <Svg width={size} height={size} accessibilityLabel={spec.title ?? "pie chart"}>
        <G>{nodes}</G>
        {inner > 0 ? (
          <>
            <SvgText fontFamily={FONT} x={cx} y={cy + 2} fontSize={15} fontWeight="600" fill={ink.primary} textAnchor="middle">
              {centreValue}
            </SvgText>
            <SvgText fontFamily={FONT} x={cx} y={cy + 18} fontSize={10} fill={ink.secondary} textAnchor="middle">
              {centreLabel.length > 16 ? `${centreLabel.slice(0, 15)}…` : centreLabel}
            </SvgText>
          </>
        ) : null}
      </Svg>
    </View>
  );
}

function ChartTable({ spec }: { spec: ChartSpec }) {
  const { colors } = useAppTheme();
  const isScatter = spec.type === "scatter";
  const rows: string[][] = isScatter
    ? spec.series.flatMap((s) => (s.data as [number, number][]).map((p) => [s.name, formatValue(p[0], spec, false), formatValue(p[1], spec, false)]))
    : spec.labels.map((label, i) => [label, ...spec.series.map((s) => formatValue((s.data as number[])[i] ?? 0, spec, false))]);
  const header = isScatter ? ["Series", "x", "y"] : ["", ...spec.series.map((s) => s.name)];
  return (
    <View style={[styles.table, { borderColor: colors.border }]} accessibilityRole="summary">
      {[header, ...rows].map((row, ri) => (
        <View key={ri} style={[styles.tableRow, ri > 0 ? { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth } : null]}>
          {row.map((cell, ci) => (
            <Text key={ci} variant="caption" color={ri === 0 ? colors.textDim : colors.text} style={[styles.tableCell, ci > 0 ? styles.tableNum : null, ri === 0 ? styles.tableHead : null]} numberOfLines={1}>
              {cell}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { width: "100%", marginVertical: space.xs, minWidth: 240 },
  title: { fontWeight: "600", marginBottom: 2 },
  footer: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm, marginTop: space.xs },
  legend: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, flexShrink: 1 },
  legendSpacer: { flex: 1 },
  legendItem: { flexDirection: "row", alignItems: "center", gap: 5 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  tableToggle: { textDecorationLine: "underline" },
  actions: { flexDirection: "row", gap: space.xs },
  iconButton: { width: 28, height: 24, alignItems: "center", justifyContent: "center" },
  tooltip: { alignSelf: "flex-start", marginTop: space.xs, paddingHorizontal: space.sm, paddingVertical: 4, borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth },
  pieRow: { alignItems: "center", marginVertical: space.xs },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.sm, marginTop: space.xs, overflow: "hidden" },
  tableRow: { flexDirection: "row" },
  tableCell: { flex: 1, paddingHorizontal: space.sm, paddingVertical: 5 },
  tableNum: { textAlign: "right", fontVariant: ["tabular-nums"] },
  tableHead: { fontWeight: "600" },
});
