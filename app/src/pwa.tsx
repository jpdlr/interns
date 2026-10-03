/**
 * Keeping the installed PWA up to date.
 *
 * Two mechanisms, because one of them cannot run yet:
 *
 *  1. Service worker. dist/ is re-exported → sw.js carries a new build stamp →
 *     the browser sees changed bytes on launch or refocus → the new worker
 *     installs. Browsers only register a service worker in a secure context,
 *     so over plain http://<tailscale-ip>:7810 this silently does nothing;
 *     it starts working the day the orchestrator is served over HTTPS.
 *  2. Build stamp poll. scripts/stamp-sw.mjs also writes dist/build.json, so
 *     the app can simply notice the id it booted with no longer matches the
 *     one on the server. This works over plain http today, costs one small
 *     no-store request on focus, and is what actually delivers updates now.
 *
 * Either way: if the app only just opened, or the owner is coming back to it
 * after a while away, we reload silently (composer drafts are saved). Only
 * mid-session do we offer a small card instead of yanking the screen away.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, space, useAppTheme } from "./theme";
import { RefreshIcon, XIcon } from "./ui/Icons";
import { Text } from "./ui/Text";

/** Below this, the app was "just opened" and can refresh without asking. */
const SILENT_RELOAD_WINDOW_MS = 3_000;
/** Background re-check cadence while the app stays open. */
const BUILD_POLL_MS = 60_000;
/** Away at least this long, coming back counts as "just opened". */
const AWAY_MS = 30_000;

export function useAppUpdate(): { updateReady: boolean; apply: () => void; dismiss: () => void } {
  const [updateReady, setUpdateReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  /** until when an update may reload without asking (just opened, or just back) */
  const quietUntil = useRef(Date.now() + SILENT_RELOAD_WINDOW_MS);
  const ready = useRef(false);
  const offer = useCallback(() => {
    if (Date.now() < quietUntil.current) location.reload();
    else {
      ready.current = true;
      setUpdateReady(true);
    }
  }, []);

  // ------------------------------------------- coming back after a while away
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= AWAY_MS) {
        // An update that waited while the owner was away goes in now.
        if (ready.current) return location.reload();
        quietUntil.current = Date.now() + SILENT_RELOAD_WINDOW_MS;
      }
      hiddenAt = null;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // ------------------------------------------------ build stamp (works on http)
  useEffect(() => {
    if (Platform.OS !== "web" || typeof fetch === "undefined") return;
    let booted: string | null = null;
    let disposed = false;

    const read = async (): Promise<string | null> => {
      try {
        const response = await fetch(`/build.json?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return null;
        const body = (await response.json()) as { build?: string };
        return typeof body.build === "string" ? body.build : null;
      } catch {
        return null;
      }
    };

    const check = async () => {
      const build = await read();
      if (disposed || !build) return;
      if (booted === null) {
        booted = build;
        return;
      }
      if (build !== booted) offer();
    };

    void check();
    const timer = setInterval(() => void check(), BUILD_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      disposed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [offer]);

  // ------------------------------------------------------------ service worker
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    // A first install is not an update — there was nothing to replace.
    const hadController = Boolean(navigator.serviceWorker.controller);
    let disposed = false;

    const cleanups: (() => void)[] = [];

    void navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        if (disposed) return;

        const check = () => {
          void registration.update().catch(() => {});
        };
        check();

        const onVisible = () => {
          if (!document.hidden) check();
        };
        document.addEventListener("visibilitychange", onVisible);
        window.addEventListener("focus", check);
        cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));
        cleanups.push(() => window.removeEventListener("focus", check));

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;
          installing.addEventListener("statechange", () => {
            if (installing.state !== "installed") return;
            if (!hadController && !navigator.serviceWorker.controller) return; // first install
            offer();
          });
        });
      })
      .catch(() => {
        // No service worker (unsupported, or served over plain http on a
        // non-localhost origin) — the app works, it just will not self-update.
      });

    return () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
    };
  }, [offer]);

  const apply = useCallback(() => {
    if (Platform.OS === "web") location.reload();
  }, []);
  const dismiss = useCallback(() => setDismissed(true), []);

  return { updateReady: updateReady && !dismissed, apply, dismiss };
}


/** The mid-session offer: a small card under the status bar, easy to ignore or dismiss. */
export function UpdatePill({ visible, onPress, onDismiss }: { visible: boolean; onPress: () => void; onDismiss?: () => void }) {
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  if (!visible) return null;
  return (
    <View style={[styles.wrap, { top: insets.top + space.sm }]} pointerEvents="box-none">
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]} accessibilityRole="alert">
        <View style={[styles.icon, { backgroundColor: colors.surfaceAlt }]}>
          <RefreshIcon size={18} color={colors.text} />
        </View>
        <Text variant="subtle" color={colors.text} style={styles.text} numberOfLines={1}>
          A new version is ready
        </Text>
        <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor: colors.accent }, pressed && styles.pressed]}>
          <Text variant="subtle" color={colors.onAccent} style={styles.bold}>
            Refresh
          </Text>
        </Pressable>
        {onDismiss ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Not now" onPress={onDismiss} hitSlop={8} style={({ pressed }) => [styles.close, pressed && styles.pressed]}>
            <XIcon size={16} color={colors.textDim} />
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 0, right: 0, alignItems: "center", paddingHorizontal: space.lg, zIndex: 50 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    width: "100%",
    maxWidth: 440,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.xl,
    paddingLeft: space.sm,
    paddingRight: space.md,
    paddingVertical: space.sm,
    shadowColor: "#000",
    shadowOpacity: 0.14,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  icon: { width: 34, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  text: { flex: 1 },
  bold: { fontWeight: "600" },
  button: { borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: 7 },
  close: { width: 24, height: 24, alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.75 },
});
