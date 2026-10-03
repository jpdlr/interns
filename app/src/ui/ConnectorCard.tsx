/**
 * A connector's card (Connectors, setup) and the one-line status each
 * connector shows on it.
 */
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { ConnectorsOverview } from "../api";
import { radius, space, useAppTheme } from "../theme";
import { ChevronRightIcon } from "./Icons";
import { Text } from "./Text";

export type ConnectorTone = "ok" | "off" | "attention";

/** One line about Outlook, and whether it needs attention. */
export function outlookSummary(o: ConnectorsOverview["outlook"]): { text: string; tone: ConnectorTone } {
  if (!o.app.client_id) return { text: "Not set up", tone: "off" };
  if (o.mailboxes.length === 0) return { text: "No mailboxes yet", tone: "off" };
  const failing = o.mailboxes.filter((m) => !m.signed_in || (m.health?.failures ?? 0) >= 3 || m.check?.ok === false);
  const names = o.mailboxes.map((m) => m.label).join(", ");
  if (failing.length) return { text: `${failing.map((m) => m.label).join(", ")} needs signing in again`, tone: "attention" };
  return { text: `${o.mailboxes.length} mailbox${o.mailboxes.length === 1 ? "" : "es"}: ${names}`, tone: "ok" };
}

export function githubSummary(g: ConnectorsOverview["github"]): { text: string; tone: ConnectorTone } {
  if (!g.connected) return { text: "Not connected", tone: "off" };
  if (g.error) return { text: "Can't reach GitHub", tone: "attention" };
  const on = g.installations.filter((i) => i.enabled).map((i) => i.login);
  if (!on.length) return { text: "Connected · reviews are off", tone: "attention" };
  return { text: `Reviews in ${on.join(", ")}${g.reviewer ? ` by ${g.reviewer.name}` : ""}`, tone: "ok" };
}

export function instagramSummary(i: ConnectorsOverview["instagram"]): { text: string; tone: ConnectorTone } {
  if (!i.connected || !i.account) return { text: "Not connected", tone: "off" };
  if (i.check && !i.check.ok) return { text: "Needs connecting again", tone: "attention" };
  if (i.missing.length) return { text: `@${i.account.username} · missing permissions`, tone: "attention" };
  if (!i.used_by.length) return { text: `@${i.account.username} · nobody researches yet`, tone: "attention" };
  return { text: `@${i.account.username} · ${i.used_by.map((u) => u.name).join(", ")}`, tone: "ok" };
}

export function ConnectorCard({
  icon,
  title,
  description,
  status,
  action,
  onPress,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  status?: { text: string; tone: ConnectorTone };
  action: string;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();
  const toneColor = status?.tone === "ok" ? colors.success : status?.tone === "attention" ? colors.action : colors.textFaint;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={[title, status?.text, action].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.card, { backgroundColor: pressed ? colors.accentSoft : colors.surfaceAlt }]}
    >
      <View style={styles.cardHead}>
        <View style={[styles.iconWrap, { backgroundColor: colors.bg }]}>{icon}</View>
        <View style={styles.cardTitle}>
          <Text variant="title">{title}</Text>
          {status ? (
            <View style={styles.statusRow}>
              <View style={[styles.dot, { backgroundColor: toneColor }]} />
              <Text variant="caption" color={status.tone === "attention" ? colors.action : undefined} numberOfLines={2} style={styles.flex}>
                {status.text}
              </Text>
            </View>
          ) : null}
        </View>
        <View style={styles.actionRow}>
          <Text variant="subtle" color={colors.text} style={styles.action}>
            {action}
          </Text>
          <ChevronRightIcon size={16} color={colors.textFaint} />
        </View>
      </View>
      <Text variant="subtle">{description}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  card: { borderRadius: radius.lg, padding: space.lg, gap: space.md },
  cardHead: { flexDirection: "row", alignItems: "center", gap: space.md },
  iconWrap: { width: 44, height: 44, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  cardTitle: { flex: 1, gap: 2 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  actionRow: { flexDirection: "row", alignItems: "center", gap: 2 },
  action: { fontWeight: "600" },
});
