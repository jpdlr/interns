/**
 * The crew directory, app-wide: slug → name / icon / face for every intern,
 * fetched once and refreshed on live-stream revisions. Mention chips in
 * markdown, speaker faces in group bubbles and the @ autocomplete all read
 * from here instead of each screen fetching /interns again.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { Intern } from "./api";
import { useRefreshSignal } from "./live";
import { useSettings } from "./settings";
import { resolveFaceId } from "./ui/InternFace";

export interface CrewMember {
  slug: string;
  name: string;
  role: string;
  faceId: string;
}

interface CrewValue {
  members: CrewMember[];
  bySlug: Record<string, CrewMember>;
  /** case-insensitive lookup by slug, full name, or first name — the same rule the orchestrator uses for @mentions */
  resolve: (token: string) => CrewMember | undefined;
  loaded: boolean;
}

const CrewContext = createContext<CrewValue>({ members: [], bySlug: {}, resolve: () => undefined, loaded: false });

export function CrewProvider({ children }: { children: React.ReactNode }) {
  const { api, ready, configured } = useSettings();
  // Hires and renames are rare: a slow, debounced refresh is plenty.
  const refreshSignal = useRefreshSignal(2_000, 10_000);
  const [interns, setInterns] = useState<Intern[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!ready || !configured) return;
    let active = true;
    api
      .listInterns()
      .then((crew) => {
        if (!active) return;
        setInterns(crew);
        setLoaded(true);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
    // revision: a hire/archive changes the directory; cheap to refetch
  }, [api, ready, configured, refreshSignal]);

  const value = useMemo<CrewValue>(() => {
    const members = interns.map((i) => ({ slug: i.slug, name: i.name, role: i.role, faceId: resolveFaceId(i.icon, i.slug) }));
    const bySlug = Object.fromEntries(members.map((m) => [m.slug, m]));
    const resolve = (token: string) => {
      const key = token.toLowerCase().replace(/[.]+$/, "");
      return (
        members.find((m) => m.slug.toLowerCase() === key)
        ?? members.find((m) => m.name.toLowerCase() === key || m.name.toLowerCase().replace(/\s+/g, "_") === key || m.name.toLowerCase().replace(/\s+/g, "-") === key)
        ?? members.find((m) => m.name.toLowerCase().split(/\s+/)[0] === key)
      );
    };
    return { members, bySlug, resolve, loaded };
  }, [interns, loaded]);

  return <CrewContext.Provider value={value}>{children}</CrewContext.Provider>;
}

export function useCrew(): CrewValue {
  return useContext(CrewContext);
}

/**
 * Why `name` can't be used, or null if it's free — mirrors the orchestrator's
 * rule (hire.ts assertNameAvailable), which stays the authority: two active
 * interns sharing a name would make @mentions ambiguous.
 */
export function nameConflict(name: string, members: CrewMember[], exceptSlug?: string): string | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  const slug = key.normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (slug === "coordinator" || slug === "memory") return `"${name.trim()}" is reserved — pick another name.`;
  const clash = members.find((m) => m.slug !== exceptSlug && m.name.trim().toLowerCase() === key);
  return clash ? `${clash.name} is already on the crew — pick another name.` : null;
}

/** Thread keys for group chats are `room-…`; everything else is an intern slug. */
export function isRoomKey(key: string | undefined): boolean {
  return Boolean(key && key.startsWith("room-"));
}

/** The `@tok` the caret is currently inside, if any — for autocomplete. */
export function mentionQueryAt(text: string): { start: number; query: string } | null {
  const m = /(^|[^\w@/.-])@([\w.-]*)$/.exec(text);
  if (!m) return null;
  return { start: text.length - m[2]!.length - 1, query: m[2]! };
}
