/**
 * Web Push subscription state + actions for the Settings screen.
 *
 * iOS 16.4+ only exposes the Notification/Push APIs inside a PWA that has
 * been installed to the home screen and opened from there — an ordinary
 * Safari tab has neither `Notification` nor `PushManager`, indistinguishable
 * from "this browser doesn't support push" unless we check for iOS
 * specifically. So "not installed as a PWA" gets its own state with the
 * exact instructions JP needs, instead of a generic "unsupported".
 */
import { useCallback, useEffect, useState } from "react";
import { Platform } from "react-native";
import type { InternsApi, PushDeliveryReport, PushStatus, PushSubscriptionJSON } from "./api";

export type PushState =
  | { kind: "checking" }
  | { kind: "unsupported"; reason: string }
  | { kind: "not-installed" }
  | { kind: "denied" }
  | { kind: "ready" } // permission not yet requested, or granted but not subscribed
  | { kind: "subscribed" }
  | { kind: "busy" }
  | { kind: "error"; message: string };

function isStandalone(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return Boolean(nav.standalone) || Boolean(window.matchMedia?.("(display-mode: standalone)").matches);
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  // iPadOS 13+ reports as "MacIntel" with touch support — Safari's own
  // recommended sniff for "this is actually an iPad".
  return (
    /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** VAPID public key (base64url, from GET /push/key) -> the Uint8Array pushManager.subscribe wants. */
function urlBase64ToUint8Array(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

export interface UsePushNotifications {
  state: PushState;
  serverStatus: PushStatus | null;
  testResult: PushDeliveryReport | null;
  /** Requests permission (if needed), subscribes, and posts the subscription to the orchestrator. */
  subscribe: () => Promise<void>;
  /** Drops the subscription both from the browser and the orchestrator. */
  unsubscribe: () => Promise<void>;
  refresh: () => Promise<void>;
  test: () => Promise<void>;
}

export function usePushNotifications(api: InternsApi): UsePushNotifications {
  const [state, setState] = useState<PushState>({ kind: "checking" });
  const [serverStatus, setServerStatus] = useState<PushStatus | null>(null);
  const [testResult, setTestResult] = useState<PushDeliveryReport | null>(null);

  const refresh = useCallback(async () => {
    void api.getPushStatus().then(setServerStatus).catch(() => {});
    if (Platform.OS !== "web" || typeof navigator === "undefined") {
      setState({ kind: "unsupported", reason: "Push notifications are web-only." });
      return;
    }
    if (!("serviceWorker" in navigator)) {
      setState({ kind: "unsupported", reason: "This browser has no service worker support." });
      return;
    }
    if (typeof Notification === "undefined" || typeof window === "undefined" || !("PushManager" in window)) {
      if (isIos() && !isStandalone()) {
        setState({ kind: "not-installed" });
      } else {
        setState({ kind: "unsupported", reason: "This browser does not support Web Push." });
      }
      return;
    }
    if (Notification.permission === "denied") {
      setState({ kind: "denied" });
      return;
    }
    try {
      const registration = await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      setState(existing ? { kind: "subscribed" } : { kind: "ready" });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const subscribe = useCallback(async () => {
    setState({ kind: "busy" });
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? { kind: "denied" } : { kind: "ready" });
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const { vapid_public } = await api.getPushKey();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        // lib.dom's ArrayBufferView<ArrayBuffer> is stricter than what a plain
        // Uint8Array's `.buffer` (typed ArrayBufferLike) satisfies; the DOM
        // API itself accepts any BufferSource at runtime.
        applicationServerKey: urlBase64ToUint8Array(vapid_public) as BufferSource,
      });
      await api.subscribePush(subscription.toJSON() as PushSubscriptionJSON);
      setServerStatus(await api.getPushStatus().catch(() => null));
      setState({ kind: "subscribed" });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [api]);

  const unsubscribe = useCallback(async () => {
    setState({ kind: "busy" });
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        // Best-effort on the server side — a stale row gets pruned on the next
        // failed send anyway, so a dropped unsubscribe call must not strand
        // the user on "busy".
        await api.unsubscribePush(subscription.endpoint).catch(() => {});
        await subscription.unsubscribe();
      }
      setState({ kind: "ready" });
      setServerStatus(await api.getPushStatus().catch(() => null));
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [api]);

  const test = useCallback(async () => {
    setState({ kind: "busy" });
    try {
      const result = await api.testPush();
      setTestResult(result);
      setServerStatus(await api.getPushStatus().catch(() => null));
      setState({ kind: "subscribed" });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [api]);

  return { state, serverStatus, testResult, subscribe, unsubscribe, refresh, test };
}
