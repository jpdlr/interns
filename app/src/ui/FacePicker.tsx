/**
 * The 20-face picker. Every tile is the real animated face, so JP chooses a
 * character rather than a thumbnail — which is the whole point of the set.
 */
import React from "react";
import { Modal, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { FACE_IDS } from "../faces.generated";
import { radius, space, useAppTheme } from "../theme";
import { Button } from "./Button";
import { InternFace } from "./InternFace";
import { Text } from "./Text";

export interface FacePickerProps {
  visible: boolean;
  selected: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Defaults to all 20 faces; pass the /meta icon catalog to drive it from the server instead. */
  ids?: string[];
  /** id -> human label, used for accessibility only (e.g. from /meta). */
  labels?: Record<string, string>;
}

export function FacePicker({ visible, selected, onSelect, onClose, ids = FACE_IDS, labels }: FacePickerProps) {
  const { colors } = useAppTheme();
  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onClose}>
      <Pressable style={[styles.backdrop, { backgroundColor: colors.overlay }]} onPress={onClose}>
        <Pressable style={[styles.sheet, { backgroundColor: colors.bg, borderColor: colors.border }]} onPress={(e) => e.stopPropagation()}>
          <Text variant="title">Pick a face</Text>
          <Text variant="subtle">They all blink and glance a little differently.</Text>
          <ScrollView contentContainerStyle={styles.grid} style={styles.scroll}>
            {ids.map((id) => {
              const active = id === selected;
              return (
                <Pressable
                  key={id}
                  onPress={() => onSelect(id)}
                  accessibilityRole="button"
                  accessibilityLabel={labels?.[id] ?? id}
                  style={[styles.tile, active && { borderColor: colors.accent, backgroundColor: colors.accentSoft }]}
                >
                  <InternFace id={id} size={54} />
                </Pressable>
              );
            })}
          </ScrollView>
          <Button label="Done" tone="primary" full onPress={onClose} />
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: space.xl,
    gap: space.sm,
    maxHeight: "85%",
  },
  scroll: { marginVertical: space.md },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: space.md, justifyContent: "center" },
  tile: {
    padding: space.sm,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderColor: "transparent",
  },
});
