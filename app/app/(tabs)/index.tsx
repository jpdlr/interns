/**
 * Crew — the chat list. One row per intern with its animated face, role,
 * last-message preview and unread dot. The Chaos Coordinator is pinned on
 * top: its chat is the front desk — ask anything and it routes the question
 * to the right intern, and "idea: …" lands on the Ideas page.
 */
import { useFocusEffect, useIsFocused, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import type { Card, Intern, Message, PageSearchHit, RoomListEntry } from "../../src/api";
import { useLive, useLiveEvents, useRefreshSignal } from "../../src/live";
import { useReducedMotion } from "../../src/motion";
import { useSettings } from "../../src/settings";
import { radius, scaledFont, space, useAppTheme } from "../../src/theme";
import { relativeTime } from "../../src/time";
import { isUnread, loadSeen, type SeenMap } from "../../src/unread";
import { ConnectionPill } from "../../src/ui/ConnectionPill";
import { FaceStack } from "../../src/ui/FaceStack";
import { OfficeStrip } from "../../src/ui/OfficeStrip";
import { PlusIcon, SearchIcon, UsersIcon, XIcon } from "../../src/ui/Icons";
import { InternFace, resolveFaceId } from "../../src/ui/InternFace";
import { cleanMessagePreview } from "../../src/ui/Markdown";
import { PageKindIcon } from "../../src/ui/Fences";
import { Button } from "../../src/ui/Button";
import { EmptyState, ErrorNote, Loading, Screen, ScreenTitle } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";
import { TypingAvatar, TypingDots } from "../../src/ui/ThinkingIndicator";

interface Row {
  slug: string;
  name: string;
  role: string;
  faceId: string;
  /** group chats: member faces, stacked */
  faceIds?: string[];
  preview: string;
  ts?: string;
  unread: boolean;
  pinned?: boolean;
  href: string;
  /** a status note beside the preview, e.g. "3 queued" */
  badge?: string;
  /** things waiting on JP: drawn like an unread marker, with the number */
  count?: number;
  busy?: boolean;
  hasActivity?: boolean;
  isTyping?: boolean;
  /** quiet for days: the face dozes */
  away?: boolean;
}

type SearchResult =
  | { key: string; type: "intern"; title: string; detail: string; intern: Intern }
  | { key: string; type: "message"; title: string; detail: string; message: Message; intern?: Intern }
  | { key: string; type: "card"; title: string; detail: string; card: Card; intern?: Intern }
  | { key: string; type: "repository"; title: string; detail: string; repository: string }
  | { key: string; type: "page"; title: string; detail: string; hit: PageSearchHit; intern?: Intern };

/** 40pt buttons plus hitSlop clear the 44pt touch target without crowding the title. */
const HEADER_ICON_SIZE = 40;
const EXPANDED_SEARCH_HEIGHT = 40;

export default function CrewScreen() {
  const { colors, fontScale } = useAppTheme();
  const { width } = useWindowDimensions();
  const { api, ready, configured } = useSettings();

  const { status: streamStatus } = useLive();
  const refreshSignal = useRefreshSignal();
  const focused = useIsFocused();
  const router = useRouter();

  // First run: no token yet, or a fresh orchestrator with nobody hired.
  // An older orchestrator without /owner just keeps the Crew tab.
  useEffect(() => {
    if (!ready) return;
    if (!configured) {
      router.replace("/setup" as never);
      return;
    }
    let cancelled = false;
    api
      .owner()
      .then((owner) => !cancelled && !owner.setup_complete && router.replace("/setup" as never))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, configured, ready, router]);
  const { archived } = useLocalSearchParams<{ archived?: string }>();

  const [interns, setInterns] = useState<Intern[]>([]);
  const [archivedBanner, setArchivedBanner] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, Message | undefined>>({});
  const [rooms, setRooms] = useState<RoomListEntry[]>([]);
  const [seen, setSeen] = useState<SeenMap>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchMessages, setSearchMessages] = useState<Message[]>([]);
  const [searchCards, setSearchCards] = useState<Card[]>([]);
  const [repositories, setRepositories] = useState<string[]>([]);
  /** people, cards and rows on pages — searched server-side as you type */
  const [pageHits, setPageHits] = useState<PageSearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchProgress = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotion();
  const searchInput = useRef<TextInput>(null);

  /**
   * `withTails` pulls each thread's history for its last-message preview.
   * Needed on first paint and on return to this screen; while the stream is
   * live, message events keep previews current, so a stream-triggered
   * refresh skips the per-intern history fetches entirely.
   */
  const load = useCallback(async (withTails = true) => {
    if (!configured) {
      setLoading(false);
      return;
    }
    try {
      const [crew, roomList] = await Promise.all([api.listInterns(), api.listRooms().catch(() => [] as RoomListEntry[])]);
      setInterns(crew);
      setRooms(roomList);
      setError(null);
      if (!withTails) return;
      // The list endpoint carries no preview, so pull each thread's tail.
      const tails = await Promise.all(
        [...crew, { slug: "coordinator" }].map(async (intern) => {
          try {
            const messages = await api.listMessages(intern.slug);
            return [intern.slug, messages[messages.length - 1]] as const;
          } catch {
            return [intern.slug, undefined] as const;
          }
        }),
      );
      setPreviews(Object.fromEntries(tails));
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [api, configured]);

  // Stream-driven refreshes only while this tab is on screen; focus reloads anyway.
  const lastSignal = useRef(refreshSignal);
  useEffect(() => {
    if (!focused || lastSignal.current === refreshSignal) return;
    lastSignal.current = refreshSignal;
    void load(streamStatus !== "live");
  }, [focused, refreshSignal, load, streamStatus]);

  useFocusEffect(
    useCallback(() => {
      void loadSeen().then(setSeen);
      // Coming back from Settings after an archive (or anything else that
      // changed the crew server-side) should never show a stale list — the
      // live stream's `revision` bump does not fire for this, since the app
      // navigated here itself rather than hearing about it over /events.
      void load();
    }, [load]),
  );

  // The archive confirm carries the fired intern's name back as a route
  // param rather than local state, so the banner survives the navigation
  // from /intern/[slug]. Shown once per value (a ref, not state, so it
  // doesn't itself trigger a re-render loop) and auto-dismissed.
  const shownArchived = useRef<string | null>(null);
  useEffect(() => {
    if (!archived || shownArchived.current === archived) return;
    shownArchived.current = archived;
    setArchivedBanner(archived);
    const timer = setTimeout(() => setArchivedBanner(null), 4000);
    return () => clearTimeout(timer);
  }, [archived]);

  useLiveEvents((event) => {
    if (event.type === "message" && event.data) {
      const message = event.data as Message;
      setPreviews((current) => ({ ...current, [message.intern]: message }));
    }
  });

  const loadSearchIndex = useCallback(async () => {
    if (!configured || searchLoading) return;
    setSearchLoading(true);
    try {
      const [allCards, repos, threads] = await Promise.all([
        api.listCards(),
        api.listGithubRepositories().catch(() => []),
        Promise.all(interns.map((intern) => api.listMessages(intern.slug).catch(() => []))),
      ]);
      setSearchCards(allCards);
      setRepositories(repos);
      setSearchMessages(threads.flat());
    } catch (e) {
      setError(e);
    } finally {
      setSearchLoading(false);
    }
  }, [api, configured, interns, searchLoading]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // The input is always mounted inside the collapsed icon, so this remains
    // inside the user's tap gesture and iOS opens the keyboard immediately.
    searchInput.current?.focus();
    Animated.timing(searchProgress, {
      toValue: 1,
      duration: reducedMotion ? 0 : 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
    void loadSearchIndex();
  }, [loadSearchIndex, reducedMotion, searchProgress]);

  const closeSearch = useCallback(() => {
    setQuery("");
    searchInput.current?.blur();
    Animated.timing(searchProgress, {
      toValue: 0,
      duration: reducedMotion ? 0 : 210,
      easing: Easing.inOut(Easing.quad),
      useNativeDriver: false,
    }).start(() => setSearchOpen(false));
  }, [reducedMotion, searchProgress]);

  const rows = useMemo<Row[]>(() => {
    const desk = previews.coordinator;
    const deskSpeaker = desk?.author === "jp" ? "You: " : desk?.author === "intern" && desk.speaker ? `${interns.find((i) => i.slug === desk.speaker)?.name ?? desk.speaker}: ` : "";
    const coordinator: Row = {
      slug: "coordinator",
      name: "Chaos Coordinator",
      role: "Front desk",
      faceId: "coordinator",
      preview: desk
        ? `${deskSpeaker}${desk.text.trim() ? cleanMessagePreview(desk.text) : desk.attachments?.length ? `📎 ${desk.attachments[0]!.name}` : ""}`
        : "Ask anything — I'll find the right intern. Start with “idea:” to save an idea.",
      ts: desk?.ts,
      unread: isUnread(seen, "coordinator", desk?.ts, desk?.author),
      pinned: true,
      href: "/chat/coordinator",
    };
    const crew = interns
      .map<Row>((intern) => {
        const last = previews[intern.slug];
        return {
          slug: intern.slug,
          name: intern.name,
          role: intern.on_pause ? `Paused · ${intern.role}` : intern.role,
          faceId: resolveFaceId(intern.icon, intern.slug),
          preview: intern.activity?.label ?? (last
            ? `${last.author === "jp" ? "You: " : ""}${last.text.trim() ? cleanMessagePreview(last.text) : last.attachments?.length ? `📎 ${last.attachments[0]!.name}` : ""}`
            : "No messages yet — say hello."),
          ts: intern.activity?.started_at ?? last?.ts,
          unread: isUnread(seen, intern.slug, last?.ts, last?.author),
          href: `/chat/${intern.slug}`,
          badge: intern.queued > 1 ? `${intern.queued} queued` : undefined,
          busy: intern.running > 0,
          hasActivity: Boolean(intern.activity),
          isTyping: intern.activity?.kind === "message" && intern.activity.status === "running",
          away: intern.on_pause || (!intern.running && Boolean(last) && Date.now() - Date.parse(last!.ts) > 3 * 86_400_000),
        };
      })
      .sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
    const byIntern = Object.fromEntries(interns.map((i) => [i.slug, i]));
    const groups = rooms.map<Row>((room) => {
      const last = previews[room.id] ?? room.last_message ?? undefined;
      const speaker = last?.author === "jp" ? "You" : last?.author === "coordinator" ? "Coordinator" : last?.speaker ? (byIntern[last.speaker]?.name ?? last.speaker) : undefined;
      const replying = interns.filter((i) => room.members.includes(i.slug) && i.activity?.status === "running" && i.activity.label.includes(room.name));
      return {
        slug: room.id,
        name: room.name,
        role: room.members.map((m) => byIntern[m]?.name ?? m).join(", "),
        faceId: resolveFaceId(byIntern[room.members[0] ?? ""]?.icon, room.members[0] ?? room.id),
        faceIds: room.members.map((m) => resolveFaceId(byIntern[m]?.icon, m)),
        preview: replying.length
          ? `${replying.map((i) => i.name).join(", ")} replying…`
          : last
            ? `${speaker ? `${speaker}: ` : ""}${last.text.trim() ? cleanMessagePreview(last.text) : last.attachments?.length ? `📎 ${last.attachments[0]!.name}` : ""}`
            : "New group — say something.",
        ts: last?.ts ?? room.updated_at,
        unread: isUnread(seen, room.id, last?.ts, last?.author),
        href: `/chat/${room.id}`,
        busy: replying.length > 0,
      };
    });
    return [coordinator, ...[...crew, ...groups].sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""))];
  }, [interns, previews, seen, rooms]);

  const byIntern = useMemo(
    () => Object.fromEntries(interns.map((intern) => [intern.slug, intern])),
    [interns],
  );

  // Pages can hold hundreds of people/rows, so they are searched on the server, debounced.
  useEffect(() => {
    const q = query.trim();
    if (!configured || !q) {
      setPageHits([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      api.searchPages(q).then((hits) => active && setPageHits(hits)).catch(() => active && setPageHits([]));
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, configured, query]);

  const searchResults = useMemo<SearchResult[]>(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [];
    const has = (...values: unknown[]) => values.some((value) => String(value ?? "").toLocaleLowerCase().includes(needle));
    const crewResults: SearchResult[] = interns
      .filter((intern) => has(intern.name, intern.slug, intern.role, intern.activity?.label, previews[intern.slug]?.text))
      .map((intern) => ({
        key: `intern-${intern.slug}`,
        type: "intern",
        title: intern.name,
        detail: intern.activity?.label ?? intern.role,
        intern,
      }));
    if (has("Chaos Coordinator", "Orchestrator", "Front desk", "coordinator")) {
      crewResults.unshift({
        key: "intern-coordinator",
        type: "intern",
        title: "Chaos Coordinator",
        detail: "Front desk",
        intern: {
          slug: "coordinator", name: "Chaos Coordinator", role: "Orchestrator", icon: "coordinator",
          session_id: null, queued: 0, running: 0, paused: 0, activity: null, spend_today: 0, cost_today_usd: 0,
        },
      });
    }
    const messageResults: SearchResult[] = searchMessages
      .filter((message) => has(message.text, message.intern, byIntern[message.intern]?.name))
      .slice(-40)
      .reverse()
      .map((message) => ({
        key: `message-${message.id}`,
        type: "message",
        title: byIntern[message.intern]?.name ?? message.intern,
        detail: cleanMessagePreview(message.text),
        message,
        intern: byIntern[message.intern],
      }));
    const cardResults: SearchResult[] = searchCards
      .filter((card) => has(card.title, card.body, card.intern, card.context?.repository, card.context?.pull_number))
      .map((card) => ({
        key: `card-${card.id}`,
        type: "card",
        title: card.title,
        detail: `${card.state} · ${String(card.context?.repository ?? byIntern[card.intern]?.name ?? card.intern)}`,
        card,
        intern: byIntern[card.intern],
      }));
    const repoResults: SearchResult[] = repositories
      .filter((repository) => has(repository))
      .map((repository) => ({ key: `repo-${repository}`, type: "repository", title: repository, detail: "GitHub repository", repository }));
    const pageResults: SearchResult[] = pageHits.map((hit) => ({
      key: `page-${hit.page_id}-${hit.item_id ?? "page"}`,
      type: "page",
      title: hit.label,
      detail: [hit.item_id ? hit.page_title : null, hit.detail].filter(Boolean).join(" · "),
      hit,
      intern: byIntern[hit.intern],
    }));
    // People and items on pages come straight after the crew: "Kettle Labs" should surface Danny first.
    return [...crewResults, ...pageResults, ...cardResults, ...messageResults, ...repoResults].slice(0, 100);
  }, [query, interns, previews, searchMessages, searchCards, repositories, byIntern, pageHits]);

  const openResult = useCallback((result: SearchResult) => {
    if (result.type === "intern") {
      router.push(`/chat/${result.intern.slug}` as never);
    } else if (result.type === "message") {
      router.push(`/chat/${result.message.intern}?message=${encodeURIComponent(result.message.id)}` as never);
    } else if (result.type === "page") {
      router.push(`/page/${result.hit.page_id}${result.hit.item_id ? `?item=${encodeURIComponent(result.hit.item_id)}` : ""}` as never);
    } else if (result.type === "card") {
      // Open cards live on Today; resolved ones in History.
      router.push(`${result.card.state === "open" ? "/today" : "/history"}?card=${encodeURIComponent(result.card.id)}` as never);
    } else {
      void Linking.openURL(`https://github.com/${result.repository}`);
    }
    closeSearch();
  }, [closeSearch, router]);

  if (!ready) return <Loading />;

  const expandedSearchWidth = Math.max(HEADER_ICON_SIZE, width - space.xl * 2);
  const searchWidth = searchProgress.interpolate({ inputRange: [0, 1], outputRange: [HEADER_ICON_SIZE, expandedSearchWidth] });
  const searchHeight = searchProgress.interpolate({ inputRange: [0, 1], outputRange: [HEADER_ICON_SIZE, EXPANDED_SEARCH_HEIGHT] });
  const searchTop = searchProgress.interpolate({ inputRange: [0, 1], outputRange: [space.lg - 3, space.lg - 3] });
  // Collapsed, the bubble sits over the spacer: page gutter + the hire button + one gap.
  const searchRight = searchProgress.interpolate({ inputRange: [0, 1], outputRange: [space.xl + HEADER_ICON_SIZE + space.sm, space.xl] });
  const normalOpacity = searchProgress.interpolate({ inputRange: [0, 0.35, 1], outputRange: [1, 0, 0] });
  const fieldOpacity = searchProgress.interpolate({ inputRange: [0, 0.45, 1], outputRange: [0, 0, 1] });
  const hasQuery = query.trim().length > 0;

  return (
    <Screen>
      <View style={styles.headerRow}>
        <Animated.View style={{ opacity: normalOpacity }} pointerEvents={searchOpen ? "none" : "auto"}>
          <ScreenTitle title="Crew" />
        </Animated.View>
        <Animated.View
          style={[styles.headerActions, { opacity: normalOpacity }]}
          pointerEvents={searchOpen ? "none" : "auto"}
        >
          <ConnectionPill />
          {configured ? (
            <>
              {/* The collapsed search bubble is absolutely positioned over the spacer, so this button must sit before it. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="New group chat"
                onPress={() => router.push("/group/new" as never)}
                hitSlop={4}
                style={({ pressed }) => [
                  styles.hireButton,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  pressed && styles.hireButtonPressed,
                ]}
              >
                <UsersIcon size={19} color={colors.textDim} />
              </Pressable>
              <View style={styles.searchSpacer} />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Hire an intern"
                onPress={() => router.push("/hire" as never)}
                hitSlop={4}
                style={({ pressed }) => [
                  styles.hireButton,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  pressed && styles.hireButtonPressed,
                ]}
              >
                <PlusIcon size={19} color={colors.textDim} />
              </Pressable>
            </>
          ) : null}
        </Animated.View>

        {configured ? (
        <Animated.View
          style={[
            styles.searchBar,
            {
              width: searchWidth,
              height: searchHeight,
              top: searchTop,
              right: searchRight,
              borderRadius: radius.pill,
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={searchOpen ? "Focus search" : "Search everything"}
            onPress={searchOpen ? () => searchInput.current?.focus() : openSearch}
            style={styles.searchGlyph}
          >
            <SearchIcon size={18} color={colors.textDim} />
          </Pressable>
          <Animated.View style={[styles.searchField, { opacity: fieldOpacity }]} pointerEvents={searchOpen ? "auto" : "none"}>
            <TextInput
              ref={searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search everything…"
              placeholderTextColor={colors.textFaint}
              autoCorrect={false}
              returnKeyType="search"
              onKeyPress={(event) => { if (event.nativeEvent.key === "Escape") closeSearch(); }}
              style={[styles.searchInput, { color: colors.text, fontSize: scaledFont(16, fontScale) }]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close search"
              onPress={closeSearch}
              hitSlop={8}
              style={styles.searchClose}
            >
              <XIcon size={17} color={colors.textDim} />
            </Pressable>
          </Animated.View>
        </Animated.View>
        ) : null}
      </View>

      {archivedBanner && !hasQuery ? (
        <View style={[styles.archivedBanner, { backgroundColor: colors.successSoft, borderColor: colors.success }]}>
          <Text variant="subtle" color={colors.success}>
            {archivedBanner} archived
          </Text>
        </View>
      ) : null}

      {error ? <ErrorNote error={error} onRetry={() => void load()} onDismiss={() => setError(null)} /> : null}

      {!configured ? (
        <EmptyState
          title="Meet your crew"
          body="Paste the API token from your orchestrator to connect this device."
        >
          <Button label="Connect" tone="primary" onPress={() => router.push("/settings?tab=connect" as never)} />
        </EmptyState>
      ) : loading ? (
        <Loading label="Waking the crew…" />
      ) : hasQuery ? (
        <FlatList
          data={searchResults}
          keyExtractor={(result) => result.key}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={styles.searchResults}
          ListEmptyComponent={
            <EmptyState
              title={searchLoading ? "Searching…" : "No results"}
              body={searchLoading ? undefined : `Nothing matches “${query.trim()}”.`}
            />
          }
          renderItem={({ item }) => <SearchResultRow result={item} onPress={() => openResult(item)} />}
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row) => row.slug}
          ListHeaderComponent={
            <OfficeStrip
              interns={interns}
              rooms={rooms}
              lastSeen={Object.fromEntries(Object.entries(previews).map(([k, v]) => [k, v?.ts]))}
            />
          }
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.textDim}
              onRefresh={() => {
                setRefreshing(true);
                void load(true);
              }}
            />
          }
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <EmptyState title="No interns yet" body="Describe the help you need and the Coordinator drafts someone for you.">
              <Button label="Hire an intern" tone="primary" onPress={() => router.push("/hire" as never)} />
            </EmptyState>
          }
          renderItem={({ item }) => <CrewRow row={item} onPress={() => router.push(item.href as never)} />}
        />
      )}
    </Screen>
  );
}

function CrewRow({ row, onPress }: { row: Row; onPress: () => void }) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[
        row.name,
        row.count ? `${row.count} waiting` : null,
        row.unread ? "unread" : null,
        row.isTyping ? "typing" : row.preview,
      ].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceAlt }]}
    >
      {row.faceIds ? (
        <FaceStack faceIds={row.faceIds} size={48} />
      ) : row.isTyping ? (
        <TypingAvatar faceId={row.faceId} name={row.name} size={48} />
      ) : (
        <InternFace id={row.faceId} size={48} clipToBounds mood={row.busy ? "thinking" : row.away ? "away" : "idle"} />
      )}
      <View style={styles.rowBody}>
        <View style={styles.rowTop}>
          <Text variant="title" numberOfLines={1} style={styles.name}>
            {row.name}
          </Text>
          {row.ts ? <Text variant="caption">{relativeTime(row.ts)}</Text> : null}
        </View>
        <Text variant="caption" numberOfLines={1} style={styles.role}>
          {row.role}
        </Text>
        <View style={styles.rowBottom}>
          {row.isTyping ? (
            <View style={styles.preview}>
              <TypingDots label={`${row.name} is typing`} />
            </View>
          ) : (
            <Text
              variant="subtle"
              numberOfLines={1}
              color={row.unread || row.count ? colors.text : colors.textDim}
              style={[styles.preview, row.unread ? styles.previewUnread : null]}
            >
              {row.preview}
            </Text>
          )}
          {row.badge ? (
            <View style={[styles.badge, { backgroundColor: colors.accentSoft }]}>
              <Text variant="caption" color={colors.accent}>
                {row.badge}
              </Text>
            </View>
          ) : null}
          {row.count ? (
            <View style={[styles.count, { backgroundColor: colors.accent }]}>
              <Text variant="caption" color={colors.onAccent} style={styles.countLabel}>
                {row.count > 99 ? "99+" : row.count}
              </Text>
            </View>
          ) : row.unread ? (
            <View style={[styles.dot, { backgroundColor: colors.accent }]} />
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

function SearchResultRow({ result, onPress }: { result: SearchResult; onPress: () => void }) {
  const { colors } = useAppTheme();
  const intern = result.type === "intern"
    ? result.intern
    : result.type === "message" || result.type === "card"
      ? result.intern
      : undefined;
  const faceId = result.type === "repository" || result.type === "page"
    ? null
    : result.type === "card" && result.card.intern === "coordinator"
      ? "coordinator"
      : intern?.slug === "coordinator"
        ? "coordinator"
        : resolveFaceId(intern?.icon, intern?.slug ?? "coordinator");
  const typeLabel = result.type === "message" ? relativeTime(result.message.ts) : result.type === "page" ? (result.hit.kind === "people" ? "person" : result.hit.item_id ? "page item" : "page") : result.type;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.searchResult, pressed && { backgroundColor: colors.surfaceAlt }]}
    >
      {faceId ? (
        <InternFace id={faceId} size={36} clipToBounds />
      ) : (
        <View style={[styles.repoMark, { backgroundColor: colors.surfaceAlt }]}>
          {result.type === "page" ? <PageKindIcon kind={result.hit.kind} size={18} color={colors.text} /> : <Text variant="caption">GH</Text>}
        </View>
      )}
      <View style={styles.searchResultBody}>
        <View style={styles.searchResultTop}>
          <Text variant="subtle" color={colors.text} numberOfLines={1} style={styles.searchResultTitle}>
            {result.title}
          </Text>
          <Text variant="caption">{typeLabel}</Text>
        </View>
        <Text variant="caption" numberOfLines={2}>{result.detail}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", position: "relative" },
  archivedBanner: {
    marginHorizontal: space.xl,
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingRight: space.xl,
    transform: [{ translateY: 1 }],
  },
  searchSpacer: { width: HEADER_ICON_SIZE, height: HEADER_ICON_SIZE },
  searchBar: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    zIndex: 5,
  },
  searchGlyph: { width: HEADER_ICON_SIZE, height: "100%", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  searchField: { flex: 1, height: "100%", flexDirection: "row", alignItems: "center" },
  searchInput: { flex: 1, height: "100%", fontSize: 16, paddingHorizontal: space.xs },
  searchClose: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  // Same quiet treatment as the connection pill — discoverable, not a beacon.
  hireButton: {
    width: HEADER_ICON_SIZE,
    height: HEADER_ICON_SIZE,
    borderRadius: radius.pill,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth,
  },
  hireButtonPressed: { opacity: 0.7 },
  // No safe-area inset here: the tab bar already covers the home indicator,
  // so paying it again just left a band of dead scroll under the last row.
  list: { paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xl },
  searchResults: { paddingHorizontal: space.md, paddingTop: space.sm, paddingBottom: space.xl },
  searchResult: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.md, borderRadius: radius.md },
  searchResultBody: { flex: 1, gap: 3 },
  searchResultTop: { flexDirection: "row", alignItems: "center", gap: space.sm },
  searchResultTitle: { flex: 1, fontWeight: "600" },
  repoMark: { width: 36, height: 36, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  separator: { height: space.xs },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingVertical: space.md,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
  },
  rowBody: { flex: 1, gap: 2 },
  rowTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  name: { flexShrink: 1 },
  role: {},
  rowBottom: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: 2 },
  preview: { flex: 1 },
  badge: {
    paddingHorizontal: space.sm,
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
  dot: { width: 10, height: 10, borderRadius: radius.pill },
  count: { minWidth: 20, height: 20, paddingHorizontal: 6, borderRadius: radius.pill, alignItems: "center", justifyContent: "center" },
  countLabel: { fontWeight: "700" },
  previewUnread: { fontWeight: "600" },
});
