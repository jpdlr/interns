/**
 * The app's only text component. Every string on screen goes through a
 * variant here so type stays consistent; ad-hoc fontSize is a smell.
 */
import React from "react";
import { StyleSheet, Text as RNText, type TextProps as RNTextProps, type TextStyle } from "react-native";
import { scaledFont, useAppTheme } from "../theme";

export type TextVariant =
  /** screen titles */
  | "display"
  /** row names, card titles */
  | "title"
  /** default body copy */
  | "body"
  /** message bubbles — slightly larger for readability */
  | "message"
  /** roles, previews, secondary lines */
  | "subtle"
  /** all-caps section headers */
  | "label"
  /** timestamps, counters */
  | "caption"
  /** tokens, ids, code spans */
  | "mono";

export interface TextProps extends RNTextProps {
  variant?: TextVariant;
  color?: string;
  center?: boolean;
  dim?: boolean;
}

export function Text({ variant = "body", color, center, dim, style, ...rest }: TextProps) {
  const { colors, fontScale } = useAppTheme();
  const metric = metrics[variant];
  return (
    <RNText
      {...rest}
      style={[
        { color: colors.text },
        styles[variant],
        {
          fontSize: scaledFont(metric.fontSize, fontScale),
          ...(metric.lineHeight ? { lineHeight: scaledFont(metric.lineHeight, fontScale) } : {}),
        },
        variant === "subtle" && { color: colors.textDim },
        (variant === "label" || variant === "caption") && { color: colors.textFaint },
        variant === "mono" && { color: colors.textDim },
        dim && { color: colors.textDim },
        color ? { color } : null,
        center && { textAlign: "center" },
        style,
      ]}
    />
  );
}

const mono = "ui-monospace, SFMono-Regular, Menlo, monospace";

const metrics: Record<TextVariant, { fontSize: number; lineHeight?: number }> = {
  display: { fontSize: 28 },
  title: { fontSize: 17 },
  body: { fontSize: 15, lineHeight: 21 },
  message: { fontSize: 16, lineHeight: 23 },
  subtle: { fontSize: 14, lineHeight: 20 },
  label: { fontSize: 11 },
  caption: { fontSize: 12 },
  mono: { fontSize: 13 },
};

const styles = StyleSheet.create({
  display: { fontSize: 28, fontWeight: "700", letterSpacing: -0.6 },
  title: { fontSize: 17, fontWeight: "600", letterSpacing: -0.2 },
  body: { fontSize: 15, lineHeight: 21 },
  message: { fontSize: 16, lineHeight: 23 },
  subtle: { fontSize: 14, lineHeight: 20 },
  label: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.1,
    textTransform: "uppercase",
  },
  caption: { fontSize: 12 },
  mono: { fontSize: 13, fontFamily: mono } as TextStyle,
});
