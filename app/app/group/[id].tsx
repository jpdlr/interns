/**
 * Create or edit a group chat: a name, an optional standing brief, and the
 * interns in it. `/group/new` creates and opens the thread; `/group/<id>`
 * edits an existing room (reached from the thread header) and can archive
 * it. Archiving hides the room and cancels queued replies; history stays in
 * the database.
 */
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Room } from "../../src/api";
import { useCrew } from "../../src/crew";
import { goBack, useConfirmDiscard } from "../../src/nav";
import { useSettings } from "../../src/settings";
import { radius, scaledFont, space, useAppTheme } from "../../src/theme";
import { Button } from "../../src/ui/Button";
import { CheckIcon } from "../../src/ui/Icons";
import { InternFace } from "../../src/ui/InternFace";
import { EmptyState, ErrorNote, Loading, Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

export default function GroupScreen() {
  const { colors, fontScale } = useAppTheme();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api, ready, configured } = useSettings();
  const { members: crew, loaded } = useCrew();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const isNew = !id || id === "new";

  const [room, setRoom] = useState<Room | null>(null);
  const [name, setName] = useState("");
  const [topic, setTopic] = useState("");
  const [pad, setPad] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (isNew || !id || !configured) return;
    let active = true;
    setLoading(true);
    setLoadError(null);
    api
      .getRoom(id)
      .then((r) => {
        if (!active) return;
        setRoom(r);
        setName(r.name);
        setTopic(r.topic);
        setPad(r.scratchpad ?? "");
        setSelected(r.members);
      })
      .catch((e) => active && setLoadError(e))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [api, id, isNew, configured, attempt]);

  // Interns write to the scratchpad while this screen is open; only an edit
  // made here should be sent back, or a rename would erase their notes.
  const padEdited = Boolean(room) && pad !== (room?.scratchpad ?? "");
  const dirty = isNew
    ? selected.length > 0 || name.trim().length > 0 || topic.trim().length > 0
    : Boolean(room) && (
      name !== room!.name
      || topic !== room!.topic
      || padEdited
      || selected.length !== room!.members.length
      || selected.some((s) => !room!.members.includes(s))
    );
  const allowLeave = useConfirmDiscard(dirty, isNew ? "this group" : "your changes");

  const toggle = useCallback((slug: string) => {
    setSelected((current) => (current.includes(slug) ? current.filter((s) => s !== slug) : [...current, slug]));
  }, []);

  const suggestedName = useMemo(() => {
    const names = selected.map((s) => crew.find((c) => c.slug === s)?.name.split(" ")[0] ?? s);
    return names.length ? names.slice(0, 3).join(", ") + (names.length > 3 ? ` +${names.length - 3}` : "") : "";
  }, [selected, crew]);

  const canSave = selected.length > 0 && (name.trim().length > 0 || suggestedName.length > 0) && !saving;

  const save = useCallback(async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const body = { name: name.trim() || suggestedName, members: selected, topic: topic.trim() };
      if (isNew) {
        const created = await api.createRoom(body);
        allowLeave();
        router.replace(`/chat/${created.id}` as never);
      } else if (room) {
        await api.patchRoom(room.id, padEdited ? { ...body, scratchpad: pad } : body);
        allowLeave();
        goBack(router, `/chat/${room.id}`);
      }
    } catch (e) {
      setError(e);
    } finally {
      setSaving(false);
    }
  }, [allowLeave, api, canSave, isNew, name, pad, padEdited, room, router, selected, suggestedName, topic]);

  const archive = useCallback(() => {
    if (!room) return;
    const go = async () => {
      try {
        await api.archiveRoom(room.id);
        allowLeave();
        router.replace("/" as never);
      } catch (e) {
        setError(e);
      }
    };
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(`Archive "${room.name}"? The conversation stays in the database but disappears from the app.`)) void go();
      return;
    }
    Alert.alert("Archive group?", `"${room.name}" disappears from the app; history is kept.`, [
      { text: "Keep", style: "cancel" },
      { text: "Archive", style: "destructive", onPress: () => void go() },
    ]);
  }, [allowLeave, api, room, router]);

  return (
    <Screen>
      <Stack.Screen options={{ title: isNew ? "New group" : room ? `${room.name} · Group` : "Group" }} />
      {!configured ? (
        <EmptyState title="Not connected" body="Add the orchestrator URL and token in Settings." />
      ) : !ready || loading || !loaded ? (
        <Loading />
      ) : loadError ? (
        <EmptyState title="Couldn't open this group">
          <ErrorNote error={loadError} subject="this group" onRetry={() => setAttempt((n) => n + 1)} />
        </EmptyState>
      ) : (
        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxl }]} keyboardShouldPersistTaps="handled">
          {error ? <ErrorNote error={error} onDismiss={() => setError(null)} style={styles.inlineError} /> : null}
          <View style={styles.field}>
            <Text variant="label">Name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder={suggestedName || "e.g. Launch week"}
              placeholderTextColor={colors.textFaint}
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale) }]}
            />
          </View>
          <View style={styles.field}>
            <Text variant="label">Members</Text>
            <Text variant="caption">Mention someone with @Name in the chat to bring them in; with no mention everyone may answer.</Text>
            <View style={styles.memberGrid}>
              {crew.map((member) => {
                const on = selected.includes(member.slug);
                return (
                  <Pressable
                    key={member.slug}
                    onPress={() => toggle(member.slug)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: on }}
                    accessibilityLabel={member.name}
                    style={({ pressed }) => [
                      styles.member,
                      { backgroundColor: on ? colors.accentSoft : colors.surface, borderColor: on ? colors.text : colors.border, opacity: pressed ? 0.8 : 1 },
                    ]}
                  >
                    <View style={styles.memberFace}>
                      <InternFace id={member.faceId} size={40} clipToBounds />
                      {on ? (
                        <View style={[styles.check, { backgroundColor: colors.accent, borderColor: colors.bg }]}>
                          <CheckIcon size={11} color={colors.onAccent} />
                        </View>
                      ) : null}
                    </View>
                    <View style={styles.memberText}>
                      <Text variant="subtle" color={colors.text} numberOfLines={1}>
                        {member.name}
                      </Text>
                      <Text variant="caption" numberOfLines={1}>
                        {member.role}
                      </Text>
                    </View>
                  </Pressable>
                );
              })}
              {crew.length === 0 ? <Text variant="subtle">No interns hired yet.</Text> : null}
            </View>
          </View>
          <View style={styles.field}>
            <Text variant="label">Standing brief (optional)</Text>
            <Text variant="caption">Shown to every member with each message — what this group is for, ground rules, who owns what.</Text>
            <TextInput
              value={topic}
              onChangeText={setTopic}
              multiline
              placeholder="e.g. Planning the Q4 launch. Rhea owns engineering risk, Tessa owns comms. Keep replies under 120 words."
              placeholderTextColor={colors.textFaint}
              style={[styles.input, styles.topicInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(15, fontScale) }]}
            />
          </View>
          {!isNew ? (
            <View style={styles.field}>
              <Text variant="label">Scratchpad</Text>
              <Text variant="caption">The group's shared notes, pinned above the chat. Interns read it with every message and can add to it themselves.</Text>
              <TextInput
                value={pad}
                onChangeText={setPad}
                multiline
                placeholder={"# Plan\n- owner: …\n- decided: …\n- open: …"}
                placeholderTextColor={colors.textFaint}
                style={[styles.input, styles.padInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(15, fontScale) }]}
              />
            </View>
          ) : null}
          <Button label={isNew ? "Create group" : "Save"} tone="primary" disabled={!canSave} busy={saving} onPress={() => void save()} />
          {!isNew && room ? (
            <View style={[styles.danger, { borderColor: colors.border }]}>
              <Text variant="label">Danger zone</Text>
              <Button label="Archive group" tone="danger" onPress={archive} />
            </View>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.xl, maxWidth: 720, width: "100%", alignSelf: "center" },
  field: { gap: space.sm },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm + 2 },
  topicInput: { minHeight: 96, textAlignVertical: "top" },
  padInput: { minHeight: 160, textAlignVertical: "top", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" },
  memberGrid: { gap: space.sm, marginTop: space.xs },
  member: { flexDirection: "row", alignItems: "center", gap: space.md, borderWidth: 1, borderRadius: radius.lg, padding: space.sm },
  memberFace: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  memberText: { flex: 1, gap: 1 },
  check: { position: "absolute", right: -2, bottom: -2, width: 18, height: 18, borderRadius: 9, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  inlineError: { marginHorizontal: 0, marginBottom: 0 },
  danger: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: space.lg, gap: space.sm, marginTop: space.lg },
});
