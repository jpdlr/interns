import { BrandLogo } from "./BrandLogo";
import React, { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import type { InternsApi, PullRequestPreview } from "../api";
import { radius, space, useAppTheme } from "../theme";
import { useThreadIndent } from "./Bubble";
import { Text } from "./Text";

export interface PullRequestReference {
  repository: string;
  number: number;
  url: string;
}

/** GitHub and CodeOps links can occur together; return one card per PR. */
export function extractPullRequestReferences(text: string): PullRequestReference[] {
  const found = new Map<string, PullRequestReference>();
  for (const match of text.matchAll(/https?:\/\/github\.com\/([^/\s)]+)\/([^/\s)]+)\/pull\/(\d+)(?:[^\s)]*)?/gi)) {
    const repository = `${match[1]}/${match[2]}`;
    const number = Number(match[3]);
    found.set(`${repository.toLowerCase()}#${number}`, { repository, number, url: match[0] });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s)]+\/PullRequests\/Open\?[^\s)]*/gi)) {
    try {
      const url = new URL(match[0]);
      const repository = url.searchParams.get("repository") ?? "";
      const number = Number(url.searchParams.get("number"));
      if (!/^[^/\s]+\/[^/\s]+$/.test(repository) || !Number.isInteger(number) || number < 1) continue;
      const key = `${repository.toLowerCase()}#${number}`;
      // Prefer the richer CodeOps destination when the message also carries
      // the GitHub URL for the same PR.
      found.set(key, { repository, number, url: match[0] });
    } catch {
      // A malformed link stays ordinary message text.
    }
  }
  return [...found.values()];
}

type CacheEntry = { expires: number; promise: Promise<PullRequestPreview> };
const previewCache = new Map<string, CacheEntry>();

function loadPreview(api: InternsApi, reference: PullRequestReference): Promise<PullRequestPreview> {
  const key = `${api.baseUrl}/${reference.repository.toLowerCase()}#${reference.number}`;
  const cached = previewCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.promise;
  const promise = api.getPullRequestPreview(reference.repository, reference.number);
  previewCache.set(key, { expires: Date.now() + 60_000, promise });
  promise.catch(() => previewCache.delete(key));
  return promise;
}

export function PullRequestPreviewCard({
  api,
  reference,
  mine = false,
}: {
  api: InternsApi;
  reference: PullRequestReference;
  mine?: boolean;
}) {
  const { colors } = useAppTheme();
  const indent = useThreadIndent();
  const [preview, setPreview] = useState<PullRequestPreview | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setPreview(null);
    setFailed(false);
    void loadPreview(api, reference)
      .then((result) => { if (active) setPreview(result); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [api, reference.number, reference.repository]);

  const risk = preview?.risk ?? "unknown";
  const riskColor = risk === "high" ? colors.urgent : risk === "medium" ? colors.action : risk === "low" ? colors.success : colors.textDim;
  const checks = preview?.checks;
  const checksColor = checks?.failed ? colors.urgent : checks?.pending ? colors.action : checks ? colors.success : colors.textDim;
  const destination = preview?.primary_url ?? reference.url;

  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open ${reference.repository} pull request ${reference.number}`}
      onPress={() => void Linking.openURL(destination)}
      style={({ pressed }) => [
        styles.card,
        mine ? styles.mine : [styles.theirs, { marginLeft: indent }],
        { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.68 : 1 },
      ]}
    >
      <View style={styles.topline}>
        <BrandLogo brand="github" size={18} />
        <Text variant="subtle" color={colors.text} numberOfLines={2} style={styles.repository}>
          {reference.repository} #{reference.number}
        </Text>
        {preview ? (
          <View style={[styles.badge, { borderColor: riskColor, backgroundColor: colors.surfaceAlt }]}>
            <Text variant="caption" color={riskColor}>{risk} risk</Text>
          </View>
        ) : null}
      </View>
      <Text variant="caption" color={preview ? colors.text : colors.textDim} numberOfLines={2}>
        {preview?.title ?? (failed ? "Preview unavailable — open pull request" : "Loading pull request…")}
      </Text>
      {preview ? (
        <View style={styles.meta}>
          <Text variant="caption" color={checksColor}>
            {checks?.total ? `${checks.passed}/${checks.total} checks` : "No checks"}
            {checks?.failed ? ` · ${checks.failed} failed` : checks?.pending ? ` · ${checks.pending} pending` : ""}
          </Text>
          <Text variant="caption">{preview.changed_files} files · +{preview.additions} −{preview.deletions}</Text>
        </View>
      ) : null}
      <Text variant="caption" color={colors.text} style={styles.openLabel}>
        Open in {preview?.primary_label ?? (reference.url.includes("/PullRequests/Open") ? "CodeOps" : "GitHub")} ↗
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    maxWidth: 560,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    gap: space.xs,
    marginTop: -space.xs,
    marginBottom: space.md,
  },
  theirs: { marginRight: space.xxl, alignSelf: "flex-start" },
  mine: { marginLeft: space.xxxl, alignSelf: "flex-end" },
  topline: { flexDirection: "row", alignItems: "center", gap: space.sm },
  repository: { flex: 1, fontWeight: "600" },
  badge: { marginLeft: "auto", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.sm, paddingVertical: 2 },
  meta: { flexDirection: "row", flexWrap: "wrap", gap: space.md },
  openLabel: { marginTop: 2, fontWeight: "600" },
});
