/**
 * The message composer: a pill exactly as tall as the send button on one line,
 * growing with the text up to five lines and then scrolling inside itself.
 *
 * It is a real multiline field, so iOS offers a return key and JP can write
 * paragraphs. Return therefore never sends. On a desktop keyboard,
 * ⌘/Ctrl+Return sends — a chord nobody types by accident.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type TextInputContentSizeChangeEventData,
} from "react-native";
import type { UploadableFile } from "../api";
import { radius, scaledFont, space, useAppTheme } from "../theme";
import { filesFromDataTransfer } from "./Attachments";
import { BulbIcon, PaperclipIcon, SendIcon } from "./Icons";

/** Matches the send button, so one line of text sits on the same baseline. */
export const COMPOSER_MIN_HEIGHT = 44;
const LINE_HEIGHT = 21;
const VERTICAL_PADDING = 22;
const MAX_LINES = 5;

export interface ComposerProps {
  value: string;
  onChangeText: (value: string) => void;
  onSend: () => void;
  sending?: boolean;
  placeholder?: string;
  onFocus?: () => void;
  onBlur?: () => void;
  /** paperclip tap; omitted = no attach button */
  onAttach?: () => void;
  /** files pasted into or dropped on the field (web) */
  onFiles?: (files: UploadableFile[]) => void;
  /** attachments are staged, so an empty text field may still send */
  hasAttachments?: boolean;
  /** uploads still in flight — sending waits for them */
  attachmentsBusy?: boolean;
  /** front desk only: the 💡 toggle that turns Send into "save this idea" */
  onToggleIdea?: () => void;
  ideaMode?: boolean;
}

