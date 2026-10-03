/**
 * Full-screen renderers for each page kind (docs/features/02-pages.md).
 *
 * JP does not edit pages directly: tapping an item opens a sheet whose
 * actions are chat messages to the page's owner, quoting the item —
 * "On My people › Ada: draft a follow-up ⟨pg_…·p1⟩". The marker
 * renders as a small page chip in the thread and gives the intern the ids.
 * The one direct edit is ticking a list item done.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Linking, Modal, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { BoardData, BoardItem, DraftData, ListData, ListItem, Page, PeopleData, Person, TableData } from "../../api";
import { useCrew } from "../../crew";
import { radius, scaledFont, space, useAppTheme } from "../../theme";
import { relativeTime } from "../../time";
import { CheckIcon, ChevronDownIcon, ExternalIcon, SearchIcon, SendIcon } from "../Icons";
import { InternFace, resolveFaceId } from "../InternFace";
import { Text } from "../Text";
import { useCoordinatorName } from "../../owner";

/** Send JP's request about a page (or one of its items) to the page's owner. */
export type AskOwner = (instruction: string, item?: { id: string; label: string }) => Promise<void>;

/**
 * What JP's message says: "AI Expo Africa — send me a calendar invite". The
 * trailing ⟨page·item⟩ marker carries the ids for the intern; the app draws it
 * as a small "📄 Events" link, so JP never sees them.
 */
export function pageMessage(page: Page, instruction: string, item?: { id: string; label: string }): string {
  const text = item ? `${item.label} — ${instruction}` : instruction.charAt(0).toUpperCase() + instruction.slice(1);
  return `${text} ⟨${page.id}${item ? `·${item.id}` : ""}⟩`;
}

/**
 * Open the sheet for `focusItem` once the page is loaded — Crew search lands
 * here with ?item=<id> ("Kettle Labs" → Danny's card, already open).
 */
function useFocusItem<T extends { id: string }>(items: T[], focusItem: string | undefined, open: (item: T) => void): void {
  const done = useRef<string | null>(null);
  useEffect(() => {
    if (!focusItem || done.current === focusItem) return;
    const item = items.find((i) => i.id === focusItem);
    if (!item) return;
    done.current = focusItem;
    open(item);
  }, [focusItem, items, open]);
}

// ------------------------------------------------------------------ dates

const localYmd = (d: Date) => new Intl.DateTimeFormat("en-CA").format(d);

function addDays(days: number): string {
  return localYmd(new Date(Date.now() + days * 86_400_000));
}

function nextMonday(): string {
  const day = new Date().getDay(); // 0 Sun … 6 Sat
  return addDays(((8 - day) % 7) || 7);
}

export function shortDate(ymd?: string): string {
  if (!ymd) return "";
  const d = new Date(`${ymd.slice(0, 10)}T12:00:00+02:00`);
  if (Number.isNaN(d.getTime())) return ymd;
  return d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short" });
}

// --------------------------------------------------------------- the sheet

export interface SheetAction {
  label: string;
  /** a chat instruction for the owner; omitted when `run` handles it */
  instruction?: string;
  run?: () => void | Promise<void>;
  tone?: "default" | "danger";
  /** the action changes the sheet itself (e.g. picks an intern next) — don't close it */
  keepOpen?: boolean;
}

