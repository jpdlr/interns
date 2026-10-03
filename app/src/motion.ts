/**
 * Reduced motion, for animations driven from JS. The faces' CSS keyframes
 * already stop under prefers-reduced-motion (app/+html.tsx); typing dots,
 * arrival pulses and card exits run through Animated and need telling.
 */
import { useEffect, useState } from "react";
import { AccessibilityInfo, Platform } from "react-native";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    Platform.OS === "web" && typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  useEffect(() => {
    if (Platform.OS === "web") {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      const onChange = () => setReduced(query.matches);
      query.addEventListener?.("change", onChange);
      return () => query.removeEventListener?.("change", onChange);
    }
    let active = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => active && setReduced(value));
    const sub = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduced);
    return () => {
      active = false;
      sub.remove();
    };
  }, []);
  return reduced;
}
