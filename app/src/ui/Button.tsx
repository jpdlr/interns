import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import { radius, space, useAppTheme, type AppColors } from "../theme";
import { Text } from "./Text";

export type ButtonTone = "primary" | "success" | "neutral" | "ghost" | "danger";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  tone?: ButtonTone;
  disabled?: boolean;
  busy?: boolean;
  small?: boolean;
  full?: boolean;
  style?: ViewStyle;
}

function tones(colors: AppColors): Record<ButtonTone, { bg: string; fg: string; border: string }> {
  return {
    primary: { bg: colors.accent, fg: colors.onAccent, border: colors.accent },
    success: { bg: colors.successSoft, fg: colors.success, border: colors.success },
    neutral: { bg: colors.surface, fg: colors.text, border: colors.border },
    ghost: { bg: "transparent", fg: colors.textDim, border: "transparent" },
    danger: { bg: colors.destructiveSoft, fg: colors.danger, border: colors.danger },
  };
}

export function Button({
  label,
  onPress,
  tone = "neutral",
  disabled = false,
  busy = false,
  small = false,
  full = false,
  style,
}: ButtonProps) {
  const { colors } = useAppTheme();
  const palette = tones(colors)[tone];
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        {
          backgroundColor: palette.bg,
          borderColor: palette.border,
          paddingVertical: small ? space.sm : space.md,
          paddingHorizontal: small ? space.md : space.lg,
          opacity: inactive ? 0.5 : pressed ? 0.82 : 1,
          alignSelf: full ? "stretch" : "flex-start",
        },
        style,
      ]}
    >
      <View style={styles.inner}>
        {busy ? <ActivityIndicator size="small" color={palette.fg} /> : null}
        <Text variant={small ? "subtle" : "body"} color={palette.fg} style={styles.label}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: "center",
  },
  inner: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: space.sm },
  label: { fontWeight: "600" },
});
