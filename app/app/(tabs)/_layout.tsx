import { Tabs } from "expo-router";
import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CalendarIcon, ChatIcon, SettingsIcon } from "../../src/ui/Icons";
import { scaledFont, useAppTheme } from "../../src/theme";
import { useSettings } from "../../src/settings";
import { useRefreshSignal } from "../../src/live";
import { isDecision } from "../../src/api";

/**
 * The bar deliberately sets no height and no bottom padding.
 *
 * React Navigation already grows the bar by the bottom safe-area inset and
 * pads it by that same amount, and it reads the inset from
 * SafeAreaInsetsContext *inside* the bar — so it re-renders on its own the
 * moment the inset is measured. Setting `height` or `paddingBottom` here
 * overrides both with a number captured in `screenOptions`, which expo-router
 * does not re-apply when it changes. That is exactly how the standalone bar
 * ended up sized for an 8px inset instead of the 34px home indicator: labels
 * clipped, and a dead band left under the bar.
 *
 * Nothing here adds margins either. The uikit bar gives each item 49px, and
 * the icon box (28) plus the item's own padding (10) plus an 11px label
 * already fills it — the two points of icon/label margin this used to carry
 * were enough to squeeze the label box down to 7px and cut the glyphs in half.
 * flexShrink: 0 keeps the label at its natural height regardless.
 */
export default function TabsLayout() {
  const insets = useSafeAreaInsets();
  const { colors, fontScale } = useAppTheme();
  const { api, configured } = useSettings();
  const refreshSignal = useRefreshSignal(1_000, 5_000);
  const [openCount, setOpenCount] = useState(0);
  const itemOffset = insets.bottom > 0 ? 4 : 0;

  useEffect(() => {
    if (!configured) { setOpenCount(0); return; }
    // Only decisions count: information cards never badge the tab (docs/features/03-today.md).
    void api.listCards("open").then((cards) => setOpenCount(cards.filter(isDecision).length)).catch(() => {});
  }, [api, configured, refreshSignal]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textFaint,
        tabBarStyle: {
          // Keep the navigator-owned height and safe-area padding, but let the
          // menu disappear into the page instead of drawing a footer panel.
          backgroundColor: "transparent",
          borderTopColor: "transparent",
          borderTopWidth: 0,
          elevation: 0,
          shadowOpacity: 0,
        },
        // A small optical nudge toward the home indicator. Transforming only
        // the items leaves the bar's measured safe-area geometry untouched.
        tabBarItemStyle: { transform: [{ translateY: itemOffset }] },
        tabBarLabelStyle: { fontSize: scaledFont(11, fontScale), fontWeight: "600", flexShrink: 0 },
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Crew",
          tabBarIcon: ({ color, size }) => <ChatIcon color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="today"
        options={{
          title: "Today",
          tabBarIcon: ({ color, size }) => <CalendarIcon color={color} size={size} />,
          tabBarBadge: openCount || undefined,
          tabBarBadgeStyle: { backgroundColor: colors.urgent, color: "#fff", fontSize: scaledFont(10, fontScale) },
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <SettingsIcon color={color} size={size} />,
        }}
      />
      </Tabs>
    </View>
  );
}
