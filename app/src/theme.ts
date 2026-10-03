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

export interface AppColors {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderSoft: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  accentDim: string;
  accentSoft: string;
  onAccent: string;
  info: string;
  action: string;
  urgent: string;
  success: string;
  danger: string;
  destructiveSoft: string;
  successSoft: string;
  actionSoft: string;
  overlay: string;
}

export const darkColors: AppColors = {
  bg: "#09090b",
  surface: "#09090b",
  surfaceAlt: "#18181b",
  border: "#27272a",
  borderSoft: "#18181b",
  text: "#fafafa",
  textDim: "#a1a1aa",
  // ≥4.5:1 on bg: timestamps, roles and placeholders are text, not decoration.
  textFaint: "#8a8a93",
  accent: "#fafafa",
  accentDim: "#e4e4e7",
  accentSoft: "rgba(250,250,250,0.08)",
  onAccent: "#18181b",
  info: "#60a5fa",
  action: "#fbbf24",
  urgent: "#f87171",
  success: "#4ade80",
  danger: "#f87171",
  destructiveSoft: "rgba(239,68,68,0.12)",
  successSoft: "rgba(34,197,94,0.10)",
  actionSoft: "rgba(245,158,11,0.10)",
  overlay: "rgba(0,0,0,0.72)",
};

export const lightColors: AppColors = {
  bg: "#ffffff",
  surface: "#ffffff",
  surfaceAlt: "#f4f4f5",
  border: "#e4e4e7",
  borderSoft: "#f4f4f5",
  text: "#09090b",
  textDim: "#52525b",
  // ≥4.5:1 on bg and surfaceAlt (was #a1a1aa, ~2.6:1).
  textFaint: "#6b6b74",
  accent: "#18181b",
  accentDim: "#27272a",
  accentSoft: "rgba(24,24,27,0.06)",
  onAccent: "#fafafa",
  info: "#2563eb",
  action: "#b45309",
  urgent: "#dc2626",
  success: "#15803d",
  danger: "#dc2626",
  destructiveSoft: "rgba(220,38,38,0.08)",
  successSoft: "rgba(21,128,61,0.08)",
  actionSoft: "rgba(180,83,9,0.08)",
  overlay: "rgba(9,9,11,0.48)",
};

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
  // Static export has no device preference and renders dark. Match that exact
  // first client frame, then resolve storage/system after mount; otherwise
  // React hydrates a light server tree against a dark client tree and leaves
  // navigator-owned inline styles (notably the transparent tab canvas) stale.
  const [hydrated, setHydrated] = useState(Platform.OS !== "web");
  const scheme: ResolvedTheme = !hydrated
    ? "dark"
    : mode === "system"
      ? (system === "light" ? "light" : "dark")
      : mode;
  const palette = scheme === "dark" ? darkColors : lightColors;

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
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    document.documentElement.dataset.theme = scheme;
    document.documentElement.style.colorScheme = scheme;
    document.documentElement.style.backgroundColor = palette.bg;
    document.body.style.backgroundColor = palette.bg;
    const root = document.getElementById("root");
    if (root) root.style.backgroundColor = palette.bg;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", palette.bg);
  }, [palette, scheme]);

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
