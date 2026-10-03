/**
 * The personality editor's "Learned from you": this week's reactions, the
 * dial moves they led to (each with Undo while it still stands), and how
 * close the next one is.
 */
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Learned, Reaction, Style, StyleChange } from "../api";
import { DIALS } from "../style";
import { radius, space, useAppTheme } from "../theme";
import { REACTION_INFO, reactionInfo } from "./Reactions";
import { Text } from "./Text";

const STEP: Partial<Record<Reaction, 1 | -1>> = { too_long: -1, too_short: 1, too_formal: -1, too_casual: 1 };

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });

/** The change behind a dial's current setting, if the reactions set it and it still stands. */
export function standingChange(learned: Learned | null, dial: keyof Style, style: Style): StyleChange | null {
  const latest = learned?.changes.find((c) => c.dial === dial);
  return latest && !latest.undone_at && style[dial] === latest.to_value ? latest : null;
}

export function LearnedFromYou({ name, learned, style, onUndo }: { name: string; learned: Learned; style: Style; onUndo: (change: StyleChange) => void }) {
  const { colors } = useAppTheme();
  const week = REACTION_INFO.filter((r) => (learned.week[r.key] ?? 0) > 0);
  const askDials = DIALS.filter((d) => (d.key === "tone" || d.key === "length") && learned.asks_first[d.key]).map((d) => d.title);
  return (
    <View style={styles.wrap}>
      <Text variant="label">Learned from you</Text>
      <View style={[styles.panel, { borderColor: colors.border, backgroundColor: colors.surface }]}>
        <View style={styles.weekRow}>
          <Text variant="body" color={colors.text}>
            This week
          </Text>
          {week.length ? (
            <View style={styles.chips}>
              {week.map(({ key, label, Icon }) => (
                <View key={key} style={[styles.chip, { borderColor: colors.border }]} accessibilityLabel={`${label}: ${learned.week[key]}`}>
                  <Icon size={14} color={colors.text} />
                  <Text variant="caption" color={colors.text} style={styles.bold}>
                    {learned.week[key]}
                  </Text>
                </View>
              ))}
            </View>
          ) : (
            <Text variant="caption">No reactions yet</Text>
          )}
        </View>

        {learned.changes.slice(0, 4).map((change) => {
          const dial = DIALS.find((d) => d.key === change.dial)!;
          const label = reactionInfo(change.reaction).label.toLowerCase();
          const stands = !change.undone_at && style[change.dial] === change.to_value;
          return (
            <View key={change.id} style={styles.line}>
              <Text variant="subtle" style={styles.flex}>
                {`${day(change.created_at)}: ${dial.title} moved from ${dial.steps[change.from_value - 1]} to ${dial.steps[change.to_value - 1]} after ${change.reactions} “${label}”${change.asked ? ", with your OK" : ""}.`}
                {change.undone_at ? " Undone." : ""}
              </Text>
              {stands ? (
                <Pressable onPress={() => onUndo(change)} accessibilityRole="button" accessibilityLabel={`Undo: ${dial.title} back to ${dial.steps[change.from_value - 1]}`} hitSlop={8}>
                  <Text variant="subtle" color={colors.text} style={styles.bold}>
                    Undo
                  </Text>
                </Pressable>
              ) : null}
            </View>
          );
        })}

        {learned.progress.map((p) => {
          const dial = DIALS.find((d) => d.key === p.dial)!;
          const to = style[p.dial] + (STEP[p.reaction] ?? 0);
          if (to < 1 || to > 5) return null;
          const more = Math.max(1, learned.threshold - p.count);
          const label = reactionInfo(p.reaction).label.toLowerCase();
          return (
            <Text key={p.reaction} variant="subtle">
              {learned.asks_first[p.dial]
                ? `${more} more “${label}” and ${name} asks about moving ${dial.title} to ${dial.steps[to - 1]}.`
                : `${more} more “${label}” and ${dial.title} moves to ${dial.steps[to - 1]}.`}
            </Text>
          );
        })}

        <Text variant="caption">
          {`Long-press any of ${name}'s messages to react. ${learned.threshold} of one kind in their last ${learned.window} messages moves a dial.`}
          {askDials.length ? ` You've stepped in on ${askDials.join(" and ")}, so ${name} asks first there.` : ` ${name} moves it and tells you; undo once and they'll ask first.`}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  panel: { borderWidth: 1, borderRadius: radius.lg, padding: space.lg, gap: space.md },
  weekRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.md, flexWrap: "wrap" },
  chips: { flexDirection: "row", gap: 6, flexWrap: "wrap" },
  chip: { flexDirection: "row", alignItems: "center", gap: 5, borderWidth: 1, borderRadius: radius.pill, paddingHorizontal: 9, paddingVertical: 3 },
  line: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  flex: { flex: 1 },
  bold: { fontWeight: "700" },
});
