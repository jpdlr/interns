/**
 * In-message blocks interns (and the orchestrator) put in a reply as fenced
 * JSON — docs/features/contracts.md §1:
 *
 *   ```page           → PagePreview: a living page; tap opens it full screen
 *   ```rule           → RuleChip: the standing order just saved, with Undo/Edit
 *   ```quick-replies  → FenceQuickReplies: one-tap answers to this message
 *   ```checklist      → ChecklistBlock: tick what you want, then submit
 *   ```pick           → PickBlock: pictures to choose from (the message's attachments)
 *
 * Everything that answers a message goes through MessageContext; without it
 * (card bodies, previews) the blocks are read-only.
 */
import { useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
import { Image, Pressable, StyleSheet, View } from "react-native";
import type { Attachment, MoodboardData, MoodboardItem, PageKind, Rule } from "../api";
import { haptic } from "../haptics";
import { useLiveEvents } from "../live";
import { changesLabel } from "../pageSeen";
import { useSettings } from "../settings";
import { radius, space, useAppTheme } from "../theme";
import { relativeTime } from "../time";
import { usePage } from "../usePage";
import { BoardIcon, CheckIcon, ChevronRightIcon, ExpandIcon, ImageIcon, ListIcon, MailIcon, PinIcon, PlayIcon, TableIcon, UsersIcon } from "./Icons";
import { FadeImage } from "./Media";
import { useMessageContext } from "./MessageContext";
import { Text } from "./Text";

export function parseFenceJson(source: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function PageKindIcon({ kind, size = 18, color }: { kind: PageKind | string; size?: number; color?: string }) {
  switch (kind) {
    case "people":
      return <UsersIcon size={size} color={color} />;
    case "board":
      return <BoardIcon size={size} color={color} />;
    case "table":
      return <TableIcon size={size} color={color} />;
    case "draft":
      return <MailIcon size={size} color={color} />;
    case "moodboard":
      return <ImageIcon size={size} color={color} />;
    default:
      return <ListIcon size={size} color={color} />;
  }
}

// ------------------------------------------------------------------- page

export function PagePreview({ id, title, kind }: { id: string; title?: string; kind?: string }) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const { page, error, seenVersion } = usePage(id);
  const shownKind = page?.kind ?? kind ?? "list";
  const changes = page ? changesLabel(seenVersion, page.version) : "";
  const gone = Boolean(page?.archived_at) || Boolean(error && /404/.test(error));
  const pictures = !gone && page?.kind === "moodboard" ? ((page.data as Partial<MoodboardData>).items ?? []).filter((item) => item.image_url) : [];
  return (
    <Pressable
      onPress={() => !gone && router.push(`/page/${id}` as never)}
      disabled={gone}
      accessibilityRole="button"
      accessibilityLabel={`Open page: ${page?.title ?? title ?? "page"}`}
      style={({ pressed }) => [styles.pageCard, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.75 : gone ? 0.55 : 1 }]}
    >
      {pictures.length ? <PageThumbs items={pictures} /> : null}
      <View style={styles.page}>
        <View style={[styles.pageIcon, { backgroundColor: colors.surfaceAlt }]}>
          <PageKindIcon kind={shownKind} color={colors.text} />
        </View>
        <View style={styles.pageText}>
          <Text variant="subtle" color={colors.text} style={styles.bold} numberOfLines={1}>
            {page?.title ?? title ?? "Page"}
          </Text>
          {gone ? (
            <Text variant="caption">This page was archived.</Text>
          ) : page?.summary ? (
            <Text variant="caption" color={colors.textDim} numberOfLines={1}>
              {page.summary}
            </Text>
          ) : null}
          {page && !gone ? (
            <Text variant="caption" numberOfLines={1}>
              {`Updated ${relativeTime(page.updated_at)}`}
              {changes ? <Text variant="caption" color={colors.info}>{` · ${changes}`}</Text> : null}
            </Text>
          ) : null}
        </View>
        {page?.pinned ? <PinIcon size={14} color={colors.textFaint} /> : null}
        {!gone ? <ChevronRightIcon size={16} color={colors.textFaint} /> : null}
      </View>
    </Pressable>
  );
}

