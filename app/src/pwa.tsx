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
 * Either way: if the app only just opened we reload silently, and if JP is
 * mid-session we offer a pill rather than yanking the screen out from under
 * him.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { radius, space, useAppTheme } from "./theme";
import { Text } from "./ui/Text";

/** Below this, the app was "just opened" and can refresh without asking. */
const SILENT_RELOAD_WINDOW_MS = 3_000;
/** Background re-check cadence while the app stays open. */
const BUILD_POLL_MS = 60_000;

export function useAppUpdate(): { updateReady: boolean; apply: () => void } {
  const [updateReady, setUpdateReady] = useState(false);

  // ------------------------------------------------ build stamp (works on http)
  useEffect(() => {
    if (Platform.OS !== "web" || typeof fetch === "undefined") return;
    const loadedAt = Date.now();
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
      if (build !== booted) {
        if (Date.now() - loadedAt < SILENT_RELOAD_WINDOW_MS) location.reload();
        else setUpdateReady(true);
      }
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
  }, []);

  // ------------------------------------------------------------ service worker
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

    const loadedAt = Date.now();
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
            if (Date.now() - loadedAt < SILENT_RELOAD_WINDOW_MS) {
              location.reload();
            } else {
              setUpdateReady(true);
            }
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
  }, []);

  const apply = useCallback(() => {
    if (Platform.OS === "web") location.reload();
  }, []);

  return { updateReady, apply };
}


/** The mid-session offer. Deliberately small and ignorable. */
export function UpdatePill({ visible, onPress }: { visible: boolean; onPress: () => void }) {
  const { colors } = useAppTheme();
  if (!visible) return null;
  return (
    <View style={styles.wrap} pointerEvents="box-none">
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        style={({ pressed }) => [styles.pill, { backgroundColor: colors.surface, borderColor: colors.border }, pressed && styles.pressed]}
      >
        <Text variant="caption" color={colors.accent}>
          Update ready — tap to refresh
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    top: space.sm,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 50,
  },
  pill: {
    paddingHorizontal: space.lg,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pressed: { opacity: 0.75 },
});