export function Composer({
  value,
  onChangeText,
  onSend,
  sending = false,
  placeholder,
  onFocus,
  onBlur,
  onAttach,
  onFiles,
  hasAttachments = false,
  attachmentsBusy = false,
  onToggleIdea,
  ideaMode = false,
}: ComposerProps) {
  const { colors, fontScale } = useAppTheme();
  const lineHeight = scaledFont(LINE_HEIGHT, fontScale);
  const composerMaxHeight = lineHeight * MAX_LINES + VERTICAL_PADDING;
  const inputRef = useRef<TextInput>(null);
  const sendRef = useRef<View>(null);
  const attachRef = useRef<View>(null);
  const [height, setHeight] = useState(COMPOSER_MIN_HEIGHT);

  // Web/iOS: a tap on a button first blurs the textarea, which dismisses the
  // keyboard and reflows the bar before the click lands — so the first tap
  // only closed the keyboard. Preventing the default on mouse/touch-down keeps
  // focus in the field. On touch devices that also suppresses the synthesized
  // click, so the action is fired straight from the touch instead.
  const latest = useRef({ onSend, onAttach, canSend: false });
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const bind = (ref: React.RefObject<View | null>, fire: () => void) => {
      const node = ref.current as unknown as HTMLElement | null;
      if (!node?.addEventListener) return () => {};
      const onMouseDown = (e: Event) => e.preventDefault(); // desktop: keep focus, let the click fire
      const onTouchStart = (e: Event) => {
        e.preventDefault(); // mobile: keep focus + keyboard; no click will follow, so act now
        fire();
      };
      node.addEventListener("mousedown", onMouseDown);
      node.addEventListener("touchstart", onTouchStart, { passive: false });
      return () => {
        node.removeEventListener("mousedown", onMouseDown);
        node.removeEventListener("touchstart", onTouchStart);
      };
    };
    const offSend = bind(sendRef, () => {
      if (latest.current.canSend) latest.current.onSend();
    });
    const offAttach = bind(attachRef, () => latest.current.onAttach?.());
    return () => {
      offSend();
      offAttach();
    };
  }, [Boolean(onAttach)]);

  /** Web: measure the textarea itself; RN's contentSize is native-only. */
  const resizeWeb = useCallback(() => {
    if (Platform.OS !== "web") return;
    const node = inputRef.current as unknown as HTMLTextAreaElement | null;
    if (!node?.style) return;
    node.style.height = "0px";
    const next = Math.min(Math.max(node.scrollHeight, COMPOSER_MIN_HEIGHT), composerMaxHeight);
    node.style.height = `${next}px`;
    node.style.overflowY = node.scrollHeight > composerMaxHeight ? "auto" : "hidden";
  }, [composerMaxHeight]);

  useEffect(() => {
    resizeWeb();
  }, [value, resizeWeb]);

  // Web, desktop keyboards: ⌘/Ctrl+Return sends. Plain Return stays a newline.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const node = inputRef.current as unknown as HTMLTextAreaElement | null;
    if (!node?.addEventListener) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey) || e.isComposing) return;
      e.preventDefault();
      if (latest.current.canSend) latest.current.onSend();
    };
    node.addEventListener("keydown", onKeyDown);
    return () => node.removeEventListener("keydown", onKeyDown);
  }, []);

  // Web: screenshots paste as files, and files can be dropped on the field.
  // React Native's TextInput exposes neither, so listen on the DOM node.
  useEffect(() => {
    if (Platform.OS !== "web" || !onFiles) return;
    const node = inputRef.current as unknown as HTMLTextAreaElement | null;
    if (!node?.addEventListener) return;
    const onPaste = (e: ClipboardEvent) => {
      const files = filesFromDataTransfer(e.clipboardData);
      if (files.length) {
        e.preventDefault();
        onFiles(files);
      }
    };
    const onDrop = (e: DragEvent) => {
      const files = filesFromDataTransfer(e.dataTransfer);
      if (files.length) {
        e.preventDefault();
        onFiles(files);
      }
    };
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    node.addEventListener("paste", onPaste);
    node.addEventListener("drop", onDrop);
    node.addEventListener("dragover", onDragOver);
    return () => {
      node.removeEventListener("paste", onPaste);
      node.removeEventListener("drop", onDrop);
      node.removeEventListener("dragover", onDragOver);
    };
  }, [onFiles]);

  const onContentSizeChange = (e: NativeSyntheticEvent<TextInputContentSizeChangeEventData>) => {
    if (Platform.OS === "web") return;
    const next = Math.min(
      Math.max(e.nativeEvent.contentSize.height, COMPOSER_MIN_HEIGHT),
      composerMaxHeight,
    );
    setHeight(next);
  };

  const canSend = (value.trim().length > 0 || hasAttachments) && !sending && !attachmentsBusy;
  latest.current = { onSend, onAttach, canSend };

  return (
    <View style={[styles.shell, { backgroundColor: colors.surfaceAlt }]}>
      {onAttach ? (
        <Pressable
          ref={attachRef}
          accessibilityRole="button"
          accessibilityLabel="Attach a file or photo"
          onPress={onAttach}
          disabled={sending}
          hitSlop={4}
          style={({ pressed }) => [styles.attach, { opacity: pressed ? 0.6 : 1 }]}
        >
          <PaperclipIcon color={colors.textDim} size={20} />
        </Pressable>
      ) : null}
      {onToggleIdea ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: ideaMode }}
          accessibilityLabel={ideaMode ? "Idea mode on — send saves an idea" : "Jot an idea"}
          onPress={onToggleIdea}
          hitSlop={4}
          style={({ pressed }) => [styles.attach, { backgroundColor: ideaMode ? colors.accent : "transparent", opacity: pressed ? 0.6 : 1 }]}
        >
          <BulbIcon color={ideaMode ? colors.onAccent : colors.textDim} size={20} />
        </Pressable>
      ) : null}
      <TextInput
        ref={inputRef}
        value={value}
        onChangeText={onChangeText}
        onFocus={onFocus}
        onBlur={onBlur}
        onContentSizeChange={onContentSizeChange}
        placeholder={placeholder}
        placeholderTextColor={colors.textFaint}
        multiline
        numberOfLines={1}
        scrollEnabled
        style={[
          styles.input,
          { color: colors.text, fontSize: scaledFont(16, fontScale), lineHeight, maxHeight: composerMaxHeight },
          Platform.OS === "web" ? { height: COMPOSER_MIN_HEIGHT } : { height },
        ]}
      />
      <Pressable
        ref={sendRef}
        accessibilityRole="button"
        accessibilityLabel="Send"
        onPress={onSend}
        disabled={!canSend}
        hitSlop={4}
        style={({ pressed }) => [
          styles.send,
          {
            backgroundColor: canSend ? colors.accent : "transparent",
            opacity: pressed ? 0.78 : 1,
          },
        ]}
      >
        {sending ? (
          <ActivityIndicator size="small" color={colors.onAccent} />
        ) : (
          <SendIcon color={canSend ? colors.onAccent : colors.textFaint} size={20} />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    flexDirection: "row",
    alignItems: "flex-end",
    padding: space.xs,
    borderRadius: radius.xl,
  },
  input: {
    flex: 1,
    minHeight: COMPOSER_MIN_HEIGHT,
    borderWidth: 0,
    paddingHorizontal: space.md,
    paddingTop: VERTICAL_PADDING / 2,
    paddingBottom: VERTICAL_PADDING / 2,
    textAlignVertical: "top",
  },
  send: {
    width: 40,
    height: 40,
    marginBottom: 2,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  attach: {
    width: 40,
    height: 40,
    marginBottom: 2,
    borderRadius: radius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
});
