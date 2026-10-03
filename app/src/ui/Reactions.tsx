/**
 * Teach by reacting: the icon bar in a message's long-press sheet, the small
 * badge a reacted message keeps, and the intern's one-line acknowledgement.
 * Four of one kind in an intern's last ten messages move a personality dial
 * (orchestrator src/reactions.ts).
 */
import React, { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Reaction } from "../api";
import { radius, space, useAppTheme } from "../theme";
import { BriefcaseIcon, GrowIcon, ShrinkIcon, SmileIcon, TargetIcon, ThumbsUpIcon } from "./Icons";
import { InternFace } from "./InternFace";
import { Text } from "./Text";

type IconComponent = (p: { size?: number; color?: string }) => React.ReactElement;

export const REACTION_INFO: { key: Reaction; label: string; lines: [string, string]; Icon: IconComponent; ack: string }[] = [
  { key: "perfect", label: "Perfect", lines: ["Perfect", ""], Icon: ThumbsUpIcon, ack: "Thanks. I'll keep doing that." },
  { key: "too_long", label: "Too long", lines: ["Too", "long"], Icon: ShrinkIcon, ack: "Noted. I'll keep it shorter." },
  { key: "too_short", label: "Too short", lines: ["Too", "short"], Icon: GrowIcon, ack: "Noted. I'll give you more." },
  { key: "too_formal", label: "Too formal", lines: ["Too", "formal"], Icon: BriefcaseIcon, ack: "Noted. I'll loosen up." },
  { key: "too_casual", label: "Too casual", lines: ["Too", "casual"], Icon: SmileIcon, ack: "Noted. I'll polish it up." },
  { key: "missed", label: "Missed the point", lines: ["Missed", "the point"], Icon: TargetIcon, ack: "Sorry. Tell me what I missed." },
];

export const reactionInfo = (key: Reaction) => REACTION_INFO.find((r) => r.key === key) ?? REACTION_INFO[0]!;

/** The six reactions as one row of round icon buttons; tapping the chosen one again takes it back. */
export function ReactionBar({ selected, onPick }: { selected: Reaction | null | undefined; onPick: (reaction: Reaction | null) => void }) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.bar} accessibilityRole="toolbar" accessibilityLabel="React">
      {REACTION_INFO.map(({ key, label, lines, Icon }) => {
        const on = selected === key;
        return (
          <Pressable
            key={key}
            onPress={() => onPick(on ? null : key)}
            accessibilityRole="button"
            accessibilityLabel={on ? `${label}, chosen. Tap to take it back` : label}
            accessibilityState={{ selected: on }}
            style={({ pressed }) => [styles.item, { opacity: pressed ? 0.6 : 1 }]}
          >
            <View style={[styles.circle, { backgroundColor: on ? colors.accent : colors.surfaceAlt }]}>
              <Icon size={20} color={on ? colors.onAccent : colors.text} />
            </View>
            <Text variant="caption" color={on ? colors.text : colors.textDim} style={styles.itemLabel} numberOfLines={2}>
              {lines[1] ? `${lines[0]}\n${lines[1]}` : lines[0]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** Under a message the owner reacted to: the reaction's icon and name. Pressing it reopens the sheet. */
export function ReactionBadge({ reaction, indent, onPress }: { reaction: Reaction; indent: number; onPress?: () => void }) {
  const { colors } = useAppTheme();
  const { label, Icon } = reactionInfo(reaction);
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole="button"
      accessibilityLabel={`You reacted: ${label}`}
      style={({ pressed }) => [styles.badge, { marginLeft: indent + space.md, backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.7 : 1 }]}
    >
      <Icon size={14} color={colors.text} />
      <Text variant="caption" color={colors.text} style={styles.badgeLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

/** "Noted. I'll keep it shorter." from the intern, with Undo; fades after a few seconds. */
export function ReactionToast({ text, faceId, onUndo, onDone }: { text: string; faceId?: string; onUndo?: () => void; onDone: () => void }) {
  const { colors } = useAppTheme();
  useEffect(() => {
    const timer = setTimeout(onDone, onUndo ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [text, onUndo, onDone]);
  return (
    <View style={[styles.toast, { backgroundColor: colors.text }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
      {faceId ? <InternFace id={faceId} size={26} clipToBounds /> : null}
      <Text variant="subtle" color={colors.bg} style={styles.toastText} numberOfLines={2}>
        {text}
      </Text>
      {onUndo ? (
        <Pressable onPress={onUndo} accessibilityRole="button" accessibilityLabel="Undo" hitSlop={10}>
          <Text variant="subtle" color={colors.bg} style={styles.undo}>
            Undo
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: space.sm, paddingTop: space.xs, paddingBottom: space.md },
  item: { flex: 1, alignItems: "center", gap: 6 },
  circle: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  itemLabel: { fontWeight: "600", textAlign: "center", lineHeight: 14 },
  badge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingLeft: 7,
    paddingRight: 9,
    paddingVertical: 3,
    marginTop: -space.sm,
    marginBottom: space.sm,
  },
  badgeLabel: { fontWeight: "600" },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    borderRadius: radius.xl,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    marginHorizontal: space.lg,
    marginBottom: space.sm,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  toastText: { flex: 1 },
  undo: { fontWeight: "700" },
});
