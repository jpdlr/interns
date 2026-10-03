/** Public deep-link bridge for push notifications and old links. The Inbox
 * became Today: `/inbox?card=` opens Today with that card first, and
 * `?view=history` opens History. */
import { useLocalSearchParams, useRouter } from "expo-router";
import React, { useEffect } from "react";
import { Loading, Screen } from "../src/ui/Screen";

export default function InboxDeepLink() {
  const router = useRouter();
  const params = useLocalSearchParams<{ card?: string; view?: string }>();
  useEffect(() => {
    if (params.view === "history") {
      router.replace(`/history${params.card ? `?card=${encodeURIComponent(params.card)}` : ""}` as never);
      return;
    }
    router.replace(`/today${params.card ? `?card=${encodeURIComponent(params.card)}` : ""}` as never);
  }, [params.card, params.view, router]);
  return <Screen><Loading label="Opening…" /></Screen>;
}
