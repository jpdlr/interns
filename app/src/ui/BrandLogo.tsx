/**
 * A real product's logo (Outlook, GitHub, Microsoft…), from svgl.app via
 * assets/brands and `npm run gen:brands`. Connectors and anything else that
 * is a named product use this, never a stand-in glyph (CONTRIBUTING.md ›
 * Logos). Dark mode uses `<brand>_dark` when the brand has one.
 */
import React from "react";
import { Platform, View, type ViewStyle } from "react-native";
import { BRAND_SVGS } from "../brands.generated";
import { useAppTheme } from "../theme";

export type Brand =
  | "outlook"
  | "github"
  | "instagram"
  | "microsoft"
  | "discord"
  | "clickup"
  | "notion"
  | "google-calendar"
  | "google-drive"
  | "google-sheets"
  | "google-slides"
  | "sharepoint"
  | "onedrive"
  | "word"
  | "excel"
  | "powerpoint";

/** Which tools are a brand's product (intern tool rows show its logo). */
export const TOOL_BRAND: Record<string, Brand> = {
  mail: "outlook",
  calendar: "outlook",
  github: "github",
  instagram: "instagram",
};

export function BrandLogo({ brand, size = 24, style }: { brand: Brand; size?: number; style?: ViewStyle }) {
  const { scheme } = useAppTheme();
  const raw = (scheme === "dark" && BRAND_SVGS[`${brand}_dark`]) || BRAND_SVGS[brand] || "";
  // Ids are unique per brand, not per copy: on web a hidden screen underneath
  // can hold the same logo, and a gradient that resolves into it paints nothing.
  const uid = React.useId().replace(/[^A-Za-z0-9_-]/g, "");
  const svg = React.useMemo(() => raw.replace(/(id="|#)brand-/g, `$1brand-${uid}-`), [raw, uid]);
  const frame: ViewStyle = { width: size, height: size };
  if (Platform.OS === "web") {
    return (
      <View style={[frame, style]} pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no">
        {/* eslint-disable-next-line react/no-danger */}
        {React.createElement("div", { style: { width: "100%", height: "100%", display: "flex" }, dangerouslySetInnerHTML: { __html: svg } })}
      </View>
    );
  }
  // Required lazily so the web render path never touches the XML parser.
  const { SvgXml } = require("react-native-svg") as typeof import("react-native-svg");
  return (
    <View style={[frame, style]} pointerEvents="none">
      <SvgXml xml={svg} width={size} height={size} />
    </View>
  );
}
