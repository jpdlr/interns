import React from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { radius, space, useAppTheme } from "../theme";
import { useThreadIndent } from "./Bubble";
import { Text } from "./Text";

export type ResourceKind = "email" | "deployment" | "clickup" | "document" | "calendar";

export interface ResourceReference {
  kind: ResourceKind;
  url: string;
  title: string;
  detail: string;
}

const LABELS: Record<ResourceKind, string> = {
  email: "Mail",
  deployment: "Deploy",
  clickup: "Task",
  document: "Doc",
  calendar: "Event",
};

function classify(url: URL): ResourceKind | null {
  const host = url.hostname.toLowerCase();
  const full = url.toString().toLowerCase();
  if (url.protocol === "mailto:" || ((host.includes("outlook.") || host.includes("office.com")) && full.includes("mail"))) return "email";
  if (host.includes("codeops") && /deploy|release|environment|build/.test(full)) return "deployment";
  if (host === "app.clickup.com" || host.endsWith(".clickup.com")) return "clickup";
  if (host.includes("calendar.google") || ((host.includes("outlook.") || host.includes("office.com")) && full.includes("calendar"))) return "calendar";
  if (
    host.includes("docs.google") || host.includes("drive.google") || host.includes("notion.") ||
    host.includes("sharepoint.") || host.includes("onedrive.") || /\.(pdf|docx?|xlsx?|pptx?)(?:$|[?#])/.test(full)
  ) return "document";
  return null;
}

function defaultTitle(kind: ResourceKind, url: URL): string {
  if (kind === "email") return url.protocol === "mailto:" ? `Email ${decodeURIComponent(url.pathname)}` : "Open email";
  if (kind === "deployment") return "CodeOps deployment";
  if (kind === "clickup") {
    const id = url.pathname.split("/").filter(Boolean).at(-1);
    return id ? `ClickUp ${id}` : "ClickUp task";
  }
  if (kind === "calendar") return "Calendar event";
  return "Open document";
}

function makeReference(raw: string, label?: string): ResourceReference | null {
  const cleaned = raw.replace(/[.,!?;:]+$/, "");
  try {
    const url = new URL(cleaned);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    // Pull requests have a richer checks/risk card of their own.
    if (/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i.test(cleaned) || /\/PullRequests\/Open\?/i.test(cleaned)) return null;
    const kind = classify(url);
    if (!kind) return null;
    const usefulLabel = label && !/^(open|here|link|view|click here)$/i.test(label.trim()) ? label.trim() : null;
    return {
      kind,
      url: cleaned,
      title: usefulLabel ?? defaultTitle(kind, url),
      detail: url.protocol === "mailto:" ? decodeURIComponent(url.pathname) : url.hostname.replace(/^www\./, ""),
    };
  } catch {
    return null;
  }
}

export function extractResourceReferences(text: string): ResourceReference[] {
  const found = new Map<string, ResourceReference>();
  for (const match of text.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+|mailto:[^)]+)\)/gi)) {
    const ref = makeReference(match[2], match[1]);
    if (ref) found.set(ref.url, ref);
  }
  for (const match of text.matchAll(/(?:https?:\/\/[^\s<>()]+|mailto:[^\s<>()]+)/gi)) {
    const ref = makeReference(match[0]);
    if (ref && !found.has(ref.url)) found.set(ref.url, ref);
  }
  return [...found.values()];
}

export function ResourceLinkPreviewCard({ reference, mine = false }: { reference: ResourceReference; mine?: boolean }) {
  const { colors } = useAppTheme();
  const indent = useThreadIndent();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${reference.title}`}
      onPress={() => void Linking.openURL(reference.url)}
      style={({ pressed }) => [
        styles.card,
        mine ? styles.mine : [styles.theirs, { marginLeft: indent }],
        { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.68 : 1 },
      ]}
    >
      <View style={[styles.kind, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Text variant="caption" color={colors.text}>{LABELS[reference.kind]}</Text>
      </View>
      <View style={styles.copy}>
        <Text variant="subtle" color={colors.text} numberOfLines={1} style={styles.title}>{reference.title}</Text>
        <Text variant="caption" numberOfLines={1}>{reference.detail}</Text>
      </View>
      <Text variant="subtle" color={colors.textDim}>↗</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { maxWidth: 560, flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.sm, marginTop: -space.xs, marginBottom: space.md },
  theirs: { marginRight: space.xxl, alignSelf: "stretch" },
  mine: { marginLeft: space.xxxl, alignSelf: "flex-end" },
  kind: { minWidth: 48, alignItems: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.sm, paddingVertical: 6 },
  copy: { flex: 1, minWidth: 0 },
  title: { fontWeight: "600" },
});
