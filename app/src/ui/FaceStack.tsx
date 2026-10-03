/**
 * Up to three overlapping faces for a group chat, in place of the single
 * face an intern row or thread header shows. More members than fit are
 * summarised with a "+n" disc.
 */
import React from "react";
import { StyleSheet, View } from "react-native";
import { useAppTheme } from "../theme";
import { InternFace } from "./InternFace";
import { Text } from "./Text";

export function FaceStack({ faceIds, size = 48 }: { faceIds: string[]; size?: number }) {
  const { colors } = useAppTheme();
  const shown = faceIds.slice(0, 3);
  const extra = faceIds.length - shown.length;
  const disc = Math.round(size * 0.66); // each face's disc, incl. the 2px ring
  const step = Math.round(disc * 0.62); // horizontal offset between discs (≈40% overlap)
  const count = shown.length + (extra > 0 ? 1 : 0);
  const width = count ? disc + step * (count - 1) : size;
  const top = Math.round((size - disc) / 2);
  return (
    <View style={{ width: Math.max(width, size), height: size }}>
      {shown.map((id, i) => (
        <View
          key={`${id}-${i}`}
          style={[styles.face, { left: i * step, top, width: disc, height: disc, borderRadius: disc / 2, backgroundColor: colors.surfaceAlt, borderColor: colors.bg }]}
        >
          <InternFace id={id} size={disc - 6} clipToBounds />
        </View>
      ))}
      {extra > 0 ? (
        <View style={[styles.face, { left: shown.length * step, top, width: disc, height: disc, borderRadius: disc / 2, backgroundColor: colors.surfaceAlt, borderColor: colors.bg }]}>
          <Text variant="caption" color={colors.textDim}>
            +{extra}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  face: { position: "absolute", borderWidth: 2, overflow: "hidden", alignItems: "center", justifyContent: "center" },
});
