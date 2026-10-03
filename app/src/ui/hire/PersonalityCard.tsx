/**
 * Who they are to talk to: four dials, a live sample of how they'd answer,
 * and the persona in words underneath for anything the dials don't cover.
 */
import React, { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Style } from "../../api";
import { DEFAULT_STYLE, DIALS, sampleReply } from "../../style";
import { radius, scaledFont, space, useAppTheme } from "../../theme";
import { GrowingInput } from "../GrowingInput";
import { CheckIcon, ChevronRightIcon, EditIcon } from "../Icons";
import { InternFace } from "../InternFace";
import { Text } from "../Text";
import { Dial } from "./Dial";
import { Section } from "./Section";

export function PersonalityCard({
  name,
  faceId,
  style,
  onStyle,
  persona,
  onPersona,
}: {
  name: string;
  faceId: string;
  style: Style | undefined;
  onStyle: (s: Style) => void;
  persona: string;
  onPersona: (p: string) => void;
}) {
  const { colors, fontScale } = useAppTheme();
  const [words, setWords] = useState(false);
  const current = style ?? DEFAULT_STYLE;
  return (
    <Section title="Personality" hint="How they talk to you. Change it any time on their profile.">
      <StyleDials faceId={faceId} style={current} onStyle={onStyle} />
      <Pressable
        onPress={() => setWords((v) => !v)}
        accessibilityRole="button"
        style={({ pressed }) => [styles.describe, { borderColor: colors.border, backgroundColor: pressed ? colors.accentSoft : colors.surface }]}
      >
        {words ? <CheckIcon size={18} color={colors.text} /> : <EditIcon size={18} color={colors.text} />}
        <Text variant="subtle" color={colors.text} style={[styles.link, styles.flex]}>
          {words ? "Done" : `Describe ${name.trim() || "them"} in your own words`}
        </Text>
        {words ? null : <ChevronRightIcon size={16} color={colors.textFaint} />}
      </Pressable>
      {words ? (
        <GrowingInput
          value={persona}
          onChangeText={onPersona}
          placeholder="Calm, dry-witted, protective of my time…"
          placeholderTextColor={colors.textFaint}
          style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale), lineHeight: scaledFont(22, fontScale) }]}
          minHeight={72}
          collapsedLines={4}
          autoFocus
        />
      ) : persona ? (
        <Text variant="caption" numberOfLines={2}>
          {persona}
        </Text>
      ) : null}
    </Section>
  );
}

/** The four dials and a sample reply that follows them. Also on the profile's Personality editor. */
export function StyleDials({ faceId, style, onStyle }: { faceId: string; style: Style; onStyle: (s: Style) => void }) {
  const { colors } = useAppTheme();
  return (
    <>
      {DIALS.map((d) => (
        <Dial key={d.key} title={d.title} low={d.low} high={d.high} steps={d.steps} value={style[d.key]} onChange={(v) => onStyle({ ...style, [d.key]: v })} />
      ))}
      <View style={styles.sample} accessibilityLabel={`Sample reply: ${sampleReply(style)}`}>
        <Text variant="caption">You: Anything I need to know?</Text>
        <View style={styles.sampleRow}>
          <InternFace id={faceId} size={30} clipToBounds />
          <View style={[styles.bubble, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text variant="subtle" color={colors.text}>
              {sampleReply(style)}
            </Text>
          </View>
        </View>
      </View>
    </>
  );
}

/** "Casual · Brief · Proactive": the dials someone moved, for summaries. */
export function styleSummary(style: Style | undefined): string {
  if (!style) return "";
  return DIALS.filter((d) => style[d.key] !== 3).map((d) => d.steps[style[d.key] - 1]).join(" · ");
}

const styles = StyleSheet.create({
  sample: { gap: space.xs },
  sampleRow: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  bubble: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, borderBottomLeftRadius: 4, padding: space.md },
  link: { fontWeight: "600" },
  flex: { flex: 1 },
  describe: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.md },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
});

export { DEFAULT_STYLE };