export function ItemSheet({
  title,
  subtitle,
  visible,
  onClose,
  actions,
  onAsk,
  children,
}: {
  title: string;
  subtitle?: string;
  visible: boolean;
  onClose: () => void;
  actions: SheetAction[];
  onAsk?: (text: string) => Promise<void>;
  children?: React.ReactNode;
}) {
  const { colors, fontScale } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [ask, setAsk] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => void | Promise<void>, keepOpen = false) => {
    setBusy(key);
    try {
      await fn();
      if (!keepOpen) onClose();
    } finally {
      setBusy(null);
    }
  };
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: colors.overlay }]} onPress={onClose} accessibilityLabel="Close">
        <Pressable style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border, paddingBottom: Math.max(insets.bottom, space.lg) }]} onPress={() => {}}>
          <View style={styles.handle} />
          <ScrollView style={styles.sheetScroll} contentContainerStyle={styles.sheetBody} keyboardShouldPersistTaps="handled">
            <Text variant="title">{title}</Text>
            {subtitle ? <Text variant="subtle">{subtitle}</Text> : null}
            {children}
            {actions.length ? (
              <View style={styles.actions}>
                {actions.map((action) => (
                  <Pressable
                    key={action.label}
                    disabled={busy !== null}
                    onPress={() => void run(action.label, action.run ?? (() => onAsk?.(action.instruction ?? action.label)), action.keepOpen)}
                    accessibilityRole="button"
                    style={({ pressed }) => [
                      styles.action,
                      { borderColor: action.tone === "danger" ? colors.danger : colors.border, opacity: busy && busy !== action.label ? 0.5 : pressed ? 0.7 : 1 },
                    ]}
                  >
                    <Text variant="caption" color={action.tone === "danger" ? colors.danger : colors.text} style={styles.bold}>
                      {busy === action.label ? "Sending…" : action.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {onAsk ? (
              <View style={[styles.askRow, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
                <TextInput
                  value={ask}
                  onChangeText={setAsk}
                  placeholder="Ask about this…"
                  placeholderTextColor={colors.textFaint}
                  style={[styles.askInput, { color: colors.text, fontSize: scaledFont(15, fontScale) }]}
                  multiline
                  numberOfLines={1}
                />
                <Pressable
                  disabled={!ask.trim() || busy !== null}
                  onPress={() => void run("ask", async () => {
                    await onAsk(ask.trim());
                    setAsk("");
                  })}
                  accessibilityRole="button"
                  accessibilityLabel="Send"
                  style={({ pressed }) => [styles.askSend, { backgroundColor: colors.accent, opacity: !ask.trim() ? 0.4 : pressed ? 0.8 : 1 }]}
                >
                  <SendIcon size={18} color={colors.onAccent} />
                </Pressable>
              </View>
            ) : null}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Field({ label, value, onPress }: { label: string; value?: string | null; onPress?: () => void }) {
  const { colors } = useAppTheme();
  if (!value) return null;
  return (
    <View style={styles.field}>
      <Text variant="caption" style={styles.fieldLabel}>
        {label}
      </Text>
      <Text variant="subtle" color={onPress ? colors.info : colors.text} onPress={onPress} style={styles.fieldValue}>
        {value}
      </Text>
    </View>
  );
}

function Tags({ tags, max = 6 }: { tags: string[]; max?: number }) {
  const { colors } = useAppTheme();
  if (!tags.length) return null;
  return (
    <View style={styles.tags}>
      {tags.slice(0, max).map((tag) => (
        <View key={tag} style={[styles.tag, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
          <Text variant="caption" color={colors.textDim}>
            {tag}
          </Text>
        </View>
      ))}
    </View>
  );
}

function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  const { colors, fontScale } = useAppTheme();
  return (
    <View style={[styles.search, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
      <SearchIcon size={16} color={colors.textDim} />
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        style={[styles.searchInput, { color: colors.text, fontSize: scaledFont(15, fontScale) }]}
      />
    </View>
  );
}

function FilterChips<T extends string>({ options, value, onChange }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const { colors } = useAppTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
      {options.map((o) => {
        const on = o.id === value;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: on }}
            style={[styles.filter, { backgroundColor: on ? colors.accent : colors.surfaceAlt, borderColor: on ? colors.accent : colors.border }]}
          >
            <Text variant="caption" color={on ? colors.onAccent : colors.text} style={styles.bold}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ----------------------------------------------------------------- people

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1]![0] : "")).toUpperCase();
}

export function PeopleView({ page, ask, focusItem }: { page: Page; ask: AskOwner; focusItem?: string }) {
  const { colors } = useAppTheme();
  const { width } = useWindowDimensions();
  const data = page.data as PeopleData;
  const people = Array.isArray(data.people) ? data.people : [];
  const today = localYmd(new Date());
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [open, setOpen] = useState<Person | null>(null);
  useFocusItem(people, focusItem, setOpen);

  const topTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const p of people) for (const t of p.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
  }, [people]);
  const due = people.filter((p) => p.next_follow_up && p.next_follow_up.slice(0, 10) <= today);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people
      .filter((p) => filter === "all" || (filter === "due" ? p.next_follow_up && p.next_follow_up.slice(0, 10) <= today : (p.tags ?? []).includes(filter)))
      .filter((p) => !q || [p.name, p.company, p.email, p.how_met, ...(p.tags ?? [])].some((v) => String(v ?? "").toLowerCase().includes(q)))
      .sort((a, b) => (a.next_follow_up ?? "9999").localeCompare(b.next_follow_up ?? "9999") || a.name.localeCompare(b.name));
  }, [people, filter, query, today]);
  const columns = width >= 900 ? 4 : width >= 600 ? 3 : 2;

  return (
    <View style={styles.kind}>
      <SearchField value={query} onChange={setQuery} placeholder={`Search ${people.length} people`} />
      <FilterChips
        value={filter}
        onChange={setFilter}
        options={[
          { id: "all", label: "Everyone" },
          ...(due.length ? [{ id: "due", label: `Follow-up due · ${due.length}` }] : []),
          ...topTags.map((t) => ({ id: t, label: t })),
        ]}
      />
      <View style={styles.grid}>
        {shown.map((p) => {
          const followUp = p.next_follow_up?.slice(0, 10);
          const overdue = Boolean(followUp && followUp < today);
          const isDue = Boolean(followUp && followUp <= today);
          return (
            <Pressable
              key={p.id}
              onPress={() => setOpen(p)}
              accessibilityRole="button"
              accessibilityLabel={`${p.name}${p.company ? `, ${p.company}` : ""}`}
              style={({ pressed }) => [
                styles.person,
                { width: `${100 / columns - 2}%` as `${number}%`, backgroundColor: colors.surface, borderColor: isDue ? (overdue ? colors.urgent : colors.action) : colors.border, opacity: pressed ? 0.75 : 1 },
              ]}
            >
              <View style={[styles.avatar, { backgroundColor: colors.surfaceAlt }]}>
                <Text variant="subtle" color={colors.text} style={styles.bold}>
                  {initials(p.name)}
                </Text>
              </View>
              <Text variant="subtle" color={colors.text} style={styles.bold} numberOfLines={1}>
                {p.name}
              </Text>
              <Text variant="caption" numberOfLines={1}>
                {p.company ?? p.stage ?? " "}
              </Text>
              <Tags tags={p.tags ?? []} max={2} />
              {followUp ? (
                <Text variant="caption" color={overdue ? colors.urgent : isDue ? colors.action : colors.textFaint} numberOfLines={1}>
                  {`${overdue ? "Overdue · " : isDue ? "Today · " : "Follow up "}${shortDate(followUp)}`}
                </Text>
              ) : p.last_touch ? (
                <Text variant="caption" numberOfLines={1}>{`Last ${shortDate(p.last_touch)}`}</Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      {shown.length === 0 ? <Text variant="subtle" center style={styles.empty}>Nobody matches.</Text> : null}
      <ItemSheet
        visible={Boolean(open)}
        onClose={() => setOpen(null)}
        title={open?.name ?? ""}
        subtitle={[open?.company, open?.stage].filter(Boolean).join(" · ") || undefined}
        onAsk={(text) => ask(text, open ? { id: open.id, label: open.name } : undefined)}
        actions={
          open
            ? [
                { label: "Draft a follow-up", instruction: "draft a follow-up (reply-all in our last thread)" },
                { label: "Follow up tomorrow", instruction: `follow up tomorrow (${addDays(1)})` },
                { label: "Follow up next week", instruction: `follow up next week (${nextMonday()})` },
                { label: "What's the history?", instruction: "what's the history?" },
              ]
            : []
        }
      >
        {open ? (
          <View style={styles.fields}>
            <Tags tags={open.tags ?? []} />
            <Field label="Email" value={open.email} onPress={open.email ? () => void Linking.openURL(`mailto:${open.email}`) : undefined} />
            <Field label="How you know them" value={open.how_met} />
            <Field label="Last contact" value={shortDate(open.last_touch)} />
            <Field label="Next follow-up" value={shortDate(open.next_follow_up)} />
            <Field label="Notes" value={open.notes} />
            {open.timeline?.length ? (
              <View style={styles.timeline}>
                <Text variant="label">Timeline</Text>
                {[...open.timeline].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 12).map((t, i) => (
                  <View key={i} style={styles.timelineRow}>
                    <Text variant="caption" style={styles.timelineWhen}>
                      {shortDate(t.ts)}
                    </Text>
                    <Text variant="subtle" color={colors.text} style={styles.flex}>
                      {`${t.kind === "mail" ? "✉️" : t.kind === "meeting" ? "📅" : t.kind === "chat" ? "💬" : "📝"} ${t.text}`}
                    </Text>
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </ItemSheet>
    </View>
  );
}

// ------------------------------------------------------------------ board

export function BoardView({ page, ask, focusItem }: { page: Page; ask: AskOwner; focusItem?: string }) {
  const { colors } = useAppTheme();
  const data = page.data as BoardData;
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const items = Array.isArray(data.items) ? data.items : [];
  const [open, setOpen] = useState<BoardItem | null>(null);
  useFocusItem(items, focusItem, setOpen);
  const today = localYmd(new Date());
  const columnTitle = (id: string) => columns.find((c) => c.id === id)?.title ?? id;
  return (
    <View style={styles.kind}>
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.board}>
        {columns.map((column) => {
          const cards = items.filter((i) => i.column === column.id);
          return (
            <View key={column.id} style={[styles.column, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <View style={styles.columnHead}>
                <Text variant="label" color={colors.text}>
                  {column.title}
                </Text>
                <Text variant="caption">{cards.length}</Text>
              </View>
              {cards.map((card) => (
                <Pressable
                  key={card.id}
                  onPress={() => setOpen(card)}
                  accessibilityRole="button"
                  accessibilityLabel={card.title}
                  style={({ pressed }) => [styles.boardCard, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.75 : 1 }]}
                >
                  <Text variant="subtle" color={colors.text} style={styles.bold}>
                    {card.title}
                  </Text>
                  {card.subtitle ? <Text variant="caption" numberOfLines={2}>{card.subtitle}</Text> : null}
                  {card.due ? (
                    <Text variant="caption" color={card.due.slice(0, 10) < today ? colors.urgent : colors.textFaint}>
                      {`Due ${shortDate(card.due)}`}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
              {cards.length === 0 ? <Text variant="caption" center style={styles.columnEmpty}>Empty</Text> : null}
            </View>
          );
        })}
      </ScrollView>
      <ItemSheet
        visible={Boolean(open)}
        onClose={() => setOpen(null)}
        title={open?.title ?? ""}
        subtitle={open ? [columnTitle(open.column), open.subtitle].filter(Boolean).join(" · ") : undefined}
        onAsk={(text) => ask(text, open ? { id: open.id, label: open.title } : undefined)}
        actions={
          open
            ? [
                ...columns.filter((c) => c.id !== open.column).map((c) => ({ label: `Move to ${c.title}`, instruction: `move to ${c.title}` })),
                { label: "Remind me", instruction: `remind me tomorrow (${addDays(1)})` },
              ]
            : []
        }
      />
    </View>
  );
}

// ------------------------------------------------------------------ table

export function TableView({ page, ask, focusItem }: { page: Page; ask: AskOwner; focusItem?: string }) {
  const { colors } = useAppTheme();
  const { width } = useWindowDimensions();
  const data = page.data as TableData;
  const columns = Array.isArray(data.columns) ? data.columns : [];
  const rows = Array.isArray(data.rows) ? data.rows : [];
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [open, setOpen] = useState<TableData["rows"][number] | null>(null);
  useFocusItem(rows, focusItem, setOpen);
  const sorted = useMemo(() => {
    if (!sort) return rows;
    return [...rows].sort((a, b) => String(a[sort.key] ?? "").localeCompare(String(b[sort.key] ?? ""), undefined, { numeric: true }) * sort.dir);
  }, [rows, sort]);
  const label = (row: TableData["rows"][number]) => String(row[columns.find((c) => !c.icon)?.key ?? columns[0]?.key ?? "id"] ?? row.id);
  const narrow = width < 560;
  return (
    <View style={styles.kind}>
      {narrow ? (
        <View style={styles.stack}>
          {sorted.map((row) => (
            <Pressable key={row.id} onPress={() => setOpen(row)} accessibilityRole="button" style={({ pressed }) => [styles.rowCard, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.75 : 1 }]}>
              {columns.map((c, i) => (
                row[c.key] === null || row[c.key] === undefined || row[c.key] === "" ? null : i === 0 || c.icon ? (
                  <Text key={c.key} variant={i === 0 ? "subtle" : "caption"} color={colors.text} style={i === 0 ? styles.bold : undefined}>
                    {String(row[c.key])}
                  </Text>
                ) : (
                  <View key={c.key} style={styles.field}>
                    <Text variant="caption" style={styles.fieldLabel}>{c.title}</Text>
                    <Text variant="caption" color={colors.text} style={styles.fieldValue}>{String(row[c.key])}</Text>
                  </View>
                )
              ))}
            </Pressable>
          ))}
        </View>
      ) : (
        <ScrollView horizontal showsHorizontalScrollIndicator>
          <View style={[styles.table, { borderColor: colors.border }]}>
            <View style={[styles.tableRow, { backgroundColor: colors.surfaceAlt }]}>
              {columns.map((c) => (
                <Pressable
                  key={c.key}
                  onPress={() => setSort((s) => (s?.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: 1 }))}
                  accessibilityRole="button"
                  accessibilityLabel={`Sort by ${c.title}`}
                  style={[styles.cell, c.icon ? styles.iconCell : null]}
                >
                  <Text variant="label" color={colors.text}>
                    {c.title}
                    {sort?.key === c.key ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
                  </Text>
                </Pressable>
              ))}
            </View>
            {sorted.map((row, i) => (
              <Pressable key={row.id} onPress={() => setOpen(row)} accessibilityRole="button" style={({ pressed }) => [styles.tableRow, { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth, backgroundColor: pressed ? colors.accentSoft : i % 2 ? colors.surfaceAlt : "transparent" }]}>
                {columns.map((c) => (
                  <View key={c.key} style={[styles.cell, c.icon ? styles.iconCell : null]}>
                    <Text variant="subtle" color={colors.text}>
                      {row[c.key] === null || row[c.key] === undefined ? "" : String(row[c.key])}
                    </Text>
                  </View>
                ))}
              </Pressable>
            ))}
          </View>
        </ScrollView>
      )}
      <ItemSheet
        visible={Boolean(open)}
        onClose={() => setOpen(null)}
        title={open ? label(open) : ""}
        onAsk={(text) => ask(text, open ? { id: open.id, label: label(open) } : undefined)}
        actions={
          open
            ? [
                { label: "Tell me more", instruction: "tell me more" },
                { label: "Add to my calendar", instruction: "send me a calendar invite" },
                { label: "Not interested", instruction: "not interested, skip things like this" },
              ]
            : []
        }
      >
        {open ? (
          <View style={styles.fields}>
            {columns.map((c) => <Field key={c.key} label={c.title} value={open[c.key] === null || open[c.key] === undefined ? undefined : String(open[c.key])} />)}
          </View>
        ) : null}
      </ItemSheet>
    </View>
  );
}

// ------------------------------------------------------------------- list

export function ListView({
  page,
  ask,
  onToggle,
  onRemove,
  onDelegate,
  onDiscuss,
  focusItem,
}: {
  page: Page;
  ask: AskOwner;
  focusItem?: string;
  onToggle: (item: ListItem) => Promise<void>;
  onRemove: (item: ListItem) => Promise<void>;
  /** ideas: hand the item to an intern's chat */
  onDelegate: (item: ListItem, slug: string) => Promise<void>;
  onDiscuss: (item: ListItem) => Promise<void>;
}) {
  const { colors } = useAppTheme();
  const crew = useCrew();
  const data = page.data as ListData;
  const items = Array.isArray(data.items) ? data.items : [];
  const [filter, setFilter] = useState<string>("open");
  const [open, setOpen] = useState<ListItem | null>(null);
  useFocusItem(items, focusItem, setOpen);
  const [delegating, setDelegating] = useState(false);
  const isIdeas = page.intern === "coordinator";
  const tags = useMemo(() => [...new Set(items.flatMap((i) => i.tags ?? []))].slice(0, 6), [items]);
  const shown = items
    .filter((i) => (filter === "open" ? !i.done : filter === "done" ? i.done : filter === "all" ? true : (i.tags ?? []).includes(filter)))
    .slice()
    .reverse();
  const doneCount = items.filter((i) => i.done).length;
  return (
    <View style={styles.kind}>
      <FilterChips
        value={filter}
        onChange={setFilter}
        options={[
          { id: "open", label: `Open · ${items.length - doneCount}` },
          ...tags.map((t) => ({ id: t, label: t })),
          ...(doneCount ? [{ id: "done", label: `Done · ${doneCount}` }] : []),
          { id: "all", label: "All" },
        ]}
      />
      <View style={styles.stack}>
        {shown.map((item) => (
          <View key={item.id} style={[styles.listRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Pressable
              onPress={() => void onToggle(item)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: Boolean(item.done) }}
              accessibilityLabel={item.done ? "Mark not done" : "Mark done"}
              hitSlop={8}
              style={[styles.box, { borderColor: item.done ? colors.accent : colors.border, backgroundColor: item.done ? colors.accent : "transparent" }]}
            >
              {item.done ? <CheckIcon size={13} color={colors.onAccent} /> : null}
            </Pressable>
            <Pressable onPress={() => setOpen(item)} accessibilityRole="button" style={styles.flex}>
              <Text variant="subtle" color={item.done ? colors.textFaint : colors.text} style={item.done ? styles.struck : undefined}>
                {item.text}
              </Text>
              <View style={styles.listMeta}>
                <Tags tags={item.tags ?? []} max={3} />
                <Text variant="caption">{relativeTime(item.ts)}</Text>
              </View>
            </Pressable>
          </View>
        ))}
      </View>
      {shown.length === 0 ? <Text variant="subtle" center style={styles.empty}>{filter === "open" ? (isIdeas ? "No open ideas. Start any message with “idea:” to add one." : "Nothing open.") : "Nothing here."}</Text> : null}
      <ItemSheet
        visible={Boolean(open)}
        onClose={() => {
          setOpen(null);
          setDelegating(false);
        }}
        title={isIdeas ? "Idea" : "Item"}
        subtitle={open?.text}
        onAsk={isIdeas ? undefined : (text) => ask(text, open ? { id: open.id, label: open.text.slice(0, 40) } : undefined)}
        actions={
          !open
            ? []
            : delegating
              ? crew.members.map((m) => ({ label: m.name, run: () => onDelegate(open, m.slug) }))
              : isIdeas
                ? [
                    { label: "Turn into work for…", run: () => setDelegating(true), keepOpen: true },
                    { label: "Discuss", run: () => onDiscuss(open) },
                    { label: open.done ? "Reopen" : "Done", run: () => onToggle(open) },
                    { label: "Drop", run: () => onRemove(open), tone: "danger" },
                  ]
                : [
                    { label: open.done ? "Reopen" : "Done", run: () => onToggle(open) },
                    { label: "Remove it", instruction: "remove it" },
                  ]
        }
      >
        {open?.source ? <Text variant="caption">{`From ${open.source.thread_key === "coordinator" ? "the front desk" : (crew.bySlug[open.source.thread_key]?.name ?? "a chat")} · ${relativeTime(open.ts)}`}</Text> : null}
        {delegating ? <Text variant="label">Who should take it?</Text> : null}
      </ItemSheet>
    </View>
  );
}

// ------------------------------------------------------------------ draft

const TONES = [
  { label: "Shorter", instruction: "make the draft shorter" },
  { label: "Warmer", instruction: "make the draft warmer" },
  { label: "More formal", instruction: "make the draft more formal" },
  { label: "Afrikaans", instruction: "rewrite the draft in Afrikaans" },
  { label: "English", instruction: "rewrite the draft in English" },
];

export function DraftView({ page, ask }: { page: Page; ask: AskOwner }) {
  const { colors, fontScale } = useAppTheme();
  const data = page.data as DraftData;
  const [threadOpen, setThreadOpen] = useState(false);
  const [change, setChange] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const notAReply = data.intended_reply && data.kind === "new";
  const send = async (key: string, instruction: string) => {
    setBusy(key);
    try {
      await ask(instruction);
    } finally {
      setBusy(null);
    }
  };
  const Row = ({ label, value }: { label: string; value: string }) =>
    value ? (
      <View style={styles.mailRow}>
        <Text variant="caption" style={styles.mailLabel}>
          {label}
        </Text>
        <Text variant="subtle" color={colors.text} style={styles.flex}>
          {value}
        </Text>
      </View>
    ) : null;
  return (
    <View style={styles.kind}>
      <View style={[styles.mail, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Row label="To" value={(data.to ?? []).join(", ")} />
        <Row label="Cc" value={(data.cc ?? []).join(", ")} />
        <Row label={data.kind === "new" ? "Subject" : "Re"} value={data.subject ?? ""} />
        <View style={[styles.badge, { backgroundColor: notAReply ? colors.actionSoft : colors.successSoft }]}>
          <Text variant="caption" color={notAReply ? colors.action : colors.success} style={styles.bold}>
            {notAReply ? "⚠ New email, not a reply" : data.kind === "reply_all" ? "✓ Reply-all in thread" : data.kind === "reply" ? "✓ Reply in thread (sender only)" : "New email"}
          </Text>
        </View>
        <View style={[styles.mailBody, { borderColor: colors.border }]}>
          <Text variant="message" color={colors.text} selectable>
            {data.body}
          </Text>
        </View>
        {data.thread?.length ? (
          <View>
            <Pressable onPress={() => setThreadOpen((v) => !v)} accessibilityRole="button" style={styles.threadToggle}>
              <View style={threadOpen ? styles.chevronUp : null}>
                <ChevronDownIcon size={14} color={colors.textDim} />
              </View>
              <Text variant="caption">{`${data.thread.length} earlier email${data.thread.length === 1 ? "" : "s"}`}</Text>
            </Pressable>
            {threadOpen
              ? data.thread.map((t, i) => (
                  <View key={i} style={[styles.quoted, { borderLeftColor: colors.border }]}>
                    <Text variant="caption" color={colors.textDim} style={styles.bold}>
                      {`${t.from}${t.date ? ` · ${relativeTime(t.date)}` : ""}`}
                    </Text>
                    <Text variant="caption" color={colors.textDim}>
                      {t.preview}
                    </Text>
                  </View>
                ))
              : null}
          </View>
        ) : null}
      </View>
      <View style={styles.actions}>
        {TONES.map((t) => (
          <Pressable
            key={t.label}
            disabled={busy !== null}
            onPress={() => void send(t.label, t.instruction)}
            accessibilityRole="button"
            style={({ pressed }) => [styles.action, { borderColor: colors.border, opacity: busy && busy !== t.label ? 0.5 : pressed ? 0.7 : 1 }]}
          >
            <Text variant="caption" color={colors.text} style={styles.bold}>
              {busy === t.label ? "Asking…" : t.label}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={[styles.askRow, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
        <TextInput
          value={change}
          onChangeText={setChange}
          placeholder="Ask for a change…"
          placeholderTextColor={colors.textFaint}
          multiline
          numberOfLines={1}
          style={[styles.askInput, { color: colors.text, fontSize: scaledFont(15, fontScale) }]}
        />
        <Pressable
          disabled={!change.trim() || busy !== null}
          onPress={() => void send("change", change.trim()).then(() => setChange(""))}
          accessibilityRole="button"
          accessibilityLabel="Send change request"
          style={({ pressed }) => [styles.askSend, { backgroundColor: colors.accent, opacity: !change.trim() ? 0.4 : pressed ? 0.8 : 1 }]}
        >
          <SendIcon size={18} color={colors.onAccent} />
        </Pressable>
      </View>
      {data.web_link ? (
        <Pressable
          onPress={() => void Linking.openURL(data.web_link!)}
          accessibilityRole="link"
          style={({ pressed }) => [styles.outlook, { backgroundColor: colors.accent, opacity: pressed ? 0.85 : 1 }]}
        >
          <Text variant="subtle" color={colors.onAccent} style={styles.bold}>
            Open in Outlook
          </Text>
          <ExternalIcon size={16} color={colors.onAccent} />
        </Pressable>
      ) : null}
      <Text variant="caption" center>
        Drafts are never sent for you — send it from Outlook when it reads right.
      </Text>
    </View>
  );
}

/** Owner line for the page header: face + name. */
export function OwnerLine({ slug }: { slug: string }) {
  const crew = useCrew();
  const coordinatorName = useCoordinatorName();
  const member = crew.bySlug[slug];
  const name = slug === "coordinator" ? coordinatorName : (member?.name ?? slug);
  return (
    <View style={styles.owner}>
      <InternFace id={slug === "coordinator" ? "coordinator" : (member?.faceId ?? resolveFaceId(undefined, slug))} size={20} clipToBounds />
      <Text variant="caption">{`Kept by ${name}`}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bold: { fontWeight: "600" },
  struck: { textDecorationLine: "line-through" },
  kind: { gap: space.md },
  empty: { marginTop: space.xl },
  backdrop: { flex: 1, justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingTop: space.sm, maxHeight: "85%" },
  handle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: "rgba(127,127,127,0.5)", marginBottom: space.xs },
  sheetScroll: { flexGrow: 0 },
  sheetBody: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: space.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.sm },
  action: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 8 },
  askRow: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: 22, paddingLeft: space.md, padding: 4, marginTop: space.sm },
  askInput: { flex: 1, paddingVertical: 8, maxHeight: 120 },
  askSend: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  fields: { gap: space.sm, marginTop: space.xs },
  field: { flexDirection: "row", gap: space.sm, alignItems: "baseline" },
  fieldLabel: { width: 110, flexShrink: 0 },
  fieldValue: { flex: 1 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  tag: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 1 },
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: 6 },
  searchInput: { flex: 1, paddingVertical: 4 },
  filters: { gap: space.sm },
  filter: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, justifyContent: "space-between" },
  person: { borderWidth: 1, borderRadius: radius.lg, padding: space.md, gap: 3, marginBottom: space.xs },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", marginBottom: space.xs },
  timeline: { gap: space.xs, marginTop: space.sm },
  timelineRow: { flexDirection: "row", gap: space.sm },
  timelineWhen: { width: 90 },
  board: { gap: space.md, paddingBottom: space.md, alignItems: "flex-start" },
  column: { width: 250, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, padding: space.sm, gap: space.sm },
  columnHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: space.xs, paddingTop: space.xs },
  columnEmpty: { paddingVertical: space.md },
  boardCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, gap: 3 },
  stack: { gap: space.sm },
  rowCard: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md, gap: 4 },
  table: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, overflow: "hidden" },
  tableRow: { flexDirection: "row" },
  cell: { width: 170, paddingHorizontal: space.md, paddingVertical: space.sm },
  iconCell: { width: 56 },
  listRow: { flexDirection: "row", gap: space.md, alignItems: "flex-start", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md },
  listMeta: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm, marginTop: 4 },
  box: { width: 22, height: 22, borderRadius: 6, borderWidth: 1.5, alignItems: "center", justifyContent: "center", marginTop: 1 },
  mail: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  mailRow: { flexDirection: "row", gap: space.sm, alignItems: "baseline" },
  mailLabel: { width: 56 },
  badge: { alignSelf: "flex-start", borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 4 },
  mailBody: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.md },
  threadToggle: { flexDirection: "row", alignItems: "center", gap: space.xs, paddingVertical: space.xs },
  chevronUp: { transform: [{ rotate: "180deg" }] },
  quoted: { borderLeftWidth: 2, paddingLeft: space.sm, marginTop: space.sm, gap: 2 },
  outlook: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm, borderRadius: radius.lg, paddingVertical: space.md },
  owner: { flexDirection: "row", alignItems: "center", gap: 6 },
});
