/**
 * Everything the app shows for files in a thread:
 *  - AttachmentList: the previews under a bubble (one picture as a thumbnail,
 *    several as a grid, file chips), tap → viewer or download.
 *  - AttachmentViewer: the full-screen modal, swiping through a message's
 *    pictures, with open/save and the source page when there is one.
 *  - PendingAttachments: the strip above the composer while JP is picking
 *    and uploading files.
 *  - pickFiles(): the platform file picker (DOM <input type=file> on web,
 *    which on iOS offers Photos/Camera/Files; native falls back to a note
 *    until a picker module is added).
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Image, Linking, Modal, Platform, Pressable, ScrollView, StyleSheet, View, useWindowDimensions, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
import type { Attachment, InternsApi, PageHeader, UploadableFile } from "../api";
import { haptic } from "../haptics";
import { radius, space, useAppTheme } from "../theme";
import { BackIcon, BoardIcon, ChevronRightIcon, DownloadIcon, ExternalIcon, FileIcon, HeartIcon, ImageIcon, PlayIcon, RefreshIcon, ReplyIcon, ShareIcon, XIcon } from "./Icons";
import { FadeImage, formatDuration, InlineVideo, saveToDevice, usePrefetchedBlob, ZoomableImage } from "./Media";
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

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** "instagram.com" → "Instagram": the source as a button label. */
function sourceName(url: string): string {
  const name = hostOf(url).replace(/\.(com|org|net|co\.za|io)$/, "");
  return name.charAt(0).toUpperCase() + name.slice(1);
}

const THUMB_MAX_W = 320;
const THUMB_MAX_H = 260;
/** a grid shows this many tiles; the last says "+N" for the rest */
const GRID_MAX = 6;
const GRID_GAP = 2;

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
  /** `gallery`: the message's pictures, for swiping in the viewer */
  onOpen: (attachment: Attachment, gallery: Attachment[]) => void;
}

function AttachmentListImpl({ attachments, api, mine, onOpen }: AttachmentListProps) {
  const pictures = attachments.filter((a) => a.kind === "image" || a.kind === "svg" || a.kind === "video");
  const files = attachments.filter((a) => a.kind === "file");
  return (
    <View style={[styles.list, mine ? styles.listMine : null]}>
      {pictures.length === 1 ? (
        <PictureThumb attachment={pictures[0]!} api={api} onPress={() => onOpen(pictures[0]!, pictures)} />
      ) : pictures.length > 1 ? (
        <PictureGrid pictures={pictures} api={api} onOpen={(att) => onOpen(att, pictures)} />
      ) : null}
      {files.map((att) => (
        <FileChip key={att.id} attachment={att} api={api} onPress={() => onOpen(att, [att])} />
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
      ) : attachment.kind === "video" ? (
        <View style={{ width: w, height: h }}>
          {/* plays muted while on screen; tap for sound in the viewer */}
          <InlineVideo uri={api.attachmentUrl(attachment)} poster={api.previewUrl(attachment, w)} width={w} height={h} inline accessibilityLabel={attachment.caption ?? attachment.name} />
          <VideoBadge duration={attachment.duration} />
        </View>
      ) : (
        <FadeImage uri={api.previewUrl(attachment, w)} style={{ width: w, height: h }} onError={() => setFailed(true)} accessibilityLabel={attachment.name} />
      )}
      {attachment.caption || attachment.link ? (
        <View style={[styles.captionBar, { backgroundColor: colors.surface }]}>
          {attachment.caption ? (
            <Text variant="caption" color={colors.textDim} numberOfLines={2}>
              {attachment.caption}
            </Text>
          ) : null}
          {attachment.link ? <SourceLine link={attachment.link} /> : null}
        </View>
      ) : null}
    </Pressable>
  );
}

/** The corner mark on a video: a play glyph and its length. */
function VideoBadge({ duration }: { duration?: number | null }) {
  return (
    <View style={styles.videoBadge} pointerEvents="none">
      <PlayIcon size={12} color="#fafafa" />
      {duration ? (
        <Text variant="caption" color="#fafafa" style={styles.videoBadgeText}>
          {formatDuration(duration)}
        </Text>
      ) : null}
    </View>
  );
}

function SourceLine({ link }: { link: string }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.source}>
      <ExternalIcon size={12} color={colors.textFaint} />
      <Text variant="caption" color={colors.textFaint} numberOfLines={1}>
        {hostOf(link)}
      </Text>
    </View>
  );
}

/**
 * Several pictures in one message, as a grid of square tiles in two columns
 * (an odd count leads with one wide tile). Up to GRID_MAX tiles; the last
 * one counts the rest. Captions and links show in the viewer.
 */
