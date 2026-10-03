/**
 * Text meant to be pasted somewhere else (a bio, a caption, an email, a post)
 * as a writing card: the reading font, wrapped, with Edit and Copy, instead
 * of a monospace code box that scrolls sideways. Alternatives an intern
 * labels ("**My pick — 138 chars**" above each fence) sit in one card behind
 * numbered tabs.
 *
 * Markdown.tsx decides what is writing: ```writing (or text, bio, caption,
 * email…), or a bare fence that doesn't look like code.
 */
import React, { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useCrew } from "../crew";
import { radius, scaledFont, space, useAppTheme } from "../theme";
import { CheckIcon, CopyIcon, EditIcon } from "./Icons";
import { copyText } from "./Markdown";
import { useMessageContext } from "./MessageContext";
import { Text } from "./Text";

/** Fence languages that are always writing. */
const WRITING_LANGS = new Set(["writing", "text", "txt", "plain", "plaintext", "draft", "bio", "caption", "copy", "email", "post", "message", "tweet"]);

/** Is this fence prose for a person to read or paste, rather than code? */
export function isWriting(lang: string, source: string): boolean {
  if (WRITING_LANGS.has(lang)) return true;
  if (lang || !source.trim()) return false;
  const code =
    /[{};]\s*$|=>|==|::|\(\)|<\/?[a-z][\w-]*[\s>]|^\s*(def|function|const|let|var|import|from|class|return|if|for|while|SELECT|INSERT|UPDATE|\$|#!|npm|git|curl)\b|^( {4}|\t)/im;
  return !code.test(source);
}

export interface WritingLabel {
  title: string;
  /** e.g. "138 chars" */
  meta: string;
}

/**
 * A label line above a fence: a fully bold line ("**⭐ My pick — 138
 * chars**") or a short heading. Leading emoji and symbols go; " — " splits off
 * the meta. Null when the line isn't a label.
 */
export function parseWritingLabel(line: string): WritingLabel | null {
  const trimmed = line.trim();
  const bold = /^\*\*(.+)\*\*:?$/.exec(trimmed) ?? /^__(.+)__:?$/.exec(trimmed);
  const heading = /^#{1,4}\s+(.+)$/.exec(trimmed);
  const raw = (bold?.[1] ?? heading?.[1])?.replace(/\*\*|__/g, "");
  if (!raw || raw.length > 80) return null;
  const clean = raw.replace(/^[^\p{L}\p{N}]+/u, "").replace(/:$/, "").trim();
  if (!clean) return null;
  const [title, ...rest] = clean.split(/\s+[—–·|]\s+|\s+-\s+/);
  return { title: title!.trim(), meta: rest.join(" · ").trim() };
}

export interface WritingOption {
  key: string;
  source: string;
  label: WritingLabel | null;
  /** lines written straight under the fence, about this version */
  notes: string[];
}

/** One version, or several behind numbered tabs. */
export function WritingBlock({ options, renderNote }: { options: WritingOption[]; renderNote: (line: string, key: string) => React.ReactNode }) {
  const { colors } = useAppTheme();
  const [active, setActive] = useState(0);
  const option = options[Math.min(active, options.length - 1)]!;
  return (
    <View style={styles.block}>
      {options.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs} accessibilityRole="tablist">
          {options.map((o, i) => {
            const on = i === active;
            return (
              <Pressable
                key={o.key}
                onPress={() => setActive(i)}
                accessibilityRole="tab"
                accessibilityState={{ selected: on }}
                style={({ pressed }) => [styles.tab, { backgroundColor: on ? colors.surface : "transparent", borderColor: on ? colors.border : "transparent", opacity: pressed ? 0.7 : 1 }]}
              >
                <View style={[styles.tabNumber, { borderColor: on ? colors.text : colors.textFaint }]}>
                  <Text variant="caption" color={on ? colors.text : colors.textDim} style={styles.tabNumberText}>
                    {i + 1}
                  </Text>
                </View>
                <Text variant="subtle" color={on ? colors.text : colors.textDim} style={on ? styles.bold : undefined} numberOfLines={1}>
                  {o.label?.title ?? `Version ${i + 1}`}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      <WritingCard source={option.source} meta={options.length > 1 ? option.label?.meta : option.label ? [option.label.title, option.label.meta].filter(Boolean).join(" · ") : ""} />
      {option.notes.map((line, i) => renderNote(line, `${option.key}-n${i}`))}
    </View>
  );
}

function WritingCard({ source, meta }: { source: string; meta?: string }) {
  const { colors } = useAppTheme();
  const message = useMessageContext();
  const { bySlug } = useCrew();
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const text = source.replace(/^\n+|\s+$/g, "");
  // in a 1:1 thread the speaker is the thread's intern
  const slug = message ? (message.speaker ?? message.thread) : null;
  const who = slug ? (bySlug[slug]?.name ?? null) : null;
  const copy = async (value: string) => {
    if (await copyText(value)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.cardBar}>
        <Text variant="subtle" color={colors.textDim} numberOfLines={1} style={styles.flex}>
          {meta ? `Writing · ${meta}` : "Writing"}
        </Text>
        {message ? (
          <Pressable onPress={() => setEditing(true)} accessibilityRole="button" accessibilityLabel="Edit" hitSlop={8} style={styles.action}>
            <EditIcon size={20} color={colors.text} />
          </Pressable>
        ) : null}
        <Pressable onPress={() => void copy(text)} accessibilityRole="button" accessibilityLabel={copied ? "Copied" : "Copy"} hitSlop={8} style={styles.action}>
          {copied ? <CheckIcon size={20} color={colors.text} /> : <CopyIcon size={20} color={colors.text} />}
        </Pressable>
      </View>
      <Text variant="message" color={colors.text} selectable>
        {text}
      </Text>
      {editing && message ? (
        <EditSheet
          initial={text}
          who={who}
          onCancel={() => setEditing(false)}
          onCopy={(value) => {
            setEditing(false);
            void copy(value);
          }}
          onSend={async (value) => {
            setEditing(false);
            await message.reply(`Here's my version:\n\n\`\`\`writing\n${value.trim()}\n\`\`\``);
          }}
        />
      ) : null}
    </View>
  );
}

/** Edit a version in place, then copy it or send it back to the intern. */
function EditSheet({ initial, who, onCancel, onCopy, onSend }: { initial: string; who: string | null; onCancel: () => void; onCopy: (v: string) => void; onSend: (v: string) => Promise<void> }) {
  const { colors, fontScale } = useAppTheme();
  const [value, setValue] = useState(initial);
  const changed = value.trim() !== initial.trim();
  return (
    <Modal transparent visible animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={[styles.backdrop, { backgroundColor: colors.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onCancel} accessibilityLabel="Close" />
        <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={styles.sheetBar}>
            <Pressable onPress={onCancel} accessibilityRole="button" hitSlop={8}>
              <Text variant="body" color={colors.textDim}>
                Cancel
              </Text>
            </Pressable>
            <Text variant="title">Edit</Text>
            <Pressable onPress={() => onCopy(value)} accessibilityRole="button" hitSlop={8}>
              <Text variant="body" color={colors.info} style={styles.bold}>
                Copy
              </Text>
            </Pressable>
          </View>
          <TextInput
            value={value}
            onChangeText={setValue}
            multiline
            autoFocus
            style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.bg, fontSize: scaledFont(16, fontScale), lineHeight: scaledFont(23, fontScale) }]}
          />
          <Pressable
            onPress={() => void onSend(value)}
            disabled={!changed}
            accessibilityRole="button"
            style={({ pressed }) => [styles.send, { backgroundColor: changed ? colors.accent : colors.surfaceAlt, opacity: pressed ? 0.8 : 1 }]}
          >
            <Text variant="body" color={changed ? colors.onAccent : colors.textFaint} style={styles.bold}>
              {who ? `Send to ${who}` : "Send"}
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  block: { gap: space.sm, marginVertical: space.xs, alignSelf: "stretch" },
  tabs: { gap: space.xs },
  tab: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: 1, borderRadius: radius.pill, paddingLeft: space.sm, paddingRight: space.md, paddingVertical: 6 },
  tabNumber: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.3, alignItems: "center", justifyContent: "center" },
  tabNumberText: { fontWeight: "600", fontSize: 11 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.xl, paddingHorizontal: space.lg, paddingTop: space.md, paddingBottom: space.lg, gap: space.sm },
  cardBar: { flexDirection: "row", alignItems: "center", gap: space.lg },
  action: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  flex: { flex: 1 },
  bold: { fontWeight: "600" },
  backdrop: { flex: 1, justifyContent: "center", padding: space.lg },
  sheet: { borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth, padding: space.lg, gap: space.md, maxWidth: 560, width: "100%", alignSelf: "center" },
  sheetBar: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  input: { minHeight: 180, maxHeight: 420, borderWidth: 1, borderRadius: radius.lg, padding: space.md, textAlignVertical: "top" },
  send: { borderRadius: radius.lg, paddingVertical: space.md, alignItems: "center" },
});
