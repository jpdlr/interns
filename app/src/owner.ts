/**
 * Who the crew works for and where (GET /owner), fetched once per connection
 * and shared. Schedules are written on the owner's clock, so anything that
 * shows a time for a cron uses `zone` from here.
 */
import { useEffect, useState } from "react";
import type { InternsApi, OwnerSettings } from "./api";
import { useSettings } from "./settings";

let cache: { api: InternsApi; owner: Promise<OwnerSettings | null> } | null = null;

function load(api: InternsApi): Promise<OwnerSettings | null> {
  if (cache?.api !== api) cache = { api, owner: api.owner().catch(() => null) };
  return cache.owner;
}

/** The owner's settings, or null until loaded (or on an orchestrator without /owner). */
export function useOwner(): OwnerSettings | null {
  const { api, configured } = useSettings();
  const [owner, setOwner] = useState<OwnerSettings | null>(null);
  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    void load(api).then((o) => !cancelled && setOwner(o));
    return () => {
      cancelled = true;
    };
  }, [api, configured]);
  return owner;
}

/** The zone schedules run in: the owner's, else this device's. */
export function useOwnerZone(): string {
  return useOwner()?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}