function PictureGrid({ pictures, api, onOpen }: { pictures: Attachment[]; api: InternsApi; onOpen: (attachment: Attachment) => void }) {
  const { colors } = useAppTheme();
  const { width: screenWidth } = useWindowDimensions();
  const width = Math.min(THUMB_MAX_W, screenWidth - 96);
  const cell = Math.floor((width - GRID_GAP) / 2);
  const shown = pictures.slice(0, GRID_MAX);
  const more = pictures.length - shown.length;
  const rows: Attachment[][] = shown.length % 2 ? [[shown[0]!]] : [];
  for (let i = shown.length % 2; i < shown.length; i += 2) rows.push(shown.slice(i, i + 2));
  return (
    <View style={[styles.grid, { width, borderColor: colors.border, backgroundColor: colors.border }]}>
      {rows.map((row, r) => (
        <View key={row[0]!.id} style={[styles.gridRow, r > 0 ? { marginTop: GRID_GAP } : null]}>
          {row.map((att) => {
            const last = more > 0 && att === shown[shown.length - 1];
            return (
              <GridTile
                key={att.id}
                attachment={att}
                api={api}
                width={row.length === 1 ? width : cell}
                height={cell}
                more={last ? more : 0}
                onPress={() => onOpen(att)}
              />
            );
          })}
        </View>
      ))}
    </View>
  );
}

