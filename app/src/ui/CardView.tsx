/**
 * A card from the orchestrator: severity edge, markdown body, action row.
 * Firing an action POSTs /cards/:id/actions/:actionId, flips the card into a
 * resolved state, and animates out; the parent is told once the animation is
 * done so the list can drop it.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Linking, Modal, PanResponder, Pressable, StyleSheet, TextInput, View } from "react-native";
import { haptic } from "../haptics";
import type { Card, CardAction } from "../api";
import { friendlyError } from "../errors";
import { useReducedMotion } from "../motion";
import { radius, scaledFont, severityColor, space, useAppTheme, type AppColors } from "../theme";
import { relativeTime } from "../time";
import { Button, type ButtonTone } from "./Button";
import { CheckIcon, ChevronDownIcon } from "./Icons";
import { InternFace, resolveFaceId } from "./InternFace";
import { cleanMessagePreview, Markdown } from "./Markdown";
import { Text } from "./Text";

const TONE_BY_STYLE: Record<CardAction["style"], ButtonTone> = {
  primary: "primary",
  success: "success",
  neutral: "neutral",
};

export interface CardViewProps {
  card: Card;
  /** avatar id of the card's intern (resolved by the caller from /interns) */
  faceId?: string;
  internName?: string;
  onAction: (card: Card, action: CardAction, note?: string) => Promise<Card>;
  /** called after the resolve animation finishes */
  onResolved?: (card: Card) => void;
  highlighted?: boolean;
  /**
   * Inbox triage: the body folds to a one-line preview behind "Details" so a
   * screenful shows several cards, not one and a half. Actions stay visible.
   */
  collapsible?: boolean;
}

/** How long a swiped action waits for an Undo before it is sent. */
const UNDO_WINDOW_MS = 4_000;

const SEVERITY_LABEL: Record<string, string> = { urgent: "Urgent", action: "Needs you", info: "FYI" };

