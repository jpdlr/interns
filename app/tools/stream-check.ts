/**
 * Checks for the live stream in src/api.ts (InternsApi.subscribe): a stream
 * that goes silent without an error is replaced, and the app catches up after
 * a reconnect and on coming back to the foreground. No server; a fake fetch
 * and a clock that can jump. Takes about ten seconds (the watchdog's tick).
 *
 *   npm run check:stream
 */
import { InternsApi, type StreamEvent, type StreamStatus } from "../src/api";

const fail = (note: string): never => {
  throw new Error(note);
};

// A clock that can jump ahead, for "nothing arrived for a minute".
let skew = 0;
const realNow = Date.now.bind(Date);
Date.now = () => realNow() + skew;

// The page: visibility and focus events, as a browser has them.
const win = new EventTarget();
const doc = Object.assign(new EventTarget(), {
  visibilityState: "visible" as "visible" | "hidden",
});
Object.assign(globalThis, { window: win, document: doc });

// Each connection sends ": connected" and then nothing, like a stream whose
// connection died somewhere along the way.
let connections = 0;
globalThis.fetch = (async (_url: string, init?: RequestInit) => {
  connections++;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(": connected\n\n"));
      init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}) as typeof fetch;

async function main() {
  const api = new InternsApi({ baseUrl: "http://127.0.0.1:1", token: "t" });
  const events: StreamEvent[] = [];
  const statuses: StreamStatus[] = [];
  const unsubscribe = api.subscribe({
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
  });

  const until = async (what: string, ok: () => boolean, ms = 15_000) => {
    const start = realNow();
    while (!ok()) {
      if (realNow() - start > ms) fail(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const polls = () => events.filter((e) => e.type === "poll").length;

  try {
    await until("the first connection", () => statuses.includes("live"));
    if (polls() !== 0) fail("no catch-up on the very first connection");

    // Coming back to the app with a fresh stream: catch up, keep the stream.
    doc.dispatchEvent(new Event("visibilitychange"));
    if (polls() !== 1) fail("coming back to the app refetches");
    if (connections !== 1) fail("a stream that spoke recently is kept");

    // Hidden: nothing to do.
    doc.visibilityState = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    if (polls() !== 1) fail("going to the background does nothing");
    doc.visibilityState = "visible";

    // A minute of silence: the watchdog replaces the stream, and the new one catches up.
    skew += 61_000;
    await until("the watchdog's reconnect", () => connections === 2);
    await until("the catch-up after reconnecting", () => polls() === 2);
    if (statuses.includes("polling") || statuses.includes("offline")) fail(`a quiet stream is not a failure: ${statuses.join(", ")}`);

    // Back from a long sleep: refetch at once and replace the quiet stream.
    skew += 31_000;
    win.dispatchEvent(new Event("pageshow"));
    if (polls() < 3) fail("pageshow refetches");
    await until("the reconnect on resume", () => connections === 3);
    await until("the catch-up after that reconnect", () => polls() >= 4);
    console.log("stream: all checks passed");
  } finally {
    unsubscribe();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
