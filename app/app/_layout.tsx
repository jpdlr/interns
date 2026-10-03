import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, type Theme } from "expo-router";
import { StatusBar } from "expo-status-bar";
import React, { useEffect } from "react";
import { Platform } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { CrewProvider } from "../src/crew";
import { LiveProvider } from "../src/live";
import { UpdatePill, useAppUpdate } from "../src/pwa";
import { SettingsProvider } from "../src/settings";
import { AppThemeProvider, scaledFont, useAppTheme } from "../src/theme";

/**
 * Every stack screen sits on top of the tabs, even when opened cold from a
 * notification or a reload. Without this a deep-linked thread has nothing
 * beneath it: no back arrow, no tab bar, and no browser chrome in the PWA.
 */
export const unstable_settings = { initialRouteName: "(tabs)" };

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AppThemeProvider>
        <SettingsProvider>
          <LiveProvider>
          <CrewProvider>
            <AppNavigation />
          </CrewProvider>
          </LiveProvider>
        </SettingsProvider>
      </AppThemeProvider>
    </SafeAreaProvider>
  );
}

function AppNavigation() {
  const router = useRouter();
  const { updateReady, apply, dismiss } = useAppUpdate();
  const { colors, scheme, fontScale } = useAppTheme();
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  const theme: Theme = {
    ...base,
    colors: {
      ...base.colors,
      primary: colors.accent,
      background: colors.bg,
      card: colors.bg,
      text: colors.text,
      border: colors.borderSoft,
      notification: colors.urgent,
    },
  };

  // A notification can wake an already-running installed PWA. Service-worker
  // WindowClient.navigate is unreliable on iOS, so the worker hands the exact
  // route to Expo Router and waits for this acknowledgement.
  useEffect(() => {
    if (Platform.OS !== "web" || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "interns:notification-navigation" || typeof event.data.url !== "string") return;
      try {
        const target = new URL(event.data.url, window.location.origin);
        if (target.origin !== window.location.origin) return;
        // push, not replace: replacing from a tab swaps out the whole tab
        // navigator, and the thread then has no way back to the crew.
        router.push(`${target.pathname}${target.search}${target.hash}` as never);
        event.ports[0]?.postMessage({ handled: true });
      } catch {
        // No acknowledgement makes the service worker use document navigation.
      }
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [router]);

  return (
          <ThemeProvider value={theme}>
            <StatusBar style={scheme === "dark" ? "light" : "dark"} />
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: colors.bg },
                headerTintColor: colors.text,
                // Same weight and size as titles inside the app (Text "title"),
                // and it follows the text-size setting like everything else.
                headerTitleStyle: { fontSize: scaledFont(17, fontScale), fontWeight: "600", color: colors.text },
                headerShadowVisible: false,
                contentStyle: { backgroundColor: colors.bg },
                // The web shell handles any CSS top safe-area inset. React
                // Navigation must not reserve the status bar a second time on
                // web. Native still needs the default.
                ...(Platform.OS === "web" ? { headerStatusBarHeight: 0 } : {}),
              }}
            >
              {/* The title is what the back button announces from a pushed screen ("Crew, back"). */}
              <Stack.Screen name="(tabs)" options={{ headerShown: false, title: "Crew" }} />
              <Stack.Screen name="chat/[slug]" options={{ title: "" }} />
              <Stack.Screen name="hire" options={{ title: "Hire an intern" }} />
              <Stack.Screen name="setup" options={{ headerShown: false, title: "Setup" }} />
              <Stack.Screen name="inbox" options={{ headerShown: false }} />
              <Stack.Screen name="intern/[slug]/index" options={{ title: "" }} />
              <Stack.Screen name="intern/[slug]/edit" options={{ title: "" }} />
              <Stack.Screen name="group/[id]" options={{ title: "Group" }} />
              <Stack.Screen name="files/[slug]" options={{ title: "Files" }} />
              <Stack.Screen name="spend" options={{ title: "Spend" }} />
              <Stack.Screen name="connectors/index" options={{ title: "Connectors" }} />
              <Stack.Screen name="connectors/outlook" options={{ title: "Outlook" }} />
              <Stack.Screen name="connectors/github" options={{ title: "GitHub" }} />
              <Stack.Screen name="connectors/instagram" options={{ title: "Instagram" }} />
              <Stack.Screen name="connectors/google-photos" options={{ title: "Google Photos" }} />
              <Stack.Screen name="page/[id]" options={{ title: "" }} />
              <Stack.Screen name="history" options={{ title: "History" }} />
            </Stack>
            <UpdatePill visible={updateReady} onPress={apply} onDismiss={dismiss} />
          </ThemeProvider>
  );
}
