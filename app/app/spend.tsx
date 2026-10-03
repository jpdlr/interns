/**
 * Spend: what the crew costs, by intern per day (stacked) and by
 * conversation — each room or 1:1 thread with its total over the window.
 * Both read GET /spend and draw with the same Chart renderer the threads
 * use, so this screen is mostly data shaping.
 */
import { Stack, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { RoomListEntry, SpendReport } from "../src/api";
import { useCrew, isRoomKey } from "../src/crew";
import { useSettings } from "../src/settings";
import { radius, space, useAppTheme } from "../src/theme";
import { relativeTime } from "../src/time";
import { Chart, nearestPaletteColors, type ChartSpec } from "../src/ui/Chart";
import { FaceStack } from "../src/ui/FaceStack";
import { faceColor, InternFace, resolveFaceId } from "../src/ui/InternFace";
import { EmptyState, ErrorNote, Loading, Screen } from "../src/ui/Screen";
import { Text } from "../src/ui/Text";

const WINDOWS = [7, 30, 90] as const;

function money(v: number): string {
  return v >= 100 ? `$${Math.round(v)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}

export default function SpendScreen() {
  const { colors, scheme } = useAppTheme();
  const { api, ready, configured } = useSettings();
  const { bySlug } = useCrew();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [report, setReport] = useState<SpendReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [rooms, setRooms] = useState<RoomListEntry[]>([]);

  const load = useCallback(async () => {
    if (!configured) {
      setLoading(false);
      return;
    }
    try {
      const [spend, roomList] = await Promise.all([api.getSpend(days), api.listRooms().catch(() => [] as RoomListEntry[])]);
      setReport(spend);
      setRooms(roomList);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, configured, days]);

  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = useCallback((key: string) => report?.names[key] ?? bySlug[key]?.name ?? key, [report, bySlug]);

  /** Stacked cost per intern per day. */
  const internChart = useMemo<ChartSpec | null>(() => {
    if (!report || report.by_intern.length === 0) return null;
    const interns = [...new Set(report.by_intern.map((r) => r.intern))];
    const totals = new Map(interns.map((i) => [i, report.by_intern.filter((r) => r.intern === i).reduce((a, r) => a + r.cost_usd, 0)]));
    const ordered = interns.sort((a, b) => (totals.get(b) ?? 0) - (totals.get(a) ?? 0)).slice(0, 8);
    const labels = report.days.map((d) => (days > 14 ? d.slice(5) : d.slice(8)));
    // Each intern keeps a colour close to their face, here and on every visit.
    const seriesColors = nearestPaletteColors(ordered.map((slug) => faceColor(bySlug[slug]?.faceId ?? resolveFaceId(undefined, slug))), scheme);
    return {
      type: "bar",
      stacked: true,
      title: `Cost per day, last ${days} days`,
      labels,
      series: ordered.map((slug, i) => ({ name: nameOf(slug), color: seriesColors[i], data: report.days.map((d) => Math.round((report.by_intern.find((r) => r.intern === slug && r.day === d)?.cost_usd ?? 0) * 1000) / 1000) })),
      format: "currency",
      currency: "$",
    };
  }, [report, days, nameOf, bySlug, scheme]);

  /** Horizontal bars: cost per conversation. */
  const threadChart = useMemo<ChartSpec | null>(() => {
    if (!report || report.by_thread.length === 0) return null;
    const top = report.by_thread.slice(0, 10);
    return {
      type: "bar",
      horizontal: true,
      title: "Cost per conversation",
      labels: top.map((t) => nameOf(t.thread)),
      series: [{ name: "Cost", data: top.map((t) => Math.round(t.cost_usd * 1000) / 1000) }],
      format: "currency",
      currency: "$",
    };
  }, [report, nameOf]);

  const totalCost = report?.by_intern.reduce((a, r) => a + r.cost_usd, 0) ?? 0;
  const totalTokens = report?.by_intern.reduce((a, r) => a + r.tokens, 0) ?? 0;

  return (
    <Screen>
      <Stack.Screen options={{ title: "Spend" }} />
      {!configured ? (
        <EmptyState title="Not connected" body="Add your API token in Settings › Connection." />
      ) : !ready || loading ? (
        <Loading />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxl }]}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.textDim} onRefresh={() => { setRefreshing(true); void load(); }} />}
        >
          {error ? <ErrorNote error={error} onRetry={() => void load()} style={styles.inlineError} /> : null}
          <View style={styles.headerRow}>
            <View>
              <Text variant="display">{report ? money(totalCost) : "—"}</Text>
              <Text variant="caption">{report ? `${totalTokens.toLocaleString()} tokens · last ${days} days` : `last ${days} days`}</Text>
            </View>
            <View style={styles.segments}>
              {WINDOWS.map((w) => (
                <Pressable
                  key={w}
                  onPress={() => setDays(w)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: days === w }}
                  style={[styles.segment, { backgroundColor: days === w ? colors.surfaceAlt : "transparent", borderColor: colors.border }]}
                >
                  <Text variant="caption" color={days === w ? colors.text : colors.textDim}>{`${w}d`}</Text>
                </Pressable>
              ))}
            </View>
          </View>

          {internChart ? (
            <View style={[styles.card, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <Chart spec={internChart} surface={colors.surfaceAlt} />
            </View>
          ) : error ? null : (
            <EmptyState title="No spend yet" body="Runs record their cost here as interns work." />
          )}

          {threadChart ? (
            <View style={[styles.card, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <Chart spec={threadChart} surface={colors.surfaceAlt} />
            </View>
          ) : null}

          {report && report.by_thread.length ? (
            <View style={styles.section}>
              <Text variant="label">Conversations</Text>
              {report.by_thread.map((t) => {
                const room = isRoomKey(t.thread);
                const member = bySlug[t.thread];
                return (
                  <Pressable
                    key={t.thread}
                    onPress={() => router.push(`/chat/${t.thread}` as never)}
                    accessibilityRole="button"
                    style={({ pressed }) => [styles.row, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.8 : 1 }]}
                  >
                    {room ? (
                      <FaceStack faceIds={(rooms.find((r) => r.id === t.thread)?.members ?? []).map((m) => bySlug[m]?.faceId ?? resolveFaceId(undefined, m))} size={40} />
                    ) : (
                      <InternFace id={member?.faceId ?? resolveFaceId(undefined, t.thread)} size={40} clipToBounds />
                    )}
                    <View style={styles.rowText}>
                      <Text variant="subtle" color={colors.text} numberOfLines={1}>
                        {nameOf(t.thread)}
                        {room ? "  · group" : ""}
                      </Text>
                      <Text variant="caption" numberOfLines={1}>
                        {`${t.runs} run${t.runs === 1 ? "" : "s"} · ${t.tokens.toLocaleString()} tokens · last ${relativeTime(t.last_ts)}`}
                      </Text>
                    </View>
                    <Text variant="subtle" color={colors.text} style={styles.money}>
                      {money(t.cost_usd)}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.lg, maxWidth: 900, width: "100%", alignSelf: "center" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-end", gap: space.md },
  segments: { flexDirection: "row", gap: space.sm },
  segment: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.md },
  section: { gap: space.sm },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.sm, paddingRight: space.md },
  rowText: { flex: 1, gap: 1 },
  money: { fontVariant: ["tabular-nums"], fontWeight: "600" },
  inlineError: { marginHorizontal: 0, marginBottom: 0 },
});
