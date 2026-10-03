/**
 * A multiline input that sizes to its text: a few lines while you read the
 * form, then grows downward to show everything once you tap into it, so long
 * prompts scroll with the page instead of inside a little box. On blur it
 * folds back to `collapsedLines` (whole lines, with a fade hinting at the
 * rest) and returns to the top of the text.
 *
 * Height comes from invisible copies of the text laid out with the same box
 * styles, rather than onContentSizeChange — react-native-web only reports
 * that on typing (not when a rename rewrites the value) and never reports a
 * shrink.
 */
import React, { useEffect, useId, useRef, useState } from "react";
import {
  Animated,
  Platform,
  StyleSheet,
  Text as RNText,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useAppTheme } from "../theme";

export function GrowingInput({
  value,
  style,
  minHeight = 0,
  collapsedLines,
  onFocus,
  onBlur,
  ...rest
}: Omit<TextInputProps, "multiline" | "style"> & {
  value: string;
  /** Box and font styles, shared with the measuring copies: set lineHeight, and no height. */
  style: StyleProp<TextStyle>;
  minHeight?: number;
  /** How many lines show while the input isn't focused. */
  collapsedLines: number;
}) {
  const [focused, setFocused] = useState(false);
  const [contentHeight, setContentHeight] = useState(minHeight);
  const [oneLineHeight, setOneLineHeight] = useState(0);
  const input = useRef<TextInput>(null);

  const flat = StyleSheet.flatten(style);
  const lineHeight = flat.lineHeight ?? 20;
  const full = Math.max(minHeight, Math.ceil(contentHeight));
  const collapsed = Math.max(minHeight, Math.ceil(oneLineHeight + (collapsedLines - 1) * lineHeight));
  const truncated = !focused && oneLineHeight > 0 && full > collapsed + 1;
  const border = flat.borderBottomWidth ?? flat.borderWidth ?? 0;

  return (
    <View>
      <RNText style={[style, styles.ghost]} onLayout={(e) => setOneLineHeight(e.nativeEvent.layout.height)} aria-hidden>
        {" "}
      </RNText>
      <RNText style={[style, styles.ghost]} onLayout={(e) => setContentHeight(e.nativeEvent.layout.height)} aria-hidden>
        {/* a trailing newline needs a line of its own, as it does in the input */}
        {value.endsWith("\n") || !value ? `${value} ` : value}
      </RNText>
      <TextInput
        ref={input}
        {...rest}
        value={value}
        multiline
        scrollEnabled={!focused}
        style={[style, { height: truncated ? collapsed : full }]}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          // Fold back to the start of the text, not wherever the caret left it.
          if (Platform.OS === "web") (input.current as unknown as HTMLElement | null)?.scrollTo?.({ top: 0 });
          onBlur?.(e);
        }}
      />
      {truncated ? (
        <Fade
          color={typeof flat.backgroundColor === "string" ? flat.backgroundColor : "transparent"}
          style={{ left: border + 2, right: border + 2, bottom: border, height: lineHeight * 1.5 }}
        />
      ) : null}
    </View>
  );
}

/** Transparent → `color`, top to bottom: the last collapsed line fades out. */
function Fade({ color, style }: { color: string; style: StyleProp<ViewStyle> }) {
  const id = `fade-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <View pointerEvents="none" style={[styles.fade, style]}>
      <Svg width="100%" height="100%" preserveAspectRatio="none">
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={0} />
            <Stop offset="0.75" stopColor={color} stopOpacity={1} />
          </LinearGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

/**
 * Briefly washes its children in the action color whenever `pulse` changes —
 * used to show which fields a rename just rewrote.
 */
export function Flash({
  pulse,
  radius,
  style,
  children,
}: {
  pulse: number;
  radius: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  const { colors } = useAppTheme();
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!pulse) return;
    opacity.setValue(0.28);
    Animated.timing(opacity, { toValue: 0, duration: 900, useNativeDriver: Platform.OS !== "web" }).start();
  }, [pulse, opacity]);

  return (
    <View style={style}>
      {children}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: radius, backgroundColor: colors.action, opacity }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // positioned, so they would otherwise paint over the input and swallow taps
  ghost: { position: "absolute", left: 0, right: 0, opacity: 0, height: undefined, minHeight: 0, pointerEvents: "none" },
  fade: { position: "absolute" },
});
