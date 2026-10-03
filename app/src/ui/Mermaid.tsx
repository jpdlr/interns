/**
 * A small Mermaid renderer for the two diagram kinds interns actually emit:
 * flowcharts (`graph` / `flowchart` TD|TB|BT|LR|RL) and sequence diagrams.
 * Parsed and laid out here, drawn with react-native-svg, so it is the same
 * on web and native and pulls in no dependency (the real mermaid is ~3 MB
 * and DOM-only). `pie` is folded into the chart renderer. Anything else
 * (class, state, gantt, er…) falls back to a code block with a note.
 *
 * Flowchart subset: node shapes [text] (text) ([text]) [[text]] {text}
 * ((text)) >text] {{text}}; edges --> --- -.-> ==> <--> with |label| or
 * -- label --> forms; chained A --> B --> C and fan-out A --> B & C;
 * `subgraph` blocks are flattened; `style`/`classDef`/`class`/`click`/`%%`
 * lines are ignored. Layout: longest-path layering, barycenter ordering,
 * straight-ish edges with arrowheads.
 *
 * Sequence subset: participant/actor (with `as` alias), messages with
 * -> --> ->> -->> -x --x -) --), `Note left of|right of|over`, and
 * loop/alt/opt/par/critical/rect blocks rendered as labelled frames;
 * activate/deactivate and autonumber are accepted and ignored.
 */
import React, { useState } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import Svg, { Defs, G, Line, Marker, Path, Polygon, Rect, Text as SvgText } from "react-native-svg";
import { radius, space, useAppTheme } from "../theme";
import type { ChartSpec } from "./Chart";
import { Text } from "./Text";

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const FONT_SIZE = 12;
const CHAR_W = 6.6; // average glyph width at 12px system sans — a measure-free estimate
const LINE_H = 16;

export type MermaidDoc =
  | { kind: "flowchart"; direction: "TD" | "BT" | "LR" | "RL"; nodes: FlowNode[]; edges: FlowEdge[] }
  | { kind: "sequence"; participants: Participant[]; events: SeqEvent[] }
  | { kind: "pie"; spec: ChartSpec }
  | { kind: "unsupported"; type: string };

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

// ------------------------------------------------------------------ parse

function unquote(s: string): string {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) ? t.slice(1, -1) : t;
}