export function CardView({ card, faceId, internName, onAction, onResolved, highlighted = false, collapsible = false }: CardViewProps) {
  const { colors, fontScale } = useAppTheme();
  const reduced = useReducedMotion();
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Card | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [expanded, setExpanded] = useState(!collapsible);
  /** a swiped action counting down, with Undo */
  const [queued, setQueued] = useState<CardAction | null>(null);
  const queuedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [prompt, setPrompt] = useState<CardAction | null>(null);
  const [note, setNote] = useState("");
  const anim = useRef(new Animated.Value(1)).current;
  const highlightPulse = useRef(new Animated.Value(0)).current;
  const dragX = useRef(new Animated.Value(0)).current;
  const [reaction, setReaction] = useState<{ kind: "grin" | "nod"; key: number } | null>(null);
  const edge = severityColor(colors, card.severity);
  const github = githubReviewContext(card);

  const run = useCallback(
    async (action: CardAction, noteValue?: string) => {
      setBusyAction(action.id);
      setError(null);
      try {
        const updated = await onAction(card, action, noteValue);
        // The intern's face grins when its work is accepted, nods when it is just acknowledged.
        setReaction({ kind: action.style === "success" || action.style === "primary" ? "grin" : "nod", key: Date.now() });
        haptic(action.style === "success" ? "success" : "tap");
        setResolved(updated);
      } catch (e) {
        setError(e);
        haptic("warning");
      } finally {
        setBusyAction(null);
      }
    },
    [card, onAction],
  );

  // The parent passes an inline onResolved; reading it through a ref keeps a
  // busy stream (each event re-renders the list) from restarting the timer
  // and leaving a resolved card on screen indefinitely.
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  useEffect(() => {
    if (!resolved) return;
    const timer = setTimeout(() => {
      Animated.timing(anim, {
        toValue: 0,
        duration: reduced ? 0 : 320,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start(() => onResolvedRef.current?.(resolved));
    }, 850);
    return () => clearTimeout(timer);
  }, [resolved, anim, reduced]);

  useEffect(() => () => {
    if (queuedTimer.current) clearTimeout(queuedTimer.current);
  }, []);

  useEffect(() => {
    if (!highlighted) {
      highlightPulse.stopAnimation();
      highlightPulse.setValue(0);
      return;
    }
    if (reduced) {
      highlightPulse.setValue(1);
      return;
    }
    highlightPulse.setValue(0);
    Animated.sequence([
      Animated.timing(highlightPulse, { toValue: 1, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: false }),
      Animated.delay(750),
      Animated.timing(highlightPulse, { toValue: 0, duration: 520, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
    ]).start();
  }, [highlighted, highlightPulse, reduced]);

  const press = (action: CardAction) => {
    if (action.kind === "button") void run(action);
    else {
      setNote("");
      setPrompt(action);
    }
  };

  /** A swipe is easy to do by accident: hold the action for a few seconds with Undo. */
  const queueSwipe = (action: CardAction) => {
    if (action.kind !== "button") return press(action);
    haptic("tap");
    setQueued(action);
    if (queuedTimer.current) clearTimeout(queuedTimer.current);
    queuedTimer.current = setTimeout(() => {
      queuedTimer.current = null;
      setQueued(null);
      void run(action);
    }, UNDO_WINDOW_MS);
  };
  const undoSwipe = () => {
    if (queuedTimer.current) clearTimeout(queuedTimer.current);
    queuedTimer.current = null;
    setQueued(null);
  };

  // The PanResponder is created once; it reads live state through this ref so
  // a second swipe while one is pending, sending or resolved does nothing.
  const swipeState = useRef({ locked: false, queue: queueSwipe });
  swipeState.current = { locked: Boolean(busyAction || resolved || queued), queue: queueSwipe };

  // Swipe like mail: right = the affirmative action (success, else primary),
  // left = snooze/dismiss (a "later"/"snooze"/"ignore"/"dismiss"/"drop" button).
  const swipeRight = card.actions.find((a) => a.kind === "button" && a.style === "success") ?? card.actions.find((a) => a.kind === "button" && a.style === "primary") ?? null;
  const swipeLeft = card.actions.find((a) => a.kind === "button" && /^(later|snooze|ignore|dismiss|drop|skip|never|ack)$/i.test(a.id)) ?? null;
  const SWIPE_TRIGGER = 96;
  const armed = useRef(false);
  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => !swipeState.current.locked && Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
      onPanResponderMove: (_e, g) => {
        const allowed = (g.dx > 0 && swipeRight) || (g.dx < 0 && swipeLeft);
        dragX.setValue(allowed ? g.dx * 0.85 : g.dx * 0.15);
        const past = Boolean(allowed) && Math.abs(g.dx) > SWIPE_TRIGGER;
        if (past && !armed.current) haptic("tap");
        armed.current = past;
      },
      onPanResponderRelease: (_e, g) => {
        armed.current = false;
        const action = g.dx > SWIPE_TRIGGER ? swipeRight : g.dx < -SWIPE_TRIGGER ? swipeLeft : null;
        Animated.spring(dragX, { toValue: 0, useNativeDriver: true, friction: 7 }).start();
        if (action && !swipeState.current.locked) swipeState.current.queue(action);
      },
      onPanResponderTerminate: () => {
        armed.current = false;
        Animated.spring(dragX, { toValue: 0, useNativeDriver: true }).start();
      },
    }),
  ).current;

  return (
    <Animated.View
      style={{
        opacity: anim,
        transform: [
          { scale: reduced ? 1 : anim.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
        ],
      }}
    >
      {swipeRight ? (
        <Animated.View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.swipeHint, styles.swipeHintRight, { opacity: dragX.interpolate({ inputRange: [0, 40, SWIPE_TRIGGER * 0.85], outputRange: [0, 0.4, 1], extrapolate: "clamp" }), transform: [{ scale: dragX.interpolate({ inputRange: [0, SWIPE_TRIGGER * 0.85, SWIPE_TRIGGER * 0.86], outputRange: [0.9, 0.95, 1.08], extrapolate: "clamp" }) }] }]}>
          <Text variant="label" color={colors.success}>{swipeRight.label}</Text>
        </Animated.View>
      ) : null}
      {swipeLeft ? (
        <Animated.View pointerEvents="none" aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[styles.swipeHint, styles.swipeHintLeft, { opacity: dragX.interpolate({ inputRange: [-SWIPE_TRIGGER * 0.85, -40, 0], outputRange: [1, 0.4, 0], extrapolate: "clamp" }), transform: [{ scale: dragX.interpolate({ inputRange: [-SWIPE_TRIGGER * 0.86, -SWIPE_TRIGGER * 0.85, 0], outputRange: [1.08, 0.95, 0.9], extrapolate: "clamp" }) }] }]}>
          <Text variant="label" color={colors.textDim}>{swipeLeft.label}</Text>
        </Animated.View>
      ) : null}
      <Animated.View
        {...pan.panHandlers}
        accessibilityState={{ selected: highlighted }}
        style={[
          styles.card,
          {
            transform: [{ translateX: dragX }],
            backgroundColor: highlightPulse.interpolate({ inputRange: [0, 1], outputRange: [colors.surface, colors.accentSoft] }),
            borderColor: highlightPulse.interpolate({ inputRange: [0, 1], outputRange: [card.severity === "urgent" ? edge : colors.border, colors.info] }),
          },
        ]}
      >
        <View style={styles.content}>
          <Pressable
            onPress={collapsible ? () => setExpanded((v) => !v) : undefined}
            disabled={!collapsible}
            accessibilityRole={collapsible ? "button" : undefined}
            accessibilityState={collapsible ? { expanded } : undefined}
            accessibilityHint={collapsible ? (expanded ? "Hide details" : "Show details") : undefined}
            style={styles.header}
          >
            {faceId ? <InternFace id={faceId} size={34} reaction={reaction?.kind ?? null} reactionKey={reaction?.key} /> : null}
            <View style={styles.headerText}>
              <Text variant="title">{card.title}</Text>
              <View style={styles.metaRow}>
                <View style={[styles.severity, { backgroundColor: severitySoft(colors, card.severity) }]}>
                  <Text variant="caption" color={edge} style={styles.severityLabel}>{SEVERITY_LABEL[card.severity] ?? card.severity}</Text>
                </View>
                <Text variant="caption" numberOfLines={1} style={styles.metaText}>
                  {(internName ?? card.intern) + " · " + relativeTime(card.created_at)}
                </Text>
              </View>
            </View>
            {collapsible && (card.body?.trim() || github) ? (
              <View style={expanded ? styles.chevronUp : null}>
                <ChevronDownIcon size={18} color={colors.textDim} />
              </View>
            ) : null}
          </Pressable>

          {github ? <GithubReviewSummary review={github} expanded={expanded} /> : null}

          {!resolved && !queued && github && card.actions.length ? (
            <View style={styles.actions}>
              {card.actions.map((action) => (
                <Button
                  key={action.id}
                  small
                  label={action.kind === "button" ? action.label : `${action.label}…`}
                  tone={TONE_BY_STYLE[action.style] ?? "neutral"}
                  busy={busyAction === action.id}
                  disabled={busyAction !== null && busyAction !== action.id}
                  onPress={() => press(action)}
                />
              ))}
            </View>
          ) : null}

          {card.body?.trim() ? (
            expanded ? (
              <View style={[styles.body, github && styles.githubBody, github && { borderTopColor: colors.border }]}>
                <Markdown body={card.body} />
              </View>
            ) : !github ? (
              <Pressable onPress={() => setExpanded(true)} accessibilityRole="button" accessibilityLabel="Show details" style={styles.body}>
                <Text variant="subtle" numberOfLines={2}>{cleanMessagePreview(card.body)}</Text>
              </Pressable>
            ) : null
          ) : null}

          {error ? (
            <Text variant="subtle" color={colors.urgent} style={{ marginTop: space.sm }}>
              {friendlyError(error).message}
            </Text>
          ) : null}

          {queued ? (
            <View style={[styles.queued, { backgroundColor: colors.surfaceAlt }]} accessibilityLiveRegion="polite">
              <Text variant="subtle" color={colors.text} style={styles.queuedText}>{queued.label}…</Text>
              <Pressable onPress={undoSwipe} accessibilityRole="button" accessibilityLabel={`Undo ${queued.label}`} hitSlop={10}>
                <Text variant="subtle" color={colors.info} style={styles.undo}>Undo</Text>
              </Pressable>
            </View>
          ) : resolved ? (
            <View style={styles.resolved}>
              <CheckIcon size={16} color={colors.success} />
              <Text variant="subtle" color={colors.success}>
                {resolvedLabel(resolved, card)}
              </Text>
            </View>
          ) : !github && card.actions.length ? (
            <View style={[styles.actions, !expanded && styles.actionsTight]}>
              {card.actions.map((action) => (
                <Button
                  key={action.id}
                  small
                  label={action.kind === "button" ? action.label : `${action.label}…`}
                  tone={TONE_BY_STYLE[action.style] ?? "neutral"}
                  busy={busyAction === action.id}
                  disabled={busyAction !== null && busyAction !== action.id}
                  onPress={() => press(action)}
                />
              ))}
            </View>
          ) : null}
        </View>
      </Animated.View>

      <Modal transparent visible={prompt !== null} animationType="fade" onRequestClose={() => setPrompt(null)}>
        <Pressable style={[styles.backdrop, { backgroundColor: colors.overlay }]} onPress={() => setPrompt(null)}>
          <Pressable style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]} onPress={(e) => e.stopPropagation()}>
            <Text variant="title">{prompt?.label}</Text>
            <Text variant="subtle" style={{ marginTop: space.xs }}>
              {prompt?.kind === "date"
                ? "Enter a date (YYYY-MM-DD) or a phrase like “next Tuesday”."
                : "Add a note to send with this action."}
            </Text>
            <TextInput
              value={note}
              onChangeText={setNote}
              autoFocus
              placeholder={prompt?.kind === "date" ? "2026-09-01" : "Note…"}
              placeholderTextColor={colors.textFaint}
              style={[styles.input, { backgroundColor: colors.bg, borderColor: colors.border, color: colors.text, fontSize: scaledFont(15, fontScale) }]}
              multiline={prompt?.kind === "text"}
            />
            <View style={styles.sheetActions}>
              <Button small tone="ghost" label="Cancel" onPress={() => setPrompt(null)} />
              <Button
                small
                tone="primary"
                label="Confirm"
                disabled={!note.trim()}
                onPress={() => {
                  const action = prompt;
                  setPrompt(null);
                  if (action) void run(action, note.trim());
                }}
              />
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </Animated.View>
  );
}

