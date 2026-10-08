/**
 * Picture and video building blocks for the thread and the viewer:
 *  - FadeImage: an <Image> that fades in once loaded, over a quiet placeholder
 *  - InlineVideo: a <video> on web (muted autoplay while on screen in the
 *    thread; controls and sound in the viewer); the poster elsewhere
 *  - ZoomableImage: pinch, drag and double-tap zoom in the viewer (web)
 *  - saveToDevice: the share sheet with the file (iOS: "Save Image" puts it
 *    in Photos), else a download
 */
import React, { useEffect, useRef, useState } from "react";
import { Animated, Image, Platform, View, type ImageResizeMode, type ImageStyle, type StyleProp, type ViewStyle } from "react-native";

export function formatDuration(seconds: number | null | undefined): string {
  if (!seconds && seconds !== 0) return "";
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function FadeImage({
  uri,
  style,
  resizeMode = "cover",
  accessibilityLabel,
  onError,
}: {
  uri: string;
  style: StyleProp<ImageStyle>;
  resizeMode?: ImageResizeMode;
  accessibilityLabel?: string;
  onError?: () => void;
}) {
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => opacity.setValue(0), [uri, opacity]);
  return (
    <Animated.Image
      source={{ uri }}
      style={[style, { opacity }]}
      resizeMode={resizeMode}
      accessibilityLabel={accessibilityLabel}
      onLoad={() => Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: Platform.OS !== "web" }).start()}
      onError={onError}
    />
  );
}

type VideoElement = HTMLVideoElement & { webkitEnterFullscreen?: () => void };

/**
 * A video. `inline`: muted, looping, no controls, playing only while at least
 * half of it is on screen (the thread). Otherwise controls and sound, playing
 * while `active` (the viewer's current page). Native shows the poster.
 *
 * The poster image sits underneath and the <video> stays invisible until it
 * has a frame to paint: a fresh <video> paints black first, which flashed.
 */
export function InlineVideo({
  uri,
  poster,
  width,
  height,
  inline = false,
  active = true,
  load = true,
  accessibilityLabel,
}: {
  uri: string;
  poster: string;
  width: number;
  height: number;
  inline?: boolean;
  active?: boolean;
  /** false: just the poster, for now (the player joins it later without replacing it) */
  load?: boolean;
  accessibilityLabel?: string;
}) {
  const ref = useRef<VideoElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    const show = () => setShown(true);
    if (video.readyState >= 2) show();
    video.addEventListener("loadeddata", show);
    video.addEventListener("playing", show);
    return () => {
      video.removeEventListener("loadeddata", show);
      video.removeEventListener("playing", show);
    };
  }, [uri, load]);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    if (!inline) {
      if (!active) {
        video.pause();
        return;
      }
      // With sound when the browser allows it; iOS refuses sound without a
      // tap (a swipe isn't one), so it then plays muted: tap the speaker.
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => setShown(true)); // can't play at all: show the controls
      });
      return;
    }
    // React doesn't reflect `muted` as an attribute, and iOS only autoplays muted video that has it
    video.muted = true;
    video.defaultMuted = true;
    video.setAttribute("muted", "");
    if (typeof IntersectionObserver === "undefined") {
      void video.play().catch(() => {});
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void video.play().catch(() => {});
        else video.pause();
      },
      { threshold: 0.5 },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [inline, active, uri, load]);

  if (Platform.OS !== "web") {
    return <FadeImage uri={poster} style={{ width, height }} accessibilityLabel={accessibilityLabel} />;
  }
  return (
    <View style={{ width, height }}>
      <FadeImage uri={poster} style={{ width, height }} resizeMode={inline ? "cover" : "contain"} accessibilityLabel={accessibilityLabel} />
      {load ? (
        <View style={{ position: "absolute", top: 0, left: 0, width, height }}>
          {React.createElement("video", {
            ref,
            src: uri,
            poster,
            playsInline: true,
            loop: inline,
            controls: !inline,
            preload: inline ? "metadata" : "auto",
            "aria-label": accessibilityLabel,
            style: {
              width,
              height,
              objectFit: inline ? "cover" : "contain",
              display: "block",
              backgroundColor: "transparent",
              opacity: shown ? 1 : 0,
              transition: "opacity 120ms ease-out",
              pointerEvents: inline ? "none" : "auto",
            },
          })}
        </View>
      ) : null}
    </View>
  );
}

const MAX_ZOOM = 4;
const DOUBLE_TAP_MS = 300;

/**
 * A picture you can pinch, drag and double-tap to zoom (web: pointer events,
 * so touch, pen and mouse alike). Reports when it is zoomed so the viewer can
 * stop paging. Unzoomed, one-finger swipes pass through to the pager.
 */
