/**
 * Haptic ticks, best effort. Android browsers and PWAs have the Vibration
 * API; iOS Safari does not expose haptics to web content at all, so on an
 * iPhone PWA these are silent until the app ships as a native build (where
 * expo-haptics would take over — it is required lazily so it stays optional).
 */
import { Platform } from "react-native";

type Pattern = "tap" | "double" | "success" | "warning";

const WEB_PATTERNS: Record<Pattern, number | number[]> = {
  tap: 12,
  double: [12, 70, 12],
  success: [10, 40, 24],
  warning: [30, 50, 30],
};

// expo-haptics is not a dependency yet; when it is installed for a native build this picks it up.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let nativeHaptics: any = null;
let nativeTried = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadNative(): any {
  if (nativeTried) return nativeHaptics;
  nativeTried = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    nativeHaptics = require("expo-haptics");
  } catch {
    nativeHaptics = null;
  }
  return nativeHaptics;
}

export function haptic(pattern: Pattern): void {
  try {
    if (Platform.OS === "web") {
      if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") navigator.vibrate(WEB_PATTERNS[pattern]);
      return;
    }
    const h = loadNative();
    if (!h) return;
    if (pattern === "tap") void h.impactAsync(h.ImpactFeedbackStyle.Light);
    else if (pattern === "double") void h.impactAsync(h.ImpactFeedbackStyle.Medium).then(() => setTimeout(() => void h.impactAsync(h.ImpactFeedbackStyle.Medium), 90));
    else if (pattern === "success") void h.notificationAsync(h.NotificationFeedbackType.Success);
    else void h.notificationAsync(h.NotificationFeedbackType.Warning);
  } catch {
    // never let a haptic throw into UI code
  }
}
