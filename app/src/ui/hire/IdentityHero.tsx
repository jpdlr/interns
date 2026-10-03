/**
 * The top of the hire builder: their face, big, reacting when you pick a
 * new one from the strip; name and role edited right where they're shown.
 */
import React, { useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { FACE_IDS } from "../../faces.generated";
import { radius, scaledFont, space, useAppTheme } from "../../theme";
import { InternFace } from "../InternFace";
import { Text } from "../Text";

export function IdentityHero({
  faceId,
  onFace,
  name,
  onName,
  onNameBlur,
  nameNote,
  nameNoteColor,
  role,
  onRole,
}: {
  faceId: string;
  onFace: (id: string) => void;
  name: string;
  onName: (v: string) => void;
  onNameBlur?: () => void;
  nameNote?: string | null;
  nameNoteColor?: string;
  role: string;
  onRole: (v: string) => void;
}) {
  const { colors, fontScale } = useAppTheme();
  const [react, setReact] = useState(0);
  const strip = useRef<ScrollView>(null);
  const pick = (id: string) => {
    onFace(id);
    setReact((n) => n + 1);
  };
  // keep the chosen face in view on open
  useEffect(() => {
    const index = FACE_IDS.indexOf(faceId);
    if (index > 2) strip.current?.scrollTo({ x: (index - 2) * 62, animated: false });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <View style={styles.hero}>
      <InternFace id={faceId} size={112} clipToBounds reaction={react ? "grin" : null} reactionKey={react} />
      <TextInput
        value={name}
        onChangeText={onName}
        onBlur={onNameBlur}
        placeholder="Name"
        placeholderTextColor={colors.textFaint}
        accessibilityLabel="Name"
        style={[styles.name, { color: colors.text, fontSize: scaledFont(34, fontScale) }]}
      />
      {nameNote ? (
        <Text variant="caption" color={nameNoteColor} center>
          {nameNote}
        </Text>
      ) : null}
      <TextInput
        value={role}
        onChangeText={onRole}
        placeholder="What they do"
        placeholderTextColor={colors.textFaint}
        accessibilityLabel="Role"
        multiline
        style={[styles.role, { color: colors.textDim, fontSize: scaledFont(17, fontScale) }]}
      />
      <ScrollView ref={strip} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip} style={styles.stripScroll}>
        {FACE_IDS.filter((id) => id !== "coordinator").map((id) => {
          const on = id === faceId;
          return (
            <Pressable
              key={id}
              onPress={() => pick(id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`Face ${id.replace("face-", "")}`}
              style={[styles.faceCell, { borderColor: on ? colors.accent : "transparent", backgroundColor: on ? colors.accentSoft : colors.surfaceAlt }]}
            >
              <InternFace id={id} size={44} clipToBounds />
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: space.xs },
  name: { fontWeight: "800", textAlign: "center", alignSelf: "stretch", paddingVertical: 2 },
  role: { textAlign: "center", alignSelf: "stretch", paddingVertical: 0 },
  stripScroll: { alignSelf: "stretch", marginHorizontal: -space.lg, marginTop: space.md },
  strip: { gap: space.sm, paddingHorizontal: space.lg },
  faceCell: { width: 54, height: 54, borderRadius: radius.md, borderWidth: 2, alignItems: "center", justifyContent: "center" },
});
