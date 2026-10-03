import React from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { radius, space, useAppTheme } from "../theme";
import { Text } from "./Text";

export interface QuickReply {
  label: string;
  text: string;
}

export function suggestQuickReplies(message: string): QuickReply[] {
  const lower = message.toLowerCase();
  const replies: QuickReply[] = [];
  if (/pull request|\bpr\b|github\.com|\/pull\/|code review/.test(lower)) {
    replies.push(
      { label: "Approve", text: "I approve the recommendation. Prepare the approval card if one is not already open." },
      { label: "Ask for changes", text: "Ask for changes. Put the proposed review in an approval card before publishing." },
    );
  } else if (/email|mailbox|inbox|outlook|mailto:|reply/.test(lower)) {
    replies.push({ label: "Draft reply", text: "Draft a concise reply for me and put it in an approval card. Do not send it." });
  } else if (/deploy|release|build|environment/.test(lower)) {
    replies.push({ label: "Check deployment", text: "Check the deployment status and tell me what is blocking it." });
  } else if (/document|brief|report|docs\.google|sharepoint|notion/.test(lower)) {
    replies.push({ label: "Summarize", text: "Summarize the linked document and call out anything that needs my decision." });
  }
  if (/calendar|meeting|event|tomorrow|deadline|due\b/.test(lower)) {
    replies.push({ label: "Add reminder", text: "Remind me about this tomorrow morning." });
  } else {
    replies.push({ label: "Remind tomorrow", text: "Remind me about this tomorrow morning." });
  }
  if (replies.length < 3) replies.push({ label: "Tell me more", text: "Tell me more, focusing on what decision you need from me." });
  return replies.slice(0, 3);
}

export function QuickReplyChips({ replies, onSelect, indent = 48 }: { replies: QuickReply[]; onSelect: (reply: QuickReply) => void; indent?: number }) {
  const { colors } = useAppTheme();
  if (!replies.length) return null;
  return (
    <View style={[styles.row, { marginLeft: indent }]} accessibilityLabel="Suggested replies">
      {replies.map((reply) => (
        <Pressable
          key={reply.label}
          accessibilityRole="button"
          accessibilityLabel={`Use quick reply: ${reply.label}`}
          onPress={() => onSelect(reply)}
          style={({ pressed }) => [styles.chip, { backgroundColor: colors.surface, borderColor: colors.border, opacity: pressed ? 0.65 : 1 }]}
        >
          <Text variant="caption" color={colors.text} style={styles.label}>{reply.label}</Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { marginRight: space.xxl, marginTop: -space.xs, marginBottom: space.md, flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 7 },
  label: { fontWeight: "600" },
});
