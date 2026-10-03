/**
 * One shared connection to GET /events for the whole app. Screens subscribe
 * to the event stream and to a `revision` counter that ticks on every event
 * (including the polling fallback's synthetic "poll"), which they use as a
 * refetch trigger.
 */
import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { StreamEvent, StreamStatus } from "./api";
import { useSettings } from "./settings";

type Listener = (event: StreamEvent) => void;

interface LiveContextValue {
  status: StreamStatus;
  detail?: string;
  /** increments on every stream event — use in a useEffect dep to refetch */
  revision: number;
  subscribe: (listener: Listener) => () => void;
}

const LiveContext = createContext<LiveContextValue | null>(null);

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const { api, ready, configured, settings } = useSettings();
  const [status, setStatus] = useState<StreamStatus>("connecting");
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  const listeners = useRef(new Set<Listener>());

  useEffect(() => {
    if (!ready || !configured) {
      setStatus("offline");
      setDetail(configured ? undefined : "Not configured — add your API URL and token in Settings.");
      return;
    }
    const unsubscribe = api.subscribe({
      onEvent: (event) => {
        for (const listener of listeners.current) listener(event);
        setRevision((r) => r + 1);
      },
      onStatus: (next, nextDetail) => {
        setStatus(next);
        setDetail(nextDetail);
      },
    });
    return unsubscribe;
    // settings identity covers baseUrl/token changes
  }, [api, ready, configured, settings.baseUrl, settings.token]);

  const value = useMemo<LiveContextValue>(
    () => ({
      status,
      detail,
      revision,
      subscribe: (listener) => {
        listeners.current.add(listener);
        return () => listeners.current.delete(listener) as unknown as void;
      },
    }),
    [status, detail, revision],
  );

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveContextValue {
  const ctx = useContext(LiveContext);
  if (!ctx) throw new Error("useLive must be used inside <LiveProvider>");
  return ctx;
}

/**
 * `revision`, debounced: a burst of stream events (a reply streaming in, a
 * card and its state change, the polling fallback's ticks) becomes one
 * refetch instead of one per event. `maxWaitMs` keeps a continuous stream
 * from starving screens of updates altogether.
 */
export function useRefreshSignal(delayMs = 600, maxWaitMs = 3_000): number {
  const { revision } = useLive();
  const [signal, setSignal] = useState(revision);
  const burstStart = useRef<number | null>(null);
  useEffect(() => {
    if (revision === signal) return;
    const now = Date.now();
    if (burstStart.current === null) burstStart.current = now;
    const wait = Math.max(0, Math.min(delayMs, burstStart.current + maxWaitMs - now));
    const timer = setTimeout(() => {
      burstStart.current = null;
      setSignal(revision);
    }, wait);
    return () => clearTimeout(timer);
  }, [revision, signal, delayMs, maxWaitMs]);
  return signal;
}

/** Subscribe to stream events with a stable callback. */
export function useLiveEvents(listener: Listener): void {
  const { subscribe } = useLive();
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => subscribe((event) => ref.current(event)), [subscribe]);
}