/** Decode the handful of entities mermaid text tends to carry. */
function decode(s: string): string {
  return s.replace(/#quot;/g, '"').replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/<br\s*\/?>/gi, "\n").replace(/\\n/g, "\n");
}

export function parseMermaid(source: string): MermaidDoc {
  const lines = source
    .split(/\r?\n/)
    .map((l) => l.replace(/%%.*$/, "").trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { kind: "unsupported", type: "empty" };
  const head = lines[0]!;
  const flow = /^(graph|flowchart)\s*(TD|TB|BT|LR|RL)?\s*;?$/i.exec(head);
  if (flow) return parseFlowchart(lines.slice(1), (flow[2] ?? "TD").toUpperCase().replace("TB", "TD") as "TD" | "BT" | "LR" | "RL");
  if (/^sequenceDiagram/i.test(head)) return parseSequence(lines.slice(1));
  if (/^pie\b/i.test(head)) return parsePie(lines);
  return { kind: "unsupported", type: head.split(/\s+/)[0] ?? "diagram" };
}

const NODE_RE = /^([A-Za-z0-9_.-]+)(?:(\(\[|\[\[|\(\(|\{\{|\[|\(|\{|>)(.*?)(\]\)|\]\]|\)\)|\}\}|\]|\)|\}))?$/;

function parseNodeToken(token: string, nodes: Map<string, FlowNode>): string | null {
  const t = token.trim();
  const m = NODE_RE.exec(t);
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
    const label = inner !== undefined ? decode(unquote(inner)) : (nodes.get(id)?.label ?? id);
    nodes.set(id, { id, label, shape: open ? shape : (nodes.get(id)?.shape ?? "rect") });
  }
  return id;
}

// An edge token: optional leading "--"/"-." text form, the arrow, optional |label|.
// Inline-label forms come first: "-- yes -->" must not be read as "--" then a node named "yes".
const EDGE_RE = /^\s*(<)?(--\s*[^-|>]+?\s*--|-\.\s*[^-|>]+?\s*\.-|==\s*[^=|>]+?\s*==|-{2,}|-\.+-|={2,})(>|o|x)?\s*(?:\|([^|]*)\|)?\s*/;

function parseFlowchart(lines: string[], direction: "TD" | "BT" | "LR" | "RL"): MermaidDoc {
  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  for (const raw of lines) {
    const line = raw.replace(/;$/, "").trim();
    if (/^(subgraph|end|style|classDef|class|click|linkStyle|direction)\b/i.test(line)) {
      const sg = /^subgraph\s+[^\s[]+\s*\[(.*)\]/i.exec(line);
      void sg; // subgraph titles are dropped; their members still lay out
      continue;
    }
    // Split the statement into node / edge tokens, walking left to right.
    let rest = line;
    let prev: string[] | null = null;
    let pendingEdge: FlowEdge | null = null;
    let guard = 0;
    while (rest.length > 0 && guard++ < 50) {
      // node group: A or A[label], possibly "A & B"
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
      if (prev && pendingEdge) {
        for (const a of prev) for (const b of group) edges.push({ ...pendingEdge, from: a, to: b });
      }
      prev = group;
      const e = EDGE_RE.exec(rest);
      if (!e) break;
      rest = rest.slice(e[0].length);
      const body = e[2]!;
      let label = e[4] !== undefined ? decode(unquote(e[4])) : undefined;
      const inline = /^(?:--|-\.|==)\s*(.+?)\s*(?:--|\.-|==)$/.exec(body);
      if (inline) label = decode(unquote(inline[1]!));
      const style: FlowEdge["style"] = body.startsWith("=") ? "thick" : /\./.test(body) ? "dotted" : "solid";
      pendingEdge = { from: "", to: "", label, style, arrow: Boolean(e[3]), both: Boolean(e[1]) && Boolean(e[3]) };
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
  const stack: { kind: "block"; label: string; text: string; events: SeqEvent[]; sections: { text: string; events: SeqEvent[] }[] }[] = [];
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
      const block = { kind: "block" as const, label: m[1]!.toLowerCase(), text: decode(m[2] ?? ""), events: [], sections: [] };
      target().push(block);
      stack.push(block);
      continue;
    }
    if ((m = /^(else|and|option)\b\s*(.*)$/i.exec(line))) {
      const top = stack[stack.length - 1];
      if (top) top.sections.push({ text: decode(m[2] ?? ""), events: [] });
      continue;
    }
    if (/^end$/i.test(line)) {
      stack.pop();
      continue;
    }
    if ((m = /^note\s+(left of|right of|over)\s+([^:]+):\s*(.*)$/i.exec(line))) {
      const side = m[1]!.toLowerCase().startsWith("left") ? "left" : m[1]!.toLowerCase().startsWith("right") ? "right" : "over";
      const over = m[2]!.split(",").map((s) => ensure(s));
      target().push({ kind: "note", over, side, text: decode(m[3] ?? "") });
      continue;
    }
    if ((m = /^(.+?)\s*(-->>|->>|-->|->|--x|-x|--\)|-\))\s*([+-]?)\s*(.+?):\s*(.*)$/.exec(line))) {
      const from = ensure(m[1]!);
      const to = ensure(m[4]!);
      const op = m[2]!;
      const head: "arrow" | "open" | "cross" | "none" = op.endsWith(">>") ? "arrow" : op.endsWith("x") ? "cross" : op.endsWith(")") ? "open" : "none";
      target().push({ kind: "message", from, to, text: decode(m[5] ?? ""), dotted: op.startsWith("--"), head });
      continue;
    }
  }
  return { kind: "sequence", participants, events: root };
}

function parsePie(lines: string[]): MermaidDoc {
  const title = /^pie\b(?:\s+showData)?\s*(?:title\s+(.*))?$/i.exec(lines[0]!)?.[1];
  const labels: string[] = [];
  const data: number[] = [];
  for (const line of lines.slice(1)) {
    const t = /^title\s+(.*)$/i.exec(line);
    if (t) continue;
    const m = /^"([^"]*)"\s*:\s*([\d.]+)/.exec(line);
    if (m) {
      labels.push(m[1]!);
      data.push(Number(m[2]));
    }
  }
  if (labels.length === 0) return { kind: "unsupported", type: "pie" };
  return { kind: "pie", spec: { type: "pie", title: title ? decode(title) : undefined, labels, series: [{ name: "Share", data }] } };
}

