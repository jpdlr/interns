/**
 * Today (docs/features/03-today.md): the day on one scrolling page — what
 * needs a decision, the schedule with each meeting's brief folded in (and a
 * debrief chip once it's over), follow-ups due, information to glance at,
 * and what the crew did while JP was away. Everything here leads back to a
 * chat; this tab only gathers. Replaces the Inbox; History is one tap away.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import type { Agenda, Card, CardAction, ScheduleEntry } from "../../src/api";
import { useCrew } from "../../src/crew";
import { haptic } from "../../src/haptics";
import { useLiveEvents } from "../../src/live";
import { useSettings } from "../../src/settings";
import { radius, space, useAppTheme } from "../../src/theme";
import { relativeTime } from "../../src/time";
import { Button } from "../../src/ui/Button";
import { CardView } from "../../src/ui/CardView";
import { ConnectionPill } from "../../src/ui/ConnectionPill";
import { BackIcon, ChevronDownIcon, ChevronRightIcon, ExternalIcon } from "../../src/ui/Icons";
import { InternFace, resolveFaceId } from "../../src/ui/InternFace";
import { Markdown } from "../../src/ui/Markdown";
import { EmptyState, ErrorNote, Loading, Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

const OPENED_KEY = "interns.todayOpened.v1";
/** Dates and times on Today are this device's local ones. */
const ymd = (d: Date) => new Intl.DateTimeFormat("en-CA").format(d);
// A YYYY-MM-DD is a calendar day, not an instant: do day maths and naming in UTC so no offset can move it.
const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const clock = (iso: string) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false }) : "");
const longDay = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