interface GithubReviewContext {
  repository: string;
  pullNumber: number;
  primaryUrl: string;
  primaryLabel: string;
  githubUrl: string;
  codeopsUrl: string | null;
  recommendation: string;
  risk: "low" | "medium" | "high" | "unknown";
  changedFiles: number;
  additions: number;
  deletions: number;
  checks: { total: number; passed: number; failed: number; pending: number };
  inlineComments: number;
}

function githubReviewContext(card: Card): GithubReviewContext | null {
  const context = card.context ?? {};
  if (context.type !== "github_review" || typeof context.repository !== "string") return null;
  const checks = context.checks && typeof context.checks === "object"
    ? context.checks as Record<string, unknown>
    : {};
  const risk = String(context.risk ?? "unknown");
  const fallbackGithub = `https://github.com/${context.repository}/pull/${context.pull_number}`;
  const githubUrl = String(context.github_url ?? context.url ?? fallbackGithub);
  const codeopsUrl = typeof context.codeops_url === "string" ? context.codeops_url : null;
  return {
    repository: context.repository,
    pullNumber: Number(context.pull_number ?? 0),
    primaryUrl: String(context.primary_url ?? context.url ?? codeopsUrl ?? githubUrl),
    primaryLabel: String(context.primary_label ?? (codeopsUrl ? "CodeOps" : "GitHub")),
    githubUrl,
    codeopsUrl,
    recommendation: String(context.recommendation ?? "COMMENT").replaceAll("_", " "),
    risk: risk === "low" || risk === "medium" || risk === "high" ? risk : "unknown",
    changedFiles: Number(context.changed_files ?? 0),
    additions: Number(context.additions ?? 0),
    deletions: Number(context.deletions ?? 0),
    checks: {
      total: Number(checks.total ?? 0),
      passed: Number(checks.passed ?? 0),
      failed: Number(checks.failed ?? 0),
      pending: Number(checks.pending ?? 0),
    },
    inlineComments: Number(context.inline_comments ?? 0),
  };
}

