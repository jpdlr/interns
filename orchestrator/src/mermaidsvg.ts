/**
 * Server-side twin of app/src/ui/Mermaid.tsx: the same flowchart /
 * sequence-diagram subset, parsed and laid out the same way, emitted as an
 * SVG string for render.ts (Discord PNGs). `pie` is converted to a chart
 * spec; other diagram types return null so the caller keeps the placeholder.
 */
import { type ChartSpec } from "./chartsvg.js";

const FONT = "Liberation Sans, DejaVu Sans, Arial, sans-serif";
const FONT_SIZE = 12;
const CHAR_W = 6.6;
const LINE_H = 16;

interface FlowNode {
  id: string;
  label: string;
  shape: "rect" | "round" | "stadium" | "subroutine" | "diamond" | "circle" | "flag" | "hexagon";
}
interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  style: "solid" | "dotted" | "thick";
  arrow: boolean;
  both?: boolean;
}
interface Participant {
  id: string;
  label: string;
  actor: boolean;
}
type SeqEvent =
  | { kind: "message"; from: string; to: string; text: string; dotted: boolean; head: "arrow" | "open" | "cross" | "none" }
  | { kind: "note"; over: string[]; side: "left" | "right" | "over"; text: string }
  | { kind: "block"; label: string; text: string; events: SeqEvent[]; sections: { text: string; events: SeqEvent[] }[] };

export type MermaidDoc =
  | { kind: "flowchart"; direction: "TD" | "BT" | "LR" | "RL"; nodes: FlowNode[]; edges: FlowEdge[] }
  | { kind: "sequence"; participants: Participant[]; events: SeqEvent[] }
  | { kind: "pie"; spec: ChartSpec }
  | { kind: "unsupported"; type: string };

const unquote = (s: string) => {
  const t = s.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
};
const decode = (s: string) => s.replace(/#quot;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<br\s*\/?>/gi, "\n").replace(/\\n/g, "\n");

export function parseMermaid(source: string): MermaidDoc {
  const lines = source.split(/\r?\n/).map((l) => l.replace(/%%.*$/, "").trim()).filter(Boolean);
  if (!lines.length) return { kind: "unsupported", type: "empty" };
  const head = lines[0]!;
  const flow = /^(graph|flowchart)\s*(TD|TB|BT|LR|RL)?\s*;?$/i.exec(head);
  if (flow) return parseFlowchart(lines.slice(1), (flow[2] ?? "TD").toUpperCase().replace("TB", "TD") as "TD" | "BT" | "LR" | "RL");
  if (/^sequenceDiagram/i.test(head)) return parseSequence(lines.slice(1));
  if (/^pie\b/i.test(head)) return parsePie(lines);
  return { kind: "unsupported", type: head.split(/\s+/)[0] ?? "diagram" };
}

const NODE_RE = /^([A-Za-z0-9_.-]+)(?:(\(\[|\[\[|\(\(|\{\{|\[|\(|\{|>)(.*?)(\]\)|\]\]|\)\)|\}\}|\]|\)|\}))?$/;
const EDGE_RE = /^\s*(<)?(--\s*[^-|>]+?\s*--|-\.\s*[^-|>]+?\s*\.-|==\s*[^=|>]+?\s*==|-{2,}|-\.+-|={2,})(>|o|x)?\s*(?:\|([^|]*)\|)?\s*/;

function parseNodeToken(token: string, nodes: Map<string, FlowNode>): string | null {
  const m = NODE_RE.exec(token.trim());
  if (!m) return null;
  const id = m[1]!;
  const open = m[2];
  const inner = m[3];
  if (!nodes.has(id) || (open && inner !== undefined)) {
    let shape: FlowNode["shape"] = "rect";
    if (open === "(") shape = "round";
    else if (open === "([") shape = "stadium";
    else if (open === "[[") shape = "subroutine";
    else if (open === "{") shape = "diamond";
    else if (open === "((") shape = "circle";
    else if (open === ">") shape = "flag";
    else if (open === "{{") shape = "hexagon";
    nodes.set(id, { id, label: inner !== undefined ? decode(unquote(inner)) : nodes.get(id)?.label ?? id, shape: open ? shape : nodes.get(id)?.shape ?? "rect" });
  }
  return id;
}

function parseFlowchart(lines: string[], direction: "TD" | "BT" | "LR" | "RL"): MermaidDoc {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  for (const raw of lines) {
    const line = raw.replace(/;$/, "").trim();
    if (/^(subgraph|end|style|classDef|class|click|linkStyle|direction)\b/i.test(line)) continue;
    let rest = line;
    let prev: string[] | null = null;
    let pending: FlowEdge | null = null;
    let guard = 0;
    while (rest.length && guard++ < 50) {
      const group: string[] = [];
      let matched = false;
      for (;;) {
        const m = /^([A-Za-z0-9_.-]+(?:\(\[.*?\]\)|\[\[.*?\]\]|\(\(.*?\)\)|\{\{.*?\}\}|\[.*?\]|\(.*?\)|\{.*?\}|>.*?\])?)\s*/.exec(rest);
        if (!m) break;
        const id = parseNodeToken(m[1]!, nodes);
        if (!id) break;
        group.push(id);
        rest = rest.slice(m[0].length);
        matched = true;
        const amp = /^&\s*/.exec(rest);
        if (!amp) break;
        rest = rest.slice(amp[0].length);
      }
      if (!matched) break;
      if (prev && pending) for (const a of prev) for (const b of group) edges.push({ ...pending, from: a, to: b });
      prev = group;
      const e = EDGE_RE.exec(rest);
      if (!e) break;
      rest = rest.slice(e[0].length);
      const body = e[2]!;
      let label = e[4] !== undefined ? decode(unquote(e[4])) : undefined;
      const inline = /^(?:--|-\.|==)\s*(.+?)\s*(?:--|\.-|==)$/.exec(body);
      if (inline) label = decode(unquote(inline[1]!));
      pending = { from: "", to: "", label, style: body.startsWith("=") ? "thick" : /\./.test(body) ? "dotted" : "solid", arrow: Boolean(e[3]), both: Boolean(e[1]) && Boolean(e[3]) };
    }
  }
  return { kind: "flowchart", direction, nodes: [...nodes.values()], edges };
}

