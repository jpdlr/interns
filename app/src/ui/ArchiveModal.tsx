/** The archive ("fire") confirmation for an intern — moved out of the profile screen as-is. */
import React, { useEffect, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import { radius, scaledFont, space, useAppTheme } from "../theme";
import { Button } from "./Button";
import { ErrorNote } from "./Screen";
import { Text } from "./Text";

/**
 * The one-way confirm for "archive intern" (fire). Cancel is the easy,
 * default action — it needs no typing and sits first. Archive stays
 * disabled until JP types the intern's name, so a stray tap can never fire
 * someone by accident.
 */
export function ArchiveModal({
  visible,
  name,
  slug,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  visible: boolean;
  name: string;
  slug: string;
  busy: boolean;
  error: unknown;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { colors, fontScale } = useAppTheme();
  const [typed, setTyped] = useState("");

  // Fresh input every time the modal opens, so a previous attempt's text (or
  // a previous intern's, in theory) never lingers.
  useEffect(() => {
    if (visible) setTyped("");
  }, [visible]);

  const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Pressable style={[styles.modalBackdrop, { backgroundColor: colors.overlay }]} onPress={onCancel}>
        <Pressable style={[styles.modalSheet, { backgroundColor: colors.bg, borderColor: colors.border }]} onPress={(e) => e.stopPropagation()}>
          <Text variant="title">Archive {name}?</Text>
          <Text variant="body" style={styles.modalBody}>
            {name} stops working immediately. Any queued work is cancelled. Their chat
            history stays, but they leave the crew. Their Discord channel is renamed{" "}
            <Text variant="mono">archived-{slug}</Text> with a farewell message.
          </Text>
          <Text variant="body" color={colors.danger} style={styles.modalBody}>
            This can&rsquo;t be undone from the app. Their files are kept on the
            server, but there is no way to bring them back from here.
          </Text>

          <View style={styles.modalField}>
            <Text variant="label">
              Type &ldquo;{name}&rdquo; to confirm
            </Text>
            <TextInput
              value={typed}
              onChangeText={setTyped}
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale) }]}
              placeholder={name}
              placeholderTextColor={colors.textFaint}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!busy}
            />
          </View>

          {error ? <ErrorNote error={error} subject={name} style={styles.modalError} /> : null}

          <View style={styles.modalActions}>
            <Button label="Cancel" tone="neutral" style={styles.modalButton} onPress={onCancel} disabled={busy} />
            <Button
              label="Archive intern"
              tone="danger"
              style={styles.modalButton}
              busy={busy}
              disabled={!matches || busy}
              onPress={onConfirm}
            />
          </View>
        </Pressable>
      </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}


const styles = StyleSheet.create({
  flex: { flex: 1 },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md, fontSize: 16 },
  modalError: { marginHorizontal: 0, marginBottom: 0 },

  modalBackdrop: {
    flex: 1,
    justifyContent: "flex-end",
  },
  modalSheet: {
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: space.xl,
    gap: space.md,
  },
  modalBody: { lineHeight: 21 },
  modalField: { gap: space.xs },
  modalActions: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  modalButton: { flex: 1 },
});
