/**
 * What they can use, as tiles: tap to give or take a tool. Products show
 * their logo; a tool whose connector isn't set up yet says so, one tap from
 * connecting it.
 */
import { useRouter } from "expo-router";
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { TOOL_INFO } from "../../internFile";
import { radius, space, useAppTheme } from "../../theme";
import { CheckIcon } from "../Icons";
import { Text } from "../Text";
import { ToolIcon } from "../ToolIcon";

const OUTLOOK_TOOLS = new Set(["mail", "calendar"]);

export function ToolTiles({
  tools,
  selected,
  onToggle,
  outlookConnected,
}: {
  /** every tool that can be given here */
  tools: string[];
  selected: string[];
  onToggle: (tool: string) => void;
  /** null while unknown */
  outlookConnected: boolean | null;
}) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const needsOutlook = outlookConnected === false && selected.some((t) => OUTLOOK_TOOLS.has(t));
  return (
    <View style={styles.wrap}>
      <View style={styles.grid}>
        {tools.map((tool) => {
          const on = selected.includes(tool);
          const info = TOOL_INFO[tool];
          return (
            <Pressable
              key={tool}
              onPress={() => onToggle(tool)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={info?.label ?? tool}
              style={({ pressed }) => [
                styles.tile,
                {
                  backgroundColor: on ? colors.accentSoft : colors.surface,
                  borderColor: on ? colors.accent : colors.border,
                  opacity: pressed ? 0.75 : 1,
                },
              ]}
            >
              <View style={styles.tileTop}>
                <ToolIcon tool={tool} size={26} />
                <View style={[styles.check, { backgroundColor: on ? colors.accent : "transparent", borderColor: on ? colors.accent : colors.border }]}>
                  {on ? <CheckIcon size={14} color={colors.onAccent} /> : null}
                </View>
              </View>
              <Text variant="subtle" color={colors.text} style={styles.label} numberOfLines={1}>
                {info?.label ?? tool}
              </Text>
              <Text variant="caption" numberOfLines={2}>
                {info?.detail ?? ""}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {needsOutlook ? (
        <Pressable onPress={() => router.push("/connectors/outlook" as never)} accessibilityRole="link" style={[styles.notice, { borderColor: colors.action }]}>
          <Text variant="caption" color={colors.action}>
            Outlook isn't connected yet, so mail and calendar won't work until it is. Connect Outlook ›
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  tile: { width: "48.5%", borderWidth: 1.5, borderRadius: radius.lg, padding: space.md, gap: 4 },
  tileTop: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: 2 },
  check: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, alignItems: "center", justifyContent: "center" },
  label: { fontWeight: "700" },
  notice: { borderWidth: 1, borderRadius: radius.md, padding: space.md },
});
