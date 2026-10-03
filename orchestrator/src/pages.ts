/**
 * Pages (docs/features/02-pages.md): validation and item edits, shared by
 * the API routes the intern-page CLI calls. The db stores whatever passes
 * here; every write bumps the page's version and emits a `page` event.
 */
import type { Db } from "./db.js";
import { pageFence } from "./fences.js";
import { PAGE_DATA_SCHEMAS, PAGE_ITEM_FIELD, type Page, type PageKind } from "./types.js";

export class PageError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "PageError";
  }
}

/** Parse `data` against its kind's schema; throws PageError with the first few issues. */
export function validatePageData(kind: PageKind, data: unknown): Record<string, unknown> {
  const parsed = PAGE_DATA_SCHEMAS[kind].safeParse(data ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".") || "data"}: ${i.message}`);
    throw new PageError(`invalid ${kind} data — ${issues.join("; ")}`);
  }
  const value = parsed.data as Record<string, unknown>;
  const field = PAGE_ITEM_FIELD[kind];
  if (field) {
    const ids = (value[field] as { id: string }[]).map((i) => i.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) throw new PageError(`duplicate item id "${dup}" in ${field}`);
  }
  return value;
}

function items(page: Page): { field: string; list: Record<string, unknown>[] } {
  const field = PAGE_ITEM_FIELD[page.kind];
  if (!field) throw new PageError(`a ${page.kind} page has no items`);
  const list = Array.isArray(page.data[field]) ? (page.data[field] as Record<string, unknown>[]) : [];
  return { field, list };
}

/** Merge `set` into one item; `id` cannot change. */
export function patchItem(db: Db, page: Page, itemId: string, set: Record<string, unknown>): Page {
  const { field, list } = items(page);
  const index = list.findIndex((i) => i.id === itemId);
  if (index === -1) throw new PageError(`no item "${itemId}" on this page`, 404);
  const next = [...list];
  const merged: Record<string, unknown> = { ...list[index], ...set, id: itemId };
  // explicit null clears an optional field
  for (const [k, v] of Object.entries(merged)) if (v === null && page.kind !== "table") delete merged[k];
  next[index] = merged;
  const data = validatePageData(page.kind, { ...page.data, [field]: next });
  return db.updatePage(page.id, { data })!;
}

export function addItem(db: Db, page: Page, item: Record<string, unknown>): Page {
  const { field, list } = items(page);
  if (typeof item.id !== "string" || !item.id) throw new PageError("a new item needs a string id");
  if (list.some((i) => i.id === item.id)) throw new PageError(`item "${String(item.id)}" already exists — use patch-item`);
  const data = validatePageData(page.kind, { ...page.data, [field]: [...list, item] });
  return db.updatePage(page.id, { data })!;
}

export function removeItem(db: Db, page: Page, itemId: string): Page {
  const { field, list } = items(page);
  if (!list.some((i) => i.id === itemId)) throw new PageError(`no item "${itemId}" on this page`, 404);
  const data = validatePageData(page.kind, { ...page.data, [field]: list.filter((i) => i.id !== itemId) });
  return db.updatePage(page.id, { data })!;
}

/** Queue the page's preview for the owner's next reply (create / `intern-page show`). */
export function announcePage(db: Db, page: Page): void {
  db.announce(page.intern, pageFence(page), page.id);
}

/** Item count for list summaries ("23 people"). */
export function itemCount(page: Page): number {
  const field = PAGE_ITEM_FIELD[page.kind];
  return field && Array.isArray(page.data[field]) ? (page.data[field] as unknown[]).length : 0;
}

/** Page without its data — what list endpoints return. */
export function pageHeader(page: Page): Omit<Page, "data"> & { items: number } {
  const { data: _data, ...rest } = page;
  return { ...rest, items: itemCount(page) };
}

// ------------------------------------------------------------------ search

export interface PageSearchHit {
  page_id: string;
  page_title: string;
  kind: Page["kind"];
  intern: string;
  /** null when the page itself (title/summary/draft) matched rather than one item */
  item_id: string | null;
  label: string;
  detail: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** Every searchable string in an item, nested lists (tags, timeline) included. */
function haystack(value: unknown, depth = 0): string {
  if (depth > 3 || value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => haystack(v, depth + 1)).join(" ");
  if (typeof value === "object") return Object.values(value as Record<string, unknown>).map((v) => haystack(v, depth + 1)).join(" ");
  return str(value);
}

function itemLabel(page: Page, item: Record<string, unknown>): { label: string; detail: string } {
  switch (page.kind) {
    case "people":
      return {
        label: str(item.name),
        detail: [str(item.company), str(item.stage), item.next_follow_up ? `follow up ${str(item.next_follow_up).slice(0, 10)}` : ""].filter(Boolean).join(" · "),
      };
    case "board": {
      const columns = Array.isArray(page.data.columns) ? (page.data.columns as { id: string; title: string }[]) : [];
      return { label: str(item.title), detail: [columns.find((c) => c.id === item.column)?.title ?? "", str(item.subtitle)].filter(Boolean).join(" · ") };
    }
    case "table": {
      const columns = Array.isArray(page.data.columns) ? (page.data.columns as { key: string; icon?: boolean }[]) : [];
      const keys = columns.filter((c) => !c.icon).map((c) => c.key);
      return { label: str(item[keys[0] ?? "id"]), detail: keys.slice(1, 4).map((k) => str(item[k])).filter(Boolean).join(" · ") };
    }
    default:
      return { label: str(item.text), detail: Array.isArray(item.tags) ? (item.tags as string[]).join(" · ") : "" };
  }
}

/**
 * Find people, cards, rows and list items across every live page: all query
 * words must appear somewhere in the item ("kettle" finds Danny Reyes,
 * whose company is Kettle Labs). Items whose label matches rank first.
 */
export function searchPages(pages: Page[], query: string, limit = 30): PageSearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const matches = (text: string) => {
    const t = text.toLowerCase();
    return words.every((w) => t.includes(w));
  };
  const hits: (PageSearchHit & { rank: number })[] = [];
  for (const page of pages) {
    if (page.archived_at) continue;
    const field = PAGE_ITEM_FIELD[page.kind];
    const items = field && Array.isArray(page.data[field]) ? (page.data[field] as Record<string, unknown>[]) : [];
    let itemHit = false;
    for (const item of items) {
      if (!matches(haystack(item))) continue;
      const { label, detail } = itemLabel(page, item);
      itemHit = true;
      hits.push({ page_id: page.id, page_title: page.title, kind: page.kind, intern: page.intern, item_id: str(item.id), label: label || str(item.id), detail, rank: matches(label) ? 0 : 1 });
    }
    // The page itself: its title/summary, or (drafts) the email it holds.
    const own = page.kind === "draft" ? `${page.title} ${page.summary} ${haystack(page.data)}` : `${page.title} ${page.summary}`;
    if (!itemHit && matches(own)) {
      hits.push({ page_id: page.id, page_title: page.title, kind: page.kind, intern: page.intern, item_id: null, label: page.title, detail: page.summary, rank: 2 });
    }
  }
  return hits
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
    .slice(0, limit)
    .map(({ rank: _rank, ...hit }) => hit);
}
