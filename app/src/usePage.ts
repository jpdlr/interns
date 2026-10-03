/**
 * One page, fetched once per screen and kept current by the live stream:
 * a `page` event with a newer version refetches it. Shared by in-thread
 * previews and the full-screen page view.
 */
import { useCallback, useEffect, useState } from "react";
import type { Page, PageEvent } from "./api";
import { useLiveEvents } from "./live";
import { loadPageSeen, onPageSeenChange } from "./pageSeen";
import { useSettings } from "./settings";

export function usePage(id: string | undefined): { page: Page | null; error: string | null; reload: () => void; seenVersion: number | undefined } {
  const { api, configured } = useSettings();
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seenVersion, setSeenVersion] = useState<number | undefined>(undefined);

  const reload = useCallback(() => {
    if (!id || !configured) return;
    api
      .getPage(id)
      .then((next) => {
        setPage(next);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, configured, id]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!id) return;
    const read = () => void loadPageSeen().then((seen) => setSeenVersion(seen[id]));
    read();
    return onPageSeenChange(read);
  }, [id]);

  useLiveEvents((event) => {
    if (event.type === "poll") return reload();
    if (event.type !== "page" || !event.data) return;
    const changed = event.data as PageEvent;
    if (changed.id !== id) return;
    if (!page || changed.version !== page.version || changed.pinned !== page.pinned || changed.archived !== Boolean(page.archived_at)) reload();
  });

  return { page, error, reload, seenVersion };
}

/** Display label + glyph name per page kind. */
export const PAGE_KIND_LABEL: Record<string, string> = {
  people: "People",
  board: "Board",
  table: "Table",
  list: "List",
  draft: "Email draft",
};