export default function TodayScreen() {
  const router = useRouter();
  const { colors } = useAppTheme();
  const { api, ready, configured } = useSettings();
  const crew = useCrew();
  const params = useLocalSearchParams<{ card?: string }>();
  // The tab stays mounted overnight, so "today" is kept current (a minute
  // tick, and every focus) and the shown day is an offset from it.
  const [today, setToday] = useState(() => ymd(new Date()));
  const [offset, setOffset] = useState(0);
  const date = shiftDay(today, offset);
  useEffect(() => {
    const tick = setInterval(() => setToday(ymd(new Date())), 60_000);
    return () => clearInterval(tick);
  }, []);
  const [agenda, setAgenda] = useState<Agenda | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [since, setSince] = useState<string | null>(null);
  const [sinceLoaded, setSinceLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focused = useIsFocused();

  // "While you were away" = since the previous visit to Today. The tab stays
  // mounted, so this runs on every focus; leaving it marks the next "since".
  useFocusEffect(
    useCallback(() => {
      setToday(ymd(new Date()));
      void AsyncStorage.getItem(OPENED_KEY)
        .then((prev) => setSince(prev && Date.now() - Date.parse(prev) < 7 * 86_400_000 ? prev : null))
        .catch(() => setSince(null))
        .finally(() => setSinceLoaded(true));
      return () => void AsyncStorage.setItem(OPENED_KEY, new Date().toISOString()).catch(() => {});
    }, []),
  );

  const load = useCallback(async () => {
    if (!sinceLoaded) return;
    if (!configured) {
      setLoading(false);
      return;
    }
    try {
      setAgenda(await api.getAgenda(date, since));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, configured, date, since, sinceLoaded]);

  // Load on focus (and when the day or "since" changes); hidden, the stream is ignored above.
  useEffect(() => {
    if (focused) void load();
  }, [load, focused]);

  // Debounced refresh on the events that change what Today shows (not while another tab is showing).
  useLiveEvents((event) => {
    if (!focused || !["card", "card_state", "agenda", "page", "poll"].includes(event.type)) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), 400);
  });

  const runAction = useCallback(
    async (card: Card, action: CardAction, note?: string) => {
      const resolved = await api.runCardAction(card.id, action.id, note);
      if (resolved.context?.type === "suggestion" && action.id === "hire" && typeof resolved.context.hire_role === "string") {
        router.push(`/hire?role=${encodeURIComponent(resolved.context.hire_role)}` as never);
      }
      return resolved;
    },
    [api, router],
  );

  const markSeen = useCallback(
    async (cards: Card[]) => {
      setAgenda((a) => (a ? { ...a, fyi: a.fyi.filter((c) => !cards.some((x) => x.id === c.id)) } : a));
      haptic("tap");
      await Promise.all(cards.map((c) => api.runCardAction(c.id, "seen").catch(() => null)));
    },
    [api],
  );

  const nameOf = useCallback((slug: string) => (slug === "coordinator" ? "Chaos Coordinator" : (crew.bySlug[slug]?.name ?? slug)), [crew.bySlug]);
  const faceOf = useCallback((slug: string) => (slug === "coordinator" ? "coordinator" : (crew.bySlug[slug]?.faceId ?? resolveFaceId(undefined, slug))), [crew.bySlug]);

  const needsYou = useMemo(() => {
    const list = agenda?.needs_you ?? [];
    const rank = { urgent: 0, action: 1, info: 2 } as const;
    const sorted = [...list].sort((a, b) => rank[a.severity] - rank[b.severity] || b.created_at.localeCompare(a.created_at));
    return params.card ? sorted.sort((a, b) => (a.id === params.card ? -1 : b.id === params.card ? 1 : 0)) : sorted;
  }, [agenda?.needs_you, params.card]);

  if (!ready) return <Loading />;
  const isToday = offset === 0;
  const nothing = agenda && !needsYou.length && !agenda.schedule.length && !agenda.follow_ups.length && !agenda.fyi.length && !agenda.away.length && !agenda.standup;

  return (
    <Screen>
      <View style={styles.headerRow}>
        <View style={styles.header}>
          <Text variant="display">{isToday ? "Today" : offset < 0 ? "Earlier" : "Ahead"}</Text>
          <View style={styles.dayNav}>
            <Pressable onPress={() => setOffset((o) => o - 1)} accessibilityRole="button" accessibilityLabel="Previous day" hitSlop={8} style={styles.navButton}>
              <BackIcon size={18} color={colors.textDim} />
            </Pressable>
            <Text variant="subtle">{longDay(date)}</Text>
            <Pressable onPress={() => setOffset((o) => o + 1)} accessibilityRole="button" accessibilityLabel="Next day" hitSlop={8} style={styles.navButton}>
              <ChevronRightIcon size={18} color={colors.textDim} />
            </Pressable>
            {!isToday ? (
              <Pressable onPress={() => setOffset(0)} accessibilityRole="button" style={[styles.todayPill, { borderColor: colors.border }]}>
                <Text variant="caption" color={colors.text}>Today</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
        <View style={styles.pill}>
          <ConnectionPill />
        </View>
      </View>

      {error ? <ErrorNote error={error} onRetry={() => void load()} onDismiss={() => setError(null)} /> : null}
      {!configured ? (
        <EmptyState title="Not connected" body="Add your API token in Settings › Connection.">
          <Button label="Open Settings" tone="primary" onPress={() => router.push("/settings?tab=connect" as never)} />
        </EmptyState>
      ) : loading && !agenda ? (
        <Loading label="Gathering the day…" />
      ) : agenda ? (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.textDim} onRefresh={() => { setRefreshing(true); void load(); }} />}
        >
          {needsYou.length && isToday ? (
            <Section title="Needs you" count={needsYou.length}>
              {needsYou.length > 1 ? <Text variant="caption" style={styles.hint}>Swipe right to approve, left to snooze.</Text> : null}
              {needsYou.map((card) => (
                <CardView
                  key={card.id}
                  card={card}
                  // Fold long cards so several fit on a screen; one opened from a link starts unfolded.
                  collapsible={card.id !== params.card}
                  highlighted={card.id === params.card}
                  internName={nameOf(card.intern)}
                  faceId={faceOf(card.intern)}
                  onAction={runAction}
                  onResolved={(resolved) => setAgenda((a) => (a ? { ...a, needs_you: a.needs_you.filter((c) => c.id !== resolved.id) } : a))}
                />
              ))}
            </Section>
          ) : null}

          <Section title="Schedule" count={agenda.schedule.filter((e) => !e.cancelled).length || undefined}>
            {agenda.schedule_error ? <Text variant="caption" color={colors.action}>Calendar unavailable right now — showing briefed meetings only.</Text> : null}
            {agenda.schedule.length === 0 ? (
              <Text variant="subtle">{isToday ? "No meetings today." : "No meetings."}</Text>
            ) : (
              <Schedule entries={agenda.schedule} showNow={isToday} nameOf={nameOf} faceOf={faceOf} />
            )}
          </Section>

          {agenda.follow_ups.length ? (
            <Section title="Follow-ups due" count={agenda.follow_ups.length}>
              {agenda.follow_ups.map((f) => (
                <Pressable
                  key={`${f.page_id}-${f.person_id}`}
                  onPress={() => router.push(`/page/${f.page_id}` as never)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.row, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
                >
                  <View style={styles.rowText}>
                    <Text variant="subtle" color={colors.text} style={styles.bold}>
                      {f.name}
                      {f.company ? <Text variant="subtle">{` · ${f.company}`}</Text> : null}
                    </Text>
                    <Text variant="caption" color={f.overdue ? colors.urgent : colors.action}>
                      {f.overdue ? `Overdue since ${new Date(`${f.due}T12:00:00+02:00`).toLocaleDateString("en-ZA", { day: "numeric", month: "short" })}` : "Due today"}
                      {` · ${nameOf(f.intern)}`}
                    </Text>
                  </View>
                  <ChevronRightIcon size={16} color={colors.textFaint} />
                </Pressable>
              ))}
            </Section>
          ) : null}

          {agenda.fyi.length && isToday ? (
            <Section
              title="For your info"
              count={agenda.fyi.length}
              action={agenda.fyi.length > 1 ? { label: "Mark all seen", onPress: () => void markSeen(agenda.fyi) } : undefined}
            >
              {agenda.fyi.map((card) => (
                <FyiRow key={card.id} card={card} name={nameOf(card.intern)} faceId={faceOf(card.intern)} onSeen={() => void markSeen([card])} />
              ))}
            </Section>
          ) : null}

          {agenda.away.length && isToday ? (
            <Section title={since ? `While you were away · ${relativeTime(since)}` : "Today so far"}>
              {agenda.away.map((a) => (
                <Pressable
                  key={a.intern}
                  onPress={() => router.push(`/chat/${a.intern}` as never)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.awayRow, { opacity: pressed ? 0.7 : 1 }]}
                >
                  <InternFace id={faceOf(a.intern)} size={28} clipToBounds />
                  <Text variant="subtle" color={colors.text} style={styles.flex}>
                    {a.summary}
                  </Text>
                </Pressable>
              ))}
            </Section>
          ) : null}

          {agenda.standup ? <Standup markdown={agenda.standup.markdown} ts={agenda.standup.ts} /> : null}

          {nothing ? <Text variant="subtle" center>A clear day. Nothing needs you.</Text> : null}

          <Pressable onPress={() => router.push("/history" as never)} accessibilityRole="button" style={({ pressed }) => [styles.historyLink, { opacity: pressed ? 0.6 : 1 }]}>
            <Text variant="subtle" color={colors.textDim}>History</Text>
            <ChevronRightIcon size={14} color={colors.textFaint} />
          </Pressable>
        </ScrollView>
      ) : null}
    </Screen>
  );
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: { label: string; onPress: () => void };
  children: React.ReactNode;
}) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.section}>
      <View style={styles.sectionHead}>
        <Text variant="label">{count ? `${title} · ${count}` : title}</Text>
        {action ? (
          <Pressable onPress={action.onPress} accessibilityRole="button" hitSlop={6}>
            <Text variant="caption" color={colors.info}>
              {action.label}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {children}
    </View>
  );
}