function severitySoft(colors: AppColors, severity: string): string {
  return severity === "urgent" ? colors.destructiveSoft : severity === "action" ? colors.actionSoft : colors.accentSoft;
}

function GithubReviewSummary({ review, expanded = true }: { review: GithubReviewContext; expanded?: boolean }) {
  const { colors } = useAppTheme();
  const riskColor = review.risk === "high" ? colors.urgent : review.risk === "medium" ? colors.action : colors.success;
  const checksColor = review.checks.failed > 0 ? colors.urgent : review.checks.pending > 0 ? colors.action : colors.success;
  return (
    <View style={styles.githubSummary}>
      <View style={styles.githubTopline}>
        <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(review.primaryUrl)}>
          <Text variant="subtle" color={colors.text} style={styles.repoLink}>
            {review.repository} #{review.pullNumber}
          </Text>
        </Pressable>
        <View style={[styles.riskBadge, { backgroundColor: colors.surfaceAlt, borderColor: riskColor }]}>
          <Text variant="caption" color={riskColor}>{review.risk} risk</Text>
        </View>
      </View>
      <Text variant="caption">
        Recommendation · {review.recommendation.toLowerCase()}
        {!expanded ? ` · ${review.checks.total ? `${review.checks.passed}/${review.checks.total} checks` : "no checks"} · +${review.additions} −${review.deletions}` : ""}
      </Text>
      {expanded ? (
      <>
      <View style={styles.reviewLinks}>
        <ReviewLink label={`Open in ${review.primaryLabel}`} url={review.primaryUrl} />
        {review.codeopsUrl && review.githubUrl !== review.primaryUrl ? <ReviewLink label="GitHub" url={review.githubUrl} /> : null}
      </View>
      <View style={styles.stats}>
        <Stat label="Files" value={String(review.changedFiles)} />
        <Stat label="Changes" value={`+${review.additions} −${review.deletions}`} />
        <Stat
          label="Checks"
          value={review.checks.total ? `${review.checks.passed}/${review.checks.total} passed` : "No checks"}
          color={checksColor}
        />
        <Stat label="Comments" value={String(review.inlineComments)} />
      </View>
      {review.checks.failed || review.checks.pending ? (
        <Text variant="caption" color={checksColor}>
          {review.checks.failed ? `${review.checks.failed} failed` : ""}
          {review.checks.failed && review.checks.pending ? " · " : ""}
          {review.checks.pending ? `${review.checks.pending} pending` : ""}
        </Text>
      ) : null}
      </>
      ) : null}
    </View>
  );
}

