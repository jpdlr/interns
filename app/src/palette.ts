/**
 * The two palettes, with no imports, so the HTML shell (app/+html.tsx) can
 * turn them into CSS variables. Before the app knows the saved theme, it
 * paints with those variables (`cssVarColors`), so the very first frame is
 * already light or dark to match: no dark flash for a light-mode user.
 */
export interface AppColors {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  borderSoft: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  accentDim: string;
  accentSoft: string;
  onAccent: string;
  info: string;
  action: string;
  urgent: string;
  success: string;
  danger: string;
  destructiveSoft: string;
  successSoft: string;
  actionSoft: string;
  overlay: string;
}

export const darkColors: AppColors = {
  bg: "#09090b",
  surface: "#09090b",
  surfaceAlt: "#18181b",
  border: "#27272a",
  borderSoft: "#18181b",
  text: "#fafafa",
  textDim: "#a1a1aa",
  // ≥4.5:1 on bg: timestamps, roles and placeholders are text, not decoration.
  textFaint: "#8a8a93",
  accent: "#fafafa",
  accentDim: "#e4e4e7",
  accentSoft: "rgba(250,250,250,0.08)",
  onAccent: "#18181b",
  info: "#60a5fa",
  action: "#fbbf24",
  urgent: "#f87171",
  success: "#4ade80",
  danger: "#f87171",
  destructiveSoft: "rgba(239,68,68,0.12)",
  successSoft: "rgba(34,197,94,0.10)",
  actionSoft: "rgba(245,158,11,0.10)",
  overlay: "rgba(0,0,0,0.72)",
};

export const lightColors: AppColors = {
  bg: "#ffffff",
  surface: "#ffffff",
  surfaceAlt: "#f4f4f5",
  border: "#e4e4e7",
  borderSoft: "#f4f4f5",
  text: "#09090b",
  textDim: "#52525b",
  // ≥4.5:1 on bg and surfaceAlt (was #a1a1aa, ~2.6:1).
  textFaint: "#6b6b74",
  accent: "#18181b",
  accentDim: "#27272a",
  accentSoft: "rgba(24,24,27,0.06)",
  onAccent: "#fafafa",
  info: "#2563eb",
  action: "#b45309",
  urgent: "#dc2626",
  success: "#15803d",
  danger: "#dc2626",
  destructiveSoft: "rgba(220,38,38,0.08)",
  successSoft: "rgba(21,128,61,0.08)",
  actionSoft: "rgba(180,83,9,0.08)",
  overlay: "rgba(9,9,11,0.48)",
};

const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** Every colour as a CSS variable that follows the page's theme (web, first frame only). */
export const cssVarColors = Object.fromEntries(Object.keys(darkColors).map((k) => [k, `var(--c-${kebab(k)})`])) as unknown as AppColors;

const vars = (colors: AppColors) =>
  Object.entries(colors)
    .map(([k, v]) => `--c-${kebab(k)}: ${v};`)
    .join(" ");

/**
 * The variables behind `cssVarColors`: light by default, dark when the device
 * is, and whatever the app's own setting says once <html data-theme> is set.
 */
export function paletteCss(): string {
  return [
    `:root { ${vars(lightColors)} }`,
    `@media (prefers-color-scheme: dark) { :root { ${vars(darkColors)} } }`,
    `:root[data-theme="light"] { ${vars(lightColors)} }`,
    `:root[data-theme="dark"] { ${vars(darkColors)} }`,
  ].join("\n");
}
