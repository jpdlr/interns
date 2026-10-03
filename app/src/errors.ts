/**
 * Turn whatever a request threw into words for JP. The raw text (status
 * codes, server detail, URLs) is kept as `detail` for a "Details" toggle, so
 * nothing is lost for debugging, but the headline never reads like a log line.
 */
import { ApiError, NetworkError } from "./api";

export interface FriendlyError {
  /** one short sentence, safe to show anywhere */
  message: string;
  /** the original text, for a details disclosure; absent when it adds nothing */
  detail?: string;
  /** whether trying again could plausibly help */
  retryable: boolean;
}

export function friendlyError(error: unknown, subject?: string): FriendlyError {
  const raw = error instanceof Error ? error.message : String(error ?? "");
  if (error instanceof NetworkError) {
    return { message: "Can't reach the orchestrator right now. Check your connection.", detail: raw, retryable: true };
  }
  if (error instanceof ApiError) {
    const what = subject ?? "that";
    if (error.status === 401) return { message: "The app's access token was rejected. Update it in Settings › Connection.", detail: raw, retryable: false };
    if (error.status === 404) return { message: `Couldn't find ${what} — maybe archived or renamed.`, detail: raw, retryable: false };
    if (error.status === 409) return { message: conflictText(raw) ?? "That clashes with something that already exists.", detail: raw, retryable: false };
    if (error.status === 413) return { message: "That's too large to send.", detail: raw, retryable: false };
    if (error.status === 429) return { message: "The orchestrator is busy. Try again in a moment.", detail: raw, retryable: true };
    if (error.status >= 500) return { message: "The orchestrator hit a problem. Try again in a moment.", detail: raw, retryable: true };
    if (error.status === 400 || error.status === 422) {
      // Validation messages are written for people ("must be ≥ 10000"): keep them.
      const reason = raw.replace(/^\d{3}[^:]*:\s*/, "").trim();
      return { message: reason && reason !== raw ? `The orchestrator didn't accept that: ${reason}` : "The orchestrator didn't accept that.", detail: raw, retryable: false };
    }
  }
  if (!raw) return { message: "Something went wrong.", retryable: true };
  // Already-friendly strings from callers pass through untouched.
  return { message: raw, retryable: true };
}

/** A 409 body is usually a sentence written for people ("Name already taken"). */
function conflictText(raw: string): string | null {
  const match = /^409[^:]*:\s*(.+)$/.exec(raw);
  return match?.[1]?.trim() || null;
}