export function ZoomableImage({
  uri,
  fullUri,
  width,
  height,
  accessibilityLabel,
  onZoomChange,
  resetKey,
}: {
  /** what shows at once: a screen-sized copy */
  uri: string;
  /** the full picture, faded in over `uri` once it has loaded; it stays from then on */
  fullUri?: string | null;
  width: number;
  height: number;
  accessibilityLabel?: string;
  onZoomChange?: (zoomed: boolean) => void;
  /** changing it puts the picture back to fit (the viewer moved on) */
  resetKey?: unknown;
}) {
  const frame = useRef<View>(null);
  const inner = useRef<View>(null);
  const zoomChange = useRef(onZoomChange);
  zoomChange.current = onZoomChange;
  const reset = useRef<() => void>(() => {});

  useEffect(() => reset.current(), [resetKey]);

  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = frame.current as unknown as HTMLElement | null;
    const content = inner.current as unknown as HTMLElement | null;
    if (!el || !content) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let scale = 1;
    let tx = 0;
    let ty = 0;
    let zoomed = false;
    let start = { scale: 1, tx: 0, ty: 0, dist: 1, mx: 0, my: 0, x: 0, y: 0 };
    let lastTap = { t: 0, x: 0, y: 0 };

    const center = () => {
      const r = el.getBoundingClientRect();
      return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    };
    const clamp = () => {
      const maxX = ((scale - 1) * width) / 2;
      const maxY = ((scale - 1) * height) / 2;
      tx = Math.max(-maxX, Math.min(maxX, tx));
      ty = Math.max(-maxY, Math.min(maxY, ty));
    };
    const apply = (animate = false) => {
      content.style.transition = animate ? "transform 180ms ease-out" : "none";
      content.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      const now = scale > 1.01;
      el.style.touchAction = now ? "none" : "pan-x pan-y";
      el.style.cursor = now ? "grab" : "zoom-in";
      if (now !== zoomed) {
        zoomed = now;
        zoomChange.current?.(now);
      }
    };
    reset.current = () => {
      scale = 1;
      tx = 0;
      ty = 0;
      apply();
    };
    const snapshot = () => {
      const pts = [...pointers.values()];
      const [a, b] = pts;
      const mx = b ? (a!.x + b.x) / 2 : a!.x;
      const my = b ? (a!.y + b.y) / 2 : a!.y;
      start = { scale, tx, ty, dist: b ? Math.hypot(a!.x - b.x, a!.y - b.y) || 1 : 1, mx, my, x: a!.x, y: a!.y };
    };

    const down = (e: PointerEvent) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        const now = Date.now();
        if (now - lastTap.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
          // double tap: zoom in on the spot, or back out
          const { cx, cy } = center();
          if (scale > 1.01) {
            scale = 1;
            tx = 0;
            ty = 0;
          } else {
            scale = 2.5;
            tx = -(e.clientX - cx) * (scale - 1);
            ty = -(e.clientY - cy) * (scale - 1);
            clamp();
          }
          apply(true);
          lastTap = { t: 0, x: 0, y: 0 };
          pointers.clear();
          return;
        }
        lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
      if (pointers.size === 2 || scale > 1.01) el.setPointerCapture?.(e.pointerId);
      snapshot();
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pts = [...pointers.values()];
      if (pts.length >= 2) {
        const [a, b] = pts;
        const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        const mx = (a!.x + b!.x) / 2;
        const my = (a!.y + b!.y) / 2;
        const next = Math.max(1, Math.min(MAX_ZOOM, (start.scale * dist) / start.dist));
        const { cx, cy } = center();
        // keep the point between the fingers under the fingers
        const k = next / start.scale;
        tx = mx - cx - (start.mx - cx - start.tx) * k;
        ty = my - cy - (start.my - cy - start.ty) * k;
        scale = next;
        clamp();
        apply();
        e.preventDefault();
      } else if (scale > 1.01) {
        tx = start.tx + (e.clientX - start.x);
        ty = start.ty + (e.clientY - start.y);
        clamp();
        apply();
        e.preventDefault();
      }
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (scale < 1.05 && scale !== 1) {
        scale = 1;
        tx = 0;
        ty = 0;
        apply(true);
      }
      if (pointers.size) snapshot();
    };

    apply();
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move, { passive: false });
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, [width, height]);

  return (
    <View ref={frame} style={{ width, height, overflow: "visible" } as StyleProp<ViewStyle>}>
      <View ref={inner} style={{ width, height }}>
        <FadeImage uri={uri} style={{ width, height }} resizeMode="contain" accessibilityLabel={accessibilityLabel} />
        {fullUri && fullUri !== uri ? <FadeImage uri={fullUri} style={{ position: "absolute", top: 0, left: 0, width, height }} resizeMode="contain" /> : null}
      </View>
    </View>
  );
}

/**
 * Keep a file: the share sheet with the file itself where the browser can
 * share files (iPhone: "Save Image"/"Save Video" puts it in Photos), else a
 * download. `blob` should be fetched ahead of the tap: Safari only opens the
 * share sheet straight from the tap.
 */
export async function saveToDevice(opts: { blob: Blob | null; name: string; type: string; downloadUrl: string; download: (url: string, name: string) => Promise<void> }): Promise<void> {
  if (Platform.OS === "web" && opts.blob && typeof navigator !== "undefined" && typeof navigator.canShare === "function" && typeof File !== "undefined") {
    const file = new File([opts.blob], opts.name, { type: opts.type });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return; // dismissed
      }
    }
  }
  await opts.download(opts.downloadUrl, opts.name);
}

/** Fetch a file ahead of a Save tap (see saveToDevice); null when it can't be had. */
export function usePrefetchedBlob(url: string | null, enabled: boolean): Blob | null {
  const [blob, setBlob] = useState<Blob | null>(null);
  useEffect(() => {
    setBlob(null);
    if (!url || !enabled || Platform.OS !== "web") return;
    let cancelled = false;
    fetch(url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (!cancelled) setBlob(b);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [url, enabled]);
  return blob;
}
