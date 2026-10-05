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
import { ExternalIcon, HeartIcon, ImageIcon, PlusIcon } from "../Icons";
import { Text } from "../Text";
import { FilterChips, ItemSheet, type AskOwner } from "./PageViews";

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const newId = () => `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function MoodboardView({ page, ask, focusItem, onChanged }: { page: Page; ask: AskOwner; focusItem?: string; onChanged: (page: Page) => void }) {
  const { api } = useSettings();
  const { colors, fontScale } = useAppTheme();
  // What you add (it has a time) goes on top, newest first; an intern's
  // references keep the order the intern gave them.
  const all = (page.data as MoodboardData).items ?? [];
  const items = [...all.filter((i) => i.ts).sort((a, b) => b.ts!.localeCompare(a.ts!)), ...all.filter((i) => !i.ts)];
  const [openId, setOpenId] = useState<string | null>(null);
  const open = all.find((item) => item.id === openId) ?? null;
  const [likedOnly, setLikedOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const tags = [...new Set(all.flatMap((item) => item.tags ?? []))].sort((a, b) => a.localeCompare(b));
  const shown = items.filter((item) => (!likedOnly || item.liked) && (!tagFilter || (item.tags ?? []).includes(tagFilter)));
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<TextInput>(null);

  useEffect(() => {
    if (focusItem) setOpenId(focusItem);
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
  const patch = async (item: MoodboardItem, set: Record<string, unknown>): Promise<boolean> => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      onChanged(await api.patchPageItem(page.id, item.id, set));
      haptic("tap");
      return true;
    } catch (e) {
      setError(friendlyError(e).message);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
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
  shown.forEach((item, i) => columns[i % 2]!.push(item));
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

      {all.length ? (
        <View style={styles.filters}>
          <FilterChips value={likedOnly ? "liked" : "all"} onChange={(value) => setLikedOnly(value === "liked")} options={[
            { id: "all", label: `All · ${all.length}` },
            { id: "liked", label: `Liked · ${all.filter((item) => item.liked).length}` },
          ]} />
          {tags.length || tagFilter ? <FilterChips value={tagFilter} onChange={setTagFilter} options={[
            { id: "", label: "All tags" },
            ...[...new Set([...tags, ...(tagFilter ? [tagFilter] : [])])].map((tag) => ({ id: tag, label: tag })),
          ]} /> : null}
        </View>
      ) : null}
      {shown.length ? (
        <View style={styles.grid}>
          {columns.map((col, c) => (
            <View key={c} style={styles.column}>
              {col.map((item) => (
                <Card key={item.id} item={item} label={label(item)} onPress={() => setOpenId(item.id)} onLike={() => void patch(item, { liked: !item.liked })} saving={saving} />
              ))}
            </View>
          ))}
        </View>
      ) : (
        <View style={[styles.empty, { borderColor: colors.border }]}>
          <ImageIcon size={28} color={colors.textDim} />
          <Text variant="subtle" center>
            {all.length ? "No items match these filters." : "Nothing on this board yet. Paste a link or an image above, or tap + to add photos."}
          </Text>
        </View>
      )}

      <ItemSheet
        visible={Boolean(open)}
        onClose={() => setOpenId(null)}
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
        {open ? <>
          <Detail item={open} />
          <LikeButton item={open} onPress={() => void patch(open, { liked: !open.liked })} disabled={saving} />
          <TagEditor key={open.id} item={open} suggestions={tags} saving={saving} onSave={(tags) => patch(open, { tags })} />
          {error ? <Text variant="caption" color={colors.danger} accessibilityRole="alert">{error}</Text> : null}
        </> : null}
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

function Card({ item, label, onPress, onLike, saving }: { item: MoodboardItem; label: string; onPress: () => void; onLike: () => void; saving: boolean }) {
  const { colors } = useAppTheme();
  const uri = useImageUri(item);
  const waiting = Boolean(item.url && !item.image && item.preview !== "none");
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}>
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
      <View style={styles.cardText}>
        <LikeButton item={item} onPress={onLike} disabled={saving} />
        {(item.tags ?? []).length ? <Text variant="caption" numberOfLines={2}>{item.tags.join(" · ")}</Text> : null}
      </View>
    </View>
  );
}

function LikeButton({ item, onPress, disabled }: { item: MoodboardItem; onPress: () => void; disabled: boolean }) {
  const { colors } = useAppTheme();
  return <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={item.liked ? "Unlike" : "Like"} accessibilityState={{ selected: Boolean(item.liked), disabled }} style={({ pressed }) => [styles.like, { opacity: disabled ? 0.5 : pressed ? 0.7 : 1 }]}>
    <HeartIcon size={19} color={item.liked ? colors.accent : colors.textDim} filled={Boolean(item.liked)} />
    <Text variant="caption" color={item.liked ? colors.accent : colors.textDim}>{item.liked ? "Liked" : "Like"}</Text>
  </Pressable>;
}

function TagEditor({ item, suggestions, saving, onSave }: { item: MoodboardItem; suggestions: string[]; saving: boolean; onSave: (tags: string[]) => Promise<boolean> }) {
  const { colors, fontScale } = useAppTheme();
  const [draft, setDraft] = useState("");
  const tags = item.tags ?? [];
  const addTag = async (value: string) => {
    const tag = value.trim();
    if (!tag || saving) return;
    if (tags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) { setDraft(""); return; }
    if (await onSave([...tags, tag])) setDraft("");
  };
  return <View style={styles.filters}>
    <Text variant="caption" color={colors.text} style={styles.bold}>Tags</Text>
    <View style={styles.tagList}>
      {tags.map((tag) => <Pressable key={tag} disabled={saving} accessibilityRole="button" accessibilityLabel={`Remove tag ${tag}`} onPress={() => void onSave(tags.filter((t) => t !== tag))} style={[styles.tag, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Text variant="caption" color={colors.text}>{tag} ×</Text>
      </Pressable>)}
    </View>
    <View style={[styles.addBar, { borderColor: colors.border, backgroundColor: colors.surfaceAlt }]}>
      <TextInput value={draft} onChangeText={setDraft} onSubmitEditing={() => void addTag(draft)} editable={!saving} placeholder="Add a tag…" accessibilityLabel="Add a tag" placeholderTextColor={colors.textFaint} returnKeyType="done" style={[styles.addInput, { color: colors.text, fontSize: scaledFont(16, fontScale) }]} />
      <Pressable disabled={saving || !draft.trim()} onPress={() => void addTag(draft)} accessibilityRole="button" accessibilityLabel="Add tag" style={[styles.addGo, { backgroundColor: colors.accent, opacity: saving || !draft.trim() ? 0.5 : 1 }]}><Text variant="caption" color={colors.onAccent}>Add</Text></Pressable>
    </View>
    {suggestions.some((tag) => !tags.includes(tag)) ? <>
      <Text variant="caption">Reuse a board tag</Text>
      <View style={styles.tagList}>{suggestions.filter((tag) => !tags.includes(tag)).map((tag) => <Pressable key={tag} disabled={saving} onPress={() => void addTag(tag)} accessibilityRole="button" accessibilityLabel={`Add tag ${tag}`} style={[styles.tag, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}><Text variant="caption" color={colors.text}>{tag}</Text></Pressable>)}</View>
    </> : null}
  </View>;
}

function Detail({ item }: { item: MoodboardItem }) {
  const { colors } = useAppTheme();
  const uri = useImageUri(item);
  return (
    <View style={styles.detail}>
      {uri ? <Image source={{ uri }} style={[styles.detailImage, { backgroundColor: colors.surfaceAlt }]} resizeMode="contain" accessibilityIgnoresInvertColors /> : null}
      {item.note ? <Text variant="subtle" color={colors.text}>{item.note}</Text> : null}
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
  filters: { gap: space.sm },
  like: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: space.xs },
  tagList: { flexDirection: "row", flexWrap: "wrap", gap: space.xs },
  tag: { minHeight: 44, justifyContent: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: space.xs },
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
