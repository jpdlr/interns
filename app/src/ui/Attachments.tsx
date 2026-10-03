/**
 * Everything the app shows for files in a thread:
 *  - AttachmentList: the previews under a bubble (image/SVG thumbnails,
 *    file chips), tap → viewer or download.
 *  - AttachmentViewer: the full-screen modal with open/save.
 *  - PendingAttachments: the strip above the composer while JP is picking
 *    and uploading files.
 *  - pickFiles(): the platform file picker (DOM <input type=file> on web,
 *    which on iOS offers Photos/Camera/Files; native falls back to a note
 *    until a picker module is added).
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Image, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from "react-native";
import type { Attachment, InternsApi, UploadableFile } from "../api";
import { radius, space, useAppTheme } from "../theme";
import { DownloadIcon, FileIcon, ImageIcon, RefreshIcon, XIcon } from "./Icons";
import { SvgBlock } from "./SvgBlock";
import { Text } from "./Text";

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function extLabel(att: Pick<Attachment, "name" | "mime">): string {
  const ext = att.name.includes(".") ? att.name.split(".").pop()!.toUpperCase() : "";
  return ext.length <= 5 ? ext : att.mime.split("/").pop()!.toUpperCase().slice(0, 5);
}

const THUMB_MAX_W = 320;
const THUMB_MAX_H = 260;

// ---------------------------------------------------------------- picking

/**
 * Open the platform picker and resolve with the chosen files. Web only for
 * now: an <input type=file> is the whole story in a PWA (iOS offers Take
 * Photo / Photo Library / Browse). Resolves [] when dismissed.
 */
export function pickFiles(opts: { accept?: string; multiple?: boolean } = {}): Promise<UploadableFile[]> {
  if (Platform.OS !== "web" || typeof document === "undefined") return Promise.resolve([]);
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = opts.multiple ?? true;
    if (opts.accept) input.accept = opts.accept;
    input.style.display = "none";
    document.body.appendChild(input);
    let settled = false;
    const done = (files: UploadableFile[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.onchange = () => done(Array.from(input.files ?? []).map(fromDomFile));
    // Safari fires no "cancel"; settle on the next focus if nothing was chosen.
    input.addEventListener("cancel", () => done([]));
    window.addEventListener("focus", () => setTimeout(() => done(Array.from(input.files ?? []).map(fromDomFile)), 800), { once: true });
    input.click();
  });
}

export function fromDomFile(file: File): UploadableFile {
  return { name: file.name || "file", type: file.type || "application/octet-stream", size: file.size, data: file };
}

/** Files carried by a paste or drop event (web). Screenshots paste as image/png with no name. */
export function filesFromDataTransfer(dt: DataTransfer | null | undefined): UploadableFile[] {
  if (!dt) return [];
  const out: UploadableFile[] = [];
  const items = dt.items ? Array.from(dt.items) : [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    const named = file.name && file.name !== "image.png" ? file : new File([file], `pasted-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${(file.type.split("/")[1] ?? "bin").replace("jpeg", "jpg")}`, { type: file.type });
    out.push(fromDomFile(named));
  }
  if (out.length === 0 && dt.files) for (const f of Array.from(dt.files)) out.push(fromDomFile(f));
  return out;
}

/** Local preview URL for a picked file (web only); revoke when done. */
export function previewUri(file: UploadableFile): string | null {
  if (Platform.OS !== "web" || typeof URL === "undefined" || !(file.data instanceof Blob)) return null;
  if (!file.type.startsWith("image/")) return null;
  return URL.createObjectURL(file.data);
}

// ------------------------------------------------------------ thread view

export interface AttachmentListProps {
  attachments: Attachment[];
  api: InternsApi;
  /** JP's bubble: previews sit on the accent bubble and right-align */
  mine: boolean;
  onOpen: (attachment: Attachment) => void;
}

function AttachmentListImpl({ attachments, api, mine, onOpen }: AttachmentListProps) {
  const pictures = attachments.filter((a) => a.kind === "image" || a.kind === "svg");
  const files = attachments.filter((a) => a.kind === "file");
  return (
    <View style={[styles.list, mine ? styles.listMine : null]}>
      {pictures.map((att) => (
        <PictureThumb key={att.id} attachment={att} api={api} onPress={() => onOpen(att)} />
      ))}
      {files.map((att) => (
        <FileChip key={att.id} attachment={att} api={api} onPress={() => onOpen(att)} />
      ))}
    </View>
  );
}

