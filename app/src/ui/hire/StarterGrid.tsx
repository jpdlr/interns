/**
 * Starter interns as cards, two across: face, name, role, what they do, and
 * what has to be connected first (with the product's logo).
 */
import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import type { InternTemplate } from "../../api";
import { radius, space, useAppTheme } from "../../theme";
import { BrandLogo } from "../BrandLogo";
import { InternFace, resolveFaceId } from "../InternFace";
import { Text } from "../Text";

const NEED_LABEL = { outlook: "Outlook", github: "GitHub" } as const;

export function StarterGrid({ templates, busyId, onPick }: { templates: InternTemplate[]; busyId: string | null; onPick: (t: InternTemplate) => void }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.grid}>
      {templates.map((t) => {
        const busy = busyId === t.id;
        return (
          <Pressable
            key={t.id}
            onPress={() => onPick(t)}
            disabled={Boolean(busyId)}
            accessibilityRole="button"
            accessibilityLabel={`${t.name}, ${t.role}. ${t.summary}`}
            style={({ pressed }) => [
              styles.card,
              { backgroundColor: pressed || busy ? colors.accentSoft : colors.surfaceAlt, opacity: busyId && !busy ? 0.5 : 1 },
            ]}
          >
            <View style={styles.top}>
              <InternFace id={resolveFaceId(t.icon, t.id)} size={48} clipToBounds />
              {busy ? <ActivityIndicator color={colors.textDim} /> : null}
            </View>
            <View style={styles.text}>
              <Text variant="title" numberOfLines={1}>
                {t.name}
              </Text>
              <Text variant="caption" color={colors.text} numberOfLines={1} style={styles.role}>
                {t.role}
              </Text>
              <Text variant="caption" numberOfLines={3}>
                {t.summary}
              </Text>
            </View>
            <View style={styles.needs}>
              {t.needs.map((need) => (
                <View key={need} style={[styles.need, { borderColor: t.ready ? colors.border : colors.action }]}>
                  <BrandLogo brand={need} size={13} />
                  <Text variant="caption" color={t.ready ? colors.textDim : colors.action}>
                    {NEED_LABEL[need]}
                  </Text>
                </View>
              ))}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  card: { width: "48.5%", borderRadius: radius.lg, padding: space.md, gap: space.sm },
  top: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  text: { gap: 2, flex: 1 },
  role: { fontWeight: "600" },
  needs: { flexDirection: "row", flexWrap: "wrap", gap: 4, minHeight: 20 },
  need: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: 6, paddingVertical: 1 },
});
