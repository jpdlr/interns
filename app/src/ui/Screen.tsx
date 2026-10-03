import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { friendlyError } from "../errors";
import { radius, space, useAppTheme } from "../theme";
import { Text } from "./Text";

/** Page background + a consistent gutter. */
export function Screen({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  const { colors } = useAppTheme();
  return <View style={[styles.screen, { backgroundColor: colors.bg }, style]}>{children}</View>;
}

export function ScreenTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={styles.header}>
      <Text variant="display">{title}</Text>
      {subtitle ? (
        <Text variant="subtle" style={{ marginTop: space.xs }}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.centered}>
      <ActivityIndicator color={colors.accent} />
      <Text variant="subtle" style={{ marginTop: space.md }}>
        {label}
      </Text>
    </View>
  );
}

export function EmptyState({
  title,
  body,
  children,
}: {
  title: string;
  body?: string;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.centered}>
      <Text variant="title" center>
        {title}
      </Text>
      {body ? (
        <Text variant="subtle" center style={{ marginTop: space.sm, maxWidth: 320 }}>
          {body}
        </Text>
      ) : null}
      {children ? <View style={{ marginTop: space.lg }}>{children}</View> : null}
    </View>
  );
}

/**
 * A request failed. Says what happened in plain words, offers Retry when it
 * could help, and keeps the raw server text one tap away under "Details".
 * Pass the thrown value itself (not `e.message`) so it can be classified.
 */
export function ErrorNote({
  error,
  subject,
  onRetry,
  onDismiss,
  style,
}: {
  error: unknown;
  /** what was being fetched, for "Couldn't find …" */
  subject?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  style?: ViewStyle;
}) {
  const { colors } = useAppTheme();
  const [showDetail, setShowDetail] = useState(false);
  const friendly = friendlyError(error, subject);
  const detail = friendly.detail && friendly.detail !== friendly.message ? friendly.detail : null;
  return (
    <View
      accessibilityRole="alert"
      style={[styles.error, { backgroundColor: colors.destructiveSoft, borderColor: colors.danger }, style]}
    >
      <Text variant="subtle" color={colors.urgent}>
        {friendly.message}
      </Text>
      {showDetail && detail ? (
        <Text variant="caption" color={colors.textDim} selectable style={styles.errorDetail}>
          {detail}
        </Text>
      ) : null}
      {(onRetry && friendly.retryable) || detail || onDismiss ? (
        <View style={styles.errorActions}>
          {onRetry && friendly.retryable ? <NoteAction label="Try again" color={colors.urgent} onPress={onRetry} strong /> : null}
          {detail ? <NoteAction label={showDetail ? "Hide details" : "Details"} color={colors.textDim} onPress={() => setShowDetail((v) => !v)} /> : null}
          {onDismiss ? <NoteAction label="Dismiss" color={colors.textDim} onPress={onDismiss} /> : null}
        </View>
      ) : null}
    </View>
  );
}

function NoteAction({ label, color, onPress, strong }: { label: string; color: string; onPress: () => void; strong?: boolean }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" hitSlop={10} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      <Text variant="caption" color={color} style={strong ? styles.errorActionStrong : undefined}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  header: { paddingHorizontal: space.xl, paddingTop: space.lg, paddingBottom: space.md },
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xxl },
  error: {
    marginHorizontal: space.xl,
    marginBottom: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    gap: space.xs,
  },
  errorDetail: { marginTop: space.xs },
  errorActions: { flexDirection: "row", gap: space.lg, marginTop: space.xs },
  errorActionStrong: { fontWeight: "600" },
});
