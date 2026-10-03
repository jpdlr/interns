/**
 * A moodboard page: visual references as image cards in two columns.
 *
 * Paste a link or an image into the field at the top (or tap + to pick
 * photos) and it lands on the board; links get their preview image from the
 * orchestrator a moment later (pagemedia.ts). Tapping a card opens it large,
 * with the link, the note and the usual "ask the owner" actions.
 */
import React, { useEffect, useRef, useState } from "react";
import { Image, Linking, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import type { MoodboardData, MoodboardItem, Page, UploadableFile } from "../../api";
import { friendlyError } from "../../errors";
import { haptic } from "../../haptics";
import { useSettings } from "../../settings";
import { radius, scaledFont, space, useAppTheme } from "../../theme";
import { filesFromDataTransfer, pickFiles } from "../Attachments";
import { ExternalIcon, ImageIcon, PlusIcon } from "../Icons";
import { Text } from "../Text";
import { ItemSheet, type AskOwner } from "./PageViews";

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const newId = () => `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function MoodboardView({ page, ask, focusItem, onChanged }: { page: Page; ask: AskOwner; focusItem?: string; onChanged: (page: Page) => void }) {
  const { api } = useSettings();
  const { colors, fontScale } = useAppTheme();
  // What you add (it has a time) goes on top, newest first; an intern's
  // references keep the order the intern gave them.
  const all = (page.data as MoodboardData).items ?? [];
  const items = [...all.filter((i) => i.ts).sort((a, b) => b.ts!.localeCompare(a.ts!)), ...all.filter((i) => !i.ts)];
  const [open, setOpen] = useState<MoodboardItem | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (focusItem) setOpen(items.find((i) => i.id === focusItem) ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusItem]);

  const add = async (fn: () => Promise<Page>) => {
    setBusy((n) => n + 1);
    setError(null);
    try {
      onChanged(await fn());
      haptic("tap");
    } catch (e) {
      setError(friendlyError(e).message);
    } finally {
      setBusy((n) => n - 1);
    }
  };
  const addImages = (files: UploadableFile[]) => {
    for (const file of files.filter((f) => f.type.startsWith("image/"))) {
      void add(async () => {
        const { image } = await api.uploadPageImage(page.id, file);
        return api.addPageItem(page.id, { id: newId(), image, by: "owner", ts: new Date().toISOString() });
      });
    }
  };
  const addLinks = (raw: string) => {
    const urls = [...new Set(raw.match(URL_RE) ?? [])];
    const note = raw.replace(URL_RE, "").trim();
    if (!urls.length && note) {
      void add(() => api.addPageItem(page.id, { id: newId(), title: note.slice(0, 200), by: "owner", ts: new Date().toISOString() }));
    }
    for (const url of urls) {
      void add(() => api.addPageItem(page.id, { id: newId(), url, ...(note && urls.length === 1 ? { note } : {}), by: "owner", ts: new Date().toISOString() }));
    }
    setText("");
  };

  // Web: an image pasted or dropped on the field goes straight onto the board.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = inputRef.current as unknown as HTMLElement | null;
    if (!node?.addEventListener) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = filesFromDataTransfer(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        addImages(files);
      }
    };
    const onDrop = (e: DragEvent) => {
      const files = filesFromDataTransfer(e.dataTransfer);
      if (files.length) {
        e.preventDefault();
        addImages(files);
      }
    };
    node.addEventListener("paste", onPaste);
    node.addEventListener("drop", onDrop);
    return () => {
      node.removeEventListener("paste", onPaste);
      node.removeEventListener("drop", onDrop);
    };
  });

  const columns: MoodboardItem[][] = [[], []];
  items.forEach((item, i) => columns[i % 2]!.push(item));
  const label = (i: MoodboardItem) => i.title || i.source || (i.url ? hostOf(i.url) : "Image");

  return (
    <View style={styles.wrap}>
      <View style={[styles.addBar, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Pressable
          onPress={() => void pickFiles({ accept: "image/*", multiple: true }).then(addImages)}
          accessibilityRole="button"
          accessibilityLabel="Add images"
          hitSlop={6}
          style={({ pressed }) => [styles.addButton, { opacity: pressed ? 0.6 : 1 }]}
        >
          <PlusIcon size={22} color={colors.text} />
        </Pressable>
        <TextInput
          ref={inputRef}
          value={text}
          onChangeText={setText}
          onSubmitEditing={() => text.trim() && addLinks(text)}
          placeholder="Paste a link or an image…"
          placeholderTextColor={colors.textFaint}
          returnKeyType="done"
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.addInput, { color: colors.text, fontSize: scaledFont(16, fontScale) }]}
          accessibilityLabel="Paste a link or an image"
        />
        {text.trim() ? (
          <Pressable onPress={() => addLinks(text)} accessibilityRole="button" style={({ pressed }) => [styles.addGo, { backgroundColor: colors.accent, opacity: pressed ? 0.8 : 1 }]}>
            <Text variant="caption" color={colors.onAccent} style={styles.bold}>
              Add
            </Text>
          </Pressable>
        ) : null}
      </View>
      {busy ? <Text variant="caption">Adding…</Text> : null}
      {error ? (
        <Text variant="caption" color={colors.danger}>
          {error}
        </Text>
      ) : null}

      {items.length ? (
        <View style={styles.grid}>
          {columns.map((col, c) => (
            <View key={c} style={styles.column}>
              {col.map((item) => (
                <Card key={item.id} item={item} label={label(item)} onPress={() => setOpen(item)} />
              ))}
            </View>
          ))}
        </View>
      ) : (
        <View style={[styles.empty, { borderColor: colors.border }]}>
          <ImageIcon size={28} color={colors.textDim} />
          <Text variant="subtle" center>
            Nothing on this board yet. Paste a link or an image above, or tap + to add photos.
          </Text>
        </View>
      )}

      <ItemSheet
        visible={Boolean(open)}
        onClose={() => setOpen(null)}
        title={open ? label(open) : ""}
        subtitle={open?.source && open.source !== label(open) ? open.source : undefined}
        onAsk={(t) => ask(t, open ? { id: open.id, label: label(open) } : undefined)}
        actions={
          open
            ? [
                { label: "Use this for a post", instruction: "use this as a reference for a post: what would ours look like?" },
                { label: "Tell me more", instruction: "tell me more about this one" },
                { label: "Remove", tone: "danger", run: () => void api.removePageItem(page.id, open.id).then(onChanged) },
              ]
            : []
        }
      >
        {open ? <Detail item={open} /> : null}
      </ItemSheet>
    </View>
  );
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function useImageUri(item: MoodboardItem): string | null {
  const { api } = useSettings();
  if (!item.image_url) return null;
  return item.image_url.startsWith("/") ? `${api.baseUrl}${item.image_url}` : item.image_url;
}

function Card({ item, label, onPress }: { item: MoodboardItem; label: string; onPress: () => void }) {
  const { colors } = useAppTheme();
  const uri = useImageUri(item);
  const waiting = Boolean(item.url && !item.image && item.preview !== "none");
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => [styles.card, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.85 : 1 }]}>
      {uri ? (
        <Image source={{ uri }} style={[styles.image, { backgroundColor: colors.surfaceAlt }]} resizeMode="cover" accessibilityIgnoresInvertColors />
      ) : (
        <View style={[styles.image, styles.noImage, { backgroundColor: colors.surfaceAlt }]}>
          {item.url ? <ExternalIcon size={22} color={colors.textDim} /> : <ImageIcon size={22} color={colors.textDim} />}
          <Text variant="caption" center>
            {waiting ? "Fetching preview…" : item.url ? hostOf(item.url) : ""}
          </Text>
        </View>
      )}
      {item.title || item.source || item.url ? (
        <View style={styles.cardText}>
          <Text variant="caption" color={colors.text} numberOfLines={2} style={styles.bold}>
            {label}
          </Text>
          {item.source && item.source !== label ? (
            <Text variant="caption" numberOfLines={1}>
              {item.source}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  );
}

function Detail({ item }: { item: MoodboardItem }) {
  const { colors } = useAppTheme();
  const uri = useImageUri(item);
  return (
    <View style={styles.detail}>
      {uri ? <Image source={{ uri }} style={[styles.detailImage, { backgroundColor: colors.surfaceAlt }]} resizeMode="contain" accessibilityIgnoresInvertColors /> : null}
      {item.note ? <Text variant="subtle" color={colors.text}>{item.note}</Text> : null}
      {item.tags.length ? <Text variant="caption">{item.tags.join(" · ")}</Text> : null}
      {item.url ? (
        <Pressable onPress={() => void Linking.openURL(item.url!)} accessibilityRole="link" style={({ pressed }) => [styles.link, { borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}>
          <ExternalIcon size={16} color={colors.text} />
          <Text variant="caption" color={colors.text} numberOfLines={1} style={styles.flex}>
            Open on {hostOf(item.url)}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: space.md },
  addBar: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.xl, paddingLeft: space.sm, paddingRight: space.sm, paddingVertical: 6 },
  addButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  addInput: { flex: 1, paddingVertical: space.sm },
  addGo: { borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 7 },
  bold: { fontWeight: "600" },
  grid: { flexDirection: "row", gap: space.sm },
  column: { flex: 1, gap: space.sm },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, overflow: "hidden" },
  image: { width: "100%", aspectRatio: 4 / 5 },
  noImage: { alignItems: "center", justifyContent: "center", gap: space.xs, padding: space.md },
  cardText: { padding: space.sm, gap: 2 },
  empty: { borderWidth: 1, borderStyle: "dashed", borderRadius: radius.lg, padding: space.xl, alignItems: "center", gap: space.sm },
  detail: { gap: space.md },
  detailImage: { width: "100%", aspectRatio: 1, borderRadius: radius.md },
  link: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md },
  flex: { flex: 1 },
});