function ReviewLink({ label, url }: { label: string; url: string }) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      accessibilityRole="link"
      onPress={() => void Linking.openURL(url)}
      style={({ pressed }) => [
        styles.reviewLink,
        { borderColor: colors.border, backgroundColor: colors.surfaceAlt, opacity: pressed ? 0.65 : 1 },
      ]}
    >
      <Text variant="caption" color={colors.text}>{label} ↗</Text>
    </Pressable>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.stat, { backgroundColor: colors.surfaceAlt }]}>
      <Text variant="caption">{label}</Text>
      <Text variant="subtle" color={color ?? colors.text}>{value}</Text>
    </View>
  );
}

function resolvedLabel(resolved: Card, original: Card): string {
  const actionId = resolved.resolution?.action;
  const label = original.actions.find((a) => a.id === actionId)?.label ?? actionId ?? "Done";
  const note = resolved.resolution?.note;
  return note ? `${label} — ${note}` : label;
}

const styles = StyleSheet.create({
  swipeHint: { position: "absolute", top: 0, bottom: 0, justifyContent: "center", paddingHorizontal: space.lg },
  swipeHintRight: { left: 0 },
  swipeHintLeft: { right: 0 },
  card: {
    flexDirection: "row",
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    marginBottom: space.md,
  },
  content: { flex: 1, padding: space.lg },
  header: { flexDirection: "row", alignItems: "center", gap: space.md },
  headerText: { flex: 1 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: 4 },
  metaText: { flexShrink: 1 },
  severity: { borderRadius: radius.sm, paddingHorizontal: 6, paddingVertical: 1 },
  severityLabel: { fontWeight: "600" },
  chevronUp: { transform: [{ rotate: "180deg" }] },
  queued: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, marginTop: space.lg, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  queuedText: { flex: 1 },
  undo: { fontWeight: "700" },
  actionsTight: { marginTop: space.md },
  body: { marginTop: space.md },
  githubBody: { paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth },
  githubSummary: { gap: space.sm, marginTop: space.md },
  githubTopline: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  repoLink: { fontWeight: "600" },
  reviewLinks: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  reviewLink: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.sm, paddingVertical: 6 },
  riskBadge: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 3 },
  stats: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  stat: { minWidth: 76, flexGrow: 1, gap: 2, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.lg },
  resolved: { flexDirection: "row", alignItems: "center", gap: space.sm, marginTop: space.lg },
  backdrop: {
    flex: 1,
    justifyContent: "center",
    padding: space.xl,
  },
  sheet: {
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.xl,
    maxWidth: 460,
    width: "100%",
    alignSelf: "center",
    gap: space.sm,
  },
  input: {
    marginTop: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.md,
    fontSize: 15,
    minHeight: 44,
  },
  sheetActions: { flexDirection: "row", justifyContent: "flex-end", gap: space.sm, marginTop: space.md },
});
