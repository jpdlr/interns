/**
 * Shown between JP sending a message and the intern's reply arriving. Interns
 * routinely take 30s–2min, so this has to stay pleasant for a long time: the
 * face pops in, keeps a gentle bob, and a thought bubble breathes three dots.
 * Nothing spins, nothing flashes, and after a while the caption softens to
 * "still working on it" so a slow reply never reads as a hung screen.
 */
import React, { useEffect, useRef } from "react";
import { Animated, Easing, Platform, StyleSheet, View } from "react-native";
import { useReducedMotion } from "../motion";
import { radius, space, useAppTheme } from "../theme";
import { InternFace } from "./InternFace";
import { Text } from "./Text";

const NATIVE_DRIVER = Platform.OS !== "web";

export type ThinkingPhase = "thinking" | "still";

export interface ThinkingIndicatorProps {
  faceId: string;
  name: string;
  phase?: ThinkingPhase;
  /** overrides the default caption (the hire flow rotates its own lines) */
  caption?: string;
  size?: number;
  /**
   * Thread layout: laid out like an incoming message (face in the bubble
   * gutter, dots in a bubble, caption under it) instead of centred.
   */
  inline?: boolean;
  /** inline only: the gutter face size, matching the thread's bubbles */
  faceSize?: number;
  /** inline only: a quiet affordance line, e.g. "Tap for options" */
  hint?: string;
}

/** Compact typing affordance for list rows and headers. */
export function TypingDots({
  label = "Typing",
  dotSize = 6,
  announce = true,
}: {
  label?: string;
  dotSize?: number;
  announce?: boolean;
}) {
  const { colors } = useAppTheme();
  return (
    <View
      accessible={announce}
      accessibilityLabel={announce ? label : undefined}
      accessibilityLiveRegion={announce ? "polite" : "none"}
      style={styles.inlineDots}
    >
      <Dot index={0} color={colors.textDim} size={dotSize} />
      <Dot index={1} color={colors.textDim} size={dotSize} />
      <Dot index={2} color={colors.textDim} size={dotSize} />
    </View>
  );
}

/** Avatar treatment used while an intern is composing a chat reply. */
export function TypingAvatar({ faceId, name, size = 48 }: { faceId: string; name: string; size?: number }) {
  const { colors } = useAppTheme();
  return (
    <View style={[styles.avatarWrap, { width: size, height: size }]}>
      <InternFace id={faceId} size={size} clipToBounds mood="thinking" />
      <View
        pointerEvents="none"
        style={[styles.avatarThought, { backgroundColor: colors.surface, borderColor: colors.border }]}
      >
        <TypingDots label={`${name} is typing`} dotSize={3} announce={false} />
      </View>
      <View
        pointerEvents="none"
        style={[styles.thoughtTailLarge, { backgroundColor: colors.surface, borderColor: colors.border }]}
      />
      <View
        pointerEvents="none"
        style={[styles.thoughtTailSmall, { backgroundColor: colors.surface, borderColor: colors.border }]}
      />
    </View>
  );
}

export function ThinkingIndicator({
  faceId,
  name,
  phase = "thinking",
  caption,
  size = 56,
  inline = false,
  faceSize = 28,
  hint,
}: ThinkingIndicatorProps) {
  const { colors } = useAppTheme();
  const reduced = useReducedMotion();
  const entrance = useRef(new Animated.Value(0)).current;
  const text = caption ?? (phase === "still" ? `${name} is still working on it…` : `${name} is thinking…`);

  useEffect(() => {
    if (reduced) {
      entrance.setValue(1);
      return;
    }
    Animated.spring(entrance, {
      toValue: 1,
      friction: 6,
      tension: 90,
      useNativeDriver: NATIVE_DRIVER,
    }).start();
  }, [entrance, reduced]);

  if (inline) {
    return (
      <Animated.View
        style={[
          styles.inlineWrap,
          {
            opacity: entrance,
            transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }],
          },
        ]}
      >
        <View style={styles.inlineRow}>
          <View style={{ width: faceSize, alignItems: "center" }}>
            <InternFace id={faceId} size={faceSize} mood="thinking" />
          </View>
          <View style={[styles.inlineBubble, { backgroundColor: colors.surfaceAlt }]}>
            <TypingDots label={`${name} is typing`} />
          </View>
        </View>
        <Text variant="caption" style={[styles.inlineCaption, { marginLeft: faceSize + space.sm + space.xs }]}>
          {text}
          {hint ? <Text variant="caption" color={colors.textDim}>{` · ${hint}`}</Text> : null}
        </Text>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      style={[
        styles.wrap,
        {
          opacity: entrance,
          transform: [
            { scale: entrance.interpolate({ inputRange: [0, 1], outputRange: [0.72, 1] }) },
            { translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }) },
          ],
        },
      ]}
    >
      <View style={styles.row}>
        <InternFace id={faceId} size={size} mood="thinking" />
        <View style={[styles.bubble, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <TypingDots label={`${name} is typing`} />
        </View>
      </View>
      <Text variant="caption" center style={styles.caption}>
        {text}
      </Text>
    </Animated.View>
  );
}

/** One breathing dot, offset so the three read as a wave rather than a blink. */
function Dot({ index, color, size }: { index: number; color: string; size: number }) {
  const value = useRef(new Animated.Value(0)).current;
  const reduced = useReducedMotion();

  useEffect(() => {
    if (reduced) {
      // Still readable as "typing", without the wave.
      value.setValue(0.6);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.delay(index * 180),
        Animated.timing(value, {
          toValue: 1,
          duration: 520,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: NATIVE_DRIVER,
        }),
        Animated.timing(value, {
          toValue: 0,
          duration: 520,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: NATIVE_DRIVER,
        }),
        Animated.delay((2 - index) * 180),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [value, index, reduced]);

  return (
    <Animated.View
      style={[
        styles.dot,
        { backgroundColor: color, width: size, height: size, borderRadius: size },
        {
          opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }),
          transform: [
            { translateY: value.interpolate({ inputRange: [0, 1], outputRange: [1.5, -2.5] }) },
          ],
        },
      ]}
    />
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", paddingVertical: space.lg, gap: space.sm },
  row: { flexDirection: "row", alignItems: "center", gap: space.sm },
  bubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs + 1,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.pill,
    borderBottomLeftRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
  },
  inlineDots: {
    height: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs + 1,
  },
  dot: {},
  avatarWrap: { position: "relative", overflow: "visible" },
  avatarThought: {
    position: "absolute",
    left: -24,
    top: 0,
    minWidth: 24,
    height: 16,
    paddingHorizontal: 4,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  thoughtTailLarge: {
    position: "absolute",
    left: -2,
    top: 14,
    width: 6,
    height: 6,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  thoughtTailSmall: {
    position: "absolute",
    left: 4,
    top: 20,
    width: 4,
    height: 4,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  caption: { opacity: 0.9, marginTop: space.xs },
  inlineWrap: { marginTop: space.xs, marginBottom: space.md },
  inlineRow: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  inlineBubble: {
    paddingHorizontal: space.lg - 2,
    paddingVertical: space.md - 1,
    borderRadius: radius.lg,
    borderBottomLeftRadius: radius.sm,
  },
  inlineCaption: { marginTop: space.xs },
});
