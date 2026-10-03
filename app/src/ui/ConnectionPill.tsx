import React, { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import { useLive } from "../live";
import { useSettings } from "../settings";
import { radius, space, useAppTheme } from "../theme";
import { Text } from "./Text";

const LABEL = {
  live: "Live",
  polling: "Delayed",
  connecting: "Connecting…",
  offline: "Offline",
} as const;

/**
 * Stream status, shown only when something is wrong. A healthy connection is
 * the normal state and needs no pill in every header; before setup there is
 * nothing to connect to, and the empty state already says so. A brief
 * "connecting" on launch is held back so it never flickers in.
 */
export function ConnectionPill() {
  const { status } = useLive();
  const { configured } = useSettings();
  const { colors } = useAppTheme();
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(true), 2_500);
    return () => clearTimeout(timer);
  }, []);
  if (!configured || status === "live" || (status === "connecting" && !settled)) return null;
  const dot = { live: colors.success, polling: colors.action, connecting: colors.textFaint, offline: colors.urgent }[status];
  return (
    <View
      accessibilityRole="text"
      accessibilityLabel={`Connection: ${LABEL[status]}`}
      style={[styles.pill, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      <View style={[styles.dot, { backgroundColor: dot }]} />
      <Text variant="caption">{LABEL[status]}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.xs + 2,
    paddingVertical: space.xs,
    paddingHorizontal: space.md - 2,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 7, height: 7, borderRadius: radius.pill },
});