// ----------------------------------------------------------------- layout

function textWidth(s: string): number {
  return Math.max(...s.split("\n").map((l) => l.length)) * CHAR_W;
}
function textLines(s: string): string[] {
  return s.split("\n");
}

interface Placed extends FlowNode {
  x: number;
  y: number;
  w: number;
  h: number;
  layer: number;
}

/** Longest-path layering + barycenter sweeps; returns absolute box positions. */
function layoutFlow(doc: Extract<MermaidDoc, { kind: "flowchart" }>, maxWidth: number) {
  const ids = doc.nodes.map((n) => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const out = new Map<string, string[]>();
  const inn = new Map<string, string[]>();
  for (const id of ids) {
    out.set(id, []);
    inn.set(id, []);
  }
  for (const e of doc.edges) {
    if (!index.has(e.from) || !index.has(e.to) || e.from === e.to) continue;
    out.get(e.from)!.push(e.to);
    inn.get(e.to)!.push(e.from);
  }
  // Layer = longest path from a source; cycles are broken by visitation order.
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
  // Barycenter ordering, a few sweeps down and up.
  const pos = new Map<string, number>();
  const reorder = (li: number, ref: Map<string, string[]>) => {
    const arr = layers[li]!;
    const bary = arr.map((id) => {
      const nb = ref.get(id)!.filter((n) => pos.has(n));
      return { id, b: nb.length ? nb.reduce((a, n) => a + pos.get(n)!, 0) / nb.length : pos.get(id) ?? 0 };
    });
    bary.sort((a, b) => a.b - b.b);
    layers[li] = bary.map((x) => x.id);
    layers[li]!.forEach((id, i) => pos.set(id, i));
  };
  layers.forEach((arr) => arr.forEach((id, i) => pos.set(id, i)));
  for (let sweep = 0; sweep < 4; sweep++) {
    for (let li = 1; li < layerCount; li++) reorder(li, inn);
    for (let li = layerCount - 2; li >= 0; li--) reorder(li, out);
  }
  const horizontal = doc.direction === "LR" || doc.direction === "RL";
  const padX = 14;
  const padY = 8;
  const gapMain = 44; // between layers
  const gapCross = 18; // between siblings
  const boxes = new Map<string, Placed>();
  const sizes = new Map(
    doc.nodes.map((n) => {
      const lines = textLines(n.label);
      let w = textWidth(n.label) + padX * 2;
      let h = lines.length * LINE_H + padY * 2;
      if (n.shape === "diamond") {
        w += 26;
        h += 14;
      }
      if (n.shape === "circle") {
        const d = Math.max(w, h) + 6;
        w = d;
        h = d;
      }
      if (n.shape === "hexagon" || n.shape === "flag") w += 18;
      return [n.id, { w: Math.max(w, 44), h: Math.max(h, 30) }];
    }),
  );
  // Cross-axis width of each layer, then centre every layer on the widest.
  const layerCross = layers.map((arr) => arr.reduce((acc, id) => acc + (horizontal ? sizes.get(id)!.h : sizes.get(id)!.w), 0) + gapCross * Math.max(0, arr.length - 1));
  const totalCross = Math.max(...layerCross, 0);
  const layerMain = layers.map((arr) => Math.max(...arr.map((id) => (horizontal ? sizes.get(id)!.w : sizes.get(id)!.h)), 0));
  let mainCursor = 0;
  layers.forEach((arr, li) => {
    let crossCursor = (totalCross - layerCross[li]!) / 2;
    for (const id of arr) {
      const size = sizes.get(id)!;
      const node = doc.nodes.find((n) => n.id === id)!;
      const main = mainCursor + (layerMain[li]! - (horizontal ? size.w : size.h)) / 2;
      boxes.set(id, {
        ...node,
        w: size.w,
        h: size.h,
        x: horizontal ? main : crossCursor,
        y: horizontal ? crossCursor : main,
        layer: li,
      });
      crossCursor += (horizontal ? size.h : size.w) + gapCross;
    }
    mainCursor += layerMain[li]! + gapMain;
  });
  let width = horizontal ? mainCursor - gapMain : totalCross;
  let height = horizontal ? totalCross : mainCursor - gapMain;
  // Reverse directions flip the main axis.
  if (doc.direction === "BT") for (const b of boxes.values()) b.y = height - b.y - b.h;
  if (doc.direction === "RL") for (const b of boxes.values()) b.x = width - b.x - b.w;
  // Fit to the bubble: scale down when wider than the box, never up.
  const scale = width > maxWidth ? maxWidth / width : 1;
  return { boxes, width, height, scale, horizontal };
}

// --------------------------------------------------------------- drawing

function nodePath(b: Placed): { d?: string; rx?: number; kind: "rect" | "path" } {
  const { x, y, w, h } = b;
  switch (b.shape) {
    case "round":
      return { kind: "rect", rx: 8 };
    case "stadium":
      return { kind: "rect", rx: h / 2 };
    case "circle":
      return { kind: "rect", rx: w / 2 };
    case "diamond":
      return { kind: "path", d: `M${x + w / 2},${y} L${x + w},${y + h / 2} L${x + w / 2},${y + h} L${x},${y + h / 2} Z` };
    case "hexagon":
      return { kind: "path", d: `M${x + 10},${y} H${x + w - 10} L${x + w},${y + h / 2} L${x + w - 10},${y + h} H${x + 10} L${x},${y + h / 2} Z` };
    case "flag":
      return { kind: "path", d: `M${x},${y} H${x + w} V${y + h} H${x} L${x + 12},${y + h / 2} Z` };
    default:
      return { kind: "rect", rx: 3 };
  }
}

/** Point on the box border towards a target, so arrows stop at the edge instead of the centre. */
function anchor(b: Placed, tx: number, ty: number): { x: number; y: number } {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = b.w / 2;
  const hh = b.h / 2;
  if (b.shape === "circle") {
    const len = Math.hypot(dx, dy);
    return { x: cx + (dx / len) * hw, y: cy + (dy / len) * hh };
  }
  const scaleX = Math.abs(dx) > 0 ? hw / Math.abs(dx) : Infinity;
  const scaleY = Math.abs(dy) > 0 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(scaleX, scaleY);
  return { x: cx + dx * s, y: cy + dy * s };
}

function Flowchart({ doc, width, ink }: { doc: Extract<MermaidDoc, { kind: "flowchart" }>; width: number; ink: Ink }) {
  const { boxes, width: w, height: h, scale } = layoutFlow(doc, width - 8);
  const svgW = Math.max(1, w * scale + 8);
  const svgH = Math.max(1, h * scale + 8);
  const nodes: React.ReactNode[] = [];
  const edges: React.ReactNode[] = [];
  doc.edges.forEach((e, i) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) return;
    const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
    const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    const p1 = anchor(a, bc.x, bc.y);
    const p2 = anchor(b, ac.x, ac.y);
    // Slight curve when nodes are not aligned, so parallel edges read as separate.
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const d = `M${p1.x},${p1.y} Q${mx},${my} ${p2.x},${p2.y}`;
    edges.push(
      <Path
        key={`e${i}`}
        d={d}
        stroke={ink.line}
        strokeWidth={e.style === "thick" ? 2.6 : 1.4}
        strokeDasharray={e.style === "dotted" ? "4,4" : undefined}
        fill="none"
        markerEnd={e.arrow ? "url(#arrow)" : undefined}
        markerStart={e.both ? "url(#arrowStart)" : undefined}
      />,
    );
    if (e.label) {
      const lw = textWidth(e.label) + 8;
      edges.push(<Rect key={`el${i}`} x={mx - lw / 2} y={my - 9} width={lw} height={18} rx={3} fill={ink.surface} />);
      edges.push(
        <SvgText key={`et${i}`} x={mx} y={my + 4} fontSize={FONT_SIZE - 1} fontFamily={FONT} fill={ink.text} textAnchor="middle">
          {e.label}
        </SvgText>,
      );
    }
  });
  for (const b of boxes.values()) {
    const shape = nodePath(b);
    const fill = b.shape === "diamond" ? ink.fillAlt : ink.fill;
    nodes.push(
      shape.kind === "rect" ? (
        <Rect key={`n${b.id}`} x={b.x} y={b.y} width={b.w} height={b.h} rx={shape.rx} fill={fill} stroke={ink.border} strokeWidth={1.2} />
      ) : (
        <Path key={`n${b.id}`} d={shape.d!} fill={fill} stroke={ink.border} strokeWidth={1.2} strokeLinejoin="round" />
      ),
    );
    const lines = textLines(b.label);
    lines.forEach((line, li) => {
      nodes.push(
        <SvgText key={`t${b.id}-${li}`} x={b.x + b.w / 2} y={b.y + b.h / 2 + 4 + (li - (lines.length - 1) / 2) * LINE_H} fontSize={FONT_SIZE} fontFamily={FONT} fill={ink.text} textAnchor="middle">
          {line}
        </SvgText>,
      );
    });
  }
  return (
    <Svg width={svgW} height={svgH} viewBox={`-4 -4 ${w + 8} ${h + 8}`} accessibilityLabel="flowchart">
      <Defs>
        <Marker id="arrow" markerWidth={10} markerHeight={10} refX={9} refY={5} orient="auto" markerUnits="userSpaceOnUse">
          <Polygon points="0,0 10,5 0,10" fill={ink.line} />
        </Marker>
        <Marker id="arrowStart" markerWidth={10} markerHeight={10} refX={1} refY={5} orient="auto" markerUnits="userSpaceOnUse">
          <Polygon points="10,0 0,5 10,10" fill={ink.line} />
        </Marker>
      </Defs>
      <G>{edges}</G>
      <G>{nodes}</G>
    </Svg>
  );
}