const THUMBS = 4;

/** A moodboard's first pictures across the top of its preview card; the last counts the rest. */
function PageThumbs({ items }: { items: MoodboardItem[] }) {
  const { colors } = useAppTheme();
  const { api } = useSettings();
  const shown = items.slice(0, THUMBS);
  const more = items.length - shown.length;
  return (
    <View style={styles.thumbs}>
      {shown.map((item, i) => {
        const uri = item.image_url!.startsWith("/") ? `${api.baseUrl}${item.image_url}` : item.image_url!;
        return (
          <View key={item.id} style={[styles.thumb, { backgroundColor: colors.surfaceAlt }]}>
            <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors />
            {more > 0 && i === shown.length - 1 ? (
              <View style={[StyleSheet.absoluteFill, styles.thumbMore]}>
                <Text variant="subtle" color="#fafafa" style={styles.bold}>{`+${more}`}</Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

// ------------------------------------------------------------------- rule

export function RuleChip({ id, text }: { id: string; text: string }) {
  const { colors } = useAppTheme();
  const { api, configured } = useSettings();
  const ctx = useMessageContext();
  const [rule, setRule] = useState<Rule | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!configured) return;
    api.getRule(id).then(setRule).catch(() => {});
  }, [api, configured, id]);
  useLiveEvents((event) => {
    if (event.type === "rule" && (event.data as Rule | undefined)?.id === id) setRule(event.data as Rule);
  });

  const removed = Boolean(rule?.removed_at);
  const paused = rule ? !rule.enabled && !removed : false;
  const undo = async () => {
    setBusy(true);
    try {
      setRule((await api.removeRule(id)).rule);
      haptic("tap");
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={[styles.rule, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, opacity: removed ? 0.6 : 1 }]}>
      <View style={styles.ruleTop}>
        <PinIcon size={15} color={removed ? colors.textFaint : colors.text} />
        <Text variant="caption" color={colors.textDim} style={styles.ruleLabel}>
          {removed ? "Standing order removed" : paused ? "Standing order (paused)" : "Standing order saved"}
        </Text>
        {rule?.hits ? <Text variant="caption">{`${rule.hits} applied`}</Text> : null}
      </View>
      <Text variant="subtle" color={colors.text} style={removed ? styles.struck : undefined}>
        {rule?.text ?? text}
      </Text>
      {!removed ? (
        <View style={styles.ruleActions}>
          <Pressable onPress={() => void undo()} disabled={busy} accessibilityRole="button" accessibilityLabel="Undo this standing order" hitSlop={6} style={[styles.ruleButton, { borderColor: colors.border }]}>
            <Text variant="caption" color={colors.text} style={styles.bold}>
              Undo
            </Text>
          </Pressable>
          {ctx ? (
            <Pressable
              onPress={() => ctx.compose(`Change that standing order to: ${rule?.text ?? text}`)}
              accessibilityRole="button"
              accessibilityLabel="Edit this standing order"
              hitSlop={6}
              style={[styles.ruleButton, { borderColor: colors.border }]}
            >
              <Text variant="caption" color={colors.text} style={styles.bold}>
                Edit
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/**
 * Three or more standing orders saved in one reply (an intern filing a batch)
 * fold into one row: "📌 15 standing orders saved", expandable to the chips.
 */
export function RuleGroup({ rules }: { rules: { id: string; text: string }[] }) {
  const { colors } = useAppTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.rule, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.ruleTop}>
        <PinIcon size={15} color={colors.text} />
        <Text variant="caption" color={colors.textDim} style={styles.ruleLabel}>
          {`${rules.length} standing orders saved`}
        </Text>
        <Text variant="caption" color={colors.info}>
          {open ? "Hide" : "Show"}
        </Text>
      </Pressable>
      {open ? rules.map((r) => <RuleChip key={r.id} id={r.id} text={r.text} />) : (
        <Text variant="caption" numberOfLines={2}>
          {rules.map((r) => r.text).join(" · ")}
        </Text>
      )}
    </View>
  );
}

// ---------------------------------------------------------- quick replies

export function FenceQuickReplies({ options }: { options: string[] }) {
  const { colors } = useAppTheme();
  const ctx = useMessageContext();
  const [sent, setSent] = useState<string | null>(null);
  if (!ctx || ctx.answered || options.length === 0) return null;
  return (
    <View style={styles.chips} accessibilityLabel="Quick replies">
      {options.slice(0, 6).map((option) => (
        <Pressable
          key={option}
          disabled={sent !== null}
          onPress={() => {
            setSent(option);
            haptic("tap");
            void ctx.reply(option).catch(() => setSent(null));
          }}
          accessibilityRole="button"
          accessibilityLabel={`Reply: ${option}`}
          style={({ pressed }) => [
            styles.chip,
            { backgroundColor: sent === option ? colors.accent : colors.surface, borderColor: colors.border, opacity: pressed || (sent && sent !== option) ? 0.55 : 1 },
          ]}
        >
          <Text variant="caption" color={sent === option ? colors.onAccent : colors.text} style={styles.bold}>
            {option}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// ------------------------------------------------------------------- pick

export interface PickOption {
  attachment: string;
  label: string;
}

export function parsePick(body: Record<string, unknown>): { question: string; options: PickOption[]; multiple: boolean; submit: string } | null {
  const options = Array.isArray(body.options)
    ? (body.options as Record<string, unknown>[])
        .filter((o) => o && typeof o.attachment === "string")
        .map((o, i) => ({ attachment: String(o.attachment), label: typeof o.label === "string" && o.label.trim() ? o.label.trim() : `Option ${i + 1}` }))
    : [];
  if (options.length === 0) return null;
  return {
    question: typeof body.question === "string" && body.question.trim() ? body.question.trim() : "Pick one",
    options,
    multiple: body.multiple === true,
    submit: typeof body.submit === "string" && body.submit.trim() ? body.submit.trim() : "Use these",
  };
}

/** Attachment ids a message offers in pick blocks: shown there, so left out of its gallery. */
export function pickAttachmentIds(text: string): Set<string> {
  const ids = new Set<string>();
  if (!text.includes("```pick")) return ids;
  for (const m of text.matchAll(/```pick[ \t]*\n([\s\S]*?)```/g)) {
    const body = parseFenceJson(m[1]!);
    for (const o of (body && parsePick(body)?.options) || []) ids.add(o.attachment);
  }
  return ids;
}

/**
 * Pictures to choose between (which photo leads the carousel). One tap
 * answers with that picture quoted; with `multiple`, tick several and submit.
 * The corner button opens them full screen to look closer.
 */
export function PickBlock({ question, options, multiple, submit }: { question: string; options: PickOption[]; multiple: boolean; submit: string }) {
  const { colors } = useAppTheme();
  const ctx = useMessageContext();
  const [width, setWidth] = useState(0);
  const [chosen, setChosen] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const byId = new Map((ctx?.attachments ?? []).map((a) => [a.id, a]));
  const pictures = options.map((o) => byId.get(o.attachment)).filter((a): a is Attachment => Boolean(a));
  const locked = !ctx || ctx.answered || sending;
  const columns = options.length === 1 ? 1 : options.length === 3 ? 3 : 2;
  const tile = width ? Math.floor((width - space.sm * (columns - 1)) / columns) : 0;
  const numbered = (ids: string[]) => ids.map((id) => options.findIndex((o) => o.attachment === id));

  const answer = async (ids: string[]) => {
    if (!ctx || ids.length === 0) return;
    setSending(true);
    haptic("success");
    const picks = numbered(ids).map((i) => options[i]!);
    const text = picks.length === 1 ? `Picked: ${picks[0]!.label}` : `Picked ${numbered(ids).map((i) => i + 1).join(", ")}: ${picks.map((p) => p.label).join("; ")}`;
    try {
      await ctx.reply(text, picks.length === 1 ? { quoteAttachmentId: picks[0]!.attachment } : undefined);
    } catch {
      setSending(false);
    }
  };
  const tap = (id: string) => {
    if (locked) return;
    if (!multiple) {
      setChosen([id]);
      void answer([id]);
      return;
    }
    haptic("tap");
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  };

  return (
    <View style={[styles.checklist, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text variant="subtle" color={colors.text} style={styles.bold}>
        {question}
      </Text>
      <View style={styles.pickGrid} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        {tile
          ? options.map((option, i) => {
              const att = byId.get(option.attachment);
              const on = chosen.includes(option.attachment);
              return (
                <View key={option.attachment} style={{ width: tile }}>
                  <Pressable
                    disabled={locked || !att}
                    onPress={() => tap(option.attachment)}
                    accessibilityRole={multiple ? "checkbox" : "button"}
                    accessibilityState={{ checked: multiple ? on : undefined, selected: on, disabled: locked }}
                    accessibilityLabel={`${i + 1}: ${option.label}`}
                    style={({ pressed }) => [
                      styles.pickTile,
                      { width: tile, height: tile, backgroundColor: colors.surfaceAlt, borderColor: on ? colors.accent : colors.border, opacity: pressed ? 0.85 : locked && !on && chosen.length ? 0.5 : 1 },
                      on ? styles.pickTileOn : null,
                    ]}
                  >
                    {att && ctx?.api ? (
                      <FadeImage uri={ctx.api.previewUrl(att, tile)} style={{ width: tile, height: tile }} accessibilityLabel={option.label} />
                    ) : (
                      <ImageIcon size={22} color={colors.textFaint} />
                    )}
                    <View style={[styles.pickNumber, { backgroundColor: on ? colors.accent : "rgba(9,9,11,0.6)" }]}>
                      {on ? <CheckIcon size={12} color={colors.onAccent} /> : <Text variant="caption" color="#fafafa" style={styles.bold}>{String(i + 1)}</Text>}
                    </View>
                    {att?.kind === "video" ? (
                      <View style={styles.pickPlay} pointerEvents="none">
                        <PlayIcon size={12} color="#fafafa" />
                      </View>
                    ) : null}
                  </Pressable>
                  {att && ctx?.openAttachment ? (
                    <Pressable
                      onPress={() => ctx.openAttachment?.(att, pictures)}
                      accessibilityRole="button"
                      accessibilityLabel={`Look closer at ${option.label}`}
                      hitSlop={6}
                      style={styles.pickExpand}
                    >
                      <ExpandIcon size={14} color="#fafafa" />
                    </Pressable>
                  ) : null}
                  <Text variant="caption" color={on ? colors.text : colors.textDim} numberOfLines={2} style={styles.pickLabel}>
                    {option.label}
                  </Text>
                </View>
              );
            })
          : null}
      </View>
      {multiple && !(ctx?.answered) ? (
        <Pressable
          disabled={locked || chosen.length === 0}
          onPress={() => void answer(chosen)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.submit, { backgroundColor: chosen.length ? colors.accent : colors.surfaceAlt, opacity: pressed ? 0.8 : 1 }]}
        >
          <Text variant="subtle" color={chosen.length ? colors.onAccent : colors.textFaint} style={styles.bold}>
            {chosen.length ? `${submit} (${chosen.length})` : submit}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

// -------------------------------------------------------------- checklist

interface ChecklistItem {
  id: string;
  text: string;
  checked: boolean;
}

export function ChecklistBlock({ title, items, submit }: { title: string; items: ChecklistItem[]; submit: string }) {
  const { colors } = useAppTheme();
  const ctx = useMessageContext();
  const [checked, setChecked] = useState<Record<string, boolean>>(() => Object.fromEntries(items.map((i) => [i.id, i.checked])));
  const [sending, setSending] = useState(false);
  const locked = !ctx || ctx.answered || sending;
  const chosen = items.filter((i) => checked[i.id]);
  const send = async () => {
    if (!ctx || chosen.length === 0) return;
    setSending(true);
    haptic("success");
    try {
      await ctx.reply(`${submit}: ${chosen.map((i) => i.id).join(", ")}`);
    } catch {
      setSending(false);
    }
  };
  return (
    <View style={[styles.checklist, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text variant="subtle" color={colors.text} style={styles.bold}>
        {title}
      </Text>
      {items.map((item) => {
        const on = Boolean(checked[item.id]);
        return (
          <Pressable
            key={item.id}
            disabled={locked}
            onPress={() => setChecked((c) => ({ ...c, [item.id]: !c[item.id] }))}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on, disabled: locked }}
            style={styles.checkRow}
          >
            <View style={[styles.box, { borderColor: on ? colors.accent : colors.border, backgroundColor: on ? colors.accent : "transparent" }]}>
              {on ? <CheckIcon size={13} color={colors.onAccent} /> : null}
            </View>
            <Text variant="subtle" color={on ? colors.text : colors.textDim} style={styles.checkText}>
              {item.text}
            </Text>
          </Pressable>
        );
      })}
      {ctx && !ctx.answered ? (
        <Pressable
          onPress={() => void send()}
          disabled={sending || chosen.length === 0}
          accessibilityRole="button"
          style={({ pressed }) => [styles.submit, { backgroundColor: colors.accent, opacity: sending || chosen.length === 0 ? 0.5 : pressed ? 0.8 : 1 }]}
        >
          <Text variant="caption" color={colors.onAccent} style={styles.bold}>
            {sending ? "Sent" : `${submit}${chosen.length ? ` (${chosen.length})` : ""}`}
          </Text>
        </Pressable>
      ) : ctx?.answered ? (
        <Text variant="caption">Answered</Text>
      ) : null}
    </View>
  );
}

/** Parse a checklist fence body into props, or null when it is not one. */
export function parseChecklist(body: Record<string, unknown>): { title: string; items: ChecklistItem[]; submit: string } | null {
  const raw = Array.isArray(body.items) ? (body.items as Record<string, unknown>[]) : [];
  const items = raw
    .map((item, i) => ({
      id: typeof item?.id === "string" || typeof item?.id === "number" ? String(item.id) : String(i + 1),
      text: typeof item?.text === "string" ? item.text : "",
      checked: item?.checked !== false,
    }))
    .filter((i) => i.text);
  if (items.length === 0) return null;
  return {
    title: typeof body.title === "string" && body.title.trim() ? body.title : "Checklist",
    items,
    submit: typeof body.submit === "string" && body.submit.trim() ? body.submit : "Do these",
  };
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  pageCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, marginVertical: space.xs, minWidth: 220, overflow: "hidden" },
  page: { flexDirection: "row", alignItems: "center", gap: space.md, padding: space.md },
  thumbs: { flexDirection: "row", gap: 2 },
  thumb: { flex: 1, aspectRatio: 1, overflow: "hidden" },
  thumbMore: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(9,9,11,0.55)" },
  pageIcon: { width: 36, height: 36, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  pageText: { flex: 1, gap: 1, minWidth: 0 },
  rule: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md, gap: space.xs, marginVertical: space.xs },
  ruleTop: { flexDirection: "row", alignItems: "center", gap: space.xs },
  ruleLabel: { flex: 1, fontWeight: "600" },
  ruleActions: { flexDirection: "row", gap: space.sm, marginTop: space.xs },
  ruleButton: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 5 },
  struck: { textDecorationLine: "line-through" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.sm },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 7 },
  checklist: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md, gap: space.sm, marginVertical: space.xs },
  checkRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  pickGrid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  pickTile: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", alignItems: "center", justifyContent: "center" },
  pickTileOn: { borderWidth: 3 },
  pickNumber: { position: "absolute", top: 6, left: 6, minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6, alignItems: "center", justifyContent: "center" },
  pickPlay: { position: "absolute", left: 6, bottom: 6, width: 22, height: 22, borderRadius: 11, backgroundColor: "rgba(9,9,11,0.6)", alignItems: "center", justifyContent: "center" },
  pickExpand: { position: "absolute", top: 6, right: 6, width: 26, height: 26, borderRadius: 13, backgroundColor: "rgba(9,9,11,0.55)", alignItems: "center", justifyContent: "center" },
  pickLabel: { marginTop: 4 },
  box: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, alignItems: "center", justifyContent: "center", marginTop: 1 },
  checkText: { flex: 1 },
  submit: { alignSelf: "flex-start", borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm, marginTop: space.xs },
});
