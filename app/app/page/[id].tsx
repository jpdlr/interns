/**
 * A page full screen (docs/features/02-pages.md): people, a board, a table,
 * a list (the Ideas page is one) or an email draft. Opened from a page
 * preview in a chat, a pinned chip, Today's follow-ups, or the intern's file.
 *
 * Opening it marks the current version seen, which clears "N changes since
 * you looked" on every preview of it. Requests about the page go to its
 * owner's chat as ordinary messages; a toast offers to jump there.
 */
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import type { ListItem } from "../../src/api";
import { useCrew } from "../../src/crew";
import { haptic } from "../../src/haptics";
import { markPageSeen } from "../../src/pageSeen";
import { useSettings } from "../../src/settings";
import { radius, space, useAppTheme } from "../../src/theme";
import { relativeTime } from "../../src/time";
import { PAGE_KIND_LABEL, usePage } from "../../src/usePage";
import { PageKindIcon } from "../../src/ui/Fences";
import { ChatIcon, PinIcon } from "../../src/ui/Icons";
import { BoardView, DraftView, ListView, OwnerLine, pageMessage, PeopleView, TableView } from "../../src/ui/pages/PageViews";
import { EmptyState, ErrorNote, Loading, Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

export default function PageScreen() {
  const { id, item } = useLocalSearchParams<{ id: string; item?: string }>();
  const router = useRouter();
  const { colors } = useAppTheme();
  const { api, ready, configured } = useSettings();
  const { page, error, reload } = usePage(id);
  const crew = useCrew();
  const [toast, setToast] = useState<{ text: string; thread?: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (page) void markPageSeen(page.id, page.version);
  }, [page?.id, page?.version]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3_500);
    return () => clearTimeout(timer);
  }, [toast]);

  /** The owner's thread: the coordinator's pages live at the front desk. */
  const ownerThread = page ? page.intern : "";

  const ask = useCallback(
    async (instruction: string, item?: { id: string; label: string }) => {
      if (!page) return;
      await api.sendMessage(ownerThread, pageMessage(page, instruction, item));
      haptic("tap");
      setToast({ text: `Sent to ${ownerThread === "coordinator" ? "the front desk" : (crew.bySlug[ownerThread]?.name ?? "the owner")}`, thread: ownerThread });
    },
    [api, crew.bySlug, ownerThread, page],
  );

  const toggle = useCallback(
    async (item: ListItem) => {
      if (!page) return;
      await api.patchPageItem(page.id, item.id, { done: !item.done });
      haptic(item.done ? "tap" : "success");
      reload();
    },
    [api, page, reload],
  );

  const remove = useCallback(
    async (item: ListItem) => {
      if (!page) return;
      await api.removePageItem(page.id, item.id);
      reload();
    },
    [api, page, reload],
  );

  const delegate = useCallback(
    async (item: ListItem, slug: string) => {
      await api.sendMessage(slug, `From my ideas: ${item.text}\n\nCan you take this on? Tell me how you'd approach it.`);
      haptic("success");
      setToast({ text: "Handed over", thread: slug });
    },
    [api],
  );

  const discuss = useCallback(
    async (item: ListItem) => {
      await api.sendMessage("coordinator", `Let's think this idea through: ${item.text}`);
      router.push("/chat/coordinator" as never);
    },
    [api, router],
  );

  const togglePin = useCallback(async () => {
    if (!page) return;
    await api.pinPage(page.id, !page.pinned);
    haptic("tap");
    reload();
  }, [api, page, reload]);

  if (!ready) return <Loading />;

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: page?.title ?? "",
          headerRight: () =>
            page ? (
              <View style={styles.headerActions}>
                <Pressable onPress={() => void togglePin()} accessibilityRole="button" accessibilityLabel={page.pinned ? "Unpin from the chat" : "Pin in the chat"} hitSlop={8} style={styles.headerButton}>
                  <PinIcon size={20} color={page.pinned ? colors.text : colors.textFaint} />
                </Pressable>
                <Pressable onPress={() => router.push(`/chat/${ownerThread}` as never)} accessibilityRole="button" accessibilityLabel="Open the chat" hitSlop={8} style={styles.headerButton}>
                  <ChatIcon size={20} color={colors.textDim} />
                </Pressable>
              </View>
            ) : null,
        }}
      />
      {!configured ? (
        <EmptyState title="Not connected" body="Add your API token in Settings › Connection." />
      ) : !page ? (
        error ? <ErrorNote error={/404/.test(error) ? "This page no longer exists — it may have been archived." : error} onRetry={reload} /> : <Loading />
      ) : (
        <ScrollView
          contentContainerStyle={styles.body}
          refreshControl={<RefreshControl refreshing={refreshing} tintColor={colors.textDim} onRefresh={() => { setRefreshing(true); reload(); setTimeout(() => setRefreshing(false), 600); }} />}
        >
          <View style={styles.head}>
            <View style={[styles.kindIcon, { backgroundColor: colors.surfaceAlt }]}>
              <PageKindIcon kind={page.kind} size={20} color={colors.text} />
            </View>
            <View style={styles.headText}>
              <Text variant="caption">{`${PAGE_KIND_LABEL[page.kind] ?? "Page"} · updated ${relativeTime(page.updated_at)}`}</Text>
              {page.summary ? <Text variant="subtle" color={colors.text}>{page.summary}</Text> : null}
              <OwnerLine slug={page.intern} />
            </View>
          </View>
          {page.archived_at ? <Text variant="caption" color={colors.action}>This page was archived — it no longer updates.</Text> : null}
          {page.kind === "people" ? (
            <PeopleView page={page} ask={ask} focusItem={item} />
          ) : page.kind === "board" ? (
            <BoardView page={page} ask={ask} focusItem={item} />
          ) : page.kind === "table" ? (
            <TableView page={page} ask={ask} focusItem={item} />
          ) : page.kind === "draft" ? (
            <DraftView page={page} ask={ask} />
          ) : (
            <ListView page={page} ask={ask} onToggle={toggle} onRemove={remove} onDelegate={delegate} onDiscuss={discuss} focusItem={item} />
          )}
        </ScrollView>
      )}
      {toast ? (
        <Pressable
          onPress={() => toast.thread && router.push(`/chat/${toast.thread}` as never)}
          accessibilityRole="button"
          style={[styles.toast, { backgroundColor: colors.accent }]}
        >
          <Text variant="caption" color={colors.onAccent} style={styles.bold}>
            {toast.text}
            {toast.thread ? " · Open chat" : ""}
          </Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  bold: { fontWeight: "600" },
  body: { padding: space.lg, gap: space.lg, paddingBottom: space.xxxl },
  head: { flexDirection: "row", gap: space.md, alignItems: "flex-start" },
  kindIcon: { width: 44, height: 44, borderRadius: radius.lg, alignItems: "center", justifyContent: "center" },
  headText: { flex: 1, gap: 4 },
  headerActions: { flexDirection: "row" },
  headerButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  toast: { position: "absolute", bottom: space.xxl, alignSelf: "center", borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm },
});
