/**
 * The audit timeline: finished work and resolved cards, newest first. It used
 * to sit behind the Inbox's History segment; Today links here now.
 */
import { useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import type { Card, Intern, TaskActivity } from "../src/api";
import { useLive } from "../src/live";
import { useSettings } from "../src/settings";
import { radius, space, useAppTheme } from "../src/theme";
import { relativeTime } from "../src/time";
import { InternFace, resolveFaceId } from "../src/ui/InternFace";
import { EmptyState, ErrorNote, Loading, Screen } from "../src/ui/Screen";
import { Text } from "../src/ui/Text";

interface HistoryItem {
  id: string;
  intern: string;
  title: string;
  detail: string;
  status: "done" | "failed" | "cancelled" | "approved" | "dismissed";
  ts: string;
}

export default function HistoryScreen() {
  const { colors } = useAppTheme();
  const { api, ready, configured } = useSettings();
  const { revision } = useLive();
  const params = useLocalSearchParams<{ card?: string }>();
  const [resolvedCards, setResolvedCards] = useState<Card[]>([]);
  const [activity, setActivity] = useState<TaskActivity[]>([]);
  const [interns, setInterns] = useState<Intern[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!configured) {
      setLoading(false);
      return;
    }
    try {
      const [resolved, recent, crew] = await Promise.all([api.listCards("resolved"), api.listActivity(120), api.listInterns()]);
      setResolvedCards(resolved);
      setActivity(recent);
      setInterns(crew);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, configured]);

  useEffect(() => { void load(); }, [load, revision]);

  const byIntern = useMemo(() => Object.fromEntries(interns.map((intern) => [intern.slug, intern])), [interns]);
  const history = useMemo(() => buildHistory(activity, resolvedCards), [activity, resolvedCards]);

  if (!ready) return <Loading />;
  return (
    <Screen>
      {error ? <ErrorNote error={error} onRetry={() => void load()} onDismiss={() => setError(null)} /> : null}
      {!configured ? (
        <EmptyState title="Not connected" body="Add your API token in Settings › Connection." />
      ) : loading ? (
        <Loading label="Fetching history…" />
      ) : (
        <FlatList
          data={history}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.historyList}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.textDim} onRefresh={() => { setRefreshing(true); void load(); }} />}
          ListEmptyComponent={<EmptyState title="No history yet" body="Completed reviews, approvals and builds will appear here." />}
          renderItem={({ item, index }) => (
            <HistoryRow item={item} intern={byIntern[item.intern]} last={index === history.length - 1} highlighted={Boolean(params.card) && item.id === `card-${params.card}`} />
          )}
        />
      )}
    </Screen>
  );
}

function HistoryRow({ item, intern, last, highlighted }: { item: HistoryItem; intern?: Intern; last: boolean; highlighted: boolean }) {
  const { colors } = useAppTheme();
  const statusColor = item.status === "failed" ? colors.urgent : item.status === "cancelled" || item.status === "dismissed" ? colors.textFaint : colors.success;
  return (
    <View style={[styles.historyRow, highlighted && { backgroundColor: colors.accentSoft }]}>
      <View style={styles.timelineRail}>
        <View style={[styles.timelineDot, { backgroundColor: statusColor }]} />
        {!last ? <View style={[styles.timelineLine, { backgroundColor: colors.border }]} /> : null}
      </View>
      <InternFace id={item.intern === "coordinator" ? "coordinator" : resolveFaceId(intern?.icon, item.intern)} size={32} clipToBounds />
      <View style={styles.historyBody}>
        <View style={styles.historyTop}>
          <Text variant="subtle" color={colors.text} style={styles.historyTitle}>{item.title}</Text>
          <Text variant="caption">{relativeTime(item.ts)}</Text>
        </View>
        <Text variant="caption" numberOfLines={2}>{item.detail}</Text>
      </View>
    </View>
  );
}

function buildHistory(activity: TaskActivity[], cards: Card[]): HistoryItem[] {
  const lastMatchingTask = new Map<string, number>();
  const taskItems: HistoryItem[] = activity
    .filter((task) => task.status === "done" || task.status === "failed" || task.status === "cancelled")
    .filter((task) => {
      const ts = Date.parse(task.finished_at ?? task.started_at ?? task.created_at);
      const key = `${task.intern}\u0000${task.status}\u0000${task.label}`;
      const previous = lastMatchingTask.get(key);
      lastMatchingTask.set(key, ts);
      // A webhook and the polling safety net can occasionally record the same
      // outcome minutes apart. Keep the audit useful without hiding a later
      // deliberate re-review of the same pull request.
      return previous === undefined || Math.abs(previous - ts) > 30 * 60_000;
    })
    .map((task) => ({
      id: `task-${task.id}`,
      intern: task.intern,
      title: task.label,
      detail: task.error ?? (task.kind === "github" ? "Pull-request review" : task.kind === "capability" ? "Integration build" : "Intern activity"),
      status: task.status as "done" | "failed" | "cancelled",
      ts: task.finished_at ?? task.started_at ?? task.created_at,
    }));
  const cardItems: HistoryItem[] = cards.map((card) => {
    const action = card.actions.find((candidate) => candidate.id === card.resolution?.action);
    const dismissed = /dismiss|ignore|reject/i.test(action?.label ?? card.resolution?.action ?? "");
    return {
      id: `card-${card.id}`,
      intern: card.intern,
      title: card.title,
      detail: `${action?.label ?? card.resolution?.action ?? "Resolved"}${card.resolution?.note ? ` · ${card.resolution.note}` : ""}`,
      status: dismissed ? "dismissed" : "approved",
      ts: card.resolved_at ?? card.updated_at,
    };
  });
  return [...taskItems, ...cardItems].sort((a, b) => b.ts.localeCompare(a.ts));
}

const styles = StyleSheet.create({
  historyList: { paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.xl },
  historyRow: { flexDirection: "row", gap: space.md, paddingBottom: space.lg, borderRadius: radius.md },
  timelineRail: { width: 10, alignItems: "center" },
  timelineDot: { width: 8, height: 8, borderRadius: radius.pill, marginTop: 12 },
  timelineLine: { position: "absolute", top: 22, bottom: -4, width: StyleSheet.hairlineWidth },
  historyBody: { flex: 1, gap: 3, paddingTop: 4 },
  historyTop: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: space.sm },
  historyTitle: { flex: 1, fontWeight: "600" },
});