export const AttachmentList = React.memo(AttachmentListImpl);

function PictureThumb({ attachment, api, onPress }: { attachment: Attachment; api: InternsApi; onPress: () => void }) {
  const { colors } = useAppTheme();
  const { width: screenWidth } = useWindowDimensions();
  const [failed, setFailed] = useState(false);
  const maxW = Math.min(THUMB_MAX_W, screenWidth - 96);
  const aspect = attachment.width && attachment.height ? attachment.width / attachment.height : 4 / 3;
  let w = maxW;
  let h = Math.round(w / aspect);
  if (h > THUMB_MAX_H) {
    h = THUMB_MAX_H;
    w = Math.round(h * aspect);
  }
  const uri = api.attachmentUrl(attachment);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={attachment.caption ?? attachment.name}
      style={({ pressed }) => [styles.thumb, { width: w, backgroundColor: colors.surfaceAlt, borderColor: colors.border, opacity: pressed ? 0.85 : 1 }]}
    >
      {failed ? (
        <View style={[styles.thumbFallback, { height: Math.min(h, 120) }]}>
          <ImageIcon size={22} color={colors.textFaint} />
          <Text variant="caption">{attachment.name}</Text>
        </View>
      ) : (
        <Image source={{ uri }} style={{ width: w, height: h }} resizeMode="cover" onError={() => setFailed(true)} accessibilityLabel={attachment.name} />
      )}
      {attachment.caption ? (
        <View style={[styles.captionBar, { backgroundColor: colors.surface }]}>
          <Text variant="caption" color={colors.textDim} numberOfLines={2}>
            {attachment.caption}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function FileChip({ attachment, api, onPress }: { attachment: Attachment; api: InternsApi; onPress: () => void }) {
  const { colors } = useAppTheme();
  // Open and Download are siblings, not nested: on web each renders a <button>,
  // and a button inside a button is invalid HTML.
  return (
    <View style={[styles.chip, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={`Open ${attachment.name}`}
        style={({ pressed }) => [styles.chipOpen, { opacity: pressed ? 0.8 : 1 }]}
      >
        <View style={[styles.chipIcon, { backgroundColor: colors.surfaceAlt }]}>
          <FileIcon size={18} color={colors.textDim} />
          <Text variant="label" style={styles.chipExt}>
            {extLabel(attachment)}
          </Text>
        </View>
        <View style={styles.chipText}>
          <Text variant="subtle" color={colors.text} numberOfLines={1}>
            {attachment.name}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {formatBytes(attachment.size)}
            {attachment.caption ? ` · ${attachment.caption}` : ""}
          </Text>
        </View>
      </Pressable>
      <Pressable
        onPress={() => void openExternal(api.attachmentUrl(attachment, true), attachment.name)}
        accessibilityRole="button"
        accessibilityLabel={`Download ${attachment.name}`}
        hitSlop={8}
        style={styles.chipAction}
      >
        <DownloadIcon size={18} color={colors.textDim} />
      </Pressable>
    </View>
  );
}

/** Open a URL in the browser / OS; on web a download URL goes through an anchor so it saves instead of navigating the PWA away. */
export async function openExternal(url: string, downloadName?: string): Promise<void> {
  if (Platform.OS === "web" && typeof document !== "undefined") {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    if (downloadName) a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    return;
  }
  await Linking.openURL(url);
}

// ----------------------------------------------------------------- viewer

export interface AttachmentViewerProps {
  attachment: Attachment | null;
  api: InternsApi;
  onClose: () => void;
}

export function AttachmentViewer({ attachment, api, onClose }: AttachmentViewerProps) {
  const { colors } = useAppTheme();
  const [svgSource, setSvgSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { width, height } = useWindowDimensions();

  useEffect(() => {
    setSvgSource(null);
    if (!attachment || attachment.kind !== "svg") return;
    let cancelled = false;
    setLoading(true);
    fetch(api.attachmentUrl(attachment))
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled) setSvgSource(text);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attachment, api]);

  if (!attachment) return null;
  const isPicture = attachment.kind === "image";
  const aspect = attachment.width && attachment.height ? attachment.width / attachment.height : 4 / 3;
  const maxW = width - space.lg * 2;
  const maxH = height - 160;
  let w = maxW;
  let h = Math.round(w / aspect);
  if (h > maxH) {
    h = maxH;
    w = Math.round(h * aspect);
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.viewer, { backgroundColor: colors.overlay }]}>
        <View style={styles.viewerBar}>
          <View style={styles.viewerTitle}>
            <Text variant="subtle" color="#fafafa" numberOfLines={1}>
              {attachment.name}
            </Text>
            <Text variant="caption" color="rgba(250,250,250,0.7)">
              {formatBytes(attachment.size)}
              {attachment.width && attachment.height ? ` · ${attachment.width}×${attachment.height}` : ""}
              {` · ${attachment.author === "jp" ? "you" : attachment.author}`}
            </Text>
          </View>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} style={styles.viewerButton}>
            <XIcon size={22} color="#fafafa" />
          </Pressable>
        </View>
        <Pressable style={styles.viewerBody} onPress={onClose} accessibilityLabel="Close viewer">
          {isPicture ? (
            <Image source={{ uri: api.attachmentUrl(attachment) }} style={{ width: w, height: h }} resizeMode="contain" accessibilityLabel={attachment.name} />
          ) : attachment.kind === "svg" ? (
            loading || !svgSource ? (
              <ActivityIndicator color="#fafafa" />
            ) : (
              <ScrollView style={{ width: maxW, maxHeight: maxH }} contentContainerStyle={styles.viewerSvg}>
                <SvgBlock xml={svgSource} maxHeight={maxH} />
              </ScrollView>
            )
          ) : (
            <View style={[styles.viewerFile, { backgroundColor: colors.surface }]}>
              <FileIcon size={34} color={colors.textDim} />
              <Text variant="body" color={colors.text} center>
                {attachment.name}
              </Text>
              <Text variant="caption" center>
                {attachment.mime} · {formatBytes(attachment.size)}
              </Text>
            </View>
          )}
        </Pressable>
        {attachment.caption ? (
          <Text variant="subtle" color="rgba(250,250,250,0.85)" center style={styles.viewerCaption}>
            {attachment.caption}
          </Text>
        ) : null}
        <View style={styles.viewerActions}>
          <ViewerAction label="Open" onPress={() => void openExternal(api.attachmentUrl(attachment))} />
          <ViewerAction label="Save" onPress={() => void openExternal(api.attachmentUrl(attachment, true), attachment.name)} />
        </View>
      </View>
    </Modal>
  );
}

function ViewerAction({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" style={({ pressed }) => [styles.viewerAction, { opacity: pressed ? 0.7 : 1 }]}>
      <Text variant="subtle" color="#09090b" style={styles.viewerActionText}>
        {label}
      </Text>
    </Pressable>
  );
}

// ---------------------------------------------------------- composer strip

export interface PendingUpload {
  /** local id, stable across re-renders */
  key: string;
  file: UploadableFile;
  /** 0..1 while uploading; 1 when done */
  progress: number;
  /** set once the orchestrator has stored it */
  attachment?: Attachment;
  error?: string;
}

export function PendingAttachments({ items, onRemove, onRetry }: { items: PendingUpload[]; onRemove: (key: string) => void; onRetry: (key: string) => void }) {
  const { colors } = useAppTheme();
  const previews = useMemo(() => new Map(items.map((item) => [item.key, previewUri(item.file)])), [items]);
  useEffect(() => {
    return () => {
      for (const uri of previews.values()) if (uri && typeof URL !== "undefined") URL.revokeObjectURL(uri);
    };
  }, [previews]);
  const remove = useCallback((key: string) => onRemove(key), [onRemove]);
  if (items.length === 0) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pendingStrip} contentContainerStyle={styles.pendingContent} keyboardShouldPersistTaps="handled">
      {items.map((item) => {
        const uri = previews.get(item.key) ?? null;
        const done = Boolean(item.attachment);
        return (
          <View key={item.key} style={[styles.pending, { backgroundColor: colors.surfaceAlt, borderColor: item.error ? colors.urgent : colors.border }]}>
            {uri ? (
              <Image source={{ uri }} style={styles.pendingImage} resizeMode="cover" accessibilityLabel={item.file.name} />
            ) : (
              <View style={[styles.pendingImage, styles.pendingFile]}>
                <FileIcon size={20} color={colors.textDim} />
                <Text variant="label">{extLabel({ name: item.file.name, mime: item.file.type })}</Text>
              </View>
            )}
            <View style={styles.pendingMeta}>
              <Text variant="caption" color={colors.text} numberOfLines={1}>
                {item.file.name}
              </Text>
              <Text variant="caption" color={item.error ? colors.urgent : colors.textFaint} numberOfLines={1}>
                {item.error ? item.error : done ? formatBytes(item.file.size) : item.progress >= 1 ? "Processing…" : `Uploading ${Math.round(item.progress * 100)}%`}
              </Text>
            </View>
            {!done && !item.error ? (
              <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
                <View style={[styles.progressFill, { backgroundColor: colors.text, width: `${Math.max(4, Math.round(item.progress * 100))}%` }]} />
              </View>
            ) : null}
            {item.error ? (
              <Pressable onPress={() => onRetry(item.key)} accessibilityRole="button" accessibilityLabel={`Retry ${item.file.name}`} style={styles.retry} hitSlop={10}>
                <RefreshIcon size={16} color={colors.text} />
              </Pressable>
            ) : null}
            <Pressable onPress={() => remove(item.key)} accessibilityRole="button" accessibilityLabel={`Remove ${item.file.name}`} hitSlop={12} style={[styles.pendingRemove, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <XIcon size={12} color={colors.text} />
            </Pressable>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm, marginTop: space.xs, alignItems: "flex-start", maxWidth: 560 },
  listMine: { alignItems: "flex-end" },
  thumb: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  thumbFallback: { alignItems: "center", justifyContent: "center", gap: space.xs, padding: space.md },
  captionBar: { paddingHorizontal: space.md, paddingVertical: space.xs },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: space.sm,
    paddingRight: space.xs,
    minWidth: 220,
    maxWidth: 360,
  },
  chipOpen: { flex: 1, flexDirection: "row", alignItems: "center", gap: space.sm },
  chipIcon: { width: 40, height: 44, borderRadius: radius.md, alignItems: "center", justifyContent: "center" },
  chipExt: { fontSize: 9, marginTop: 1 },
  chipText: { flex: 1, gap: 1 },
  chipAction: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  viewer: { flex: 1, paddingTop: 54, paddingBottom: 34 },
  viewerBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, gap: space.md },
  viewerTitle: { flex: 1 },
  viewerButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  viewerBody: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.lg },
  viewerSvg: { padding: space.xs },
  viewerFile: { alignItems: "center", gap: space.sm, padding: space.xl, borderRadius: radius.xl, maxWidth: 320 },
  viewerCaption: { paddingHorizontal: space.xl, marginBottom: space.md },
  viewerActions: { flexDirection: "row", justifyContent: "center", gap: space.md },
  viewerAction: { backgroundColor: "#fafafa", paddingHorizontal: space.xl, paddingVertical: space.sm + 2, borderRadius: radius.pill },
  viewerActionText: { fontWeight: "600" },
  pendingStrip: { maxHeight: 96, marginBottom: space.sm },
  pendingContent: { gap: space.sm, paddingHorizontal: 2, paddingTop: 6 },
  pending: { width: 200, flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.xs, overflow: "visible" },
  pendingImage: { width: 44, height: 44, borderRadius: radius.sm },
  pendingFile: { alignItems: "center", justifyContent: "center", gap: 1 },
  pendingMeta: { flex: 1, gap: 1 },
  progressTrack: { position: "absolute", left: space.xs, right: space.xs, bottom: 2, height: 2, borderRadius: 1, overflow: "hidden" },
  progressFill: { height: 2 },
  retry: { paddingHorizontal: space.sm },
  retryText: { textDecorationLine: "underline" },
  pendingRemove: { position: "absolute", top: -6, right: -6, width: 20, height: 20, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
});