function parseSequence(lines: string[]): MermaidDoc {
  const participants: Participant[] = [];
  const byId = new Map<string, Participant>();
  const ensure = (id: string, actor = false) => {
    const key = unquote(id.trim());
    if (!byId.has(key)) {
      const p = { id: key, label: key, actor };
      byId.set(key, p);
      participants.push(p);
    }
    return key;
  };
  type Block = Extract<SeqEvent, { kind: "block" }>;
  const stack: Block[] = [];
  const root: SeqEvent[] = [];
  const target = () => {
    const top = stack[stack.length - 1];
    if (!top) return root;
    const section = top.sections[top.sections.length - 1];
    return section ? section.events : top.events;
  };
  for (const raw of lines) {
    const line = raw.replace(/;$/, "").trim();
    let m: RegExpExecArray | null;
    if ((m = /^(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i.exec(line))) {
      const id = ensure(m[2]!, m[1]!.toLowerCase() === "actor");
      if (m[3]) byId.get(id)!.label = decode(unquote(m[3]));
      continue;
    }
    if (/^(autonumber|activate|deactivate)\b/i.test(line)) continue;
    if ((m = /^(loop|alt|opt|par|critical|rect|break)\b\s*(.*)$/i.exec(line))) {
      const block: Block = { kind: "block", label: m[1]!.toLowerCase(), text: decode(m[2] ?? ""), events: [], sections: [] };
      target().push(block);
      stack.push(block);
      continue;
    }
    if ((m = /^(else|and|option)\b\s*(.*)$/i.exec(line))) {
      stack[stack.length - 1]?.sections.push({ text: decode(m[2] ?? ""), events: [] });
      continue;
    }
    if (/^end$/i.test(line)) {
      stack.pop();
      continue;
    }
    if ((m = /^note\s+(left of|right of|over)\s+([^:]+):\s*(.*)$/i.exec(line))) {
      const side = m[1]!.toLowerCase().startsWith("left") ? "left" : m[1]!.toLowerCase().startsWith("right") ? "right" : "over";
      target().push({ kind: "note", over: m[2]!.split(",").map((s) => ensure(s)), side, text: decode(m[3] ?? "") });
      continue;
    }
    if ((m = /^(.+?)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)\s*(.+?):\s*(.*)$/.exec(line))) {
      const op = m[2]!;
      target().push({ kind: "message", from: ensure(m[1]!), to: ensure(m[4]!), text: decode(m[5] ?? ""), dotted: op.startsWith("--"), head: op.endsWith(">>") ? "arrow" : op.endsWith("x") ? "cross" : op.endsWith(")") ? "open" : "none" });
    }
  }
  return { kind: "sequence", participants, events: root };
}