function GridTile({ attachment, api, width, height, more, onPress }: { attachment: Attachment; api: InternsApi; width: number; height: number; more: number; onPress: () => void }) {
  const { colors } = useAppTheme();
  const [failed, setFailed] = useState(false);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="imagebutton"
      accessibilityLabel={more ? `${attachment.caption ?? attachment.name}, and ${more} more` : (attachment.caption ?? attachment.name)}
      style={({ pressed }) => [{ width, height, backgroundColor: colors.surfaceAlt, opacity: pressed ? 0.85 : 1 }]}
    >
      {failed ? (
        <View style={[styles.tileFallback, { width, height }]}>
          <ImageIcon size={20} color={colors.textFaint} />
        </View>
      ) : (
        <FadeImage uri={api.previewUrl(attachment, width)} style={{ width, height }} onError={() => setFailed(true)} accessibilityLabel={attachment.name} />
      )}
      {attachment.kind === "video" && !more ? <VideoBadge duration={attachment.duration} /> : null}
      {more ? (
        <View style={[StyleSheet.absoluteFill, styles.tileMore]}>
          <Text variant="title" color="#fafafa">{`+${more}`}</Text>
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
  /** the pictures to swipe through (the message's); default: just `attachment` */
  gallery?: Attachment[];
  api: InternsApi;
  onClose: () => void;
  /** reply about the picture on screen (the thread passes this; Files doesn't) */
  onReply?: (attachment: Attachment) => void;
}

export function AttachmentViewer({ attachment, gallery, api, onClose, onReply }: AttachmentViewerProps) {
  const { width, height } = useWindowDimensions();
  const pages = useMemo(() => {
    if (!attachment) return [];
    return gallery?.some((a) => a.id === attachment.id) ? gallery : [attachment];
  }, [attachment, gallery]);
  const [index, setIndex] = useState(0);
  /** the area between the title bar and the caption, for sizing pages */
  const [bodyHeight, setBodyHeight] = useState(0);
  const [zoomed, setZoomed] = useState(false);
  /** hearts given or taken here, ahead of the thread catching up */
  const [liked, setLiked] = useState<Record<string, boolean>>({});
  const [boards, setBoards] = useState<PageHeader[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const scroller = useRef<ScrollView>(null);
  const laidOutWidth = useRef(0);

  const startIndex = attachment ? Math.max(0, pages.findIndex((a) => a.id === attachment.id)) : 0;
  useEffect(() => setIndex(startIndex), [startIndex, attachment]);
  useEffect(() => {
    setLiked({});
    setBoards(null);
    setToast(null);
  }, [attachment]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const goTo = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(pages.length - 1, next));
      setIndex(clamped);
      scroller.current?.scrollTo({ x: clamped * width, animated: true });
    },
    [pages.length, width],
  );

  // arrow keys step through on web; Escape closes
  useEffect(() => {
    if (!attachment || Platform.OS !== "web" || typeof window === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") goTo(index + 1);
      else if (e.key === "ArrowLeft") goTo(index - 1);
      else if (e.key === "Escape") (boards ? setBoards(null) : onClose());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [attachment, goTo, index, onClose, boards]);

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = Math.round(e.nativeEvent.contentOffset.x / width);
      if (next !== index && next >= 0 && next < pages.length) setIndex(next);
    },
    [index, pages.length, width],
  );

  const current = pages[index] ?? attachment;
  const isMedia = current?.kind === "image" || current?.kind === "video";
  // Safari opens the share sheet only straight from a tap, so the file is fetched ahead of it
  const blob = usePrefetchedBlob(current ? api.attachmentUrl(current) : null, Boolean(current && isMedia && current.size <= 15 * 1024 * 1024));

  if (!attachment || !current) return null;
  const many = pages.length > 1;
  const maxW = width - space.lg * 2;
  const maxH = (bodyHeight || height - 260) - space.lg * 2;
  const hearted = liked[current.id] ?? Boolean(current.liked);

  const toggleHeart = async () => {
    const next = !hearted;
    setLiked((l) => ({ ...l, [current.id]: next }));
    haptic("tap");
    try {
      await api.likeAttachment(current.id, next);
    } catch {
      setLiked((l) => ({ ...l, [current.id]: !next }));
      setToast("Couldn't save that. Try again.");
    }
  };
  const keep = async (pageId?: string) => {
    setBoards(null);
    try {
      const result = await api.saveAttachmentToBoard(current.id, pageId);
      haptic("success");
      setToast(result.already ? `Already on ${result.page.title}` : `Kept on ${result.page.title}`);
    } catch {
      setToast("Couldn't keep it. Try again.");
    }
  };
  const chooseBoard = async () => {
    try {
      const all = (await api.listPages(current.intern)).filter((p) => p.kind === "moodboard" && !p.archived_at);
      if (all.length === 0) return void keep();
      setBoards(all);
    } catch {
      void keep();
    }
  };
  const save = () =>
    void saveToDevice({ blob, name: current.name, type: current.mime, downloadUrl: api.attachmentUrl(current, true), download: openExternal });

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => (boards ? setBoards(null) : onClose())}>
      <View style={styles.viewer}>
        <View style={styles.viewerBar}>
          <View style={styles.viewerTitle}>
            <Text variant="subtle" color="#fafafa" numberOfLines={1}>
              {many ? `${index + 1} of ${pages.length}` : current.name}
            </Text>
            <Text variant="caption" color="rgba(250,250,250,0.7)" numberOfLines={1}>
              {many ? `${current.name} · ` : ""}
              {current.kind === "video" && current.duration ? `${formatDuration(current.duration)} · ` : ""}
              {formatBytes(current.size)}
              {current.width && current.height ? ` · ${current.width}×${current.height}` : ""}
              {` · ${current.author === "jp" ? "you" : current.author}`}
            </Text>
          </View>
          <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} style={styles.viewerButton}>
            <XIcon size={22} color="#fafafa" />
          </Pressable>
        </View>
        <View style={styles.viewerBody} onLayout={(e) => setBodyHeight(e.nativeEvent.layout.height)}>
          <ScrollView
            ref={scroller}
            horizontal
            pagingEnabled
            scrollEnabled={many && !zoomed}
            showsHorizontalScrollIndicator={false}
            onScroll={onScroll}
            scrollEventThrottle={32}
            contentOffset={{ x: startIndex * width, y: 0 }}
            onLayout={(e) => {
              // only when the screen width changes (rotation): mid-swipe it would yank the pager
              if (e.nativeEvent.layout.width === laidOutWidth.current) return;
              laidOutWidth.current = e.nativeEvent.layout.width;
              scroller.current?.scrollTo({ x: index * width, animated: false });
            }}
            style={{ width }}
          >
            {pages.map((att, i) => (
              <View key={att.id} style={[styles.viewerPage, { width, height: bodyHeight || undefined }]}>
                <ViewerContent attachment={att} api={api} maxW={maxW} maxH={maxH} active={i === index} onZoomChange={setZoomed} />
              </View>
            ))}
          </ScrollView>
          {many && index > 0 && !zoomed ? (
            <Pressable onPress={() => goTo(index - 1)} accessibilityRole="button" accessibilityLabel="Previous" hitSlop={8} style={[styles.viewerStep, styles.viewerStepLeft]}>
              <BackIcon size={20} color="#fafafa" />
            </Pressable>
          ) : null}
          {many && index < pages.length - 1 && !zoomed ? (
            <Pressable onPress={() => goTo(index + 1)} accessibilityRole="button" accessibilityLabel="Next" hitSlop={8} style={[styles.viewerStep, styles.viewerStepRight]}>
              <ChevronRightIcon size={20} color="#fafafa" />
            </Pressable>
          ) : null}
        </View>
        {/* a fixed slot: captions of different lengths must not resize the pages mid-swipe */}
        {pages.some((a) => a.caption) ? (
          <View style={styles.viewerCaptionSlot}>
            <Text variant="subtle" color="rgba(250,250,250,0.85)" center numberOfLines={3} style={styles.viewerCaption}>
              {current.caption ?? ""}
            </Text>
          </View>
        ) : null}
        {many ? (
          <View style={styles.viewerDots}>
            {pages.map((att, i) => (
              <View key={att.id} style={[styles.viewerDot, { backgroundColor: i === index ? "#fafafa" : "rgba(250,250,250,0.35)" }]} />
            ))}
          </View>
        ) : null}
        {toast ? (
          <View style={styles.viewerToast} accessibilityLiveRegion="polite">
            <Text variant="caption" color="#09090b" style={styles.viewerActionText}>
              {toast}
            </Text>
          </View>
        ) : null}
        <View style={styles.viewerActions}>
          {isMedia ? (
            <ViewerAction label={hearted ? "Loved" : "Love"} onPress={() => void toggleHeart()} selected={hearted}>
              <HeartIcon size={22} color={hearted ? "#f43f5e" : "#fafafa"} filled={hearted} />
            </ViewerAction>
          ) : null}
          {isMedia ? (
            <ViewerAction label="Keep" onPress={() => void chooseBoard()}>
              <BoardIcon size={22} color="#fafafa" />
            </ViewerAction>
          ) : null}
          {onReply ? (
            <ViewerAction label="Reply" onPress={() => onReply(current)}>
              <ReplyIcon size={22} color="#fafafa" />
            </ViewerAction>
          ) : null}
          {current.link ? (
            <ViewerAction label={sourceName(current.link)} onPress={() => void openExternal(current.link!)}>
              <ExternalIcon size={22} color="#fafafa" />
            </ViewerAction>
          ) : (
            <ViewerAction label="Open" onPress={() => void openExternal(api.attachmentUrl(current))}>
              <ExternalIcon size={22} color="#fafafa" />
            </ViewerAction>
          )}
          <ViewerAction label="Save" onPress={save}>
            {Platform.OS === "web" && typeof navigator !== "undefined" && typeof navigator.canShare === "function" ? (
              <ShareIcon size={22} color="#fafafa" />
            ) : (
              <DownloadIcon size={22} color="#fafafa" />
            )}
          </ViewerAction>
        </View>
        {boards ? (
          <Pressable style={styles.boardBackdrop} onPress={() => setBoards(null)} accessibilityLabel="Close board list">
            <View style={styles.boardSheet}>
              <Text variant="subtle" color="#fafafa" style={styles.viewerActionText}>
                Keep it on
              </Text>
              {[...boards, ...(boards.some((b) => b.title === "Saved pictures") ? [] : [null])].map((board) => (
                <Pressable
                  key={board?.id ?? "new"}
                  onPress={() => void keep(board?.id)}
                  accessibilityRole="button"
                  style={({ pressed }) => [styles.boardRow, { opacity: pressed ? 0.7 : 1 }]}
                >
                  <BoardIcon size={18} color="rgba(250,250,250,0.8)" />
                  <Text variant="subtle" color="#fafafa" numberOfLines={1} style={styles.boardTitle}>
                    {board ? board.title : "Saved pictures (new board)"}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Pressable>
        ) : null}
      </View>
    </Modal>
  );
}

/** One page of the viewer: a zoomable picture, a playing video, an SVG, or a file card. */
function ViewerContent({ attachment, api, maxW, maxH, active, onZoomChange }: { attachment: Attachment; api: InternsApi; maxW: number; maxH: number; active: boolean; onZoomChange: (zoomed: boolean) => void }) {
  const { colors } = useAppTheme();
  const [svgSource, setSvgSource] = useState<string | null>(null);
  // Once a page has been on screen it keeps its full picture: swapping images
  // as pages come and go is what made swiping flash.
  const [visited, setVisited] = useState(active);
  useEffect(() => {
    if (active) setVisited(true);
  }, [active]);

  useEffect(() => {
    setSvgSource(null);
    if (attachment.kind !== "svg") return;
    let cancelled = false;
    fetch(api.attachmentUrl(attachment))
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled) setSvgSource(text);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [attachment, api]);

  if (attachment.kind === "image" || attachment.kind === "video") {
    const aspect = attachment.width && attachment.height ? attachment.width / attachment.height : attachment.kind === "video" ? 9 / 16 : 4 / 3;
    let w = maxW;
    let h = Math.round(w / aspect);
    if (h > maxH) {
      h = maxH;
      w = Math.round(h * aspect);
    }
    if (attachment.kind === "video") {
      // The player is made the first time you land on the video and kept,
      // paused, when you swipe on: removing it put the opening frame back
      // mid-swipe, and a new one painted black.
      return (
        <InlineVideo uri={api.attachmentUrl(attachment)} poster={api.previewUrl(attachment, w)} width={w} height={h} active={active} load={visited} accessibilityLabel={attachment.caption ?? attachment.name} />
      );
    }
    // a screen-sized copy at once; the full picture fades in over it the first time you land on it
    return (
      <ZoomableImage
        uri={api.previewUrl(attachment, w)}
        fullUri={visited ? api.attachmentUrl(attachment) : null}
        width={w}
        height={h}
        accessibilityLabel={attachment.caption ?? attachment.name}
        onZoomChange={active ? onZoomChange : undefined}
        resetKey={active}
      />
    );
  }
  if (attachment.kind === "svg") {
    return !svgSource ? (
      <ActivityIndicator color="#fafafa" />
    ) : (
      <ScrollView style={{ width: maxW, maxHeight: maxH }} contentContainerStyle={styles.viewerSvg}>
        <SvgBlock xml={svgSource} maxHeight={maxH} />
      </ScrollView>
    );
  }
  return (
    <View style={[styles.viewerFile, { backgroundColor: colors.surface }]}>
      <FileIcon size={34} color={colors.textDim} />
      <Text variant="body" color={colors.text} center>
        {attachment.name}
      </Text>
      <Text variant="caption" center>
        {attachment.mime} · {formatBytes(attachment.size)}
      </Text>
    </View>
  );
}

function ViewerAction({ label, onPress, selected, children }: { label: string; onPress: () => void; selected?: boolean; children: React.ReactNode }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      hitSlop={6}
      style={({ pressed }) => [styles.viewerAction, { opacity: pressed ? 0.6 : 1 }]}
    >
      {children}
      <Text variant="caption" color="rgba(250,250,250,0.8)" numberOfLines={1}>
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
  captionBar: { paddingHorizontal: space.md, paddingVertical: space.xs, gap: 2 },
  source: { flexDirection: "row", alignItems: "center", gap: 4 },
  grid: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden" },
  gridRow: { flexDirection: "row", gap: GRID_GAP },
  tileFallback: { alignItems: "center", justifyContent: "center" },
  tileMore: { alignItems: "center", justifyContent: "center", backgroundColor: "rgba(9,9,11,0.55)" },
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
  viewer: { flex: 1, paddingTop: 54, paddingBottom: 34, backgroundColor: "#09090b" },
  viewerBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: space.lg, gap: space.md },
  viewerTitle: { flex: 1 },
  viewerButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  viewerBody: { flex: 1, justifyContent: "center" },
  viewerPage: { alignItems: "center", justifyContent: "center", padding: space.lg },
  viewerStep: { position: "absolute", top: "50%", marginTop: -20, width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(9,9,11,0.5)" },
  viewerStepLeft: { left: space.sm },
  viewerStepRight: { right: space.sm },
  viewerDots: { flexDirection: "row", justifyContent: "center", gap: 6, marginBottom: space.md },
  viewerDot: { width: 6, height: 6, borderRadius: 3 },
  viewerSvg: { padding: space.xs },
  viewerFile: { alignItems: "center", gap: space.sm, padding: space.xl, borderRadius: radius.xl, maxWidth: 320 },
  viewerCaption: { paddingHorizontal: space.xl },
  viewerCaptionSlot: { height: 66, justifyContent: "flex-start", marginBottom: space.sm },
  viewerActions: { flexDirection: "row", justifyContent: "space-around", paddingHorizontal: space.md, maxWidth: 520, width: "100%", alignSelf: "center" },
  viewerAction: { alignItems: "center", gap: 4, minWidth: 56, minHeight: 44, paddingVertical: 4 },
  viewerToast: { alignSelf: "center", backgroundColor: "#fafafa", borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.xs + 2, marginBottom: space.md },
  boardBackdrop: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, backgroundColor: "rgba(0,0,0,0.5)", justifyContent: "flex-end" },
  boardSheet: { backgroundColor: "#18181b", borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: space.lg, paddingBottom: space.xl + 20, gap: space.xs },
  boardRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: 48 },
  boardTitle: { flex: 1 },
  videoBadge: { position: "absolute", left: 8, bottom: 8, flexDirection: "row", alignItems: "center", gap: 4, backgroundColor: "rgba(9,9,11,0.6)", borderRadius: radius.pill, paddingHorizontal: 7, paddingVertical: 3 },
  videoBadgeText: { fontVariant: ["tabular-nums"] },
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
