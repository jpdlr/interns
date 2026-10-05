/**
 * The handful of glyphs the app needs, as paths — react-native-svg renders
 * these on web (via react-native-web) and native alike, so no icon font.
 */
import React from "react";
import { View, type ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useAppTheme } from "../theme";
import { BrandLogo } from "./BrandLogo";

interface IconProps {
  size?: number;
  color?: ColorValue;
}

function Icon({ size = 22, color, d }: IconProps & { d: string }) {
  const { colors } = useAppTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={d} stroke={color ?? colors.textDim} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export const ChatIcon = (p: IconProps) => (
  <Icon {...p} d="M20 12a7.5 7.5 0 0 1-7.5 7.5H8L4 22v-4.2A7.5 7.5 0 0 1 12.5 4.5 7.5 7.5 0 0 1 20 12Z" />
);
export const InboxIcon = (p: IconProps) => (
  <Icon {...p} d="M3.5 13.5h4l1.2 2.2h6.6l1.2-2.2h4M3.5 13.5 6 5.5h12l2.5 8v4.2a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8Z" />
);
export const SettingsIcon = (p: IconProps) => (
  <Icon {...p} d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm8-3.2a8 8 0 0 0-.15-1.5l2-1.5-2-3.4-2.35.9a8 8 0 0 0-2.6-1.5L14.5 2h-5l-.4 2.5a8 8 0 0 0-2.6 1.5L4.15 5.1l-2 3.4 2 1.5A8 8 0 0 0 4 12c0 .5.05 1 .15 1.5l-2 1.5 2 3.4 2.35-.9a8 8 0 0 0 2.6 1.5l.4 2.5h5l.4-2.5a8 8 0 0 0 2.6-1.5l2.35.9 2-3.4-2-1.5c.1-.5.15-1 .15-1.5Z" />
);
export const SendIcon = (p: IconProps) => <Icon {...p} d="M4.5 12h14m0 0-5.5-5.5M18.5 12 13 17.5" />;
export const BackIcon = (p: IconProps) => <Icon {...p} d="M15 5l-7 7 7 7" />;
export const CheckIcon = (p: IconProps) => <Icon {...p} d="M5 12.5l4.5 4.5L19 7" />;
export const PlusIcon = (p: IconProps) => <Icon {...p} d="M12 5v14M5 12h14" />;
export const RefreshIcon = (p: IconProps) => (
  <Icon {...p} d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5" />
);
export const SearchIcon = (p: IconProps) => (
  <Icon {...p} d="m20 20-4.3-4.3m2.3-5.2a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z" />
);
export const XIcon = (p: IconProps) => <Icon {...p} d="M6 6l12 12M18 6 6 18" />;
export const ChevronRightIcon = (p: IconProps) => <Icon {...p} d="M9 5l7 7-7 7" />;
export const ChevronDownIcon = (p: IconProps) => <Icon {...p} d="M5 9l7 7 7-7" />;
export const GearIcon = (p: IconProps) => (
  <Icon {...p} d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Zm8-3.2a8 8 0 0 0-.15-1.5l2-1.5-2-3.4-2.35.9a8 8 0 0 0-2.6-1.5L14.5 2h-5l-.4 2.5a8 8 0 0 0-2.6 1.5L4.15 5.1l-2 3.4 2 1.5A8 8 0 0 0 4 12c0 .5.05 1 .15 1.5l-2 1.5 2 3.4 2.35-.9a8 8 0 0 0 2.6 1.5l.4 2.5h5l.4-2.5a8 8 0 0 0 2.6-1.5l2.35.9 2-3.4-2-1.5c.1-.5.15-1 .15-1.5Z" />
);
export const PaperclipIcon = (p: IconProps) => (
  <Icon {...p} d="m20.5 11.2-8.3 8.3a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.6 1.6 0 0 1-2.3-2.3l7.9-7.9" />
);
export const DownloadIcon = (p: IconProps) => <Icon {...p} d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M4.5 19.5h15" />;
export const ExpandIcon = (p: IconProps) => <Icon {...p} d="M9 4H4v5m11-5h5v5M9 20H4v-5m11 5h5v-5" />;
export const FileIcon = (p: IconProps) => (
  <Icon {...p} d="M14 3H7a1.5 1.5 0 0 0-1.5 1.5v15A1.5 1.5 0 0 0 7 21h10a1.5 1.5 0 0 0 1.5-1.5V7.5L14 3Zm0 0v4.5h4.5M9 12.5h6M9 16h6" />
);
export const ImageIcon = (p: IconProps) => (
  <Icon {...p} d="M5 4.5h14A1.5 1.5 0 0 1 20.5 6v12a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18V6A1.5 1.5 0 0 1 5 4.5Zm10.2 5.3a1.4 1.4 0 1 0-2.8 0 1.4 1.4 0 0 0 2.8 0ZM3.5 16.5l5-5 5 5 2.5-2.5 4.5 4.5" />
);
export const UsersIcon = (p: IconProps) => (
  <Icon {...p} d="M16 19.5v-1.7a3.3 3.3 0 0 0-3.3-3.3H6.3A3.3 3.3 0 0 0 3 17.8v1.7M12.8 8a3.3 3.3 0 1 1-6.6 0 3.3 3.3 0 0 1 6.6 0Zm8.2 11.5v-1.7a3.3 3.3 0 0 0-2.5-3.2M15.5 4.9a3.3 3.3 0 0 1 0 6.3" />
);
export const ReplyIcon = (p: IconProps) => <Icon {...p} d="M9.5 6.5 4 11.5l5.5 5M4.5 11.5H14a5.5 5.5 0 0 1 5.5 5.5v1.5" />;
export const CopyIcon = (p: IconProps) => (
  <Icon {...p} d="M8.5 8.5V6A1.5 1.5 0 0 1 10 4.5h8A1.5 1.5 0 0 1 19.5 6v8a1.5 1.5 0 0 1-1.5 1.5h-2.5M6 8.5h8A1.5 1.5 0 0 1 15.5 10v8a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18v-8A1.5 1.5 0 0 1 6 8.5Z" />
);
export const TableIcon = (p: IconProps) => (
  <Icon {...p} d="M4.5 6A1.5 1.5 0 0 1 6 4.5h12A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V6Zm0 4.5h15m-15 4.5h15M10 4.5v15" />
);
export const ChartIcon = (p: IconProps) => <Icon {...p} d="M4.5 19.5h15M7 16v-5m5 5V7m5 9v-3" />;
export const EditIcon = (p: IconProps) => (
  <Icon {...p} d="M4.5 19.5h4l10-10a1.4 1.4 0 0 0 0-2l-2-2a1.4 1.4 0 0 0-2 0l-10 10v4Zm9.5-13 3 3" />
);
export const TrashIcon = (p: IconProps) => (
  <Icon {...p} d="M4.5 7h15M9.5 7V4.8c0-.5.4-.8.9-.8h3.2c.5 0 .9.3.9.8V7m-8 0 .7 12.2c0 .7.6 1.3 1.3 1.3h6c.7 0 1.3-.6 1.3-1.3L16 7" />
);

export const CalendarIcon = (p: IconProps) => (
  <Icon {...p} d="M7.5 3.5v3m9-3v3M4.5 10h15M6 6h12a1.5 1.5 0 0 1 1.5 1.5V18a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V7.5A1.5 1.5 0 0 1 6 6Z" />
);
export const BoardIcon = (p: IconProps) => <Icon {...p} d="M5 4.5h3.5v15H5Zm5.25 0h3.5v10h-3.5Zm5.25 0H19v12.5h-3.5Z" />;
export const ListIcon = (p: IconProps) => <Icon {...p} d="M9 6.5h10.5M9 12h10.5M9 17.5h10.5M4.75 6.5h.5M4.75 12h.5M4.75 17.5h.5" />;
export const MailIcon = (p: IconProps) => (
  <Icon {...p} d="M5 5.5h14A1.5 1.5 0 0 1 20.5 7v10a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 17V7A1.5 1.5 0 0 1 5 5.5Zm-1 1 8 6.5 8-6.5" />
);
/** A branch, for build/code work. (Products like GitHub use their own logo: BrandLogo.) */
export const BranchIcon = (p: IconProps) => (
  <Icon {...p} d="M6.5 3.5v11M6.5 14.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM17.5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM17.5 9c0 4-4.5 4-11 5.5" />
);
export const TerminalIcon = (p: IconProps) => (
  <Icon {...p} d="M4.5 5.5h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM7.5 9.5 10 12l-2.5 2.5M12 15h4.5" />
);
export const GlobeIcon = (p: IconProps) => (
  <Icon {...p} d="M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 0 0 0-17ZM3.5 12h17M12 3.5c2.2 2.3 3.3 5.1 3.3 8.5s-1.1 6.2-3.3 8.5c-2.2-2.3-3.3-5.1-3.3-8.5S9.8 5.8 12 3.5Z" />
);
export const BulbIcon = (p: IconProps) => (
  <Icon {...p} d="M9.5 18h5M10.25 21h3.5M12 3a5.75 5.75 0 0 0-3.4 10.4c.55.42.9 1.04.9 1.73V15.5h5v-.37c0-.69.35-1.31.9-1.73A5.75 5.75 0 0 0 12 3Z" />
);
export const ExternalIcon = (p: IconProps) => (
  <Icon {...p} d="M13.5 4.5h6v6m0-6-8.5 8.5M18 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1H10" />
);
export const PinIcon = (p: IconProps) => (
  <Icon {...p} d="M9 4.5h6M10 4.5v5.2l-3 3.3h10l-3-3.3V4.5M12 13v6.5" />
);

// Reactions (teach by reacting): Perfect, Too long, Too short, Too formal, Too casual, Missed the point.
export const ThumbsUpIcon = (p: IconProps) => (
  <Icon {...p} d="M7.5 10.5v8.9M7.5 10.5l3.6-6.3c.4-.7 1.3-1 2-.6.6.3.9 1 .8 1.7l-.6 3.9h4.9c1.2 0 2.1 1.1 1.9 2.3l-1.2 6.3c-.2.9-1 1.6-1.9 1.6H4.8c-.7 0-1.3-.6-1.3-1.3v-6.4c0-.7.6-1.3 1.3-1.3h2.7Z" />
);
export const ShrinkIcon = (p: IconProps) => <Icon {...p} d="M4 14h6v6M20 10h-6V4M14 10l6.5-6.5M3.5 20.5 10 14" />;
export const GrowIcon = (p: IconProps) => <Icon {...p} d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5" />;
export const BriefcaseIcon = (p: IconProps) => (
  <Icon {...p} d="M8.5 7V5.5c0-.8.7-1.5 1.5-1.5h4c.8 0 1.5.7 1.5 1.5V7M4.5 7h15c.8 0 1.5.7 1.5 1.5V18c0 .8-.7 1.5-1.5 1.5h-15c-.8 0-1.5-.7-1.5-1.5V8.5C3 7.7 3.7 7 4.5 7ZM3 12.5h18" />
);
export const SmileIcon = (p: IconProps) => (
  <Icon {...p} d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM8.5 14.5s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9 9.5h.01M15 9.5h.01" />
);
export const TargetIcon = (p: IconProps) => (
  <Icon {...p} d="M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0ZM13 12a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
);

/**
 * Official Discord "Clyde" mark, single-color, drawn from the brand's public
 * SVG path data (fill, not stroke — unlike the line icons above). Small and
 * monochrome, only ever shown at the dimmed caption color: this is a source
 * marker ("this message came in over Discord"), not a brand badge.
 */
/** "Sent from Discord" — Discord's own logo (BrandLogo), at badge size. */
export function DiscordIcon({ size = 12 }: IconProps) {
  return (
    <View accessible accessibilityLabel="sent from Discord">
      <BrandLogo brand="discord" size={size} />
    </View>
  );
}

export function HeartIcon({ size = 22, color, filled = false }: IconProps & { filled?: boolean }) {
  const { colors } = useAppTheme();
  const tint = color ?? colors.textDim;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z" stroke={tint} fill={filled ? tint : "none"} strokeWidth={1.7} strokeLinejoin="round" />
    </Svg>
  );
}