function parsePie(lines: string[]): MermaidDoc {
  const title = /^pie\b(?:\s+showData)?\s*(?:title\s+(.*))?$/i.exec(lines[0]!)?.[1];
  const labels: string[] = [];
  const data: number[] = [];
  for (const line of lines.slice(1)) {
    const m = /^"([^"]*)"\s*:\s*([\d.]+)/.exec(line);
    if (m) {
      labels.push(m[1]!);
      data.push(Number(m[2]));
    }
  }
  if (!labels.length) return { kind: "unsupported", type: "pie" };
  return { kind: "pie", spec: { type: "pie", title: title ? decode(title) : undefined, labels, series: [{ name: "Share", data }] } };
}

// ----------------------------------------------------------------- drawing

interface Ink {
  text: string;
  muted: string;
  line: string;
  border: string;
  fill: string;
  fillAlt: string;
  note: string;
  surface: string;
}
export const DARK_INK: Ink = {
  text: "#ffffff",
  muted: "#c3c2b7",
  line: "#c3c2b7",
  border: "#898781",
  fill: "rgba(57,135,229,0.28)",
  fillAlt: "rgba(217,89,38,0.28)",
  note: "rgba(201,133,0,0.28)",
  surface: "#1a1a19",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const tw = (s: string) => Math.max(...s.split("\n").map((l) => l.length)) * CHAR_W;
const txt = (x: number, y: number, s: string, fill: string, opts: { size?: number; anchor?: string; weight?: string } = {}) =>
  `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${opts.size ?? FONT_SIZE}" fill="${fill}" text-anchor="${opts.anchor ?? "start"}"${opts.weight ? ` font-weight="${opts.weight}"` : ""}>${esc(s)}</text>`;

interface Placed extends FlowNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

function layoutFlow(doc: Extract<MermaidDoc, { kind: "flowchart" }>) {
  const ids = doc.nodes.map((n) => n.id);
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    inn.set(id, []);
  }
  for (const e of doc.edges) {
    if (!out.has(e.from) || !inn.has(e.to) || e.from === e.to) continue;
    out.get(e.from)!.push(e.to);
    inn.get(e.to)!.push(e.from);
  }
  const layer = new Map<string, number>();
  const visiting = new Set<string>();
  const depth = (id: string): number => {
    if (layer.has(id)) return layer.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = inn.get(id)!;
    const d = parents.length ? Math.max(...parents.map((p) => depth(p) + 1)) : 0;
    visiting.delete(id);
    layer.set(id, d);
    return d;
  };
  for (const id of ids) depth(id);
  const layerCount = Math.max(0, ...[...layer.values()]) + 1;
  const layers: string[][] = Array.from({ length: layerCount }, () => []);
  for (const id of ids) layers[layer.get(id)!]!.push(id);
  const pos = new Map<string, number>();
  layers.forEach((arr) => arr.forEach((id, i) => pos.set(id, i)));
  const reorder = (li: number, ref: Map<string, string[]>) => {
    const bary = layers[li]!.map((id) => {
      const nb = ref.get(id)!.filter((n) => pos.has(n));
      return { id, b: nb.length ? nb.reduce((a, n) => a + pos.get(n)!, 0) / nb.length : pos.get(id) ?? 0 };
    });
    bary.sort((a, b) => a.b - b.b);
    layers[li] = bary.map((x) => x.id);
    layers[li]!.forEach((id, i) => pos.set(id, i));
  };
  for (let s = 0; s < 4; s++) {
    for (let li = 1; li < layerCount; li++) reorder(li, inn);
    for (let li = layerCount - 2; li >= 0; li--) reorder(li, out);
  }
  const horizontal = doc.direction === "LR" || doc.direction === "RL";
  const sizes = new Map(
    doc.nodes.map((n) => {
      let w = tw(n.label) + 28;
      let h = n.label.split("\n").length * LINE_H + 16;
      if (n.shape === "diamond") {
        w += 26;
        h += 14;
      }
      if (n.shape === "circle") w = h = Math.max(w, h) + 6;
      if (n.shape === "hexagon" || n.shape === "flag") w += 18;
      return [n.id, { w: Math.max(w, 44), h: Math.max(h, 30) }];
    }),
  );
  const gapMain = 44;
  const gapCross = 18;
  const cross = layers.map((arr) => arr.reduce((a, id) => a + (horizontal ? sizes.get(id)!.h : sizes.get(id)!.w), 0) + gapCross * Math.max(0, arr.length - 1));
  const totalCross = Math.max(...cross, 0);
  const main = layers.map((arr) => Math.max(...arr.map((id) => (horizontal ? sizes.get(id)!.w : sizes.get(id)!.h)), 0));
  const boxes = new Map<string, Placed>();
  let cursor = 0;
  layers.forEach((arr, li) => {
    let c = (totalCross - cross[li]!) / 2;
    for (const id of arr) {
      const size = sizes.get(id)!;
      const m = cursor + (main[li]! - (horizontal ? size.w : size.h)) / 2;
      boxes.set(id, { ...doc.nodes.find((n) => n.id === id)!, w: size.w, h: size.h, x: horizontal ? m : c, y: horizontal ? c : m });
      c += (horizontal ? size.h : size.w) + gapCross;
    }
    cursor += main[li]! + gapMain;
  });
  const width = horizontal ? cursor - gapMain : totalCross;
  const height = horizontal ? totalCross : cursor - gapMain;
  if (doc.direction === "BT") for (const b of boxes.values()) b.y = height - b.y - b.h;
  if (doc.direction === "RL") for (const b of boxes.values()) b.x = width - b.x - b.w;
  return { boxes, width, height };
}

