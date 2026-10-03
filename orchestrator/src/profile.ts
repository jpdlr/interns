/**
 * Who the crew works for, and where. Set once at startup from config
 * (`owner_name`, `timezone`) so prompts and date maths can read it without
 * threading config through every call; tests get the defaults.
 */
import type { Config } from "./config.js";
import { timeZone } from "./config.js";

let owner = "Boss";
let zone = timeZone({ timezone: "" });

export function setProfile(config: Pick<Config, "owner_name" | "timezone">): void {
  owner = config.owner_name.trim() || "Boss";
  zone = timeZone(config);
}

/** What the interns call the person they work for ("JP", "Sam", "Boss"). */
export function ownerName(): string {
  return owner;
}

/** IANA time zone the owner lives in (Today, agendas, local dates). */
export function localZone(): string {
  return zone;
}
