/**
 * Try before you hire: put a question to the candidate and they answer in
 * character, from the personality and instructions as they stand right now
 * (POST /hire/interview). Nobody is hired; change a dial and ask again.
 */
import React, { useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, TextInput, View } from "react-native";
import type { InternManifest } from "../../api";
import { useSettings } from "../../settings";
import { radius, scaledFont, space, useAppTheme } from "../../theme";
import { Button } from "../Button";
import { InternFace } from "../InternFace";
import { ErrorNote } from "../Screen";
import { Text } from "../Text";
import { Section } from "./Section";

const SUGGESTED = ["What will you do on your first day?", "How will you keep me posted?", "What won't you do without asking me?"];

export function InterviewCard({ draft, faceId }: { draft: InternManifest; faceId: string }) {
  const { api } = useSettings();
  const { colors, fontScale } = useAppTheme();
  const [turns, setTurns] = useState<{ question: string; answer: string }[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const name = draft.name.trim() || "them";

  const ask = async (q: string) => {
    const text = q.trim();
    if (text.length < 2 || asking) return;
    setAsking(text);
    setQuestion("");
    setError(null);
    try {
      const { answer } = await api.interview(draft, text, turns.slice(-4));
      setTurns((t) => [...t, { question: text, answer }]);
    } catch (e) {
      setError(e);
      setQuestion(text);
    } finally {
      setAsking(null);
    }
  };

  return (
    <Section title={`Interview ${name}`} hint="Ask anything; they answer as they would on the job. Change a dial and ask again.">
      {turns.map((t, i) => (
        <View key={i} style={styles.turn}>
          <View style={[styles.mine, { backgroundColor: colors.accent }]}>
            <Text variant="subtle" color={colors.onAccent}>
              {t.question}
            </Text>
          </View>
          <View style={styles.theirsRow}>
            <InternFace id={faceId} size={28} clipToBounds />
            <View style={[styles.theirs, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Text variant="subtle" color={colors.text}>
                {t.answer}
              </Text>
            </View>
          </View>
        </View>
      ))}
      {asking ? (
        <View style={styles.turn}>
          <View style={[styles.mine, { backgroundColor: colors.accent }]}>
            <Text variant="subtle" color={colors.onAccent}>
              {asking}
            </Text>
          </View>
          <View style={styles.theirsRow}>
            <InternFace id={faceId} size={28} clipToBounds mood="thinking" />
            <ActivityIndicator color={colors.textDim} />
          </View>
        </View>
      ) : null}
      {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}
      {turns.length === 0 && !asking ? (
        <View style={styles.chips}>
          {SUGGESTED.map((q) => (
            <Pressable key={q} onPress={() => void ask(q)} accessibilityRole="button" style={({ pressed }) => [styles.chip, { borderColor: colors.border, backgroundColor: pressed ? colors.accentSoft : colors.surface }]}>
              <Text variant="caption" color={colors.text}>
                {q}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <View style={styles.askRow}>
        <TextInput
          value={question}
          onChangeText={setQuestion}
          placeholder={`Ask ${name} something…`}
          placeholderTextColor={colors.textFaint}
          onSubmitEditing={() => void ask(question)}
          returnKeyType="send"
          accessibilityLabel="Interview question"
          style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale) }]}
        />
        <Button label="Ask" tone="neutral" small disabled={question.trim().length < 2 || Boolean(asking)} onPress={() => void ask(question)} />
      </View>
    </Section>
  );
}

const styles = StyleSheet.create({
  turn: { gap: space.sm },
  mine: { alignSelf: "flex-end", maxWidth: "85%", borderRadius: radius.lg, borderBottomRightRadius: 4, paddingHorizontal: space.md, paddingVertical: space.sm },
  theirsRow: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  theirs: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, borderBottomLeftRadius: 4, padding: space.md },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  askRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  input: { flex: 1, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm },
});
