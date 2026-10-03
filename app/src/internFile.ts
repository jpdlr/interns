/**
 * One intern's "employee file", shared by the profile overview and its
 * editors (app/intern/[slug]/…): the manifest from the orchestrator, the
 * /meta catalogs, and the form shape the editors work on.
 */
import { useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";
import { ApiError, type InternManifestDetail, type InternManifestPatch, type MetaResponse, type NotifyLevel, type Style } from "./api";
import { DEFAULT_STYLE } from "./style";
import { useSettings } from "./settings";

/** Used only if GET /meta fails — mirrors orchestrator/src/engine.ts TOOL_CATALOG keys. */
export const FALLBACK_TOOLS = ["fs.read", "fs.write", "shell", "web", "notebook", "todo", "mail", "calendar", "cards", "instagram", "photos"];

/** What each tool lets an intern do, in plain words. */
export const TOOL_INFO: Record<string, { label: string; detail: string }> = {
  "fs.read": { label: "Read files", detail: "Look at files on the server" },
  "fs.write": { label: "Write files", detail: "Create and edit files on the server" },
  shell: { label: "Run commands", detail: "Use the server's command line" },
  web: { label: "Browse the web", detail: "Search and read web pages" },
  notebook: { label: "Notebooks", detail: "Edit Jupyter notebooks" },
  todo: { label: "To-do list", detail: "Keep a working checklist" },
  mail: { label: "Outlook mail", detail: "Read mail and write drafts — never sends" },
  calendar: { label: "Outlook calendar", detail: "Read your calendar" },
  cards: { label: "Cards", detail: "Ask you to decide things with cards" },
  github: { label: "GitHub", detail: "Read pull requests, propose reviews" },
  instagram: { label: "Instagram research", detail: "Look up public accounts and hashtags — never posts" },
  photos: { label: "Your photos", detail: "Photos you share from Google Photos" },
  "integration.build": { label: "Build integrations", detail: "Forge's build tooling" },
};

/** The notification levels in JP's words, quietest last. */
export const NOTIFY_INFO: Record<NotifyLevel, { label: string; detail: string }> = {
  all: { label: "Everything", detail: "Every message and card buzzes straight away." },
  needs_you: { label: "When they need you", detail: "Replies to you, questions and decisions buzz. Updates they post on their own wait for your summary." },
  summary: { label: "Summary only", detail: "Nothing buzzes on its own; it all comes in your summary." },
  off: { label: "Nothing", detail: "No notifications. It's all still here in the app." },
};
export const NOTIFY_LEVELS: NotifyLevel[] = ["all", "needs_you", "summary", "off"];

/** "Last 2 weeks: 12 buzzes, you opened 3 · 8 in summaries" */
export function notifyStatsLine(stats: InternManifestDetail["notify_stats"]): string | undefined {
  if (!stats || stats.now + stats.summary + stats.off === 0) return undefined;
  const parts = [
    stats.now ? `${stats.now} buzz${stats.now === 1 ? "" : "es"}, you opened ${stats.opened}` : null,
    stats.summary ? `${stats.summary} in summaries` : null,
    stats.off ? `${stats.off} left in the app` : null,
  ].filter(Boolean);
  return `Last 2 weeks: ${parts.join(" · ")}`;
}

export interface FormState {
  name: string;
  role: string;
  persona: string;
  system_prompt: string;
  icon: string;
  tools: string[];
  cron: string;
  mentions: boolean;
  mail_push: boolean;
  backlog: string[];
  daily_token_cap: string;
  drafts_only: boolean;
  notify: NotifyLevel;
  /** Outlook mailboxes they may use; null = every connected one */
  mailboxes: string[] | null;
  /** personality dials */
  style: Style;
}

export function formFromManifest(m: InternManifestDetail): FormState {
  return {
    name: m.name,
    role: m.role,
    persona: m.persona,
    system_prompt: m.system_prompt,
    icon: m.icon,
    tools: [...m.tools],
    cron: m.triggers.cron ?? "",
    mentions: m.triggers.mentions !== false,
    mail_push: m.triggers.mail_push ?? false,
    backlog: [...m.backlog],
    daily_token_cap: String(m.guardrails.daily_token_cap),
    drafts_only: m.guardrails.drafts_only,
    notify: m.notify ?? "needs_you",
    mailboxes: m.mailboxes ?? null,
    style: m.style ?? DEFAULT_STYLE,
  };
}

export function buildPatch(form: FormState): InternManifestPatch {
  return {
    name: form.name.trim(),
    role: form.role.trim(),
    persona: form.persona.trim(),
    system_prompt: form.system_prompt.trim(),
    icon: form.icon,
    tools: form.tools,
    triggers: {
      cron: form.cron.trim() ? form.cron.trim() : null,
      mentions: form.mentions,
      mail_push: form.mail_push,
    },
    backlog: form.backlog.map((item) => item.trim()).filter(Boolean),
    guardrails: {
      drafts_only: form.drafts_only,
      daily_token_cap: Number(form.daily_token_cap),
    },
    notify: form.notify,
    mailboxes: form.mailboxes,
    style: form.style,
  };
}

/**
 * Only what an editor actually changed, so saving one section never writes
 * back stale copies of the others (a switch flipped elsewhere, a backlog the
 * intern edited meanwhile). A rename's carried prose edits count as changes.
 */
export function changedPatch(initial: FormState, form: FormState): InternManifestPatch {
  const before = buildPatch(initial);
  const after = buildPatch(form);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const out: InternManifestPatch = {};
  for (const key of ["name", "role", "persona", "system_prompt", "icon", "tools", "backlog", "notify", "mailboxes", "style"] as const) {
    if (!same(before[key], after[key])) Object.assign(out, { [key]: after[key] });
  }
  const triggers = Object.fromEntries(Object.entries(after.triggers ?? {}).filter(([k, v]) => !same(before.triggers?.[k as keyof typeof before.triggers], v)));
  if (Object.keys(triggers).length) out.triggers = triggers;
  if (!same(before.guardrails, after.guardrails)) out.guardrails = after.guardrails;
  return out;
}

/** 41230 → "41k", 200000 → "200k", 1500000 → "1.5M". */
export function shortTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/**
 * Load the manifest (+ /meta, best-effort) and refetch whenever the screen
 * regains focus — coming back from an editor shows what was just saved.
 */
export function useInternFile(slug: string | undefined) {
  const { api, configured } = useSettings();
  const [manifest, setManifest] = useState<InternManifestDetail | null>(null);
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    if (!slug || !configured) {
      setLoading(false);
      return;
    }
    try {
      const [detail, metaResult] = await Promise.all([api.getInternManifest(slug), api.getMeta().catch(() => null)]);
      setManifest(detail);
      setMeta(metaResult);
      setNotFound(false);
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(e);
    } finally {
      setLoading(false);
    }
  }, [api, configured, slug]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  /** Save part of the manifest straight away (switches, the face). */
  const patch = useCallback(
    async (p: InternManifestPatch) => {
      if (!slug) return;
      const updated = await api.patchInternManifest(slug, p);
      setManifest(updated);
      return updated;
    },
    [api, slug],
  );

  return { manifest, meta, loading, notFound, error, load, patch, setManifest };
}
