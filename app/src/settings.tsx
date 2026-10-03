/**
 * API URL + token, persisted in AsyncStorage. Nothing is hardcoded: the
 * phone will reach the orchestrator over Tailscale, so the base URL must be
 * editable at runtime. The default is the loopback address that the
 * orchestrator binds on this box, which is only useful in the web dev server.
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";
import { createApi, type Credentials, type InternsApi } from "./api";

const STORAGE_KEY = "interns.settings.v1";

/**
 * The orchestrator now serves this bundle itself, so on web the API lives at
 * the origin we were loaded from — no configuration needed on the phone.
 * Settings can still point somewhere else for development.
 */
export const DEFAULT_BASE_URL =
  Platform.OS === "web" && typeof location !== "undefined" && location.origin.startsWith("http")
    ? location.origin
    : "http://127.0.0.1:7810";

export interface Settings extends Credentials {}

interface SettingsContextValue {
  settings: Settings;
  /** false until AsyncStorage has been read — screens should wait */
  ready: boolean;
  /** true once a non-empty token is stored */
  configured: boolean;
  api: InternsApi;
  save: (next: Partial<Settings>) => Promise<void>;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

const EMPTY: Settings = { baseUrl: DEFAULT_BASE_URL, token: "" };

export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const [settings, setSettings] = useState<Settings>(EMPTY);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const raw = await AsyncStorage.getItem(STORAGE_KEY);
        if (!cancelled && raw) {
          const parsed = JSON.parse(raw) as Partial<Settings>;
          setSettings({
            baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl ? parsed.baseUrl : DEFAULT_BASE_URL,
            token: typeof parsed.token === "string" ? parsed.token : "",
          });
        }
      } catch {
        // corrupt/unavailable storage: fall back to defaults rather than crash
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(async (next: Partial<Settings>) => {
    setSettings((current) => {
      const merged = { ...current, ...next };
      void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(merged)).catch(() => {});
      return merged;
    });
  }, []);

  const value = useMemo<SettingsContextValue>(
    () => ({
      settings,
      ready,
      configured: settings.token.trim().length > 0,
      // A fresh client per credential change keeps the stream honest: the
      // LiveProvider resubscribes because this identity changes.
      api: createApi(settings),
      save,
    }),
    [settings, ready, save],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error("useSettings must be used inside <SettingsProvider>");
  return ctx;
}
