import React, { useEffect, useRef } from "react";
import { Animated, PanResponder, Platform, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import { haptic } from "../haptics";
import type { Attachment, InternsApi, Message } from "../api";
import { radius, space, useAppTheme } from "../theme";
import { clockTime } from "../time";
import { AttachmentList } from "./Attachments";
import { DiscordIcon, ReplyIcon } from "./Icons";
import { InternFace } from "./InternFace";
import { hasMarkdown, Markdown } from "./Markdown";
import { Text } from "./Text";

/** Desktop gutter face: big enough that the blinking and glancing read at a glance. */
export const THREAD_FACE_SIZE = 40;
/** Phone gutter face: a narrower column so bubbles keep most of the width. */
const MOBILE_FACE_SIZE = 28;
const MOBILE_THREAD_BREAKPOINT = 640;
const SWIPE_TRIGGER = 64;

/** Where an intern's bubble starts: past the face gutter. Previews and chips line up with it. */
export function useThreadIndent(): number {
  const { width } = useWindowDimensions();
  return (width < MOBILE_THREAD_BREAKPOINT ? MOBILE_FACE_SIZE : THREAD_FACE_SIZE) + space.sm;
}

export interface BubbleProps {
  message: Message;
  /** avatar id for the intern side */
  faceId?: string;
  /** last bubble of a run: draws the face beside it and the time under it */
  showFace?: boolean;
  /** draw the time / reply row under the bubble (end of a run, or a send in flight) */
  showMeta?: boolean;
  /** optimistic message not yet acknowledged by the API */
  pending?: boolean;
  failed?: boolean;
  /** Notification/search deep link target. */
  highlighted?: boolean;
  /** needed to resolve attachment URLs; bubbles without attachments can omit it */
  api?: InternsApi;
  onOpenAttachment?: (attachment: Attachment) => void;
  /** group chats / handoffs: who spoke, shown above the first bubble of a run */
  speakerName?: string;
  /** the message this one answers, resolved by the thread: who said it and a snippet */
  replyTo?: { id: string; who: string; snippet: string } | null;
  onPressReplyTo?: (id: string) => void;
  /** swipe-to-reply and the reply glyph */
  onReply?: (message: Message) => void;
  /** long-press / right-click menu (reply / copy / forward / pin / make a card) */
  onLongPress?: (message: Message) => void;
  /** a failed send: tap the "Not sent" line to try again */
  onRetry?: (message: Message) => void;
}

/** An intern's sign-off: a trailing line that starts with an em dash, drawn quieter than the body. */
export function splitSignature(text: string): { body: string; signature: string | null } {
  const lines = text.trimEnd().split("\n");
  const last = lines[lines.length - 1] ?? "";
  if (lines.length > 1 && /^[—–-]\s?\S.{1,90}$/.test(last.trim()) && !/^[-–—]{3,}/.test(last.trim())) {
    return { body: lines.slice(0, -1).join("\n").trimEnd(), signature: last.trim().replace(/^[—–-]\s?/, "— ") };
  }
  return { body: text, signature: null };
}

function BubbleImpl({
  message,
  faceId,
  showFace = true,
  showMeta = true,
  pending,
  failed,
  highlighted = false,
  api,
  onOpenAttachment,
  speakerName,
  replyTo,
  onPressReplyTo,
  onReply,
  onLongPress,
  onRetry,
}: BubbleProps) {
  const mine = message.author === "jp";
  const { colors } = useAppTheme();
  const { width } = useWindowDimensions();
  const faceSize = width < MOBILE_THREAD_BREAKPOINT ? MOBILE_FACE_SIZE : THREAD_FACE_SIZE;
  const attachments = message.attachments ?? [];
  const hasText = message.text.trim().length > 0;
  const { body, signature } = mine ? { body: message.text, signature: null } : splitSignature(message.text);
  // Charts, drawings, diagrams and tables size themselves to the bubble, so
  // those bubbles take the full column; plain text shrinks to fit.
  const rich = /```|^\s*\|.+\|\s*$|!\[[^\]]*\]\(/m.test(body);

  // Handlers come from the thread as stable callbacks taking the message, so
  // the memo below holds; the refs let the one-time PanResponder see them.
  const replyRef = useRef(onReply);
  replyRef.current = onReply;
  const messageRef = useRef(message);
  messageRef.current = message;

  // Swipe right to reply, like WhatsApp: the row follows the finger a little,
  // a reply glyph fades in, and past the threshold the reply is armed. iOS
  // PWAs have no haptics, so the glyph also fills in when armed.
  const dragX = useRef(new Animated.Value(0)).current;
  const armed = useRef(false);
  const armedGlyph = useRef(new Animated.Value(0)).current;
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Boolean(replyRef.current) && g.dx > 12 && g.dx > Math.abs(g.dy) * 1.6,
      onPanResponderMove: (_e, g) => {
        const x = Math.max(0, Math.min(g.dx, 120)) * 0.7;
        dragX.setValue(x);
        if (!armed.current && g.dx > SWIPE_TRIGGER) {
          armed.current = true;
          armedGlyph.setValue(1);
          haptic("tap");
        }
        if (armed.current && g.dx <= SWIPE_TRIGGER) {
          armed.current = false;
          armedGlyph.setValue(0);
        }
      },
      onPanResponderRelease: () => {
        const fire = armed.current;
        armed.current = false;
        armedGlyph.setValue(0);
        Animated.spring(dragX, { toValue: 0, useNativeDriver: true, friction: 7 }).start();
        if (fire) replyRef.current?.(messageRef.current);
      },
      onPanResponderTerminate: () => {
        armed.current = false;
        armedGlyph.setValue(0);
        Animated.spring(dragX, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  // Desktop: right-click opens the same menu as a long-press, and covers
  // attachment-only messages, which have no bubble to hold.
  const rowRef = useRef<View>(null);
  const longPressRef = useRef(onLongPress);
  longPressRef.current = onLongPress;
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = rowRef.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return;
    const onContextMenu = (event: MouseEvent) => {
      if (!longPressRef.current) return;
      event.preventDefault();
      longPressRef.current(messageRef.current);
    };
    node.addEventListener("contextmenu", onContextMenu);
    return () => node.removeEventListener("contextmenu", onContextMenu);
  }, []);

  const quoteInside = Boolean(replyTo && hasText);
  const quote = replyTo ? (
    <Pressable
      onPress={() => onPressReplyTo?.(replyTo.id)}
      accessibilityRole="button"
      accessibilityLabel={`Replying to ${replyTo.who}: ${replyTo.snippet}`}
      style={({ pressed }) => [
        styles.quote,
        quoteInside ? styles.quoteInside : mine ? styles.quoteMine : null,
        mine && quoteInside
          ? { borderLeftColor: colors.onAccent, backgroundColor: `${colors.onAccent}1f` }
          : { borderLeftColor: colors.textFaint, backgroundColor: colors.accentSoft },
        { opacity: pressed ? 0.7 : 1 },
      ]}
    >
      <Text variant="caption" color={mine && quoteInside ? colors.onAccent : colors.text} numberOfLines={1} style={styles.quoteWho}>
        {replyTo.who}
      </Text>
      <Text variant="caption" color={mine && quoteInside ? colors.onAccent : undefined} numberOfLines={1} style={mine && quoteInside ? styles.quoteSnippetMine : null}>
        {replyTo.snippet}
      </Text>
    </Pressable>
  ) : null;

  return (
    <View ref={rowRef} style={styles.swipeFrame}>
      {onReply ? (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.swipeGlyph,
            {
              opacity: dragX.interpolate({ inputRange: [0, 20, SWIPE_TRIGGER * 0.7], outputRange: [0, 0.3, 1], extrapolate: "clamp" }),
              backgroundColor: colors.surfaceAlt,
              transform: [{ scale: armedGlyph.interpolate({ inputRange: [0, 1], outputRange: [1, 1.15] }) }],
            },
          ]}
        >
          <Animated.View style={[StyleSheet.absoluteFill, styles.swipeGlyphFill, { backgroundColor: colors.accent, opacity: armedGlyph.interpolate({ inputRange: [0, 1], outputRange: [0, 0.18] }) }]} />
          <ReplyIcon size={14} color={colors.textDim} />
        </Animated.View>
      ) : null}
      <Animated.View
        {...(onReply ? pan.panHandlers : {})}
        accessibilityState={{ selected: highlighted }}
        style={[
          styles.row,
          showMeta || failed ? null : styles.rowRun,
          mine ? styles.rowMine : styles.rowTheirs,
          { transform: [{ translateX: dragX }] },
        ]}
      >
        {!mine ? (
          <View style={[styles.gutter, { width: faceSize }]}>
            {showFace && faceId ? <InternFace id={faceId} size={faceSize} /> : null}
          </View>
        ) : null}
        <View style={[styles.column, mine ? styles.columnMine : styles.columnTheirs]}>
          {speakerName ? (
            <Text variant="caption" style={styles.speaker}>
              {speakerName}
            </Text>
          ) : null}
          {quote && !quoteInside ? quote : null}
          {hasText ? (
            <Pressable
              onLongPress={onLongPress ? () => onLongPress(message) : undefined}
              delayLongPress={380}
              disabled={!onLongPress}
              accessibilityHint={onLongPress ? "Long-press for message actions" : undefined}
              accessibilityActions={onLongPress ? [{ name: "longpress", label: "Message actions" }] : undefined}
              onAccessibilityAction={(event) => {
                if (event.nativeEvent.actionName === "longpress") onLongPress?.(message);
              }}
              style={({ pressed }) => [
                styles.bubble,
                rich ? styles.bubbleRich : null,
                pressed && onLongPress ? { opacity: 0.85 } : null,
                mine
                  ? [styles.mine, { backgroundColor: colors.accent }]
                  : [styles.theirs, { backgroundColor: colors.surfaceAlt }],
                failed ? { borderWidth: 1, borderColor: colors.urgent } : null,
                highlighted ? { borderWidth: 2, borderColor: colors.info } : null,
                pending ? styles.pending : null,
              ]}
            >
              {quoteInside ? quote : null}
              {hasMarkdown(body) ? (
                // Interns write markdown; raw ** and backticks in a bubble is a bug.
                <Markdown body={body} variant="message" tone={mine ? "onAccent" : "default"} surface={mine ? colors.accent : colors.surfaceAlt} />
              ) : (
                <Text variant="message" color={mine ? colors.onAccent : colors.text}>
                  {body}
                </Text>
              )}
              {signature ? (
                <Text variant="caption" color={colors.textDim} style={styles.signature}>
                  {signature}
                </Text>
              ) : null}
              {message.pinned ? (
                <Text variant="caption" color={mine ? colors.onAccent : colors.textFaint} style={styles.pinnedMark}>
                  📌 pinned
                </Text>
              ) : null}
            </Pressable>
          ) : null}
          {attachments.length && api ? (
            <View style={pending ? styles.pending : null}>
              <AttachmentList attachments={attachments} api={api} mine={mine} onOpen={(att) => onOpenAttachment?.(att)} />
            </View>
          ) : null}
        </View>
      </Animated.View>
      {/* Under the row, not in it: the face lines up with the bubble's foot. */}
      <View style={[styles.metaRow, mine ? styles.metaRowMine : { paddingLeft: faceSize + space.sm }, showMeta || failed ? styles.rowEnd : null]}>
          {failed ? (
        <Pressable
          onPress={() => onRetry?.(message)}
          disabled={!onRetry}
          accessibilityRole="button"
          accessibilityLabel="Not sent. Tap to try again"
          hitSlop={8}
          style={[styles.meta, styles.metaMine]}
        >
          <Text variant="caption" color={colors.urgent}>
            Not sent · <Text variant="caption" color={colors.urgent} style={styles.retry}>Tap to retry</Text>
          </Text>
        </Pressable>
      ) : showMeta ? (
        <View style={[styles.meta, mine ? styles.metaMine : null]}>
          <Text variant="caption">{pending ? "Sending…" : clockTime(message.ts)}</Text>
          {/* Absence of the glyph means "from here" (the app); only a
              Discord-origin message gets the marker. */}
          {message.surface === "discord" ? (
            <View style={styles.discordMark} accessible accessibilityLabel="sent from Discord">
              <DiscordIcon size={11} color={colors.textFaint} />
            </View>
          ) : null}
          {onReply && !pending ? (
            <Pressable
              onPress={() => onReply(message)}
              accessibilityRole="button"
              accessibilityLabel="Reply to this message"
              hitSlop={12}
              style={styles.replyAction}
            >
              <ReplyIcon size={14} color={colors.textFaint} />
            </Pressable>
          ) : null}
        </View>
      ) : null}
      </View>
    </View>
  );
}

/** Memoised: a long thread re-renders on every stream event. */
export const Bubble = React.memo(BubbleImpl);

export function DayDivider({ label }: { label: string }) {
  return (
    <View style={styles.divider}>
      <Text variant="label">{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  swipeFrame: { position: "relative" },
  swipeGlyph: { position: "absolute", left: 0, top: "50%", marginTop: -14, width: 28, height: 28, borderRadius: 14, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  swipeGlyphFill: { borderRadius: 14 },
  row: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  // Bubbles in one speaker's run sit close; the run ends with breathing room.
  rowRun: { marginBottom: space.xs },
  rowEnd: { marginBottom: space.md },
  rowMine: { justifyContent: "flex-end", paddingLeft: space.xxxl },
  rowTheirs: { justifyContent: "flex-start", paddingRight: space.lg },
  gutter: { alignItems: "center" },
  // The width cap lives on the column, and the bubble is held to the column:
  // a bubble capped only at 560 grows to fit a nowrap reply quote and runs
  // off a phone screen (left for yours, right for theirs).
  column: { flexShrink: 1, minWidth: 0, maxWidth: 560 },
  columnMine: { alignItems: "flex-end" },
  columnTheirs: { flex: 1, alignItems: "flex-start" },
  bubble: {
    paddingVertical: space.md - 2,
    paddingHorizontal: space.lg - 2,
    borderRadius: radius.lg,
    maxWidth: "100%",
  },
  bubbleRich: { alignSelf: "stretch" },
  mine: { borderBottomRightRadius: radius.sm },
  theirs: {
    borderBottomLeftRadius: radius.sm,
    shadowColor: "#000000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 6,
    elevation: 1,
  },
  pending: { opacity: 0.6 },
  speaker: { marginBottom: 3, marginLeft: space.xs, fontWeight: "600" },
  signature: { marginTop: space.sm, fontStyle: "italic" },
  pinnedMark: { marginTop: space.xs },
  // nowrap single-line text would otherwise widen the column past the row: cap and clip.
  quote: { borderLeftWidth: 3, borderRadius: radius.sm, paddingHorizontal: space.sm, paddingVertical: 4, marginBottom: 4, maxWidth: 300, minWidth: 0, overflow: "hidden", alignSelf: "flex-start" },
  quoteInside: { maxWidth: "100%", alignSelf: "stretch", marginBottom: space.sm },
  quoteMine: { alignSelf: "flex-end" },
  quoteWho: { fontWeight: "600" },
  quoteSnippetMine: { opacity: 0.8 },
  metaRow: { flexDirection: "row" },
  metaRowMine: { justifyContent: "flex-end" },
  meta: { flexDirection: "row", alignItems: "center", marginTop: space.xs, paddingHorizontal: space.xs },
  metaMine: { alignSelf: "flex-end" },
  retry: { fontWeight: "600", textDecorationLine: "underline" },
  replyAction: { marginLeft: space.sm, padding: 2 },
  discordMark: { marginLeft: space.xs },
  divider: { alignItems: "center", marginVertical: space.lg },
});