function Schedule({ entries, showNow, nameOf, faceOf }: { entries: ScheduleEntry[]; showNow: boolean; nameOf: (s: string) => string; faceOf: (s: string) => string }) {
  const { colors } = useAppTheme();
  const now = Date.now();
  const nodes: React.ReactNode[] = [];
  let nowPlaced = !showNow;
  for (const entry of entries) {
    if (!nowPlaced && !entry.all_day && Date.parse(entry.start) > now) {
      nodes.push(
        <View key="now" style={styles.nowLine} accessibilityLabel="Now">
          <View style={[styles.nowDot, { backgroundColor: colors.urgent }]} />
          <View style={[styles.nowRule, { backgroundColor: colors.urgent }]} />
        </View>,
      );
      nowPlaced = true;
    }
    nodes.push(<MeetingRow key={entry.event_id} entry={entry} nameOf={nameOf} faceOf={faceOf} />);
  }
  if (!nowPlaced) {
    nodes.push(
      <View key="now" style={styles.nowLine}>
        <View style={[styles.nowDot, { backgroundColor: colors.urgent }]} />
        <View style={[styles.nowRule, { backgroundColor: colors.urgent }]} />
      </View>,
    );
  }
  return <View style={styles.schedule}>{nodes}</View>;
}

function MeetingRow({ entry, nameOf, faceOf }: { entry: ScheduleEntry; nameOf: (s: string) => string; faceOf: (s: string) => string }) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const now = Date.now();
  const start = Date.parse(entry.start);
  const end = Date.parse(entry.end);
  const soon = start > now && start - now < 15 * 60_000;
  const live = start <= now && now < end;
  const past = end <= now;
  const people = entry.attendees.filter((a) => a.name).map((a) => a.name.split(" ")[0]);
  const outsiders = entry.attendees.filter((a) => a.external).length;
  const debrief = entry.debrief;
  return (
    <View style={[styles.meeting, { borderColor: soon || live ? colors.info : colors.border, backgroundColor: live ? colors.accentSoft : colors.surface, opacity: entry.cancelled ? 0.5 : past ? 0.8 : 1 }]}>
      <View style={styles.meetingTop}>
        <Text variant="subtle" color={colors.text} style={[styles.time, styles.bold]}>
          {entry.all_day ? "All day" : clock(entry.start)}
        </Text>
        <View style={styles.flex}>
          <Text variant="subtle" color={colors.text} style={[styles.bold, entry.cancelled ? styles.struck : null]}>
            {entry.title}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {[
              entry.all_day ? null : `until ${clock(entry.end)}`,
              people.length ? `${people.slice(0, 4).join(", ")}${people.length > 4 ? ` +${people.length - 4}` : ""}` : null,
              outsiders ? `${outsiders} external` : null,
              entry.location,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          {soon ? <Text variant="caption" color={colors.info}>{`Starts in ${Math.max(1, Math.round((start - now) / 60_000))} min`}</Text> : live ? <Text variant="caption" color={colors.info}>On now</Text> : null}
        </View>
        {entry.web_link ? (
          <Pressable onPress={() => void Linking.openURL(entry.web_link!)} accessibilityRole="link" accessibilityLabel="Open in Outlook" hitSlop={8}>
            <ExternalIcon size={16} color={colors.textFaint} />
          </Pressable>
        ) : null}
      </View>
      {entry.brief ? (
        <View>
          <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.briefToggle}>
            <InternFace id={faceOf(entry.brief.intern)} size={18} clipToBounds />
            <Text variant="caption" color={colors.textDim} style={styles.flex}>{`Brief from ${nameOf(entry.brief.intern)}`}</Text>
            <View style={open ? styles.chevronUp : null}>
              <ChevronDownIcon size={14} color={colors.textDim} />
            </View>
          </Pressable>
          {open ? (
            <View style={[styles.brief, { borderLeftColor: colors.border }]}>
              <Markdown body={entry.brief.markdown} variant="subtle" />
            </View>
          ) : null}
        </View>
      ) : null}
      {debrief && (debrief.state === "pending" || debrief.state === "asked") ? (
        <Pressable
          onPress={() => router.push(`/chat/${debrief.intern}${debrief.message_id ? `?message=${encodeURIComponent(debrief.message_id)}` : ""}` as never)}
          accessibilityRole="button"
          style={({ pressed }) => [styles.debrief, { backgroundColor: colors.accent, opacity: pressed ? 0.8 : 1 }]}
        >
          <Text variant="caption" color={colors.onAccent} style={styles.bold}>
            {debrief.state === "asked" ? `Debrief with ${nameOf(debrief.intern)}` : "Debrief"}
          </Text>
        </Pressable>
      ) : debrief?.state === "answered" ? (
        <Text variant="caption" color={colors.success}>✓ Debriefed</Text>
      ) : null}
    </View>
  );
}

