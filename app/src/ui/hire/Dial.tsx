/**
 * A five-step dial: tap a stop (or use the screen reader's adjust gesture).
 * The track fills up to the chosen stop; the stop's name sits on the right.
 * Read-only with a dashed `ghost` stop, it shows a move ("Balanced → Brief")
 * on an intern's card.
 */
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { space, useAppTheme } from "../../theme";
import { Text } from "../Text";

export function Dial({
  title,
  low,
  high,
  steps,
  value,
  onChange,
  ghost,
  valueText,
  badge,
}: {
  title: string;
  low: string;
  high: string;
  /** the name of each of the five stops */
  steps: string[];
  value: number;
  /** omitted: read-only */
  onChange?: (v: number) => void;
  /** a second stop drawn dashed: where the dial is going (or was) */
  ghost?: number;
  /** replaces the stop name on the right, e.g. "Balanced → Brief" */
  valueText?: string;
  /** beside the value, e.g. "from your reactions" */
  badge?: React.ReactNode;
}) {
  const { colors } = useAppTheme();
  const set = (v: number) => onChange?.(Math.min(5, Math.max(1, v)));
  return (
    <View
      style={styles.dial}
      accessible
      accessibilityRole={onChange ? "adjustable" : undefined}
      accessibilityLabel={onChange ? title : `${title}: ${valueText ?? steps[value - 1]}`}
      accessibilityValue={onChange ? { min: 1, max: 5, now: value, text: steps[value - 1] } : undefined}
      accessibilityActions={onChange ? [{ name: "increment" }, { name: "decrement" }] : undefined}
      onAccessibilityAction={(e) => set(value + (e.nativeEvent.actionName === "increment" ? 1 : -1))}
    >
      <View style={styles.head}>
        <Text variant="body" style={styles.title}>
          {title}
        </Text>
        <View style={styles.valueRow}>
          {badge}
          <Text variant="subtle" color={value === 3 && !valueText ? colors.textDim : colors.accent} style={styles.valueLabel}>
            {valueText ?? steps[value - 1]}
          </Text>
        </View>
      </View>
      <View style={styles.trackRow}>
        <View style={[styles.track, { backgroundColor: colors.border }]} />
        <View style={[styles.fill, { width: `${((value - 1) / 4) * 100}%`, backgroundColor: colors.accent }]} />
        {[1, 2, 3, 4, 5].map((stop) => {
          const on = stop === value;
          const passed = stop <= value;
          if (stop === ghost && !on) {
            return <View key={stop} style={[styles.stopHit, { left: `${((stop - 1) / 4) * 100}%` }]}><View style={[styles.ghost, { borderColor: colors.textDim, backgroundColor: colors.surface }]} /></View>;
          }
          return (
            <Pressable
              key={stop}
              disabled={!onChange}
              onPress={() => set(stop)}
              hitSlop={10}
              accessibilityLabel={`${title}: ${steps[stop - 1]}`}
              style={[styles.stopHit, { left: `${((stop - 1) / 4) * 100}%` }]}
            >
              <View
                style={[
                  on ? styles.thumb : styles.stop,
                  { backgroundColor: passed ? colors.accent : colors.surface, borderColor: passed ? colors.accent : colors.border },
                  on && { borderColor: colors.surface, shadowColor: "#000" },
                ]}
              />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.ends}>
        <Text variant="caption">{low}</Text>
        <Text variant="caption">{high}</Text>
      </View>
    </View>
  );
}

const THUMB = 24;
const STOP = 12;
const styles = StyleSheet.create({
  dial: { gap: space.sm },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  title: { fontWeight: "600" },
  valueRow: { flexDirection: "row", alignItems: "center", gap: space.sm, flexShrink: 1 },
  valueLabel: { fontWeight: "600" },
  trackRow: { height: THUMB, justifyContent: "center", marginHorizontal: THUMB / 2 },
  track: { position: "absolute", left: 0, right: 0, height: 4, borderRadius: 2 },
  fill: { position: "absolute", left: 0, height: 4, borderRadius: 2 },
  stopHit: { position: "absolute", width: THUMB, height: THUMB, marginLeft: -THUMB / 2, alignItems: "center", justifyContent: "center" },
  stop: { width: STOP, height: STOP, borderRadius: STOP / 2, borderWidth: 2 },
  ghost: { width: THUMB - 4, height: THUMB - 4, borderRadius: (THUMB - 4) / 2, borderWidth: 2, borderStyle: "dashed" },
  thumb: { width: THUMB, height: THUMB, borderRadius: THUMB / 2, borderWidth: 3, shadowOpacity: 0.25, shadowRadius: 4, shadowOffset: { width: 0, height: 1 }, elevation: 2 },
  ends: { flexDirection: "row", justifyContent: "space-between" },
});