const SEQ_HEAD_H = 34;
const SEQ_ROW = 34;
const SEQ_MIN_GAP = 120;

function flattenSeq(events: SeqEvent[]): { rows: number } {
  let rows = 0;
  for (const e of events) {
    if (e.kind === "block") {
      rows += 1 + flattenSeq(e.events).rows;
      for (const s of e.sections) rows += 1 + flattenSeq(s.events).rows;
      rows += 0.5;
    } else if (e.kind === "note") rows += 1.4;
    else rows += 1;
  }
  return { rows };
}

function SequenceDiagram({ doc, width, ink }: { doc: Extract<MermaidDoc, { kind: "sequence" }>; width: number; ink: Ink }) {
  const n = doc.participants.length;
  if (n === 0) return null;
  const labelWidths = doc.participants.map((p) => textWidth(p.label) + 24);
  const boxW = Math.max(60, ...labelWidths);
  // Gap: enough for the longest message between adjacent lanes, capped by the bubble.
  let gap = SEQ_MIN_GAP;
  const walk = (events: SeqEvent[]) => {
    for (const e of events) {
      if (e.kind === "message") gap = Math.max(gap, textWidth(e.text) + 24);
      if (e.kind === "block") {
        walk(e.events);
        e.sections.forEach((s) => walk(s.events));
      }
    }
  };
  walk(doc.events);
  const natural = boxW + (n - 1) * Math.max(gap, boxW + 20) + 40;
  const scale = natural > width ? width / natural : 1;
  const lane = (i: number) => 20 + boxW / 2 + i * Math.max(gap, boxW + 20);
  const idx = new Map(doc.participants.map((p, i) => [p.id, i]));
  const totalRows = flattenSeq(doc.events).rows;
  const h = SEQ_HEAD_H + 16 + totalRows * SEQ_ROW + SEQ_HEAD_H + 8;
  const nodes: React.ReactNode[] = [];
  let y = SEQ_HEAD_H + 24;

  const drawEvents = (events: SeqEvent[], depth: number) => {
    for (const e of events) {
      if (e.kind === "message") {
        const a = lane(idx.get(e.from) ?? 0);
        const b = lane(idx.get(e.to) ?? 0);
        const self = a === b;
        const label = e.text;
        if (self) {
          nodes.push(<Path key={`m${y}`} d={`M${a},${y - 6} H${a + 30} V${y + 10} H${a + 6}`} stroke={ink.line} strokeWidth={1.3} fill="none" strokeDasharray={e.dotted ? "4,4" : undefined} markerEnd={e.head === "arrow" ? "url(#sarrow)" : undefined} />);
          nodes.push(
            <SvgText key={`mt${y}`} x={a + 36} y={y + 3} fontSize={FONT_SIZE - 1} fontFamily={FONT} fill={ink.text}>
              {label}
            </SvgText>,
          );
        } else {
          nodes.push(<Line key={`m${y}`} x1={a} y1={y} x2={b + (b > a ? -2 : 2)} y2={y} stroke={ink.line} strokeWidth={1.3} strokeDasharray={e.dotted ? "4,4" : undefined} markerEnd={e.head === "arrow" || e.head === "none" ? "url(#sarrow)" : e.head === "open" ? "url(#sopen)" : undefined} />);
          if (e.head === "cross") {
            const cx = b + (b > a ? -6 : 6);
            nodes.push(<Path key={`mx${y}`} d={`M${cx - 4},${y - 4} L${cx + 4},${y + 4} M${cx - 4},${y + 4} L${cx + 4},${y - 4}`} stroke={ink.line} strokeWidth={1.4} />);
          }
          nodes.push(
            <SvgText key={`mt${y}`} x={(a + b) / 2} y={y - 5} fontSize={FONT_SIZE - 1} fontFamily={FONT} fill={ink.text} textAnchor="middle">
              {label}
            </SvgText>,
          );
        }
        y += SEQ_ROW;
      } else if (e.kind === "note") {
        const lanes = e.over.map((id) => lane(idx.get(id) ?? 0));
        const tw = textWidth(e.text) + 16;
        let x0: number;
        let w: number;
        if (e.side === "over") {
          const min = Math.min(...lanes);
          const max = Math.max(...lanes);
          w = Math.max(tw, max - min + 40);
          x0 = (min + max) / 2 - w / 2;
        } else if (e.side === "right") {
          x0 = lanes[0]! + 10;
          w = tw;
        } else {
          x0 = lanes[0]! - 10 - tw;
          w = tw;
        }
        const lines = textLines(e.text);
        const nh = lines.length * LINE_H + 10;
        nodes.push(<Rect key={`n${y}`} x={x0} y={y - 8} width={w} height={nh} rx={3} fill={ink.note} stroke={ink.border} strokeWidth={1} />);
        lines.forEach((line, li) =>
          nodes.push(
            <SvgText key={`nt${y}-${li}`} x={x0 + w / 2} y={y + 5 + li * LINE_H} fontSize={FONT_SIZE - 1} fontFamily={FONT} fill={ink.text} textAnchor="middle">
              {line}
            </SvgText>,
          ),
        );
        y += SEQ_ROW * 1.4;
      } else {
        const top = y - 10;
        const x0 = 8 + depth * 8;
        const x1 = natural - 8 - depth * 8;
        y += SEQ_ROW * 0.9;
        drawEvents(e.events, depth + 1);
        for (const s of e.sections) {
          nodes.push(<Line key={`sec${y}`} x1={x0} y1={y - 16} x2={x1} y2={y - 16} stroke={ink.border} strokeWidth={1} strokeDasharray="4,3" />);
          nodes.push(
            <SvgText key={`sect${y}`} x={x0 + 8} y={y - 2} fontSize={FONT_SIZE - 1} fontFamily={FONT} fill={ink.muted}>
              {`[${s.text || (e.label === "alt" ? "else" : e.label === "par" ? "and" : "")}]`}
            </SvgText>,
          );
          y += SEQ_ROW * 0.9;
          drawEvents(s.events, depth + 1);
        }
        y += SEQ_ROW * 0.5;
        nodes.unshift(<Rect key={`b${top}`} x={x0} y={top} width={x1 - x0} height={y - top - 8} rx={3} fill="none" stroke={ink.border} strokeWidth={1} />);
        nodes.push(<Rect key={`bl${top}`} x={x0} y={top} width={textWidth(e.label) + 14} height={16} fill={ink.fillAlt} />);
        nodes.push(
          <SvgText key={`blt${top}`} x={x0 + 7} y={top + 12} fontSize={FONT_SIZE - 2} fontFamily={FONT} fill={ink.text} fontWeight="600">
            {e.label}
          </SvgText>,
        );
        if (e.text) {
          nodes.push(
            <SvgText key={`bx${top}`} x={x0 + textWidth(e.label) + 22} y={top + 12} fontSize={FONT_SIZE - 2} fontFamily={FONT} fill={ink.muted}>
              {`[${e.text}]`}
            </SvgText>,
          );
        }
      }
    }
  };
  drawEvents(doc.events, 0);
  const bottom = y + 4;
  const heads: React.ReactNode[] = [];
  doc.participants.forEach((p, i) => {
    const cx = lane(i);
    heads.push(<Line key={`l${i}`} x1={cx} y1={SEQ_HEAD_H} x2={cx} y2={bottom} stroke={ink.border} strokeWidth={1} strokeDasharray="3,3" />);
    for (const yy of [0, bottom]) {
      heads.push(<Rect key={`h${i}-${yy}`} x={cx - boxW / 2} y={yy} width={boxW} height={SEQ_HEAD_H} rx={p.actor ? SEQ_HEAD_H / 2 : 3} fill={ink.fill} stroke={ink.border} strokeWidth={1.2} />);
      heads.push(
        <SvgText key={`ht${i}-${yy}`} x={cx} y={yy + SEQ_HEAD_H / 2 + 4} fontSize={FONT_SIZE} fontFamily={FONT} fill={ink.text} textAnchor="middle" fontWeight="600">
          {p.label}
        </SvgText>,
      );
    }
  });
  const totalH = bottom + SEQ_HEAD_H + 4;
  void h;
  return (
    <Svg width={natural * scale} height={totalH * scale} viewBox={`0 0 ${natural} ${totalH}`} accessibilityLabel="sequence diagram">
      <Defs>
        <Marker id="sarrow" markerWidth={10} markerHeight={10} refX={9} refY={5} orient="auto" markerUnits="userSpaceOnUse">
          <Polygon points="0,0 10,5 0,10" fill={ink.line} />
        </Marker>
        <Marker id="sopen" markerWidth={10} markerHeight={10} refX={9} refY={5} orient="auto" markerUnits="userSpaceOnUse">
          <Path d="M0,0 L10,5 L0,10" stroke={ink.line} strokeWidth={1.3} fill="none" />
        </Marker>
      </Defs>
      <G>{heads}</G>
      <G>{nodes}</G>
    </Svg>
  );
}

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