function anchor(b: Placed, tx: number, ty: number) {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (!dx && !dy) return { x: cx, y: cy };
  const hw = b.w / 2;
  const hh = b.h / 2;
  if (b.shape === "circle") {
    const len = Math.hypot(dx, dy);
    return { x: cx + (dx / len) * hw, y: cy + (dy / len) * hh };
  }
  const s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: cx + dx * s, y: cy + dy * s };
}

function nodeShape(b: Placed, fill: string, stroke: string): string {
  const { x, y, w, h } = b;
  const common = `fill="${fill}" stroke="${stroke}" stroke-width="1.2"`;
  switch (b.shape) {
    case "round":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" ${common}/>`;
    case "stadium":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" ${common}/>`;
    case "circle":
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${w / 2}" ${common}/>`;
    case "diamond":
      return `<path d="M${x + w / 2},${y} L${x + w},${y + h / 2} L${x + w / 2},${y + h} L${x},${y + h / 2} Z" ${common} stroke-linejoin="round"/>`;
    case "hexagon":
      return `<path d="M${x + 10},${y} H${x + w - 10} L${x + w},${y + h / 2} L${x + w - 10},${y + h} H${x + 10} L${x},${y + h / 2} Z" ${common}/>`;
    case "flag":
      return `<path d="M${x},${y} H${x + w} V${y + h} H${x} L${x + 12},${y + h / 2} Z" ${common}/>`;
    default:
      return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ${common}/>`;
  }
}

function flowchartSvg(doc: Extract<MermaidDoc, { kind: "flowchart" }>, ink: Ink): string {
  const { boxes, width, height } = layoutFlow(doc);
  const pad = 16;
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width + pad * 2}" height="${height + pad * 2}" viewBox="${-pad} ${-pad} ${width + pad * 2} ${height + pad * 2}">`);
  out.push(`<rect x="${-pad}" y="${-pad}" width="${width + pad * 2}" height="${height + pad * 2}" fill="${ink.surface}"/>`);
  out.push(`<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><polygon points="0,0 10,5 0,10" fill="${ink.line}"/></marker><marker id="arrowStart" markerWidth="10" markerHeight="10" refX="1" refY="5" orient="auto" markerUnits="userSpaceOnUse"><polygon points="10,0 0,5 10,10" fill="${ink.line}"/></marker></defs>`);
  for (const e of doc.edges) {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) continue;
    const p1 = anchor(a, b.x + b.w / 2, b.y + b.h / 2);
    const p2 = anchor(b, a.x + a.w / 2, a.y + a.h / 2);
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    out.push(`<path d="M${p1.x},${p1.y} Q${mx},${my} ${p2.x},${p2.y}" stroke="${ink.line}" stroke-width="${e.style === "thick" ? 2.6 : 1.4}"${e.style === "dotted" ? ' stroke-dasharray="4,4"' : ""} fill="none"${e.arrow ? ' marker-end="url(#arrow)"' : ""}${e.both ? ' marker-start="url(#arrowStart)"' : ""}/>`);
    if (e.label) {
      const lw = tw(e.label) + 8;
      out.push(`<rect x="${mx - lw / 2}" y="${my - 9}" width="${lw}" height="18" rx="3" fill="${ink.surface}"/>`);
      out.push(txt(mx, my + 4, e.label, ink.text, { size: FONT_SIZE - 1, anchor: "middle" }));
    }
  }
  for (const b of boxes.values()) {
    out.push(nodeShape(b, b.shape === "diamond" ? ink.fillAlt : ink.fill, ink.border));
    const lines = b.label.split("\n");
    lines.forEach((line, li) => out.push(txt(b.x + b.w / 2, b.y + b.h / 2 + 4 + (li - (lines.length - 1) / 2) * LINE_H, line, ink.text, { anchor: "middle" })));
  }
  out.push("</svg>");
  return out.join("");
}

