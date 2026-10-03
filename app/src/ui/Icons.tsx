/**
 * The handful of glyphs the app needs, as paths — react-native-svg renders
 * these on web (via react-native-web) and native alike, so no icon font.
 */
import React from "react";
import type { ColorValue } from "react-native";
import Svg, { Path } from "react-native-svg";
import { useAppTheme } from "../theme";

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
/** GitHub, drawn as a branch (no logos in the icon set). */
export const BranchIcon = (p: IconProps) => (
  <Icon {...p} d="M6.5 3.5v11M6.5 14.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM17.5 4a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5ZM17.5 9c0 4-4.5 4-11 5.5" />
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

/**
 * Official Discord "Clyde" mark, single-color, drawn from the brand's public
 * SVG path data (fill, not stroke — unlike the line icons above). Small and
 * monochrome, only ever shown at the dimmed caption color: this is a source
 * marker ("this message came in over Discord"), not a brand badge.
 */
export function DiscordIcon({ size = 12, color }: IconProps) {
  const { colors } = useAppTheme();
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" accessibilityLabel="sent from Discord">
      <Path
        fill={color ?? colors.textFaint}
        d="M20.32 5.37a19.8 19.8 0 0 0-4.9-1.52.07.07 0 0 0-.08.04c-.21.38-.45.86-.61 1.25a18.3 18.3 0 0 0-5.48 0 12.6 12.6 0 0 0-.62-1.25.08.08 0 0 0-.08-.04c-1.7.29-3.34.8-4.9 1.52a.07.07 0 0 0-.03.03C.83 9.05.15 12.62.48 16.15a.08.08 0 0 0 .03.06 19.9 19.9 0 0 0 5.99 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.23-2a.08.08 0 0 0-.04-.11 13.1 13.1 0 0 1-1.87-.89.08.08 0 0 1 0-.13c.13-.09.25-.19.37-.28a.07.07 0 0 1 .08-.01c3.93 1.79 8.18 1.79 12.05 0a.07.07 0 0 1 .08.01c.12.1.24.19.37.28a.08.08 0 0 1 0 .13c-.6.35-1.22.64-1.87.89a.08.08 0 0 0-.04.11c.36.7.78 1.37 1.23 2a.08.08 0 0 0 .08.03 19.85 19.85 0 0 0 6-3.03.08.08 0 0 0 .03-.06c.4-4.08-.66-7.63-2.79-10.75a.06.06 0 0 0-.03-.03ZM8.02 14.05c-1.18 0-2.16-1.08-2.16-2.42s.96-2.42 2.16-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.16-1.08-2.16-2.42s.96-2.42 2.16-2.42c1.21 0 2.18 1.1 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Z"
      />
    </Svg>
  );
}