export interface MermaidProps {
  source: string;
  /** rendered when the diagram type is unsupported; the caller usually shows the source as code */
  fallback?: React.ReactNode;
  /** chart renderer for `pie`, injected to avoid a circular import */
  renderPie?: (spec: ChartSpec) => React.ReactNode;
}

function MermaidImpl({ source, fallback, renderPie }: MermaidProps) {
  const { colors, scheme } = useAppTheme();
  const [width, setWidth] = useState(0);
  const doc = React.useMemo(() => parseMermaid(source), [source]);
  const ink: Ink = {
    text: colors.text,
    muted: colors.textDim,
    line: colors.textDim,
    border: colors.textFaint,
    fill: scheme === "dark" ? "rgba(57,135,229,0.22)" : "rgba(42,120,214,0.12)",
    fillAlt: scheme === "dark" ? "rgba(217,89,38,0.22)" : "rgba(235,104,52,0.12)",
    note: scheme === "dark" ? "rgba(201,133,0,0.22)" : "rgba(237,161,0,0.16)",
    surface: colors.surface,
  };
  if (doc.kind === "unsupported") {
    return (
      <View>
        <Text variant="caption">{`${doc.type} diagrams are not rendered yet — source below.`}</Text>
        {fallback}
      </View>
    );
  }
  if (doc.kind === "pie") return <View>{renderPie ? renderPie(doc.spec) : fallback}</View>;
  return (
    <View style={[styles.frame, { backgroundColor: colors.surface, borderColor: colors.border }]} onLayout={(e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width) - space.sm * 2)}>
      {width > 0 ? (
        <View style={styles.center}>
          {doc.kind === "flowchart" ? <Flowchart doc={doc} width={width} ink={ink} /> : <SequenceDiagram doc={doc} width={width} ink={ink} />}
        </View>
      ) : null}
    </View>
  );
}

export const Mermaid = React.memo(MermaidImpl);

const styles = StyleSheet.create({
  frame: {
    width: "100%",
    minWidth: 220,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.sm,
    marginVertical: space.xs,
    overflow: "hidden",
  },
  center: { alignItems: "center" },
});