function sequenceSvg(doc: Extract<MermaidDoc, { kind: "sequence" }>, ink: Ink): string {
  const n = doc.participants.length;
  if (!n) return "";
  const HEAD = 34;
  const ROW = 34;
  const boxW = Math.max(60, ...doc.participants.map((p) => tw(p.label) + 24));
  let gap = 120;
  const walk = (events: SeqEvent[]) => {
    for (const e of events) {
      if (e.kind === "message") gap = Math.max(gap, tw(e.text) + 24);
      if (e.kind === "block") {
        walk(e.events);
        e.sections.forEach((s) => walk(s.events));
      }
    }
  };
  walk(doc.events);
  const step = Math.max(gap, boxW + 20);
  const natural = boxW + (n - 1) * step + 40;
  const lane = (i: number) => 20 + boxW / 2 + i * step;
  const idx = new Map(doc.participants.map((p, i) => [p.id, i]));
  const body: string[] = [];
  const frames: string[] = [];
  let y = HEAD + 24;
  const draw = (events: SeqEvent[], depth: number) => {
    for (const e of events) {
      if (e.kind === "message") {
        const a = lane(idx.get(e.from) ?? 0);
        const b = lane(idx.get(e.to) ?? 0);
        const dash = e.dotted ? ' stroke-dasharray="4,4"' : "";
        if (a === b) {
          body.push(`<path d="M${a},${y - 6} H${a + 30} V${y + 10} H${a + 6}" stroke="${ink.line}" stroke-width="1.3" fill="none"${dash}${e.head === "arrow" ? ' marker-end="url(#sarrow)"' : ""}/>`);
          body.push(txt(a + 36, y + 3, e.text, ink.text, { size: FONT_SIZE - 1 }));
        } else {
          const marker = e.head === "arrow" || e.head === "none" ? ' marker-end="url(#sarrow)"' : e.head === "open" ? ' marker-end="url(#sopen)"' : "";
          body.push(`<line x1="${a}" y1="${y}" x2="${b + (b > a ? -2 : 2)}" y2="${y}" stroke="${ink.line}" stroke-width="1.3"${dash}${marker}/>`);
          if (e.head === "cross") {
            const cx = b + (b > a ? -6 : 6);
            body.push(`<path d="M${cx - 4},${y - 4} L${cx + 4},${y + 4} M${cx - 4},${y + 4} L${cx + 4},${y - 4}" stroke="${ink.line}" stroke-width="1.4"/>`);
          }
          body.push(txt((a + b) / 2, y - 5, e.text, ink.text, { size: FONT_SIZE - 1, anchor: "middle" }));
        }
        y += ROW;
      } else if (e.kind === "note") {
        const lanes = e.over.map((id) => lane(idx.get(id) ?? 0));
        const w0 = tw(e.text) + 16;
        let x0: number;
        let w: number;
        if (e.side === "over") {
          const min = Math.min(...lanes);
          const max = Math.max(...lanes);
          w = Math.max(w0, max - min + 40);
          x0 = (min + max) / 2 - w / 2;
        } else if (e.side === "right") {
          x0 = lanes[0]! + 10;
          w = w0;
        } else {
          x0 = lanes[0]! - 10 - w0;
          w = w0;
        }
        const lines = e.text.split("\n");
        body.push(`<rect x="${x0}" y="${y - 8}" width="${w}" height="${lines.length * LINE_H + 10}" rx="3" fill="${ink.note}" stroke="${ink.border}"/>`);
        lines.forEach((line, li) => body.push(txt(x0 + w / 2, y + 5 + li * LINE_H, line, ink.text, { size: FONT_SIZE - 1, anchor: "middle" })));
        y += ROW * 1.4;
      } else {
        const top = y - 10;
        const x0 = 8 + depth * 8;
        const x1 = natural - 8 - depth * 8;
        y += ROW * 0.9;
        draw(e.events, depth + 1);
        for (const s of e.sections) {
          body.push(`<line x1="${x0}" y1="${y - 16}" x2="${x1}" y2="${y - 16}" stroke="${ink.border}" stroke-dasharray="4,3"/>`);
          body.push(txt(x0 + 8, y - 2, `[${s.text || (e.label === "alt" ? "else" : e.label === "par" ? "and" : "")}]`, ink.muted, { size: FONT_SIZE - 1 }));
          y += ROW * 0.9;
          draw(s.events, depth + 1);
        }
        y += ROW * 0.5;
        frames.push(`<rect x="${x0}" y="${top}" width="${x1 - x0}" height="${y - top - 8}" rx="3" fill="none" stroke="${ink.border}"/>`);
        body.push(`<rect x="${x0}" y="${top}" width="${tw(e.label) + 14}" height="16" fill="${ink.fillAlt}"/>`);
        body.push(txt(x0 + 7, top + 12, e.label, ink.text, { size: FONT_SIZE - 2, weight: "600" }));
        if (e.text) body.push(txt(x0 + tw(e.label) + 22, top + 12, `[${e.text}]`, ink.muted, { size: FONT_SIZE - 2 }));
      }
    }
  };
  draw(doc.events, 0);
  const bottom = y + 4;
  const heads: string[] = [];
  doc.participants.forEach((p, i) => {
    const cx = lane(i);
    heads.push(`<line x1="${cx}" y1="${HEAD}" x2="${cx}" y2="${bottom}" stroke="${ink.border}" stroke-dasharray="3,3"/>`);
    for (const yy of [0, bottom]) {
      heads.push(`<rect x="${cx - boxW / 2}" y="${yy}" width="${boxW}" height="${HEAD}" rx="${p.actor ? HEAD / 2 : 3}" fill="${ink.fill}" stroke="${ink.border}" stroke-width="1.2"/>`);
      heads.push(txt(cx, yy + HEAD / 2 + 4, p.label, ink.text, { anchor: "middle", weight: "600" }));
    }
  });
  const totalH = bottom + HEAD + 4;
  const pad = 12;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${natural + pad * 2}" height="${totalH + pad * 2}" viewBox="${-pad} ${-pad} ${natural + pad * 2} ${totalH + pad * 2}">` +
    `<rect x="${-pad}" y="${-pad}" width="${natural + pad * 2}" height="${totalH + pad * 2}" fill="${ink.surface}"/>` +
    `<defs><marker id="sarrow" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><polygon points="0,0 10,5 0,10" fill="${ink.line}"/></marker><marker id="sopen" markerWidth="10" markerHeight="10" refX="9" refY="5" orient="auto" markerUnits="userSpaceOnUse"><path d="M0,0 L10,5 L0,10" stroke="${ink.line}" stroke-width="1.3" fill="none"/></marker></defs>` +
    heads.join("") + frames.join("") + body.join("") + "</svg>"
  );
}

/** Mermaid source → SVG string, or null when the diagram type is unsupported. `pie` returns a chart spec instead. */
export function mermaidToSvg(source: string, ink: Ink = DARK_INK): { svg: string } | { pie: ChartSpec } | null {
  const doc = parseMermaid(source);
  if (doc.kind === "flowchart") return { svg: flowchartSvg(doc, ink) };
  if (doc.kind === "sequence") return { svg: sequenceSvg(doc, ink) };
  if (doc.kind === "pie") return { pie: doc.spec };
  return null;
}