function FyiRow({ card, name, faceId, onSeen }: { card: Card; name: string; faceId: string; onSeen: () => void }) {
  const { colors } = useAppTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={[styles.fyi, { borderColor: colors.border }]}>
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.fyiTop}>
        <InternFace id={faceId} size={26} clipToBounds />
        <View style={styles.flex}>
          <Text variant="subtle" color={colors.text} numberOfLines={open ? undefined : 1} style={styles.bold}>
            {card.title}
          </Text>
          <Text variant="caption">{`${name} · ${relativeTime(card.created_at)}`}</Text>
        </View>
        <Pressable onPress={onSeen} accessibilityRole="button" accessibilityLabel={`Mark seen: ${card.title}`} hitSlop={6} style={[styles.seen, { borderColor: colors.border }]}>
          <Text variant="caption" color={colors.text} style={styles.bold}>
            Seen
          </Text>
        </Pressable>
      </Pressable>
      {open ? (
        <View style={styles.fyiBody}>
          <Markdown body={card.body} variant="subtle" />
        </View>
      ) : null}
    </View>
  );
}

function Standup({ markdown, ts }: { markdown: string; ts: string }) {
  const { colors } = useAppTheme();
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.section}>
      <Pressable onPress={() => setOpen((v) => !v)} accessibilityRole="button" accessibilityState={{ expanded: open }} style={styles.sectionHead}>
        <Text variant="label">{`Standup · ${new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false })}`}</Text>
        <View style={open ? styles.chevronUp : null}>
          <ChevronDownIcon size={14} color={colors.textDim} />
        </View>
      </Pressable>
      {open ? (
        <View style={[styles.standup, { backgroundColor: colors.surfaceAlt }]}>
          <Markdown body={markdown} variant="subtle" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bold: { fontWeight: "600" },
  struck: { textDecorationLine: "line-through" },
  headerRow: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  header: { paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.sm, gap: space.xs, flex: 1 },
  dayNav: { flexDirection: "row", alignItems: "center", gap: space.xs },
  navButton: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  todayPill: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2, marginLeft: space.xs },
  pill: { paddingRight: space.xl, paddingTop: space.lg },
  body: { paddingHorizontal: space.lg, paddingBottom: space.xxxl, gap: space.xl },
  section: { gap: space.sm },
  sectionHead: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.xs },
  schedule: { gap: space.sm },
  meeting: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  meetingTop: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  time: { width: 52 },
  briefToggle: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingVertical: 2 },
  brief: { borderLeftWidth: 2, paddingLeft: space.md, marginTop: space.xs },
  chevronUp: { transform: [{ rotate: "180deg" }] },
  debrief: { alignSelf: "flex-start", borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  nowLine: { flexDirection: "row", alignItems: "center", marginVertical: 2 },
  nowDot: { width: 8, height: 8, borderRadius: 4 },
  nowRule: { flex: 1, height: 1.5 },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md },
  rowText: { flex: 1, gap: 2 },
  fyi: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md, gap: space.sm },
  fyiTop: { flexDirection: "row", alignItems: "center", gap: space.md },
  fyiBody: { paddingLeft: 26 + space.md },
  seen: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 5 },
  awayRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.xs },
  standup: { borderRadius: radius.lg, padding: space.md },
  hint: { marginHorizontal: space.xs },
  historyLink: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.xs, paddingVertical: space.md },
});
