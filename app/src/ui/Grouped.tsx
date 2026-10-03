/**
 * Grouped settings lists, iOS Settings style: a small caps title, a rounded
 * card of rows separated by hairlines, and an optional footnote. Rows either
 * open something (label · value · chevron) or carry a switch.
 */
import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { radius, space, useAppTheme } from "../theme";
import { ChevronRightIcon } from "./Icons";
import { Text } from "./Text";

export function Group({ title, footer, children, action }: { title?: string; footer?: string; children: React.ReactNode; action?: React.ReactNode }) {
  const { colors } = useAppTheme();
  const rows = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={styles.group}>
      {title || action ? (
        <View style={styles.titleRow}>
          {title ? <Text variant="label">{title}</Text> : <View />}
          {action}
        </View>
      ) : null}
      <View style={[styles.card, { backgroundColor: colors.surfaceAlt }]}>
        {rows.map((row, i) => (
          <View key={i}>
            {i > 0 ? <View style={[styles.separator, { backgroundColor: colors.border }]} /> : null}
            {row}
          </View>
        ))}
      </View>
      {footer ? (
        <Text variant="caption" style={styles.footer}>
          {footer}
        </Text>
      ) : null}
    </View>
  );
}

export function Row({
  label,
  value,
  detail,
  onPress,
  destructive,
  right,
  accessibilityLabel,
}: {
  label: string;
  /** short value on the right ("Mondays at 09:00") */
  value?: string;
  /** a second line under the label */
  detail?: string;
  onPress?: () => void;
  destructive?: boolean;
  /** custom right side (a switch); replaces value + chevron */
  right?: React.ReactNode;
  accessibilityLabel?: string;
}) {
  const { colors } = useAppTheme();
  const body = (
    <>
      <View style={styles.rowText}>
        <Text variant="body" color={destructive ? colors.danger : colors.text}>
          {label}
        </Text>
        {detail ? (
          <Text variant="caption" numberOfLines={2}>
            {detail}
          </Text>
        ) : null}
      </View>
      {right ?? (
        <View style={styles.rowRight}>
          {value ? (
            <Text variant="subtle" numberOfLines={1} style={styles.value}>
              {value}
            </Text>
          ) : null}
          {onPress && !destructive ? <ChevronRightIcon size={16} color={colors.textFaint} /> : null}
        </View>
      )}
    </>
  );
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? [label, value].filter(Boolean).join(", ")}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.accentSoft }]}
    >
      {body}
    </Pressable>
  );
}

export function Switch({ value, onChange, disabled, label }: { value: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value, disabled }}
      aria-checked={value}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={() => onChange(!value)}
      hitSlop={8}
      style={[
        styles.track,
        { backgroundColor: value ? colors.accent : colors.bg, borderColor: value ? colors.accent : colors.border, opacity: disabled ? 0.45 : 1 },
      ]}
    >
      <View style={[styles.thumb, { backgroundColor: value ? colors.onAccent : colors.textFaint }, value && styles.thumbOn]} />
    </Pressable>
  );
}

/** A small segmented control for a row's right side (theme, text size). */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { value: T; label: string; textStyle?: object }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
}) {
  const { colors } = useAppTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={[styles.segments, { backgroundColor: colors.bg, borderColor: colors.border }]}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            aria-checked={selected}
            accessibilityLabel={o.label}
            onPress={() => onChange(o.value)}
            hitSlop={4}
            style={[styles.segment, selected && { backgroundColor: colors.accent }]}
          >
            <Text variant="caption" color={selected ? colors.onAccent : colors.text} style={[styles.segmentLabel, o.textStyle]}>
              {o.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  segments: { flexDirection: "row", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, padding: 2 },
  segment: { minWidth: 44, paddingHorizontal: space.sm, paddingVertical: 6, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  segmentLabel: { fontWeight: "600" },
  group: { gap: space.xs },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: space.md },
  card: { borderRadius: radius.lg, overflow: "hidden" },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: space.lg },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md, minHeight: 50 },
  rowText: { flex: 1, gap: 2 },
  rowRight: { flexDirection: "row", alignItems: "center", gap: space.xs, maxWidth: "55%" },
  value: { flexShrink: 1, textAlign: "right" },
  footer: { paddingHorizontal: space.md },
  track: { width: 50, height: 30, borderRadius: 15, borderWidth: 1, padding: 2, justifyContent: "center" },
  thumb: { width: 24, height: 24, borderRadius: 12 },
  thumbOn: { transform: [{ translateX: 20 }] },
});
