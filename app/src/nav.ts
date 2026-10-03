/**
 * Back navigation that never strands the reader. A screen opened cold — from
 * a notification, a shared link or a PWA relaunch — may have nothing beneath
 * it, and an installed PWA has no browser back button to fall back on.
 */
import { useNavigation, type useRouter } from "expo-router";
import { useCallback, useEffect, useRef } from "react";
import { Alert, Platform } from "react-native";

type Router = ReturnType<typeof useRouter>;

export function goBack(router: Router, fallback = "/"): void {
  if (router.canGoBack()) router.back();
  else router.replace(fallback as never);
}

/**
 * Ask before a form with unsaved edits is left by back, swipe or a link.
 * Call the returned `allowLeave()` right before navigating away after a
 * successful save — state updates have not re-rendered yet at that point.
 */
export function useConfirmDiscard(dirty: boolean, what = "your changes"): () => void {
  const navigation = useNavigation();
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const allowed = useRef(false);

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const unsubscribe = navigation.addListener("beforeRemove" as never, (event: any) => {
      if (!dirtyRef.current || allowed.current) return;
      event.preventDefault();
      const leave = () => navigation.dispatch(event.data.action);
      if (Platform.OS === "web" && typeof window !== "undefined") {
        if (window.confirm(`Discard ${what}?`)) leave();
        return;
      }
      Alert.alert(`Discard ${what}?`, "You haven't saved yet.", [
        { text: "Keep editing", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: leave },
      ]);
    });
    return unsubscribe;
  }, [navigation, what]);

  // Reloading or closing the tab skips navigation events entirely.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined" || !dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  return useCallback(() => {
    allowed.current = true;
  }, []);
}
