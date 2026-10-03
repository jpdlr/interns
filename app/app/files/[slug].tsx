/**
 * Everything exchanged with one intern: a gallery of pictures and a list of
 * files, newest first, from GET /interns/:slug/attachments. Tapping a
 * picture opens the same viewer the thread uses; tapping a file downloads
 * it. "Jump to message" is not here on purpose — the thread already shows
 * each file in context, this screen is for finding a thing later.
 */
import { Stack, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Image, Pressable, RefreshControl, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Attachment, Intern } from "../../src/api";
import { useRefreshSignal } from "../../src/live";
import { useSettings } from "../../src/settings";
import { radius, space, useAppTheme } from "../../src/theme";
import { dayLabel } from "../../src/time";
import { AttachmentViewer, formatBytes, openExternal } from "../../src/ui/Attachments";
import { DownloadIcon, FileIcon } from "../../src/ui/Icons";
import { EmptyState, ErrorNote, Loading, Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

type Filter = "all" | "pictures" | "files";

export default function FilesScreen() {
  const { colors } = useAppTheme();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { api, ready, configured } = useSettings();
  const refreshSignal = useRefreshSignal(1_500, 6_000);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  const [intern, setIntern] = useState<Intern | null>(null);
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [viewing, setViewing] = useState<Attachment | null>(null);

  const load = useCallback(async () => {
    if (!slug || !configured) {
      setLoading(false);
      return;
    }
    try {
      const [crew, list] = await Promise.all([api.listInterns(), api.listAttachments(slug, 500)]);
      setIntern(crew.find((c) => c.slug === slug) ?? null);
      setItems(list.filter((a) => a.message_id)); // unsent uploads are not "exchanged"
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, slug, configured]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const pictures = useMemo(() => items.filter((a) => a.kind === "image" || a.kind === "svg"), [items]);
  const files = useMemo(() => items.filter((a) => a.kind === "file"), [items]);
  const columns = width >= 900 ? 5 : width >= 600 ? 4 : 3;
  const tile = Math.floor((Math.min(width, 1100) - space.lg * 2 - space.sm * (columns - 1)) / columns);

  /** Files grouped by day so a long history stays scannable. */
  const fileGroups = useMemo(() => {
    const groups: { label: string; items: Attachment[] }[] = [];
    for (const a of files) {
      const label = dayLabel(a.created_at);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(a);
      else groups.push({ label, items: [a] });
    }
    return groups;
  }, [files]);

  const title = intern ? `Files with ${intern.name}` : "Files";
  const total = items.length;
  const bytes = items.reduce((acc, a) => acc + a.size, 0);

  return (
    <Screen>
      <Stack.Screen options={{ title }} />
      {!configured ? (
        <EmptyState title="Not connected" body="Add your API token in Settings › Connection." />
      ) : !ready || loading ? (
        <Loading />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxl }]}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.textDim}
              onRefresh={() => {
                setRefreshing(true);
                void load();
              }}
            />
          }
        >
          {error ? <ErrorNote error={error} onRetry={() => void load()} style={styles.inlineError} /> : null}
          <View style={styles.summaryRow}>
            <Text variant="subtle">
              {total === 0 ? "Nothing exchanged yet" : `${total} item${total === 1 ? "" : "s"} · ${formatBytes(bytes)}`}
            </Text>
            <View style={styles.segments}>
              {(["all", "pictures", "files"] as Filter[]).map((f) => (
                <Pressable
                  key={f}
                  onPress={() => setFilter(f)}
                  accessibilityRole="button"
                  accessibilityState={{ selected: filter === f }}
                  style={[styles.segment, { backgroundColor: filter === f ? colors.surfaceAlt : "transparent", borderColor: colors.border }]}
                >
                  <Text variant="caption" color={filter === f ? colors.text : colors.textDim}>
                    {f === "all" ? "All" : f === "pictures" ? `Pictures ${pictures.length}` : `Files ${files.length}`}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          {total === 0 ? (
            <EmptyState
              title={`No files with ${intern?.name ?? slug} yet`}
              body="Anything you attach in the thread, or the intern sends back, shows up here."
            />
          ) : null}

          {filter !== "files" && pictures.length ? (
            <View style={styles.section}>
              {filter === "all" ? <Text variant="label" style={styles.sectionLabel}>Pictures</Text> : null}
              <View style={styles.grid}>
                {pictures.map((a) => (
                  <Pressable
                    key={a.id}
                    onPress={() => setViewing(a)}
                    accessibilityRole="imagebutton"
                    accessibilityLabel={a.caption ?? a.name}
                    style={({ pressed }) => [styles.tile, { width: tile, height: tile, backgroundColor: colors.surfaceAlt, borderColor: colors.border, opacity: pressed ? 0.85 : 1 }]}
                  >
                    <Image source={{ uri: api.attachmentUrl(a) }} style={{ width: tile, height: tile }} resizeMode="cover" accessibilityLabel={a.name} />
                    {/* Top corner, small: pictures often carry their own caption along the bottom edge. */}
                    <View style={[styles.tileTag, { backgroundColor: colors.overlay }]}>
                      <Text variant="caption" color="#fafafa" numberOfLines={1} style={styles.tileTagText}>
                        {a.author === "jp" ? "you" : intern?.name ?? a.author}
                      </Text>
                    </View>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          {filter !== "pictures" && files.length ? (
            <View style={styles.section}>
              {filter === "all" ? <Text variant="label" style={styles.sectionLabel}>Files</Text> : null}
              {fileGroups.map((group) => (
                <View key={group.label} style={styles.group}>
                  <Text variant="caption" style={styles.groupLabel}>
                    {group.label}
                  </Text>
                  {group.items.map((a) => (
                    // Open and Download are siblings: nested, they'd be a <button> inside a <button> on web.
                    <View key={a.id} style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                      <Pressable
                        onPress={() => setViewing(a)}
                        accessibilityRole="button"
                        accessibilityLabel={`Open ${a.name}`}
                        style={({ pressed }) => [styles.rowOpen, { opacity: pressed ? 0.8 : 1 }]}
                      >
                        <View style={[styles.rowIcon, { backgroundColor: colors.surfaceAlt }]}>
                          <FileIcon size={18} color={colors.textDim} />
                        </View>
                        <View style={styles.rowText}>
                          <Text variant="subtle" color={colors.text} numberOfLines={1}>
                            {a.name}
                          </Text>
                          <Text variant="caption" numberOfLines={1}>
                            {formatBytes(a.size)} · {a.author === "jp" ? "you" : intern?.name ?? a.author}
                            {a.caption ? ` · ${a.caption}` : ""}
                          </Text>
                        </View>
                      </Pressable>
                      <Pressable
                        onPress={() => void openExternal(api.attachmentUrl(a, true), a.name)}
                        accessibilityRole="button"
                        accessibilityLabel={`Download ${a.name}`}
                        hitSlop={8}
                        style={styles.rowAction}
                      >
                        <DownloadIcon size={18} color={colors.textDim} />
                      </Pressable>
                    </View>
                  ))}
                </View>
              ))}
            </View>
          ) : null}
        </ScrollView>
      )}
      <AttachmentViewer attachment={viewing} api={api} onClose={() => setViewing(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.lg, maxWidth: 1100, width: "100%", alignSelf: "center" },
  summaryRow: { gap: space.sm },
  segments: { flexDirection: "row", gap: space.sm },
  segment: { paddingHorizontal: space.md, paddingVertical: 6, borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth },
  section: { gap: space.sm },
  sectionLabel: { marginBottom: space.xs },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  tile: { borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  tileTag: { position: "absolute", left: space.xs, top: space.xs, maxWidth: "80%", borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 },
  tileTagText: { fontWeight: "600" },
  inlineError: { marginHorizontal: 0, marginBottom: 0 },
  group: { gap: space.sm, marginBottom: space.sm },
  groupLabel: { marginTop: space.xs },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.sm, paddingRight: space.xs },
  rowOpen: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm },
  rowIcon: { width: 40, height: 40, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  rowText: { flex: 1, gap: 1 },
  rowAction: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
});
