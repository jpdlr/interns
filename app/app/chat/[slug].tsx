/**
 * A thread with one intern. Messages bubble by author (JP right, intern
 * left), sends are optimistic, and the live stream appends anything that
 * arrives while the screen is open — including replies that came in over
 * Discord, since both surfaces render the same backend state.
 *
 * Layout notes: plain flexbox in ordinary document flow — the list takes the
 * slack and the composer sits at the bottom of the screen. Nothing here reacts
 * to the keyboard; iOS moves the page itself when the composer takes focus.
 * The list content is bottom-aligned so a short thread hugs the composer
 * instead of stranding a gap above it.
 */
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Animated, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View, type LayoutChangeEvent } from "react-native";
import { haptic } from "../../src/haptics";
import { useReducedMotion } from "../../src/motion";
import { copyText, Markdown } from "../../src/ui/Markdown";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Attachment, Card, CardAction, Intern, Message, PageEvent, PageHeader, Room, TaskActivity, UploadableFile } from "../../src/api";
import { scaledFont } from "../../src/theme";
import { isRoomKey, mentionQueryAt, useCrew } from "../../src/crew";
import { clearDraft, loadDraft, saveDraft } from "../../src/drafts";
import { friendlyError } from "../../src/errors";
import { useLive, useLiveEvents, useRefreshSignal } from "../../src/live";
import { useSettings } from "../../src/settings";
import { radius, space, useAppTheme } from "../../src/theme";
import { clockTime, dayKey, dayLabel } from "../../src/time";
import { loadSeen, markSeen } from "../../src/unread";
import { AttachmentViewer, PendingAttachments, filesFromDataTransfer, pickFiles, type PendingUpload } from "../../src/ui/Attachments";
import { Bubble, DayDivider, useThreadIndent } from "../../src/ui/Bubble";
import { Button } from "../../src/ui/Button";
import { CardView } from "../../src/ui/CardView";
import { Composer } from "../../src/ui/Composer";
import { FaceStack } from "../../src/ui/FaceStack";
import { CheckIcon, ChevronDownIcon, EditIcon, GearIcon, PaperclipIcon, SearchIcon, UsersIcon, XIcon } from "../../src/ui/Icons";
import { cleanMessagePreview, stripMarkdown } from "../../src/ui/Markdown";
import { InternFace, resolveFaceId } from "../../src/ui/InternFace";
import { MessageProvider } from "../../src/ui/MessageContext";
import { extractPullRequestReferences, PullRequestPreviewCard } from "../../src/ui/PullRequestPreview";
import { extractResourceReferences, ResourceLinkPreviewCard } from "../../src/ui/ResourceLinkPreview";
import { QuickReplyChips, suggestQuickReplies } from "../../src/ui/QuickReplies";
import { EmptyState, ErrorNote, Loading, Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";
import { ThinkingIndicator } from "../../src/ui/ThinkingIndicator";
import { useCoordinatorName } from "../../src/owner";

interface Pending {
  message: Message;
  failed?: boolean;
}

/** After this long the thinking caption softens so a slow reply never reads as hung. */
const STILL_THINKING_AFTER_MS = 45_000;
/** Safety net: never leave the indicator up forever if a task dies silently. */
const GIVE_UP_AFTER_MS = 6 * 60_000;

export default function ChatScreen() {
  const { colors, fontScale } = useAppTheme();
  const { slug, message: targetMessageId } = useLocalSearchParams<{ slug: string; message?: string }>();
  const { api, ready, configured } = useSettings();
  const { status: streamStatus } = useLive();
  const refreshSignal = useRefreshSignal();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { width: windowWidth } = useWindowDimensions();
  /** quick replies and the typing row line up with the bubbles, past the face gutter */
  const quickReplyIndent = useThreadIndent();

  const [intern, setIntern] = useState<Intern | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [crewList, setCrewList] = useState<Intern[]>([]);
  const isRoom = isRoomKey(slug);
  /** the coordinator's chat: routes each message to one intern (docs/features/06) */
  const frontDesk = slug === "coordinator";
  const [ideaMode, setIdeaMode] = useState(false);
  /** pages pinned in this thread, shown beside pinned messages */
  const [pinnedPages, setPinnedPages] = useState<PageHeader[]>([]);
  const crew = useCrew();
  const coordinatorName = useCoordinatorName();
  const [messages, setMessages] = useState<Message[]>([]);
  const [cards, setCards] = useState<Card[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  /** the very first load failed: there is no thread to show, only the error */
  const [loadFailed, setLoadFailed] = useState(false);
  const loadedOnce = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  /** When JP's last message went out and we started waiting for a reply. */
  const [awaitingSince, setAwaitingSince] = useState<number | null>(null);
  const [tick, setTick] = useState(() => Date.now());
  const [unreadAnchorId, setUnreadAnchorId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [taskAction, setTaskAction] = useState<string | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  /** the task-controls sheet, opened by tapping the thinking avatar */
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  /** long-press message menu */
  const [menuFor, setMenuFor] = useState<Message | null>(null);
  const [forwardFor, setForwardFor] = useState<Message | null>(null);
  const [menuNote, setMenuNote] = useState<string | null>(null);
  /** in-thread search */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  /** the intern's face winces when its task fails, nods when it picks the message up */
  const [faceReaction, setFaceReaction] = useState<{ kind: "wince" | "nod" | "grin"; key: number } | null>(null);
  const [padOpen, setPadOpen] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  /** messages that arrived while JP was scrolled up, for the jump button */
  const [unseenCount, setUnseenCount] = useState(0);
  /** files staged in the composer, uploading or uploaded, not yet sent */
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [dragging, setDragging] = useState(false);
  /** the message JP is answering (rooms): shown above the composer, sent as reply_to */
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  /** measured y of every message row, for "jump to the quoted message" */
  const rowY = useRef(new Map<string, number>());
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);

  const scrollRef = useRef<ScrollView>(null);
  const hasAnchored = useRef(false);
  const openedTarget = useRef<string | null>(null);
  const unreadInitialized = useRef(false);
  const draftHydrated = useRef(false);
  const atBottom = useRef(true);
  /**
   * Until this time, keep pinning to the newest message whatever the scroll
   * events say. A send changes the composer height and the content height in
   * the same frame; without this the animated scroll lands short, the list
   * decides JP has scrolled away, and the reply then arrives off-screen.
   */
  const stickUntil = useRef(0);

  const scrollTargetId = targetMessageId ?? unreadAnchorId;

  useEffect(() => {
    openedTarget.current = null;
  }, [scrollTargetId]);

  useEffect(() => {
    unreadInitialized.current = false;
    loadedOnce.current = false;
    setLoadFailed(false);
    setUnreadAnchorId(null);
    hasAnchored.current = false;
    atBottom.current = true;
    setShowJumpToLatest(false);
    setUnseenCount(0);
    setUploads([]);
    setViewing(null);
    setReplyingTo(null);
    rowY.current.clear();
    setMenuFor(null);
    setForwardFor(null);
    setSearchOpen(false);
    setSearchQuery("");
    setPadOpen(false);
  }, [slug]);

  const pins = useMemo(() => messages.filter((m) => m.pinned), [messages]);

  const searchHits = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [] as string[];
    return messages.filter((m) => m.text.toLowerCase().includes(q)).map((m) => m.id);
  }, [messages, searchQuery]);
  useEffect(() => {
    setSearchIndex(0);
  }, [searchQuery]);
  useEffect(() => {
    const id = searchHits[searchIndex];
    if (id) setJumpTarget(id);
  }, [searchHits, searchIndex]);

  useEffect(() => {
    if (!jumpTarget) return;
    const y = rowY.current.get(jumpTarget);
    if (y !== undefined) scrollRef.current?.scrollTo({ y: Math.max(0, y - space.lg), animated: true });
    setHighlightedMessageId(jumpTarget);
    const timer = setTimeout(() => {
      setHighlightedMessageId(null);
      setJumpTarget(null);
    }, 1_800);
    return () => clearTimeout(timer);
  }, [jumpTarget]);

  /**
   * Stage files and start uploading each one immediately, so by the time JP
   * has typed a caption the bytes are usually already on the orchestrator.
   * Failures stay in the strip with a Retry; sending waits for the strip to
   * settle. The upload id is what POST /messages claims.
   */
  const startUpload = useCallback(
    (item: PendingUpload) => {
      if (!slug) return;
      setUploads((current) => current.map((u) => (u.key === item.key ? { ...u, progress: 0, error: undefined } : u)));
      void api
        .uploadAttachment(slug, item.file, {
          onProgress: (fraction) => setUploads((current) => current.map((u) => (u.key === item.key ? { ...u, progress: fraction } : u))),
        })
        .then((attachment) => setUploads((current) => current.map((u) => (u.key === item.key ? { ...u, progress: 1, attachment } : u))))
        .catch((e) => setUploads((current) => current.map((u) => (u.key === item.key ? { ...u, error: e instanceof Error ? e.message : String(e) } : u))));
    },
    [api, slug],
  );

  const addFiles = useCallback(
    (files: UploadableFile[]) => {
      if (files.length === 0) return;
      const items: PendingUpload[] = files.map((file) => ({ key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file, progress: 0 }));
      setUploads((current) => [...current, ...items].slice(0, 20));
      for (const item of items) startUpload(item);
    },
    [startUpload],
  );

  const attach = useCallback(async () => {
    if (Platform.OS !== "web") {
      Alert.alert("Attachments", "Attaching files works in the web app for now — open Interns from your Home Screen to send one.");
      return;
    }
    addFiles(await pickFiles({ multiple: true }));
  }, [addFiles]);

  // Web: dropping a file anywhere on the thread stages it, not just on the field.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    let depth = 0;
    const isFiles = (e: DragEvent) => Boolean(e.dataTransfer?.types.includes("Files"));
    const onEnter = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (isFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      depth = 0;
      setDragging(false);
      const files = filesFromDataTransfer(e.dataTransfer);
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    };
    document.addEventListener("dragenter", onEnter);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("dragover", onOver);
    document.addEventListener("drop", onDrop);
    return () => {
      document.removeEventListener("dragenter", onEnter);
      document.removeEventListener("dragleave", onLeave);
      document.removeEventListener("dragover", onOver);
      document.removeEventListener("drop", onDrop);
    };
  }, [addFiles]);

  useEffect(() => {
    if (!slug) return;
    let active = true;
    draftHydrated.current = false;
    setDraft("");
    void loadDraft(slug).then((saved) => {
      if (!active) return;
      setDraft(saved);
      draftHydrated.current = true;
    });
    return () => { active = false; };
  }, [slug]);

  useEffect(() => {
    if (!slug || !draftHydrated.current) return;
    const timer = setTimeout(() => void saveDraft(slug, draft), 250);
    return () => clearTimeout(timer);
  }, [slug, draft]);

  useEffect(() => {
    if (!targetMessageId) {
      setHighlightedMessageId(null);
      return;
    }
    setHighlightedMessageId(targetMessageId);
    const timer = setTimeout(() => setHighlightedMessageId(null), 1_800);
    return () => clearTimeout(timer);
  }, [targetMessageId]);

  const revealTarget = useCallback((messageId: string, event: LayoutChangeEvent) => {
    if (!scrollTargetId || messageId !== scrollTargetId || openedTarget.current === scrollTargetId) return;
    openedTarget.current = scrollTargetId;
    hasAnchored.current = true;
    const y = Math.max(0, event.nativeEvent.layout.y - space.lg);
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ y, animated: false }));
  }, [scrollTargetId]);

  const jumpToLatest = useCallback((animated = true) => {
    atBottom.current = true;
    setShowJumpToLatest(false);
    setUnseenCount(0);
    scrollRef.current?.scrollToEnd({ animated });
  }, []);

  /** Follow the bottom for a moment, through any layout churn (a send, a reply landing). */
  const stickToBottom = useCallback((ms = 1_200) => {
    stickUntil.current = Date.now() + ms;
    jumpToLatest(false);
  }, [jumpToLatest]);

  const faceId = useMemo(() => (frontDesk ? "coordinator" : resolveFaceId(intern?.icon, slug ?? "")), [frontDesk, intern?.icon, slug]);
  const memberFaces = useMemo(() => (room?.members ?? []).map((m) => crew.bySlug[m]?.faceId ?? resolveFaceId(undefined, m)), [room?.members, crew.bySlug]);
  const threadName = isRoom ? room?.name ?? "Group" : frontDesk ? coordinatorName : intern?.name ?? slug;
  /** Faces/names per speaker for group chats and handoffs. */
  const speakerOf = useCallback(
    (message: Message) => {
      const who = message.author === "coordinator" ? "coordinator" : message.speaker ?? message.intern;
      if (message.author === "jp") return null;
      if (who === "coordinator") return { faceId: "coordinator", name: coordinatorName, slug: "coordinator" };
      const member = crew.bySlug[who];
      return { faceId: member?.faceId ?? resolveFaceId(undefined, who), name: member?.name ?? who, slug: who };
    },
    [crew.bySlug],
  );
  /** Who can be @mentioned here: room members, or every intern in a 1:1 thread. */
  const mentionable = useMemo(() => {
    const pool = isRoom ? crew.members.filter((m) => room?.members.includes(m.slug)) : crew.members.filter((m) => m.slug !== slug);
    return pool;
  }, [crew.members, isRoom, room?.members, slug]);
  const mentionQuery = useMemo(() => mentionQueryAt(draft), [draft]);
  const mentionSuggestions = useMemo(() => {
    if (!mentionQuery) return [];
    const q = mentionQuery.query.toLowerCase();
    const people = mentionable.filter((m) => !q || m.name.toLowerCase().startsWith(q) || m.slug.toLowerCase().startsWith(q)).slice(0, 6);
    // In a room, "@all" (or the room's name) addresses everyone and skips the responder pre-check.
    const everyone = isRoom && (!q || "all".startsWith(q) || "everyone".startsWith(q) || (room?.name ?? "").toLowerCase().startsWith(q))
      ? [{ slug: "all", name: "Everyone", role: "", faceId: "" }]
      : [];
    return [...everyone, ...people];
  }, [mentionQuery, mentionable, isRoom, room?.name]);
  const insertMention = useCallback(
    (name: string) => {
      if (!mentionQuery) return;
      const handle = name === "Everyone" ? "all" : name.includes(" ") ? name.split(" ")[0]! : name;
      setDraft(`${draft.slice(0, mentionQuery.start)}@${handle} `);
    },
    [draft, mentionQuery],
  );

  const load = useCallback(async () => {
    if (!slug || !configured) {
      setLoading(false);
      return;
    }
    try {
      const [crewNow, history, allCards, seen, roomNow, pages] = await Promise.all([
        api.listInterns(),
        api.listMessages(slug),
        api.listCards(),
        loadSeen(),
        isRoom ? api.getRoom(slug) : Promise.resolve(null),
        api.listPages(slug).catch(() => [] as PageHeader[]),
      ]);
      setPinnedPages(pages.filter((p) => p.pinned && !p.archived_at));
      setCrewList(crewNow);
      setRoom(roomNow);
      if (!unreadInitialized.current) {
        const previous = seen[slug];
        const firstUnread = previous
          ? history.find((message) => message.author !== "jp" && message.ts > previous)?.id ?? null
          : null;
        setUnreadAnchorId(firstUnread);
        unreadInitialized.current = true;
      }
      setIntern(crewNow.find((c) => c.slug === slug) ?? null);
      setMessages(history);
      // The front desk's own cards (failures, cap hits) belong on Today, not in the conversation.
      setCards(frontDesk ? [] : allCards.filter((card) => card.intern === slug));
      setError(null);
      setLoadFailed(false);
      const last = history[history.length - 1];
      if (last) void markSeen(slug, last.ts);
      // A reply may have landed while we were away or between polls.
      setAwaitingSince((since) => {
        if (since === null) return null;
        const replied = history.some((m) => m.author !== "jp" && Date.parse(m.ts) >= since - 1000);
        return replied ? null : since;
      });
    } catch (e) {
      setError(e);
      if (!loadedOnce.current) setLoadFailed(true);
    } finally {
      loadedOnce.current = true;
      setLoading(false);
    }
  }, [api, slug, configured, isRoom, frontDesk]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  useLiveEvents((event) => {
    if (!event.data) return;
    if (event.type === "message") {
      const message = event.data as Message;
      if (message.intern !== slug) return;
      const known = messages.some((m) => m.id === message.id);
      // A message is re-emitted when the intern's files get linked to it, so
      // a known id replaces rather than being ignored.
      setMessages((current) => (current.some((m) => m.id === message.id) ? current.map((m) => (m.id === message.id ? message : m)) : [...current, message]));
      // Anything JP sent from this device is already on screen optimistically.
      setPending((current) => current.filter((p) => p.failed || p.message.text !== message.text));
      if (!known && message.author !== "jp" && !atBottom.current) setUnseenCount((n) => n + 1);
      if (!known && message.author !== "jp") {
        setAwaitingSince(null);
        // A soft tap when a reply lands; two when someone addresses you in a room.
        const addressesMe = isRoom && (/(^|[^\w@])@jp\b/i.test(message.text) || messages.some((m) => m.author === "jp" && m.id === message.reply_to));
        haptic(addressesMe ? "double" : "tap");
      }
      void markSeen(slug, message.ts);
      return;
    }
    if (event.type === "room") {
      const updated = event.data as Room;
      if (updated.id === slug) setRoom(updated);
      return;
    }
    if (event.type === "page") {
      const changed = event.data as PageEvent;
      if (changed.intern === slug || changed.thread_key === slug) void api.listPages(slug!).then((pages) => setPinnedPages(pages.filter((p) => p.pinned && !p.archived_at))).catch(() => {});
      return;
    }
    if (event.type === "task_state") {
      const task = event.data as TaskActivity;
      const mine = isRoom ? room?.members.includes(task.intern) && room && task.label.includes(room.name) : frontDesk ? task.label.includes("front desk") : task.intern === slug;
      if (!mine) return;
      if (task.status === "failed") {
        setFaceReaction({ kind: "wince", key: Date.now() });
        haptic("warning");
      } else if (task.status === "running" && task.kind === "message") {
        setFaceReaction({ kind: "nod", key: Date.now() });
      }
      // keep the header/activity fresh without a full reload
      setIntern((current) => (current && current.slug === task.intern ? { ...current, activity: ["done", "failed", "cancelled"].includes(task.status) ? null : task, running: task.status === "running" ? 1 : 0, queued: task.status === "queued" ? 1 : 0, paused: task.status === "paused" ? 1 : 0 } : current));
      setCrewList((current) => current.map((c) => (c.slug === task.intern ? { ...c, activity: ["done", "failed", "cancelled"].includes(task.status) ? null : task, running: task.status === "running" ? 1 : 0, queued: task.status === "queued" ? 1 : 0, paused: task.status === "paused" ? 1 : 0 } : c)));
    }
    if (event.type === "card" || event.type === "card_state") {
      const card = event.data as Card;
      if (card.intern !== slug) return;
      setCards((current) => current.some((item) => item.id === card.id)
        ? current.map((item) => item.id === card.id ? card : item)
        : [...current, card]);
    }
  });

  // Two signals, and both have to still make sense: JP is waiting on a reply
  // he asked for, or the backend says a task is running and the last word in
  // the thread is still JP's. Without the second half an intern that stays
  // busy after answering would leave the indicator up forever.
  const roomWorker = isRoom
    ? crewList.find((c) => room?.members.includes(c.slug) && c.activity && ["running", "queued", "paused"].includes(c.activity.status) && room && c.activity.label.includes(room.name))
    : frontDesk
      ? crewList.find((c) => c.activity && ["running", "queued", "paused"].includes(c.activity.status) && c.activity.label.includes("front desk"))
      : undefined;
  const roomBusy = Boolean(roomWorker && roomWorker.activity?.status === "running");
  /** the task the avatar's popup controls: this intern's, or the room member replying here */
  const shared = isRoom || frontDesk;
  const activeTask = shared ? roomWorker?.activity ?? null : intern?.activity && ["running", "queued", "paused"].includes(intern.activity.status) ? intern.activity : null;
  const paused = activeTask?.status === "paused";
  const busy = (intern?.running ?? 0) > 0 || (intern?.queued ?? 0) > 0 || roomBusy;
  const lastAuthor = messages[messages.length - 1]?.author;
  const pendingFromJp = pending.some((p) => !p.failed);
  const lastWordIsJps = pendingFromJp || lastAuthor === "jp" || messages.length === 0;
  const waiting = awaitingSince !== null || (busy && lastWordIsJps) || paused;

  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => setTick(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, [waiting]);

  useEffect(() => {
    if (awaitingSince !== null && tick - awaitingSince > GIVE_UP_AFTER_MS) setAwaitingSince(null);
  }, [tick, awaitingSince]);

  /**
   * Who said each message and a one-line snippet, for reply quotes. Built once
   * per message list so every bubble gets the same object back and its memo
   * holds while JP types.
   */
  const quotes = useMemo(() => {
    const map = new Map<string, { id: string; who: string; snippet: string }>();
    for (const target of messages) {
      const who = target.author === "jp" ? "You" : (speakerOf(target)?.name ?? "");
      const snippet = target.text.trim() ? stripMarkdown(target.text).slice(0, 90) : target.attachments?.length ? `📎 ${target.attachments[0]!.name}` : "";
      map.set(target.id, { id: target.id, who, snippet });
    }
    return map;
  }, [messages, speakerOf]);
  const quoteOf = useCallback((id: string | null | undefined) => (id ? quotes.get(id) ?? null : null), [quotes]);

  /** Long-press menu actions. */
  const menuAction = useCallback(
    async (action: "reply" | "copy" | "forward" | "pin" | "card" | "retry" | "edit" | "discard" | "idea" | "notlikethis") => {
      const target = menuFor;
      if (!target) return;
      setMenuFor(null);
      if (action === "retry") return void retryPending(target);
      if (action === "edit") return editPending(target);
      if (action === "discard") return discardPending(target);
      try {
        if (action === "reply") setReplyingTo(target);
        else if (action === "copy") setMenuNote((await copyText(target.text)) ? "Copied" : "Could not copy here");
        else if (action === "forward") setForwardFor(target);
        else if (action === "pin") {
          const updated = await api.pinMessage(target.id, !target.pinned);
          setMessages((current) => current.map((m) => (m.id === updated.id ? updated : m)));
          setMenuNote(updated.pinned ? "Pinned" : "Unpinned");
        } else if (action === "idea") {
          const saved = await api.saveIdea(stripMarkdown(target.text).slice(0, 1000) || "(idea)", { thread_key: slug!, message_id: target.id });
          setMenuNote(`💡 Saved to Ideas (${saved.count})`);
          haptic("success");
        } else if (action === "notlikethis") {
          // The intern who wrote it proposes a standing order (docs/features/04).
          const who = target.speaker ?? target.intern;
          const ask = "Don't send me this kind of thing. Suggest a standing order so it stops — use a hard rule if one fits.";
          if (who === slug) await sendText(ask, target.id);
          else {
            await api.sendMessage(who, `> ${stripMarkdown(target.text).slice(0, 300).replace(/\n/g, "\n> ")}\n\n${ask}`);
            setMenuNote(`Asked ${speakerOf(target)?.name ?? "them"} in their chat`);
          }
        } else if (action === "card") {
          const who = target.author === "jp" ? "You" : speakerOf(target)?.name ?? "Intern";
          const title = target.text.replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim().slice(0, 70) || "From the thread";
          await api.createCard({
            intern: isRoom || target.author !== "intern" ? "coordinator" : target.speaker ?? slug!,
            title,
            body: `${target.text}\n\n_From ${who} in ${threadName}._`,
            severity: "action",
            actions: [{ id: "done", label: "Done", style: "success", kind: "button" }, { id: "later", label: "Later", style: "neutral", kind: "button" }],
          });
          setMenuNote("Card created — it's in your inbox");
          haptic("success");
        }
      } catch (e) {
        setMenuNote(friendlyError(e).message);
      }
      setTimeout(() => setMenuNote(null), 2200);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, isRoom, menuFor, slug, speakerOf, threadName],
  );

  const forwardTo = useCallback(
    async (targetSlug: string) => {
      const target = forwardFor;
      setForwardFor(null);
      if (!target) return;
      const who = target.author === "jp" ? "me" : speakerOf(target)?.name ?? "an intern";
      try {
        await api.sendMessage(targetSlug, `Forwarded from ${who} in ${threadName}:\n\n> ${target.text.replace(/\n/g, "\n> ")}\n\nPlease take a look.`);
        router.push(`/chat/${targetSlug}` as never);
      } catch (e) {
        setMenuNote(friendlyError(e).message);
        setTimeout(() => setMenuNote(null), 2200);
      }
    },
    [api, forwardFor, router, speakerOf, threadName],
  );

  const uploadsBusy = uploads.some((u) => !u.attachment && !u.error);
  const readyAttachments = useMemo(() => uploads.filter((u) => u.attachment).map((u) => u.attachment!), [uploads]);

  /**
   * POST an optimistic message that is already on screen. On failure it stays
   * in the thread marked "Not sent" with its text and attachments intact, so
   * a retry (tap) or edit (long-press) never means retyping.
   */
  const deliver = useCallback(async (optimistic: Message): Promise<boolean> => {
    if (!slug) return false;
    setSending(true);
    setAwaitingSince(Date.now());
    setTick(Date.now());
    stickToBottom();
    try {
      const result = await api.sendMessage(slug, optimistic.text, (optimistic.attachments ?? []).map((a) => a.id), optimistic.reply_to ?? null);
      setPending((current) => current.filter((p) => p.message.id !== optimistic.id));
      setMessages((current) =>
        current.some((m) => m.id === result.message.id) ? current : [...current, result.message],
      );
      // Ideas and debrief "Skip" wake nobody; don't leave the thinking face up.
      if (result.targets && result.targets.length === 0) setAwaitingSince(null);
      void markSeen(slug, result.message.ts);
      return true;
    } catch {
      setPending((current) =>
        current.map((p) => (p.message.id === optimistic.id ? { ...p, failed: true } : p)),
      );
      setAwaitingSince(null);
      haptic("warning");
      return false;
    } finally {
      setSending(false);
    }
  }, [api, slug, stickToBottom]);

  /**
   * Send a message as JP that answers a specific message — quick replies,
   * checklists, "Don't send me this kind of thing…". Same optimistic bubble
   * and failure handling as the composer; rejects when it was not sent so the
   * block can unlock.
   */
  const sendText = useCallback(async (text: string, replyTo: string | null) => {
    if (!slug) return;
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      intern: slug,
      author: "jp",
      text,
      ts: new Date().toISOString(),
      surface: "app",
      attachments: [],
      reply_to: replyTo,
    };
    setPending((current) => [...current, { message: optimistic }]);
    if (!(await deliver(optimistic))) throw new Error("not sent");
  }, [deliver, slug]);

  const send = useCallback(async () => {
    const typed = draft.trim();
    if ((!typed && readyAttachments.length === 0) || !slug || sending || uploadsBusy) return;
    // Idea mode (front desk): the orchestrator files anything starting with 💡.
    const text = ideaMode && typed && !/^\s*(idea\s*:|💡)/i.test(typed) ? `💡 ${typed}` : typed;
    const optimistic: Message = {
      id: `pending-${Date.now()}`,
      intern: slug,
      author: "jp",
      text,
      ts: new Date().toISOString(),
      surface: "app",
      attachments: readyAttachments,
      reply_to: replyingTo?.id ?? null,
    };
    setReplyingTo(null);
    setDraft("");
    void clearDraft(slug);
    setUploads((current) => current.filter((u) => u.error)); // failed ones stay for a retry
    setPending((current) => [...current, { message: optimistic }]);
    await deliver(optimistic);
  }, [deliver, draft, slug, sending, readyAttachments, uploadsBusy, replyingTo, ideaMode]);

  const retryPending = useCallback(async (message: Message) => {
    if (sending) return;
    const fresh = { ...message, ts: new Date().toISOString() };
    setPending((current) => [...current.filter((p) => p.message.id !== message.id), { message: fresh }]);
    await deliver(fresh);
  }, [deliver, sending]);

  /** Put a failed message back in the composer and take it out of the thread. */
  const editPending = useCallback((message: Message) => {
    setPending((current) => current.filter((p) => p.message.id !== message.id));
    setDraft(message.text);
    if (message.reply_to) setReplyingTo(messages.find((m) => m.id === message.reply_to) ?? null);
  }, [messages]);

  const discardPending = useCallback((message: Message) => {
    setPending((current) => current.filter((p) => p.message.id !== message.id));
  }, []);

  const openMenu = useCallback((message: Message) => {
    haptic("tap");
    setMenuFor(message);
  }, []);

  const runCardAction = useCallback(
    (card: Card, action: CardAction, note?: string) => api.runCardAction(card.id, action.id, note),
    [api],
  );

  const runTaskControl = useCallback(async (action: "pause" | "resume" | "cancel" | "prioritize") => {
    const task = activeTask;
    if (!task || taskAction) return;
    setTaskAction(action);
    setTaskError(null);
    try {
      const updated = await api.runTaskAction(task.id, action);
      setIntern((current) => current ? {
        ...current,
        activity: updated.status === "cancelled" ? null : updated,
        running: updated.status === "running" ? 1 : 0,
        queued: updated.status === "queued" ? Math.max(1, current.queued) : 0,
        paused: updated.status === "paused" ? 1 : 0,
      } : current);
    } catch (e) {
      setTaskError(e instanceof Error ? e.message : String(e));
    } finally {
      setTaskAction(null);
    }
    if (action === "cancel") setTaskMenuOpen(false);
  }, [api, activeTask, taskAction]);

  const onTaskAction = useCallback((action: "pause" | "resume" | "cancel" | "prioritize") => {
    if (action !== "cancel") {
      void runTaskControl(action);
      return;
    }
    const label = activeTask?.label ?? "The agent's current work will stop.";
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(`Cancel this task?\n\n${label}`)) void runTaskControl("cancel");
      return;
    }
    Alert.alert("Cancel this task?", label, [
      { text: "Keep working", style: "cancel" },
      { text: "Cancel task", style: "destructive", onPress: () => void runTaskControl("cancel") },
    ]);
  }, [activeTask?.label, runTaskControl]);

  /** Same person, same day, within a few minutes: one visual run. */
  const RUN_GAP_MS = 5 * 60_000;
  const draftEmpty = draft.trim().length === 0;
  const pickQuickReply = useCallback((reply: { text: string }) => setDraft(reply.text), []);
  const setReplyTarget = useCallback((message: Message) => setReplyingTo(message), []);
  const onUpdatedCard = useCallback((updated: Card) => setCards((current) => current.map((card) => card.id === updated.id ? updated : card)), []);
  const onRowLayout = useCallback((messageId: string, event: LayoutChangeEvent) => {
    rowY.current.set(messageId, event.nativeEvent.layout.y);
    revealTarget(messageId, event);
  }, [revealTarget]);

  const timeline = useMemo(() => {
    const messageEntries = [...messages, ...pending.map((p) => p.message)].map((message) => ({
      type: "message" as const,
      id: message.id,
      ts: message.ts,
      message,
    }));
    const cardEntries = cards.map((card) => ({
      type: "card" as const,
      id: card.id,
      ts: card.created_at,
      card,
    }));
    const all = [...messageEntries, ...cardEntries].sort((a, b) => a.ts.localeCompare(b.ts));
    const failedIds = new Set(pending.filter((p) => p.failed).map((p) => p.message.id));
    const pendingIds = new Set(pending.filter((p) => !p.failed).map((p) => p.message.id));
    const nodes: React.ReactNode[] = [];
    const latestIncomingId = [...messages].reverse().find((message) => message.author !== "jp")?.id;
    // A message is "answered" once JP has written after it — its quick replies / checklist are spent.
    const answered = new Set<string>();
    let jpLater = pending.length > 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (jpLater) answered.add(messages[i]!.id);
      if (messages[i]!.author === "jp") jpLater = true;
    }
    let currentDay = "";
    all.forEach((entry, index) => {
      const key = dayKey(entry.ts);
      if (key !== currentDay) {
        currentDay = key;
        nodes.push(<DayDivider key={`day-${key}`} label={dayLabel(entry.ts)} />);
      }
      if (entry.type === "card") {
        nodes.push(
          <ThreadCard
            key={`card-${entry.card.id}`}
            card={entry.card}
            faceId={faceId}
            internName={intern?.name ?? slug}
            onAction={runCardAction}
            onUpdated={onUpdatedCard}
          />,
        );
        return;
      }
      const message = entry.message;
      // A run is one speaker's consecutive messages. The face sits beside the
      // LAST bubble (bottom-aligned, as in Messages), the name above the
      // first, and the time once under the run instead of under every bubble.
      const next = all[index + 1];
      const prev = all[index - 1];
      if (!targetMessageId && message.id === unreadAnchorId) {
        nodes.push(<UnreadDivider key={`unread-${message.id}`} />);
      }
      const speaker = speakerOf(message);
      const sameRun = (other: (typeof all)[number] | undefined) =>
        Boolean(
          other
          && other.type === "message"
          && other.message.author === message.author
          && (speakerOf(other.message)?.slug ?? null) === (speaker?.slug ?? null)
          && dayKey(other.ts) === key
          && Math.abs(Date.parse(other.ts) - Date.parse(message.ts)) < RUN_GAP_MS
          && !failedIds.has(other.message.id),
        );
      const runStart = !sameRun(prev) || (!targetMessageId && message.id === unreadAnchorId);
      const runEnd = !sameRun(next) || (!targetMessageId && next?.id === unreadAnchorId);
      const showSpeakerName = Boolean(speaker && (isRoom || speaker.slug !== slug) && runStart);
      // Replying to the message directly above says nothing a quote would add.
      const quotesPrevious = Boolean(prev && prev.type === "message" && prev.message.id === message.reply_to);
      const isPending = pendingIds.has(message.id);
      const isFailed = failedIds.has(message.id);
      const pullRequests = extractPullRequestReferences(message.text);
      const resources = extractResourceReferences(message.text);
      nodes.push(
        <ArrivalMessage
          key={message.id}
          id={message.id}
          testID={`message-${message.id}`}
          active={message.id === highlightedMessageId}
          onLayout={onRowLayout}
        >
          <MessageProvider
            value={{
              thread: slug!,
              messageId: message.id,
              speaker: message.speaker ?? null,
              answered: answered.has(message.id),
              reply: (text) => sendText(text, message.id),
              compose: (text) => {
                setReplyingTo(message);
                setDraft(text);
              },
            }}
          >
          <Bubble
            message={message}
            faceId={speaker?.faceId ?? faceId}
            speakerName={showSpeakerName ? speaker?.name : undefined}
            showFace={runEnd}
            showMeta={runEnd || isPending}
            pending={isPending}
            failed={isFailed}
            highlighted={message.id === highlightedMessageId}
            api={api}
            onOpenAttachment={setViewing}
            replyTo={quotesPrevious ? null : quoteOf(message.reply_to)}
            onPressReplyTo={setJumpTarget}
            onReply={!isPending && !isFailed ? setReplyTarget : undefined}
            onLongPress={!isPending ? openMenu : undefined}
            onRetry={isFailed ? retryPending : undefined}
          />
          </MessageProvider>
          {pullRequests.map((reference) => (
            <PullRequestPreviewCard
              key={`${reference.repository}#${reference.number}`}
              api={api}
              reference={reference}
              mine={message.author === "jp"}
            />
          ))}
          {resources.map((reference) => (
            <ResourceLinkPreviewCard key={reference.url} reference={reference} mine={message.author === "jp"} />
          ))}
          {message.id === latestIncomingId && draftEmpty && !waiting && !/```(quick-replies|checklist)/.test(message.text) ? (
            <QuickReplyChips replies={suggestQuickReplies(message.text)} onSelect={pickQuickReply} indent={quickReplyIndent} />
          ) : null}
        </ArrivalMessage>,
      );
    });
    return nodes;
    // `draftEmpty`, not `draft`: typing must not rebuild every row.
  }, [messages, pending, cards, faceId, intern?.name, slug, runCardAction, onUpdatedCard, targetMessageId, unreadAnchorId, highlightedMessageId, onRowLayout, api, draftEmpty, waiting, speakerOf, isRoom, quoteOf, setReplyTarget, openMenu, retryPending, pickQuickReply, quickReplyIndent, sendText]);

  if (!ready) return <Loading />;

  const thinkingPhase =
    awaitingSince !== null && tick - awaitingSince > STILL_THINKING_AFTER_MS ? "still" : "thinking";

  return (
    <Screen>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={[styles.headerTitle, { maxWidth: Math.max(160, windowWidth - 196) }]}>
              {isRoom ? <FaceStack faceIds={memberFaces} size={38} /> : <InternFace id={faceId} size={38} reaction={faceReaction?.kind ?? null} reactionKey={faceReaction?.key} />}
              <View style={styles.headerText}>
                <Text variant="title" numberOfLines={1}>
                  {threadName}
                </Text>
                <Text variant="caption" numberOfLines={1}>
                  {isRoom
                    ? (room?.members ?? []).map((m) => crew.bySlug[m]?.name ?? m).join(", ")
                    : frontDesk
                      ? roomWorker?.activity?.label ?? "Front desk · I'll find the right intern"
                      : intern?.activity?.label ?? (intern?.role ?? "")}
                </Text>
              </View>
            </View>
          ),
          headerRight: () => (
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => setSearchOpen((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel="Search this conversation"
                hitSlop={8}
                style={({ pressed }) => [styles.headerSettings, { opacity: pressed ? 0.55 : 1 }]}
              >
                <SearchIcon size={20} color={searchOpen ? colors.text : colors.textDim} />
              </Pressable>
              <Pressable
                onPress={() => router.push(`/files/${slug}` as never)}
                accessibilityRole="button"
                accessibilityLabel={`Files exchanged with ${intern?.name ?? slug}`}
                hitSlop={8}
                style={({ pressed }) => [styles.headerSettings, { opacity: pressed ? 0.55 : 1 }]}
              >
                <PaperclipIcon size={20} color={colors.textDim} />
              </Pressable>
              {!frontDesk ? (
              <Pressable
                onPress={() => router.push((isRoom ? `/group/${slug}` : `/intern/${slug}`) as never)}
                accessibilityRole="button"
                accessibilityLabel={`${threadName} settings`}
                hitSlop={8}
                style={({ pressed }) => [styles.headerSettings, { opacity: pressed ? 0.55 : 1 }]}
              >
                <GearIcon size={20} color={colors.textDim} />
              </Pressable>
              ) : null}
            </View>
          ),
        }}
      />

      {!configured ? (
        <EmptyState title="Not connected" body="Add your API token in Settings › Connection.">
          <Button label="Open Settings" tone="primary" onPress={() => router.push("/settings?tab=connect" as never)} />
        </EmptyState>
      ) : loading ? (
        <Loading />
      ) : loadFailed ? (
        <EmptyState title={`Couldn't open ${isRoom ? "this group" : intern?.name ?? "this thread"}`}>
          <ErrorNote error={error} subject={isRoom ? "this group" : "this intern"} onRetry={() => { setLoading(true); void load(); }} />
        </EmptyState>
      ) : (
        <View style={styles.flex}>
          {streamStatus === "offline" ? (
            <View style={[styles.offline, { backgroundColor: colors.actionSoft }]} accessibilityRole="alert">
              <Text variant="caption" color={colors.action}>Offline — new messages won't arrive, and sending may fail.</Text>
            </View>
          ) : null}
          {searchOpen ? (
            <View style={[styles.searchBar, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <SearchIcon size={16} color={colors.textDim} />
              <TextInput
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder="Search this conversation"
                placeholderTextColor={colors.textFaint}
                autoFocus
                style={[styles.searchInput, { color: colors.text, fontSize: scaledFont(15, fontScale) }]}
                onSubmitEditing={() => searchHits.length && setSearchIndex((i) => (i + 1) % searchHits.length)}
              />
              {searchQuery.trim() ? (
                <Text variant="caption">{searchHits.length ? `${searchIndex + 1} of ${searchHits.length}` : "0"}</Text>
              ) : null}
              <Pressable onPress={() => searchHits.length && setSearchIndex((i) => (i - 1 + searchHits.length) % searchHits.length)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Previous match" style={[styles.searchButton, styles.searchNav]}>
                <ChevronDownIcon size={16} color={colors.textDim} />
              </Pressable>
              <Pressable onPress={() => searchHits.length && setSearchIndex((i) => (i + 1) % searchHits.length)} hitSlop={8} accessibilityRole="button" accessibilityLabel="Next match" style={[styles.searchButton, styles.searchNavDown]}>
                <ChevronDownIcon size={16} color={colors.textDim} />
              </Pressable>
              <Pressable onPress={() => { setSearchOpen(false); setSearchQuery(""); }} hitSlop={8} accessibilityRole="button" accessibilityLabel="Close search" style={styles.searchButton}>
                <XIcon size={16} color={colors.textDim} />
              </Pressable>
            </View>
          ) : null}
          {isRoom && (room?.scratchpad?.trim() || padOpen) ? (
            <View style={[styles.pad, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
              <Pressable onPress={() => setPadOpen((v) => !v)} accessibilityRole="button" accessibilityLabel={padOpen ? "Collapse scratchpad" : "Expand scratchpad"} style={styles.padHeader}>
                <Text variant="label">📝 Scratchpad</Text>
                <View style={padOpen ? styles.chevronUp : null}>
                  <ChevronDownIcon size={16} color={colors.textDim} />
                </View>
              </Pressable>
              {padOpen ? (
                <View style={styles.padBody}>
                  {room?.scratchpad?.trim() ? <Markdown body={room.scratchpad} variant="subtle" /> : <Text variant="subtle">Nothing here yet.</Text>}
                  <Pressable onPress={() => router.push(`/group/${slug}` as never)} accessibilityRole="button" accessibilityLabel="Edit scratchpad" hitSlop={8} style={styles.padEdit}>
                    <EditIcon size={16} color={colors.textDim} />
                  </Pressable>
                </View>
              ) : (
                <Text variant="caption" numberOfLines={1}>{room?.scratchpad.replace(/[#*_`>-]/g, "").replace(/\s+/g, " ").trim()}</Text>
              )}
            </View>
          ) : null}
          {pins.length || pinnedPages.length ? (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pinBar} contentContainerStyle={styles.pinBarContent}>
              {pinnedPages.map((p) => (
                <Pressable key={p.id} onPress={() => router.push(`/page/${p.id}` as never)} accessibilityRole="button" accessibilityLabel={`Pinned page: ${p.title}`} style={[styles.pinChip, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
                  <Text variant="caption" color={colors.text} numberOfLines={1} style={styles.pinText}>
                    {`${p.kind === "list" && p.intern === "coordinator" ? "💡" : "📄"} ${p.title}`}
                  </Text>
                </Pressable>
              ))}
              {pins.map((p) => (
                <Pressable key={p.id} onPress={() => setJumpTarget(p.id)} accessibilityRole="button" accessibilityLabel={`Pinned: ${p.text.slice(0, 60)}`} style={[styles.pinChip, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
                  <Text variant="caption" color={colors.text} numberOfLines={1} style={styles.pinText}>
                    📌 {p.text.replace(/```[\s\S]*?```/g, "").replace(/\s+/g, " ").trim().slice(0, 48)}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          ) : null}
          {menuNote ? (
            <View style={[styles.note, { backgroundColor: colors.surfaceAlt }]}>
              <Text variant="caption" color={colors.text}>{menuNote}</Text>
            </View>
          ) : null}
          <View style={styles.threadFrame}>
            <ScrollView
              ref={scrollRef}
              style={styles.flex}
              contentContainerStyle={styles.thread}
              keyboardShouldPersistTaps="handled"
              scrollEventThrottle={16}
              onScroll={(event) => {
                const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
                const isAtBottom = contentOffset.y + layoutMeasurement.height >= contentSize.height - 48;
                // Layout churn right after a send is not JP scrolling away.
                if (!isAtBottom && Date.now() < stickUntil.current) return;
                if (atBottom.current === isAtBottom) return;
                atBottom.current = isAtBottom;
                setShowJumpToLatest(!isAtBottom);
                if (isAtBottom) setUnseenCount(0);
              }}
              onLayout={() => {
                // The composer grew or shrank (a long draft was sent, the
                // keyboard moved the page): stay on the newest message.
                if (atBottom.current && hasAnchored.current) scrollRef.current?.scrollToEnd({ animated: false });
              }}
              onContentSizeChange={() => {
                const targetExists = Boolean(
                  scrollTargetId
                  && openedTarget.current !== scrollTargetId
                  && [...messages, ...pending.map((item) => item.message)].some((message) => message.id === scrollTargetId),
                );
                if (targetExists) return; // the target row's onLayout owns the initial scroll
                // Anchor the first paint. After that, only follow new content
                // while the reader is already at the bottom.
                if (!hasAnchored.current) {
                  // First paint: pictures, charts and link previews finish
                  // laying out after this; keep following them to the bottom.
                  stickUntil.current = Date.now() + 2_000;
                  jumpToLatest(false);
                } else if (Date.now() < stickUntil.current) jumpToLatest(false);
                else if (atBottom.current) jumpToLatest(true);
                hasAnchored.current = true;
              }}
            >
              {timeline.length ? (
                timeline
              ) : (
                <EmptyState
                  title={isRoom ? `Start the conversation in ${threadName}` : frontDesk ? "The front desk" : `Say hello to ${intern?.name ?? "your intern"}`}
                  body={isRoom ? "Mention someone with @Name, or ask the room." : frontDesk ? "Ask anything — I'll hand it to the right intern. Start a message with “idea:” (or tap 💡) to save an idea." : intern?.role}
                />
              )}

              {waiting ? (
                // Tapping the typing row opens the task controls (prioritize / pause / cancel).
                <Pressable
                  onPress={() => activeTask && setTaskMenuOpen(true)}
                  disabled={!activeTask}
                  accessibilityRole={activeTask ? "button" : undefined}
                  accessibilityLabel={activeTask ? `${activeTask.label}. Tap for task controls` : undefined}
                  style={({ pressed }) => [{ opacity: pressed ? 0.7 : 1 }]}
                >
                  <ThinkingIndicator
                    inline
                    faceId={shared ? (roomWorker ? crew.bySlug[roomWorker.slug]?.faceId ?? memberFaces[0] ?? faceId : memberFaces[0] ?? faceId) : faceId}
                    faceSize={quickReplyIndent - space.sm}
                    name={shared ? roomWorker?.name ?? (frontDesk ? "The front desk" : "The group") : intern?.name ?? slug ?? "They"}
                    phase={thinkingPhase}
                    caption={
                      paused
                        ? `${shared ? roomWorker?.name ?? "Work" : intern?.name ?? "Work"} is paused`
                        : activeTask?.status === "running"
                          ? `${shared ? roomWorker?.name ?? "Someone" : intern?.name ?? "They"} is on it…`
                          : activeTask?.status === "queued"
                            ? `${shared ? roomWorker?.name ?? "Someone" : intern?.name ?? "They"} has it queued${(intern?.queued ?? 0) > 1 ? ` (${intern!.queued} ahead)` : ""}…`
                            : undefined
                    }
                    hint={activeTask ? (paused ? "Tap to resume or cancel" : "Tap for options") : undefined}
                  />
                </Pressable>
              ) : null}
            </ScrollView>
            {showJumpToLatest ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={unseenCount ? `${unseenCount} new message${unseenCount === 1 ? "" : "s"}. Jump to latest` : "Jump to latest message"}
                onPress={() => jumpToLatest(true)}
                style={({ pressed }) => [
                  styles.jumpToLatest,
                  unseenCount ? styles.jumpToLatestWide : null,
                  {
                    backgroundColor: unseenCount ? colors.accent : colors.surface,
                    borderColor: colors.border,
                    shadowColor: "#000000",
                    opacity: pressed ? 0.72 : 1,
                  },
                ]}
              >
                {unseenCount ? (
                  <Text variant="caption" color={colors.onAccent} style={styles.jumpLabel}>
                    {unseenCount === 1 ? "1 new" : `${unseenCount} new`}
                  </Text>
                ) : null}
                <ChevronDownIcon size={unseenCount ? 16 : 20} color={unseenCount ? colors.onAccent : colors.text} />
              </Pressable>
            ) : null}
          </View>

          {error ? <ErrorNote error={error} onRetry={() => void load()} onDismiss={() => setError(null)} /> : null}

          <View
            testID="chat-composer-bar"
            style={[
              styles.composer,
              {
                paddingBottom: composerFocused ? space.xs : Math.max(insets.bottom, space.sm),
                backgroundColor: colors.bg,
              },
            ]}
          >
            {dragging ? (
              <View style={[styles.dropHint, { borderColor: colors.info, backgroundColor: colors.accentSoft }]}>
                <Text variant="subtle" color={colors.info} center>
                  Drop files to attach
                </Text>
              </View>
            ) : null}
            {replyingTo ? (
              <View style={[styles.replyBar, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
                <View style={styles.replyBarText}>
                  <Text variant="caption" color={colors.text} style={styles.replyBarWho}>
                    {`Replying to ${quoteOf(replyingTo.id)?.who ?? ""}`}
                  </Text>
                  <Text variant="caption" numberOfLines={1}>
                    {quoteOf(replyingTo.id)?.snippet ?? ""}
                  </Text>
                </View>
                <Pressable onPress={() => setReplyingTo(null)} accessibilityRole="button" accessibilityLabel="Cancel reply" hitSlop={8} style={styles.iconButton}>
                  <XIcon size={18} color={colors.textDim} />
                </Pressable>
              </View>
            ) : null}
            {mentionSuggestions.length ? (
              <View style={styles.mentionRow} accessibilityRole="menu">
                {mentionSuggestions.map((m) => (
                  <Pressable
                    key={m.slug}
                    onPress={() => insertMention(m.name)}
                    accessibilityRole="menuitem"
                    accessibilityLabel={`Mention ${m.name}`}
                    style={({ pressed }) => [styles.mentionChip, { backgroundColor: colors.surfaceAlt, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
                  >
                    {m.faceId ? (
                      <InternFace id={m.faceId} size={22} clipToBounds />
                    ) : (
                      <View style={styles.mentionAllIcon}>
                        <UsersIcon size={16} color={colors.textDim} />
                      </View>
                    )}
                    <Text variant="subtle" color={colors.text}>
                      {m.name}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <PendingAttachments
              items={uploads}
              onRemove={(key) => setUploads((current) => current.filter((u) => u.key !== key))}
              onRetry={(key) => {
                const item = uploads.find((u) => u.key === key);
                if (item) startUpload(item);
              }}
            />
            <Composer
              value={draft}
              onChangeText={setDraft}
              onSend={() => void send()}
              sending={sending}
              onAttach={() => void attach()}
              onFiles={addFiles}
              hasAttachments={readyAttachments.length > 0}
              attachmentsBusy={uploadsBusy}
              placeholder={
                ideaMode
                  ? "Jot an idea…"
                  : readyAttachments.length
                    ? "Add a note (optional)…"
                    : isRoom
                      ? `Message ${threadName} — @ to mention…`
                      : frontDesk
                        ? "Ask anything — I'll route it…"
                        : `Message ${intern?.name ?? slug}…`
              }
              onToggleIdea={frontDesk ? () => setIdeaMode((v) => !v) : undefined}
              ideaMode={ideaMode}
              // The one concession to the keyboard: once iOS has finished
              // moving the page, put the newest message back in view. No
              // geometry, no listeners -- just a scroll to the bottom.
              onFocus={() => {
                setComposerFocused(true);
                // Only when already at the bottom: replying to an older or
                // searched message should not yank the thread away from it.
                if (atBottom.current) setTimeout(() => jumpToLatest(true), 350);
              }}
              onBlur={() => setComposerFocused(false)}
            />
          </View>
        </View>
      )}
      <AttachmentViewer attachment={viewing} api={api} onClose={() => setViewing(null)} />
      <Modal visible={Boolean(menuFor)} transparent animationType="fade" onRequestClose={() => setMenuFor(null)}>
        <Pressable style={[styles.sheetBackdrop, { backgroundColor: colors.overlay }]} onPress={() => setMenuFor(null)} accessibilityLabel="Close message menu">
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border, paddingBottom: Math.max(insets.bottom, space.lg) }]} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <Text variant="caption" numberOfLines={2} style={styles.sheetPreview}>
              {menuFor ? (menuFor.text.trim() ? cleanMessagePreview(menuFor.text) : menuFor.attachments?.length ? `📎 ${menuFor.attachments.map((a) => a.name).join(", ")}` : "") : ""}
            </Text>
            {menuFor && pending.some((p) => p.failed && p.message.id === menuFor.id) ? (
              <>
                <SheetItem label="Try again" onPress={() => void menuAction("retry")} />
                <SheetItem label="Edit and resend" onPress={() => void menuAction("edit")} />
                {menuFor.text.trim() ? <SheetItem label="Copy text" onPress={() => void menuAction("copy")} /> : null}
                <SheetItem label="Delete" destructive onPress={() => void menuAction("discard")} />
              </>
            ) : (
              <>
                <SheetItem label="Reply" onPress={() => void menuAction("reply")} />
                {menuFor?.text.trim() ? <SheetItem label="Copy text" onPress={() => void menuAction("copy")} /> : null}
                <SheetItem label="Forward to another intern…" onPress={() => void menuAction("forward")} />
                <SheetItem label={menuFor?.pinned ? "Unpin" : "Pin to the top"} onPress={() => void menuAction("pin")} />
                <SheetItem label="Turn into a card" onPress={() => void menuAction("card")} />
                <SheetItem label="Save as idea" onPress={() => void menuAction("idea")} />
                {menuFor?.author === "intern" && menuFor.speaker ? (
                  <SheetItem label="Don't send me this kind of thing…" onPress={() => void menuAction("notlikethis")} />
                ) : null}
              </>
            )}
          </Pressable>
        </Pressable>
      </Modal>
      <Modal visible={Boolean(forwardFor)} transparent animationType="fade" onRequestClose={() => setForwardFor(null)}>
        <Pressable style={[styles.sheetBackdrop, { backgroundColor: colors.overlay }]} onPress={() => setForwardFor(null)} accessibilityLabel="Close">
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border, paddingBottom: Math.max(insets.bottom, space.lg) }]} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            <Text variant="label" style={styles.sheetPreview}>Forward to</Text>
            {crew.members.filter((m) => m.slug !== slug).map((m) => (
              <Pressable key={m.slug} onPress={() => void forwardTo(m.slug)} accessibilityRole="button" style={({ pressed }) => [styles.sheetRow, { opacity: pressed ? 0.7 : 1 }]}>
                <InternFace id={m.faceId} size={28} clipToBounds />
                <Text variant="body" color={colors.text}>{m.name}</Text>
                <Text variant="caption" numberOfLines={1} style={styles.sheetRole}>{m.role}</Text>
              </Pressable>
            ))}
          </Pressable>
        </Pressable>
      </Modal>
      <Modal visible={taskMenuOpen && Boolean(activeTask)} transparent animationType="fade" onRequestClose={() => setTaskMenuOpen(false)}>
        <Pressable style={[styles.sheetBackdrop, { backgroundColor: colors.overlay }]} onPress={() => setTaskMenuOpen(false)} accessibilityLabel="Close task controls">
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border, paddingBottom: Math.max(insets.bottom, space.lg) }]} onPress={() => {}}>
            <View style={styles.sheetHandle} />
            {activeTask ? (
              <TaskControls task={activeTask} busyAction={taskAction} error={taskError} onAction={onTaskAction} />
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>
    </Screen>
  );
}

function SheetItem({ label, onPress, destructive }: { label: string; onPress: () => void; destructive?: boolean }) {
  const { colors } = useAppTheme();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.sheetRow, { backgroundColor: pressed ? colors.surfaceAlt : "transparent" }]}>
      <Text variant="body" color={destructive ? colors.danger : colors.text}>{label}</Text>
    </Pressable>
  );
}

function TaskControls({
  task,
  busyAction,
  error,
  onAction,
}: {
  task: TaskActivity;
  busyAction: string | null;
  error: string | null;
  onAction: (action: "pause" | "resume" | "cancel" | "prioritize") => void;
}) {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.taskControls, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
      <View style={styles.taskCopy}>
        <Text variant="label">{task.status === "paused" ? "Paused task" : task.status === "queued" ? "Up next" : "Working now"}</Text>
        <Text variant="subtle" color={colors.text} numberOfLines={2}>{task.label.replace(/^(Paused|Queued|Priority):\s*/, "")}</Text>
        {error ? <Text variant="caption" color={colors.urgent}>{error}</Text> : null}
      </View>
      <View style={styles.taskActions}>
        <Button small label={task.priority > 0 ? "Prioritized" : "Prioritize"} tone={task.priority > 0 ? "primary" : "neutral"} busy={busyAction === "prioritize"} disabled={busyAction !== null || task.priority > 0} onPress={() => onAction("prioritize")} />
        {task.status === "running" ? <Button small label="Pause" tone="neutral" busy={busyAction === "pause"} disabled={busyAction !== null} onPress={() => onAction("pause")} /> : null}
        {task.status === "paused" ? <Button small label="Resume" tone="primary" busy={busyAction === "resume"} disabled={busyAction !== null} onPress={() => onAction("resume")} /> : null}
        <Button small label="Cancel" tone="danger" busy={busyAction === "cancel"} disabled={busyAction !== null} onPress={() => onAction("cancel")} />
      </View>
    </View>
  );
}

function ThreadCard({
  card,
  faceId,
  internName,
  onAction,
  onUpdated,
}: {
  card: Card;
  faceId: string;
  internName: string;
  onAction: (card: Card, action: CardAction, note?: string) => Promise<Card>;
  onUpdated: (card: Card) => void;
}) {
  const { colors } = useAppTheme();
  if (card.state === "open") {
    return (
      <View style={styles.inlineCard}>
        <CardView
          card={card}
          faceId={faceId}
          internName={internName}
          onAction={onAction}
          onResolved={onUpdated}
        />
      </View>
    );
  }
  const action = card.actions.find((item) => item.id === card.resolution?.action);
  return (
    <View style={styles.resolvedCardRow}>
      <View style={styles.resolvedCardGutter}>
        <CheckIcon size={16} color={colors.success} />
      </View>
      <View style={[styles.resolvedCard, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Text variant="subtle" color={colors.text} style={styles.resolvedCardTitle}>
          {card.title}
        </Text>
        <Text variant="caption">
          {action?.label ?? card.resolution?.action ?? "Resolved"} · {clockTime(card.resolved_at ?? card.updated_at)}
        </Text>
      </View>
    </View>
  );
}

function ArrivalMessage({
  id,
  active,
  children,
  onLayout,
  testID,
}: {
  id: string;
  active: boolean;
  children: React.ReactNode;
  onLayout: (id: string, event: LayoutChangeEvent) => void;
  testID: string;
}) {
  const { colors } = useAppTheme();
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    if (reduced) {
      // A steady highlight for as long as the row is the target; no pulse.
      pulse.setValue(1);
      return;
    }
    pulse.setValue(0);
    Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: false }),
      Animated.delay(750),
      Animated.timing(pulse, { toValue: 0, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
    ]).start();
  }, [active, pulse, reduced]);
  return (
    <Animated.View
      testID={testID}
      onLayout={(event) => onLayout(id, event)}
      style={[
        styles.arrival,
        { backgroundColor: pulse.interpolate({ inputRange: [0, 1], outputRange: ["transparent", colors.accentSoft] }) },
      ]}
    >
      {children}
    </Animated.View>
  );
}

function UnreadDivider() {
  const { colors } = useAppTheme();
  return (
    <View style={styles.unreadDivider} accessibilityRole="text" accessibilityLabel="New messages">
      <View style={[styles.unreadLine, { backgroundColor: colors.info }]} />
      <Text variant="label" color={colors.info}>New messages</Text>
      <View style={[styles.unreadLine, { backgroundColor: colors.info }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  threadFrame: { flex: 1, position: "relative" },
  // Roles are long; without a cap the subtitle runs off the right edge.
  // Room for the back arrow on the left and three icons on the right, so the
  // subtitle truncates instead of running under the search icon.
  headerTitle: { flexDirection: "row", alignItems: "center", gap: space.sm },
  headerText: { flexShrink: 1 },
  headerSettings: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  headerActions: { flexDirection: "row" },
  // flexGrow + flex-end keeps the newest message just above the composer
  // instead of stranding empty space under a short thread.
  thread: {
    padding: space.lg,
    paddingBottom: space.md,
    flexGrow: 1,
    justifyContent: "flex-end",
  },
  composer: {
    paddingHorizontal: space.lg,
    paddingTop: space.sm,
  },
  dropHint: { borderWidth: 1, borderStyle: "dashed", borderRadius: 12, paddingVertical: space.sm, marginBottom: space.sm },
  mentionRow: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginBottom: space.sm },
  mentionChip: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 4, paddingRight: space.md, paddingVertical: 4, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth },
  mentionAllIcon: { width: 22, height: 22, alignItems: "center", justifyContent: "center" },
  replyBar: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: space.md, paddingVertical: space.sm, marginBottom: space.sm },
  replyBarText: { flex: 1, gap: 1 },
  replyBarWho: { fontWeight: "600" },
  replyText: { textDecorationLine: "underline" },
  jumpToLatest: {
    position: "absolute",
    right: space.lg,
    bottom: space.md,
    minWidth: 40,
    height: 40,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    gap: space.xs,
    alignItems: "center",
    justifyContent: "center",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.16,
    shadowRadius: 9,
    elevation: 5,
  },
  jumpToLatestWide: { paddingHorizontal: space.md },
  jumpLabel: { fontWeight: "600" },
  offline: { paddingHorizontal: space.lg, paddingVertical: space.xs + 2, alignItems: "center" },
  taskControls: { padding: space.md, gap: space.md },
  sheetBackdrop: { flex: 1, justifyContent: "flex-end" },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingTop: space.sm, paddingHorizontal: space.sm },
  sheetHandle: { alignSelf: "center", width: 36, height: 4, borderRadius: 2, backgroundColor: "rgba(127,127,127,0.5)", marginBottom: space.xs },
  sheetPreview: { paddingHorizontal: space.md, paddingVertical: space.sm },
  sheetRow: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.md, paddingVertical: space.md },
  sheetRole: { flex: 1, textAlign: "right" },
  searchBar: { flexDirection: "row", alignItems: "center", gap: space.sm, marginHorizontal: space.lg, marginTop: space.sm, paddingHorizontal: space.md, paddingVertical: 6, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
  searchInput: { flex: 1, paddingVertical: 4 },
  searchButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  searchNav: { transform: [{ rotate: "180deg" }] },
  searchNavDown: { transform: [{ rotate: "0deg" }] },
  pad: { marginHorizontal: space.lg, marginTop: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: space.md, paddingVertical: space.sm, gap: 4 },
  padHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  padBody: { gap: space.sm, paddingTop: space.xs },
  link: { textDecorationLine: "underline" },
  iconButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  chevronUp: { transform: [{ rotate: "180deg" }] },
  padEdit: { alignSelf: "flex-start", width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  pinBar: { flexGrow: 0, marginTop: space.sm },
  pinBarContent: { paddingHorizontal: space.lg, gap: space.sm },
  pinChip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 999, paddingHorizontal: space.md, paddingVertical: 5, maxWidth: 260 },
  pinText: {},
  note: { alignSelf: "center", marginTop: space.sm, paddingHorizontal: space.md, paddingVertical: 5, borderRadius: 999 },
  taskCopy: { gap: 2 },
  taskActions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  inlineCard: { marginVertical: space.sm },
  arrival: { borderRadius: 14, marginHorizontal: -space.sm, paddingHorizontal: space.sm },
  unreadDivider: { flexDirection: "row", alignItems: "center", gap: space.sm, marginVertical: space.md },
  unreadLine: { height: StyleSheet.hairlineWidth, flex: 1 },
  resolvedCardRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginBottom: space.md },
  resolvedCardGutter: { width: 40, alignItems: "center" },
  resolvedCard: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, paddingHorizontal: space.md, paddingVertical: space.sm, gap: 2 },
  resolvedCardTitle: { fontWeight: "600" },
});
