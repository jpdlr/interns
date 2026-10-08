/**
 * Instagram posts and reels linked in a message, shown under it as a card
 * with the post's image, caption and account (orchestrator linkpreview.ts
 * fetches and keeps them). Tap opens the post.
 */
import React, { useEffect, useState } from "react";
import { Linking, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import type { InternsApi, LinkPreview } from "../api";
import { radius, space, useAppTheme } from "../theme";
import { BrandLogo } from "./BrandLogo";
import { useThreadIndent } from "./Bubble";
import { ExternalIcon } from "./Icons";
import { FadeImage } from "./Media";
import { Text } from "./Text";

const POST_LINK = /https?:\/\/(?:www\.)?instagram\.com\/(?:[\w.]+\/)?(?:p|reels?|tv)\/[\w-]+\/?(?:\?[^\s)<>]*)?/g;
/** a message links a handful of posts at most worth a card each */
const MAX_CARDS = 4;

/** The Instagram post links in a message, in order, without repeats. */
export function instagramLinks(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(POST_LINK)) found.add(m[0].replace(/[.,;:!?]+$/, ""));
  return [...found].slice(0, MAX_CARDS);
}

/** Cards already fetched this session (null: nothing to show), shared by every thread. */
const cache = new Map<string, Promise<LinkPreview | null>>();

function usePreview(api: InternsApi, url: string): LinkPreview | null | undefined {
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let pending = cache.get(url);
    if (!pending) {
      pending = api.getLinkPreview(url);
      cache.set(url, pending);
    }
    void pending.then((p) => {
      if (!cancelled) setPreview(p);
    });
    return () => {
      cancelled = true;
    };
  }, [api, url]);
  return preview;
}

export function InstagramPreviewCard({ api, url, mine = false }: { api: InternsApi; url: string; mine?: boolean }) {
  const { colors } = useAppTheme();
  const indent = useThreadIndent();
  const { width: screen } = useWindowDimensions();
  const preview = usePreview(api, url);
  if (!preview) return null; // loading, or nothing to show: the link in the text is enough
  const width = Math.min(260, screen - indent - space.xxl);
  const reel = /\/(reels?|tv)\//.test(url);
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={`Open on Instagram: ${preview.title ?? preview.source ?? "post"}`}
      onPress={() => void Linking.openURL(url)}
      style={({ pressed }) => [
        styles.card,
        mine ? styles.mine : { marginLeft: indent },
        { width, backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      {preview.image_url ? (
        <FadeImage uri={api.absoluteUrl(preview.image_url)} style={{ width, height: Math.round(width * (reel ? 1.25 : 1)) }} accessibilityLabel={preview.title ?? "Instagram post"} />
      ) : null}
      <View style={styles.meta}>
        <BrandLogo brand="instagram" size={18} />
        <View style={styles.copy}>
          {preview.source ? (
            <Text variant="caption" color={colors.text} numberOfLines={1} style={styles.source}>
              {preview.source}
            </Text>
          ) : null}
          {preview.title ? (
            <Text variant="caption" color={colors.textDim} numberOfLines={2}>
              {preview.title}
            </Text>
          ) : null}
        </View>
        <ExternalIcon size={16} color={colors.textFaint} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, overflow: "hidden", marginTop: -space.xs, marginBottom: space.md, alignSelf: "flex-start" },
  mine: { alignSelf: "flex-end" },
  meta: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.sm },
  copy: { flex: 1, minWidth: 0, gap: 1 },
  source: { fontWeight: "600" },
});
