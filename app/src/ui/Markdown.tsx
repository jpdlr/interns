/**
 * Deliberately tiny markdown renderer — headings, bullets, numbered lists,
 * blockquotes, horizontal rules, fenced/inline code, bold, italic and links
 * (as styled text). Used for both card bodies and chat bubbles: interns write
 * markdown, so raw `**stars**` in a message bubble is a bug. Markdown links
 * and pasted web URLs are real, tappable links on native and web.
 *
 * A real markdown dependency is not worth the bundle weight for this, and a
 * WebView per bubble would be far worse. Parsing is a single pass over the
 * lines and the component is memoised, so a long thread re-rendering on every
 * SSE event does not re-parse anything.
 */
import React, { useState } from "react";
import { Image, Linking, Platform, Pressable, ScrollView, Share, StyleSheet, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { useRouter } from "expo-router";
import { useCrew } from "../crew";
import { usePage } from "../usePage";
import { radius, space, useAppTheme, type AppColors } from "../theme";
import { Chart, parseChartBlock } from "./Chart";
import { ChecklistBlock, FenceQuickReplies, PagePreview, parseChecklist, parseFenceJson, RuleChip, RuleGroup } from "./Fences";
import { CheckIcon, CopyIcon, UsersIcon } from "./Icons";
import { InternFace } from "./InternFace";
import { Mermaid } from "./Mermaid";
import { SvgBlock } from "./SvgBlock";
import { Text, type TextVariant } from "./Text";

/**
 * Put text on the clipboard. Web has the async clipboard API; native RN has
 * no clipboard without a module, so the share sheet stands in (it offers
 * Copy on iOS). Resolves true when something happened.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (Platform.OS === "web") {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      return false;
    }
    await Share.share({ message: text });
    return true;
  } catch {
    return false;
  }
}

/** A fenced code block with a language tag and a copy button in its corner. */
function CodeFence({ source, lang, palette }: { source: string; lang: string; palette: Palette }) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (await copyText(source)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <View style={[styles.fence, { borderColor: palette.rule, backgroundColor: palette.codeBg }]}>
      <View style={styles.fenceBar}>
        <Text variant="label" color={palette.dim}>
          {lang || "code"}
        </Text>
        <Pressable onPress={() => void onCopy()} accessibilityRole="button" accessibilityLabel={copied ? "Copied" : Platform.OS === "web" ? "Copy code" : "Share code"} hitSlop={8} style={styles.fenceAction}>
          {copied ? <CheckIcon size={15} color={palette.dim} /> : <CopyIcon size={15} color={palette.dim} />}
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
        <Text variant="mono" color={palette.text} selectable>
          {source}
        </Text>
      </ScrollView>
    </View>
  );
}

/** "onAccent" = drawn on the violet bubble, where accent-coloured ink vanishes. */
export type MarkdownTone = "default" | "onAccent";

interface Palette {
  text: string;
  dim: string;
  code: string;
  codeBg: string;
  link: string;
  rule: string;
}

function palettes(colors: AppColors): Record<MarkdownTone, Palette> {
  return {
    default: {
      text: colors.text,
      dim: colors.textDim,
      code: colors.text,
      codeBg: colors.surfaceAlt,
      link: colors.text,
      rule: colors.border,
    },
    onAccent: {
      text: colors.onAccent,
      dim: colors.onAccent,
      code: colors.onAccent,
      codeBg: colors.accentSoft,
      link: colors.onAccent,
      rule: colors.onAccent,
    },
  };
}

type Span = { text: string; bold?: boolean; italic?: boolean; code?: boolean; href?: string; mention?: string; page?: string; pageItem?: string };

