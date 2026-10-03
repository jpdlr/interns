/**
 * Tiny in-process typed event bus. The API's SSE stream and the Discord
 * adapter subscribe here; db.ts emits on writes. Single-process by design.
 */
import { EventEmitter } from "node:events";
import type { Card, Message, Page, Room, Rule, Task } from "./types.js";

export interface BusEvents {
  message: (msg: Message) => void;
  card: (card: Card) => void;
  card_state: (card: Card) => void;
  task_state: (task: Task) => void;
  /** a room's name/members/brief/scratchpad changed */
  room: (room: Room) => void;
  /** a page was created or changed (version bumped), pinned or archived */
  page: (page: Page) => void;
  /** a standing order was added, toggled or removed */
  rule: (rule: Rule) => void;
  /** something on a day's agenda changed (a brief or debrief landed) — YYYY-MM-DD */
  agenda: (date: string) => void;
}

export class EventBus {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(100);
  }

  on<K extends keyof BusEvents>(event: K, listener: BusEvents[K]): () => void {
    this.ee.on(event, listener as (...args: unknown[]) => void);
    return () => this.ee.off(event, listener as (...args: unknown[]) => void);
  }

  emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): void {
    this.ee.emit(event, ...args);
  }
}
