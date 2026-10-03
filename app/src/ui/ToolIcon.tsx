/**
 * The icon for an intern tool row: the product's own logo when the tool is a
 * product (Outlook mail and calendar, GitHub, Instagram), otherwise a plain glyph.
 */
import React from "react";
import { BrandLogo, TOOL_BRAND } from "./BrandLogo";
import { BoardIcon, BranchIcon, EditIcon, FileIcon, GlobeIcon, InboxIcon, ListIcon, TerminalIcon } from "./Icons";

const GLYPHS: Record<string, (p: { size?: number }) => React.ReactElement> = {
  "fs.read": FileIcon,
  "fs.write": EditIcon,
  shell: TerminalIcon,
  web: GlobeIcon,
  notebook: BoardIcon,
  todo: ListIcon,
  cards: InboxIcon,
  "integration.build": BranchIcon,
};

export function ToolIcon({ tool, size = 22 }: { tool: string; size?: number }) {
  const brand = TOOL_BRAND[tool];
  if (brand) return <BrandLogo brand={brand} size={size} />;
  const Glyph = GLYPHS[tool] ?? ListIcon;
  return <Glyph size={size} />;
}
