/**
 * App-wide visual system, based on shadcn/ui's zinc palette.
 *
 * The provider keeps the selected mode in AsyncStorage and follows the device
 * when set to `system`. Components consume the palette through `useAppTheme`
 * so native, web, navigation chrome, and the status bar all change together.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform, useColorScheme } from "react-native";
import type { CardSeverity } from "./api";

export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type TextSize = "small" | "medium" | "large";

export const TEXT_SCALE: Record<TextSize, number> = {
  small: 0.9,
  medium: 1,
  large: 1.15,
};

export function scaledFont(value: number, scale: number): number {
  return Math.round(value * scale);
}

export { cssVarColors, darkColors, lightColors, type AppColors } from "./palette";
import { cssVarColors, darkColors, lightColors, type AppColors } from "./palette";

/** 4pt base scale. */
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32, xxxl: 48 } as const;

/** shadcn-style compact corners; pills are reserved for pills. */
export const radius = { sm: 6, md: 8, lg: 12, xl: 16, pill: 999 } as const;

export function severityColor(colors: AppColors, severity: CardSeverity | string): string {
  return ({ info: colors.info, action: colors.action, urgent: colors.urgent } as Record<string, string>)[severity] ?? colors.info;
}

interface AppThemeValue {
  colors: AppColors;
  mode: ThemeMode;
  scheme: ResolvedTheme;
  setMode: (mode: ThemeMode) => Promise<void>;
  textSize: TextSize;
  fontScale: number;
  setTextSize: (size: TextSize) => Promise<void>;
}

const STORAGE_KEY = "interns.theme.v1";
const TEXT_SIZE_STORAGE_KEY = "interns.textSize.v1";
const AppThemeContext = createContext<AppThemeValue | null>(null);

export function AppThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [textSize, setTextSizeState] = useState<TextSize>("medium");
  // Static export has no device preference. Its tree and the first client
  // frame both paint with CSS variables (cssVarColors) that the page resolves
  // to light or dark, then storage/system are resolved after mount; a
  // different first client tree would leave navigator-owned inline styles
  // (notably the transparent tab canvas) stale after hydration.
  const [hydrated, setHydrated] = useState(Platform.OS !== "web");
  const scheme: ResolvedTheme = !hydrated
    ? "dark"
    : mode === "system"
      ? (system === "light" ? "light" : "dark")
      : mode;
  // Before the saved theme is known (web), paint with CSS variables that the
  // page already resolves to light or dark: the same tree as the static
  // export, but the right colours from the first frame.
  const palette = !hydrated ? cssVarColors : scheme === "dark" ? darkColors : lightColors;

  useEffect(() => {
    let active = true;
    void Promise.all([AsyncStorage.getItem(STORAGE_KEY), AsyncStorage.getItem(TEXT_SIZE_STORAGE_KEY)])
      .then(([storedMode, storedTextSize]) => {
        if (active && (storedMode === "system" || storedMode === "light" || storedMode === "dark")) setModeState(storedMode);
        if (active && (storedTextSize === "small" || storedTextSize === "medium" || storedTextSize === "large")) {
          setTextSizeState(storedTextSize);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) setHydrated(true);
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined" || !hydrated) return;
    document.documentElement.dataset.theme = scheme;
    document.documentElement.style.colorScheme = scheme;
    document.documentElement.style.backgroundColor = palette.bg;
    document.body.style.backgroundColor = palette.bg;
    const root = document.getElementById("root");
    if (root) root.style.backgroundColor = palette.bg;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", palette.bg);
  }, [palette, scheme, hydrated]);

  const setMode = useCallback(async (next: ThemeMode) => {
    setModeState(next);
    await AsyncStorage.setItem(STORAGE_KEY, next).catch(() => {});
  }, []);

  const setTextSize = useCallback(async (next: TextSize) => {
    setTextSizeState(next);
    await AsyncStorage.setItem(TEXT_SIZE_STORAGE_KEY, next).catch(() => {});
  }, []);

  const value = useMemo<AppThemeValue>(
    () => ({ colors: palette, mode, scheme, setMode, textSize, fontScale: TEXT_SCALE[textSize], setTextSize }),
    [palette, mode, scheme, setMode, textSize, setTextSize],
  );
  return React.createElement(AppThemeContext.Provider, { value }, children);
}

export function useAppTheme(): AppThemeValue {
  const value = useContext(AppThemeContext);
  if (!value) throw new Error("useAppTheme must be used inside <AppThemeProvider>");
  return value;
}
