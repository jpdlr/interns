/** A titled card on the hire builder: a small heading, an optional hint, and a rounded panel. */
import React from "react";
import { StyleSheet, View } from "react-native";
import { radius, space, useAppTheme } from "../../theme";
import { Text } from "../Text";

export function Section({ title, hint, right, children, flush }: { title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode; flush?: boolean }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.section}>
      <View style={styles.head}>
        <View style={styles.flex}>
          <Text variant="label">{title}</Text>
          {hint ? <Text variant="caption">{hint}</Text> : null}
        </View>
        {right}
      </View>
      <View style={[styles.panel, flush && styles.flush, { backgroundColor: colors.surfaceAlt }]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  head: { flexDirection: "row", alignItems: "flex-end", gap: space.md, paddingHorizontal: space.md },
  flex: { flex: 1, gap: 2 },
  panel: { borderRadius: radius.lg, padding: space.lg, gap: space.lg },
  flush: { padding: 0, gap: 0, overflow: "hidden" },
});