// The @mention alternative must not fire inside an email address: it requires a non-word char (or line start) before the @.
// ⟨pg_…·item⟩ is the page reference the app adds when JP acts on a page item (docs/features/02-pages.md).
const INLINE = /(⟨pg_[^⟩\s]+⟩|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_|`[^`]+`|\[[^\]]+\]\([^)]+\)|https?:\/\/[^\s<>()]+|mailto:[^\s<>()]+|(?<![\w@/.-])@[\w][\w.-]*)/g;

/** The page reference as a small inline link (like @mentions) — the ids stay out of sight. */
function PageRefChip({ pageId, itemId, tone }: { pageId: string; itemId?: string; tone: Palette }) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { page } = usePage(pageId);
  // On JP's own (accent) bubble a blue tint would fight the fill.
  const color = tone.text === colors.onAccent ? tone.dim : colors.info;
  return (
    <Text
      variant="caption"
      color={color}
      onPress={() => router.push(`/page/${pageId}${itemId ? `?item=${encodeURIComponent(itemId)}` : ""}` as never)}
      accessibilityRole="link"
      accessibilityLabel={`Open ${page?.title ?? "the page"}`}
    >
      {`  📄 ${page?.title ?? "page"}`}
    </Text>
  );
}

/**
 * `@Name` drawn as inline text: bold and tinted, tappable to open that
 * intern's thread. It stays a Text (not a View chip) so it wraps and
 * punctuates like a word — "Nia's numbers", not "[Nia] 's numbers". The
 * face pills live in the composer's suggestion row, where they help pick.
 * Unknown names stay plain text.
 */
function MentionChip({ token, tone, variant }: { token: string; tone: Palette; variant: TextVariant }) {
  const { colors } = useAppTheme();
  const { resolve } = useCrew();
  const router = useRouter();
  const member = resolve(token);
  // On JP's own (accent) bubble a blue tint would fight the fill; bold reads fine.
  const color = tone.text === colors.onAccent ? tone.text : colors.info;
  if (!member && ["all", "everyone", "team", "here"].includes(token.toLowerCase())) {
    return (
      <Text variant={variant} color={color} style={styles.mentionName} accessibilityLabel="Everyone">
        @everyone
      </Text>
    );
  }
  if (!member) return <Text variant={variant} color={tone.text}>{`@${token}`}</Text>;
  return (
    <Text
      variant={variant}
      color={color}
      style={styles.mentionName}
      onPress={() => router.push(`/chat/${member.slug}` as never)}
      accessibilityRole="link"
      accessibilityLabel={`Open ${member.name}`}
    >
      {`@${member.name.split(" ")[0]}`}
    </Text>
  );
}

/** Refuse executable/custom schemes supplied by an agent. */
function safeHref(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function parseInline(line: string): Span[] {
  const spans: Span[] = [];
  let last = 0;
  for (const match of line.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > last) spans.push({ text: line.slice(last, index) });
    const token = match[0];
    if (token.startsWith("⟨")) {
      const [pageId, pageItem] = token.slice(1, -1).split("·");
      spans.push({ text: "", page: pageId, ...(pageItem ? { pageItem } : {}) });
    } else if (token.startsWith("**") || token.startsWith("__")) {
      // Emphasis nests: **[label](url)** and **@Rhea** keep their link / mention.
      for (const inner of parseInline(token.slice(2, -2))) spans.push({ ...inner, bold: true });
    } else if (token.startsWith("`")) {
      spans.push({ text: token.slice(1, -1), code: true });
    } else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      spans.push({ text: link?.[1] ?? token, href: link ? safeHref(link[2]) : undefined });
    } else if (token.startsWith("@")) {
      spans.push({ text: token, mention: token.slice(1).replace(/[.]+$/, "") });
      const trailing = /[.]+$/.exec(token)?.[0] ?? "";
      if (trailing) spans.push({ text: trailing });
    } else if (token.startsWith("http://") || token.startsWith("https://") || token.startsWith("mailto:")) {
      // A full stop after a pasted URL belongs to the sentence, not the URL.
      const trailing = /[.,!?;:]+$/.exec(token)?.[0] ?? "";
      const text = trailing ? token.slice(0, -trailing.length) : token;
      spans.push({ text, href: safeHref(text) });
      if (trailing) spans.push({ text: trailing });
    } else {
      for (const inner of parseInline(token.slice(1, -1))) spans.push({ ...inner, italic: true });
    }
    last = index + token.length;
  }
  if (last < line.length) spans.push({ text: line.slice(last) });
  return spans.length ? spans : [{ text: line }];
}

interface InlineProps {
  line: string;
  palette: Palette;
  variant: TextVariant;
  color?: string;
  emphasized?: boolean;
}

const TABLE_COLUMN_WIDTH = 156;
// A table inside a chat bubble has substantially less room than the device
// viewport. Below this width, a sideways scroll area is both fiddly to find
// and easy to mistake for the vertical conversation scroll.
const TABLE_STACK_BREAKPOINT = 520;

function tableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (character === "\\" && trimmed[index + 1] === "|") {
      cell += "|";
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableDivider(line: string): boolean {
  const cells = tableCells(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function MarkdownTable({ rows, palette, variant }: { rows: string[][]; palette: Palette; variant: TextVariant }) {
  const { width: viewportWidth } = useWindowDimensions();
  const columnCount = Math.max(...rows.map((row) => row.length));
  const width = columnCount * TABLE_COLUMN_WIDTH;

  // On a phone, turn each data row into a compact labelled card instead of
  // making the reader horizontally swipe within the chat's vertical scroller.
  // The first column is the row heading; the remaining column headings make
  // every value self-explanatory without requiring the table header to stay
  // visible while reading.
  if (viewportWidth < TABLE_STACK_BREAKPOINT && columnCount > 1 && rows.length > 1) {
    const headers = rows[0] ?? [];
    return (
      <View style={styles.stackedTable} accessibilityRole="summary" accessibilityLabel={`Table with ${rows.length - 1} rows`}>
        {rows.slice(1).map((row, rowIndex) => (
          <View key={rowIndex} style={[styles.stackedTableRow, { backgroundColor: palette.codeBg, borderColor: palette.rule }]}>
            {headers[0] ? (
              <Inline line={row[0] ?? ""} palette={palette} variant={variant} color={palette.text} emphasized />
            ) : null}
            {Array.from({ length: columnCount - 1 }, (_, offset) => {
              const columnIndex = offset + 1;
              return (
                <View key={columnIndex} style={styles.stackedTableCell}>
                  <Text variant="caption" color={palette.dim} style={styles.stackedTableLabel}>
                    {headers[columnIndex] ?? `Column ${columnIndex + 1}`}
                  </Text>
                  <View style={styles.stackedTableValue}>
                    <Inline line={row[columnIndex] ?? ""} palette={palette} variant={variant} color={palette.text} />
                  </View>
                </View>
              );
            })}
          </View>
        ))}
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={columnCount > 2}
      style={styles.tableScroller}
      contentContainerStyle={styles.tableScrollerContent}
    >
      <View style={[styles.table, { width, backgroundColor: palette.codeBg }]}>
        {rows.map((row, rowIndex) => (
          <View
            key={rowIndex}
            style={[
              styles.tableRow,
              rowIndex > 0 ? { borderTopColor: palette.rule, borderTopWidth: StyleSheet.hairlineWidth } : null,
            ]}
          >
            {Array.from({ length: columnCount }, (_, columnIndex) => (
              <View
                key={columnIndex}
                style={[
                  styles.tableCell,
                  columnIndex > 0 ? { borderLeftColor: palette.rule, borderLeftWidth: StyleSheet.hairlineWidth } : null,
                ]}
              >
                <Inline
                  line={row[columnIndex] ?? ""}
                  palette={palette}
                  variant={variant}
                  color={palette.text}
                  emphasized={rowIndex === 0}
                />
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function Inline({ line, palette, variant, color, emphasized = false }: InlineProps) {
  return (
    <Text variant={variant} color={color ?? palette.text} style={emphasized ? styles.bold : null}>
      {parseInline(line).map((span, i) => span.page ? (
        <PageRefChip key={i} pageId={span.page} itemId={span.pageItem} tone={palette} />
      ) : span.mention ? (
        <MentionChip key={i} token={span.mention} tone={palette} variant={variant} />
      ) : (
        <Text
          key={i}
          variant={span.code ? "mono" : variant}
          color={span.href ? palette.link : span.code ? palette.code : (color ?? palette.text)}
          accessibilityRole={span.href ? "link" : undefined}
          onPress={span.href ? () => void Linking.openURL(span.href!) : undefined}
          suppressHighlighting={!span.href}
          style={[
            span.bold ? styles.bold : null,
            span.italic ? styles.italic : null,
            span.href ? styles.link : null,
            span.code ? [styles.code, { backgroundColor: palette.codeBg }] : null,
          ]}
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

export interface MarkdownProps {
  body: string;
  /** body text size — bubbles use "message" (16px), cards use "body" (15px) */
  variant?: TextVariant;
  tone?: MarkdownTone;
  /** the background the markdown sits on — charts use it for their surface gaps */
  surface?: string;
}

/** A remote image referenced as `![alt](https://…)` on its own line. */
function MarkdownImage({ src, alt, palette }: { src: string; alt: string; palette: Palette }) {
  const [width, setWidth] = useState(0);
  const [aspect, setAspect] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const onLayout = (e: LayoutChangeEvent) => setWidth(Math.round(e.nativeEvent.layout.width));
  const height = width && aspect ? Math.min(320, Math.round(width / aspect)) : 0;
  return (
    <View style={styles.image} onLayout={onLayout}>
      {failed ? (
        <Text variant="caption" color={palette.dim}>
          {alt || src}
        </Text>
      ) : width > 0 ? (
        <Image
          source={{ uri: src }}
          style={{ width: aspect ? Math.min(width, Math.round(height * aspect)) : width, height: height || 180 }}
          resizeMode="contain"
          accessibilityLabel={alt}
          onLoad={(e) => {
            const { width: w, height: h } = e.nativeEvent.source;
            if (w && h) setAspect(w / h);
          }}
          onError={() => setFailed(true)}
        />
      ) : null}
    </View>
  );
}

function MarkdownImpl({ body, variant = "body", tone = "default", surface }: MarkdownProps) {
  const { colors } = useAppTheme();
  const palette = palettes(colors)[tone];
  const chartSurface = surface ?? (tone === "onAccent" ? colors.accent : colors.surfaceAlt);
  const blocks: React.ReactNode[] = [];
  const lines = body.replace(/\r\n/g, "\n").split("\n");
  let fence: string[] | null = null;
  let fenceLang = "";

  /**
   * Close a fence. Two languages render natively instead of as code: a
   * ```chart JSON spec becomes a Chart, and ```svg markup is drawn inline.
   * Anything that fails to parse falls back to the plain code block so the
   * intern's output is never lost.
   */
  const pushFence = (key: string) => {
    const source = (fence ?? []).join("\n");
    const lang = fenceLang.toLowerCase();
    // Message blocks (docs/features/contracts.md §1). Invalid JSON shows one
    // quiet line — never the raw JSON.
    if (lang === "page" || lang === "rule" || lang === "quick-replies" || lang === "checklist") {
      const body = parseFenceJson(source);
      if (lang === "page" && typeof body?.id === "string") {
        blocks.push(<PagePreview key={key} id={body.id} title={typeof body.title === "string" ? body.title : undefined} kind={typeof body.kind === "string" ? body.kind : undefined} />);
      } else if (lang === "rule" && typeof body?.id === "string") {
        blocks.push(<RuleChip key={key} id={body.id} text={typeof body.text === "string" ? body.text : ""} />);
      } else if (lang === "quick-replies" && Array.isArray(body?.options)) {
        blocks.push(<FenceQuickReplies key={key} options={(body.options as unknown[]).filter((o): o is string => typeof o === "string" && Boolean(o.trim()))} />);
      } else if (lang === "checklist" && body && parseChecklist(body)) {
        blocks.push(<ChecklistBlock key={key} {...parseChecklist(body)!} />);
      } else {
        blocks.push(
          <Text key={key} variant="caption" color={palette.dim}>
            (couldn't show this block)
          </Text>,
        );
      }
      fence = null;
      return;
    }
    if (lang === "chart" || lang === "chart.json") {
      const spec = parseChartBlock(source);
      if (spec) {
        blocks.push(
          <View key={key} style={[styles.chart, { borderColor: palette.rule, backgroundColor: chartSurface }]}>
            <Chart spec={spec} surface={chartSurface} />
          </View>,
        );
        fence = null;
        return;
      }
    }
    if (lang === "svg" || (lang === "xml" && /<svg[\s>]/i.test(source)) || (!lang && /^\s*(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(source))) {
      blocks.push(<SvgBlock key={key} xml={source} />);
      fence = null;
      return;
    }
    if (lang === "mermaid" || (!lang && /^\s*(graph|flowchart|sequenceDiagram|pie)\b/i.test(source))) {
      blocks.push(
        <Mermaid
          key={key}
          source={source}
          fallback={<CodeFence source={source} lang="mermaid" palette={palette} />}
          renderPie={(spec) => (
            <View style={[styles.chart, { borderColor: palette.rule, backgroundColor: chartSurface }]}>
              <Chart spec={spec} surface={chartSurface} />
            </View>
          )}
        />,
      );
      fence = null;
      return;
    }
    blocks.push(<CodeFence key={key} source={source} lang={lang} palette={palette} />);
    fence = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      if (fence) pushFence(`f${index}`);
      else {
        fence = [];
        fenceLang = line.trim().slice(3).trim().split(/\s+/)[0] ?? "";
      }
      continue;
    }
    if (fence) {
      fence.push(line);
      continue;
    }

    // An image on its own line: ![alt](https://…) — remote http(s) only.
    const image = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/.exec(line);
    if (image && safeHref(image[2]) && /^https?:/i.test(image[2])) {
      blocks.push(<MarkdownImage key={index} src={image[2]} alt={image[1]} palette={palette} />);
      continue;
    }

    // GitHub-style tables are a header row followed by a dash divider. Keep
    // the complete table together and let narrow chat cards scroll sideways.
    if (line.includes("|") && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
      const rows = [tableCells(line)];
      index += 2; // skip the header divider
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push(<MarkdownTable key={`table-${index}`} rows={rows} palette={palette} variant={variant} />);
      continue;
    }

    // Horizontal rule: --- / *** / ___ (before the bullet rule, which would
    // otherwise swallow "---" as a list item).
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<View key={index} style={[styles.rule, { backgroundColor: palette.rule }]} />);
      continue;
    }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      // Headings carry inline markdown too (a bold link as a call-to-action is common).
      blocks.push(
        <View key={index} style={styles.heading}>
          <Inline line={heading[2]} palette={palette} variant="title" emphasized />
        </View>,
      );
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push(
        <View key={index} style={styles.listRow}>
          <Text variant={variant} color={palette.dim} style={styles.bulletDot}>
            •
          </Text>
          <View style={styles.listBody}>
            <Inline line={bullet[1]} palette={palette} variant={variant} />
          </View>
        </View>,
      );
      continue;
    }
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (numbered) {
      blocks.push(
        <View key={index} style={styles.listRow}>
          <Text variant={variant} color={palette.dim} style={styles.bulletDot}>
            {numbered[1]}.
          </Text>
          <View style={styles.listBody}>
            <Inline line={numbered[2]} palette={palette} variant={variant} />
          </View>
        </View>,
      );
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      blocks.push(
        <View key={index} style={[styles.quote, { borderLeftColor: palette.rule }]}>
          <Inline line={quote[1]} palette={palette} variant={variant} color={palette.dim} />
        </View>,
      );
      continue;
    }
    if (!line.trim()) {
      blocks.push(<View key={index} style={styles.gap} />);
      continue;
    }
    blocks.push(
      <View key={index} style={styles.paragraph}>
        <Inline line={line} palette={palette} variant={variant} />
      </View>,
    );
  }

  if (fence !== null) pushFence("fence-tail");

  return <View>{groupRuleChips(blocks)}</View>;
}

/**
 * A run of three or more rule chips (blank lines between them allowed) folds
 * into one RuleGroup, so an intern saving a batch of standing orders posts one
 * row instead of a wall of cards.
 */
function groupRuleChips(blocks: React.ReactNode[]): React.ReactNode[] {
  const isRule = (b: React.ReactNode): b is React.ReactElement<{ id: string; text: string }> => React.isValidElement(b) && b.type === RuleChip;
  const isGap = (b: React.ReactNode) => React.isValidElement(b) && (b.props as { style?: unknown }).style === styles.gap;
  const out: React.ReactNode[] = [];
  let run: React.ReactElement<{ id: string; text: string }>[] = [];
  let gaps: React.ReactNode[] = [];
  const flush = () => {
    if (run.length >= 3) out.push(<RuleGroup key={`rules-${run[0]!.props.id}`} rules={run.map((r) => ({ id: r.props.id, text: r.props.text }))} />);
    else out.push(...run);
    run = [];
  };
  for (const block of blocks) {
    if (isRule(block)) {
      if (run.length) gaps = [];
      else out.push(...gaps.splice(0));
      run.push(block);
    } else if (isGap(block) && run.length) {
      gaps.push(block);
    } else {
      flush();
      out.push(...gaps.splice(0), block);
    }
  }
  flush();
  out.push(...gaps);
  return out;
}

/** Memoised: threads re-render on every stream event; the text does not change. */
export const Markdown = React.memo(MarkdownImpl);

/**
 * Flatten markdown to plain text for one-line previews (chat list rows),
 * where the syntax characters are just noise.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/```page\s*\n([\s\S]*?)```/gi, (_m, body: string) => ` 📄 ${String(parseFenceJson(body)?.title ?? "page")} `)
    .replace(/```rule\s*\n([\s\S]*?)```/gi, (_m, body: string) => ` 📌 ${String(parseFenceJson(body)?.text ?? "standing order")} `)
    .replace(/```checklist\s*\n([\s\S]*?)```/gi, (_m, body: string) => ` ☑ ${String(parseFenceJson(body)?.title ?? "checklist")} `)
    .replace(/```quick-replies\s*\n[\s\S]*?```/gi, " ")
    .replace(/⟨pg_[^⟩]*⟩/g, "")
    .replace(/```(?:chart|chart\.json)[\s\S]*?```/gi, " [chart] ")
    .replace(/```svg[\s\S]*?```/gi, " [drawing] ")
    .replace(/```mermaid[\s\S]*?```/gi, " [diagram] ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/^\s*\|?\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/gm, " ")
    .replace(/^\s*\|(.+)\|\s*$/gm, "$1")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, " ")
    .replace(/^\s*#{1,3}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/\*([^*]+)\*|_([^_]+)_/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(^|[^\w@/.-])@([\w][\w.-]*)/g, "$1@$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Plain-text list/search preview with agent implementation details removed.
 * Full paths remain available inside the thread when they are genuinely useful,
 * but they should never become the intern's identity on Crew.
 */
export function cleanMessagePreview(text: string): string {
  return stripMarkdown(text)
    .replace(/\s+(?:at|in|from)\s+\/(?:private\/)?tmp\/[^\s,;)}\]]+/gi, "")
    .replace(/\s+(?:at|in|from)\s+\/home\/[^\s,;)}\]]+/gi, "")
    .replace(/\/(?:private\/)?tmp\/[^\s,;)}\]]+/gi, "local workspace")
    .replace(/\/home\/[^\s,;)}\]]+/gi, "local workspace")
    .replace(/https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)[^\s]*/gi, "$1/$2 #$3")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .trim();
}

/** True when a string contains markdown worth parsing (cheap pre-check). */
export function hasMarkdown(text: string): boolean {
  return /(⟨pg_|\*\*|__|`|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*>|^\s*#{1,3}\s|^\s*\|.+\|\s*$|^\s*([-*_])(\s*\2){2,}\s*$|\[[^\]]+\]\(|https?:\/\/|mailto:|(?:^|[^\w@/.-])@\w)/m.test(
    text,
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  link: { textDecorationLine: "underline" },
  code: {
    borderRadius: radius.sm,
    paddingHorizontal: space.xs,
  },
  heading: { marginTop: space.sm, marginBottom: space.xs },
  paragraph: { marginBottom: space.xs },
  listRow: { flexDirection: "row", gap: space.sm, marginBottom: space.xs },
  bulletDot: { minWidth: 16 },
  listBody: { flex: 1 },
  quote: {
    borderLeftWidth: 2,
    paddingLeft: space.md,
    marginVertical: space.xs,
  },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: space.md, opacity: 0.9 },
  fence: {
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    paddingTop: space.sm,
    marginVertical: space.xs,
    alignSelf: "stretch",
  },
  fenceBar: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: space.xs },
  mentionName: { fontWeight: "700" },
  fenceAction: { width: 24, height: 20, alignItems: "center", justifyContent: "center" },
  chart: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    marginVertical: space.xs,
    alignSelf: "stretch",
  },
  image: { marginVertical: space.xs, borderRadius: radius.md, overflow: "hidden", alignSelf: "stretch" },
  tableScroller: { maxWidth: "100%", marginVertical: space.sm, borderRadius: radius.md },
  tableScrollerContent: { flexGrow: 0 },
  table: { overflow: "hidden", borderRadius: radius.md },
  tableRow: { flexDirection: "row" },
  tableCell: { width: TABLE_COLUMN_WIDTH, paddingHorizontal: space.md, paddingVertical: space.sm },
  stackedTable: { gap: space.sm, marginVertical: space.sm, alignSelf: "stretch" },
  stackedTableRow: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, gap: space.sm },
  stackedTableCell: { flexDirection: "row", alignItems: "baseline", gap: space.sm },
  stackedTableLabel: { width: 88, flexShrink: 0 },
  stackedTableValue: { flex: 1, minWidth: 0 },
  gap: { height: space.sm },
});
