/**
 * Starter interns (GET /templates): a face, a name and one sentence each.
 * Picking one opens it as a normal hire candidate, so everything stays
 * editable before anyone is hired. Templates that need something connected
 * first (Outlook, GitHub) say so instead of failing later.
 */
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { InternTemplate } from "../api";
import { useSettings } from "../settings";
import { radius, space, useAppTheme } from "../theme";
import { BrandLogo } from "./BrandLogo";
import { ChevronRightIcon } from "./Icons";
import { InternFace, resolveFaceId } from "./InternFace";
import { Text } from "./Text";

const NEED_LABEL: Record<InternTemplate["needs"][number], string> = {
  outlook: "Connect Outlook",
  github: "Connect GitHub",
};

export function useTemplates(): { templates: InternTemplate[]; loading: boolean; error: unknown } {
  const { api, configured } = useSettings();
  const [templates, setTemplates] = useState<InternTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  // again on focus: coming back from Connectors, a starter may be ready now
  useFocusEffect(
    useCallback(() => {
      if (!configured) return;
      let cancelled = false;
      api
        .templates()
        .then((list) => !cancelled && setTemplates(list))
        .catch((e) => !cancelled && setError(e))
        .finally(() => !cancelled && setLoading(false));
      return () => {
        cancelled = true;
      };
    }, [api, configured]),
  );
  return { templates, loading, error };
}

export function TemplatePicker({
  templates,
  onPick,
  busyId,
}: {
  templates: InternTemplate[];
  onPick: (template: InternTemplate) => void;
  /** the template being opened, shown dimmed */
  busyId?: string | null;
}) {
  const { colors } = useAppTheme();
  const router = useRouter();
  return (
    <View style={[styles.list, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      {templates.map((template, index) => (
        <Pressable
          key={template.id}
          accessibilityRole="button"
          accessibilityLabel={`${template.name}, ${template.role}. ${template.summary}`}
          disabled={Boolean(busyId)}
          onPress={() => onPick(template)}
          style={({ pressed }) => [
            styles.row,
            index > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
            (pressed || busyId === template.id) && { backgroundColor: colors.surfaceAlt },
            busyId && busyId !== template.id && styles.dimmed,
          ]}
        >
          <InternFace id={resolveFaceId(template.icon, template.id)} size={44} clipToBounds />
          <View style={styles.text}>
            <Text variant="title" numberOfLines={1}>
              {template.name} <Text variant="subtle">· {template.role}</Text>
            </Text>
            <Text variant="caption" numberOfLines={2}>
              {template.summary}
            </Text>
            {!template.ready && template.needs.length ? (
              <View style={styles.needs}>
                {template.needs.map((need) => (
                  <Pressable
                    key={need}
                    onPress={() => router.push(`/connectors/${need}` as never)}
                    accessibilityRole="link"
                    accessibilityLabel={NEED_LABEL[need]}
                    hitSlop={6}
                    style={({ pressed }) => [styles.need, { borderColor: colors.border }, pressed && { backgroundColor: colors.accentSoft }]}
                  >
                    <BrandLogo brand={need} size={14} />
                    <Text variant="caption" color={colors.text}>
                      {NEED_LABEL[need]} ›
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
          <ChevronRightIcon size={18} color={colors.textFaint} />
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.xl, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingVertical: space.md, paddingHorizontal: space.lg },
  text: { flex: 1, gap: 2 },
  needs: { flexDirection: "row", gap: space.xs, marginTop: space.xs },
  need: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2, flexDirection: "row", alignItems: "center", gap: 4 },
  dimmed: { opacity: 0.5 },
});
