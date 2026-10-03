/** Catalog of avatar icons (the bot-face set) for hire-time selection. */
import * as path from "node:path";
import { repoRoot } from "./config.js";

export interface IconInfo {
  id: string;
  label: string; // shown in the Discord select menu
}

export const ICONS: IconInfo[] = [
  { id: "face-01", label: "TV head · sky blue · antenna" },
  { id: "face-02", label: "Cloud · coral · satellite dot" },
  { id: "face-03", label: "Tall arch · cream · sleepy" },
  { id: "face-04", label: "Tiny pea · mint · wanderer" },
  { id: "face-05", label: "Wide capsule · amber · beret" },
  { id: "face-06", label: "Flat-top · charcoal · side-eye" },
  { id: "face-07", label: "Droplet · white · golden halo" },
  { id: "face-08", label: "Giant close-up · white · big eyes" },
  { id: "face-09", label: "Gear · navy · spinning rim" },
  { id: "face-10", label: "Bean · rose · freckles" },
  { id: "face-11", label: "Tower · teal · watchful" },
  { id: "face-12", label: "Spiky sun · gold · spinning rays" },
  { id: "face-13", label: "Squished oval · violet · mellow" },
  { id: "face-14", label: "Soft triangle · white · leaf sprout" },
  { id: "face-15", label: "Corner peeker · shy" },
  { id: "face-16", label: "Gem · lavender · cyclops" },
  { id: "face-17", label: "Overflowing capsule · red · bold" },
  { id: "face-18", label: "Narrow arch · blue-gray · tail wisp" },
  { id: "face-19", label: "Round · tangerine · ear nubs, winks" },
  { id: "face-20", label: "Squircle · sage · nodder" },
];

export const AVATAR_PNG_DIR = process.env.INTERNS_AVATAR_DIR ?? path.join(repoRoot(), "avatars", "png");
