/**
 * One part of an intern's profile at a time (?section=about|personality|
 * instructions|schedule|work|tools|budget). Save sits in the header and stays
 * off until something changed and it's valid; leaving with unsaved changes
 * asks first. Renaming still carries the new name into the role, personality,
 * instructions and standing work (src/rename.ts) and says where it did.
 */
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { nameConflict, useCrew } from "../../../src/crew";
import type { MailboxStatus } from "../../../src/api";
import { changedPatch, FALLBACK_TOOLS, formFromManifest, NOTIFY_INFO, NOTIFY_LEVELS, notifyStatsLine, shortTokens, TOOL_INFO, useInternFile, wordCount, type FormState } from "../../../src/internFile";
import { goBack, useConfirmDiscard } from "../../../src/nav";
import { describeMentions, useNameCarry, type ProseField } from "../../../src/rename";
import { useSettings } from "../../../src/settings";
import { radius, scaledFont, space, useAppTheme } from "../../../src/theme";
import { Group, Row, Switch } from "../../../src/ui/Grouped";
import { Flash, GrowingInput } from "../../../src/ui/GrowingInput";
import { CheckIcon, TrashIcon } from "../../../src/ui/Icons";
import { ToolIcon } from "../../../src/ui/ToolIcon";
import { StyleDials } from "../../../src/ui/hire/PersonalityCard";
import { resolveFaceId } from "../../../src/ui/InternFace";
import { SchedulePicker } from "../../../src/ui/SchedulePicker";
import { ErrorNote, Loading, Screen } from "../../../src/ui/Screen";
import { Text } from "../../../src/ui/Text";

type Section = "about" | "personality" | "instructions" | "schedule" | "work" | "tools" | "budget" | "notify" | "mailboxes";

const TITLES: Record<Section, string> = {
  about: "Name and role",
  personality: "Personality",
  instructions: "Instructions",
  schedule: "Schedule",
  work: "Standing work",
  tools: "Tools",
  budget: "Daily budget",
  notify: "Notifications",
  mailboxes: "Mailboxes",
};

const BUDGETS = [50_000, 100_000, 200_000, 500_000, 1_000_000];

export default function InternEditor() {
  const { colors, fontScale } = useAppTheme();
  const { slug, section: rawSection } = useLocalSearchParams<{ slug: string; section?: string }>();
  const section: Section = (rawSection && rawSection in TITLES ? rawSection : "about") as Section;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { manifest, meta, patch } = useInternFile(slug);
  const { members } = useCrew();
  const nameCarry = useNameCarry();
  const [form, setForm] = useState<FormState | null>(null);
  const [initial, setInitial] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [renameNote, setRenameNote] = useState<string | null>(null);
  const [flashes, setFlashes] = useState<Partial<Record<ProseField, number>>>({});
  const [newItem, setNewItem] = useState("");

  // Seed the form once, from the first manifest we get (refocus refetches must not wipe edits).
  useEffect(() => {
    if (manifest && !initial) {
      const next = formFromManifest(manifest);
      setForm(next);
      setInitial(next);
    }
  }, [manifest, initial]);

  const update = useCallback((p: Partial<FormState>) => setForm((f) => (f ? { ...f, ...p } : f)), []);
  const editProse = useCallback(
    (p: Partial<FormState>) => {
      nameCarry.settle();
      setRenameNote(null);
      update(p);
    },
    [nameCarry, update],
  );
  const rename = useCallback(
    (name: string) => {
      if (!form) return;
      const { patch: carried, changed, mentions } = nameCarry.rename(form, name);
      setForm({ ...form, ...carried });
      setRenameNote(describeMentions(mentions));
      if (changed.length) setFlashes((c) => ({ ...c, ...Object.fromEntries(changed.map((f) => [f, (c[f] ?? 0) + 1])) }));
    },
    [form, nameCarry],
  );

  const dirty = Boolean(form && initial && JSON.stringify(form) !== JSON.stringify(initial));
  const nameError = form ? nameConflict(form.name, members, slug) : null;
  const capError = useMemo(() => {
    if (!form) return null;
    const cap = Number(form.daily_token_cap.trim());
    if (!form.daily_token_cap.trim()) return "Enter a daily budget.";
    if (!Number.isInteger(cap) || cap < 10_000) return "Use a whole number of at least 10,000.";
    return null;
  }, [form]);
  const valid = Boolean(form && form.name.trim() && form.role.trim() && form.system_prompt.trim() && !nameError && !capError);
  const allowLeave = useConfirmDiscard(dirty, "your changes");

  const save = useCallback(async () => {
    if (!form || !valid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await patch(changedPatch(initial!, form));
      allowLeave();
      goBack(router, `/intern/${slug}`);
    } catch (e) {
      setSaveError(e);
    } finally {
      setSaving(false);
    }
  }, [allowLeave, form, initial, patch, router, saving, slug, valid]);

  const tools = useMemo(() => {
    const base = meta?.tools?.length ? meta.tools : FALLBACK_TOOLS;
    return Array.from(new Set([...base, ...(form?.tools ?? [])]));
  }, [meta, form?.tools]);

  const inputStyle = [styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale), lineHeight: scaledFont(22, fontScale) }];
  const name = manifest?.name ?? "this intern";

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: TITLES[section],
          headerRight: () => (
            <Pressable onPress={() => void save()} disabled={!dirty || !valid || saving} accessibilityRole="button" accessibilityLabel="Save" hitSlop={8} style={styles.headerButton}>
              <Text variant="body" color={dirty && valid && !saving ? colors.info : colors.textFaint} style={styles.bold}>
                {saving ? "Saving…" : "Save"}
              </Text>
            </Pressable>
          ),
        }}
      />
      {!form ? (
        <Loading />
      ) : (
        <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxl }]} keyboardShouldPersistTaps="handled">
          {saveError ? <ErrorNote error={saveError} onDismiss={() => setSaveError(null)} /> : null}

          {section === "about" ? (
            <>
              <Field label="Name" note={nameError ?? renameNote} noteColor={nameError ? colors.danger : undefined}>
                <TextInput value={form.name} onChangeText={rename} onBlur={nameCarry.settle} style={inputStyle} autoCorrect={false} />
              </Field>
              <Field label="Role" note="One line on the crew list and in chats.">
                <Flash pulse={flashes.role ?? 0} radius={radius.md}>
                  <GrowingInput value={form.role} onChangeText={(role) => editProse({ role })} style={inputStyle} minHeight={0} collapsedLines={4} placeholderTextColor={colors.textFaint} />
                </Flash>
              </Field>
            </>
          ) : null}

          {section === "personality" ? (
            <View style={[styles.dials, { backgroundColor: colors.surfaceAlt }]}>
              <StyleDials faceId={resolveFaceId(form.icon, slug ?? "")} style={form.style} onStyle={(style) => update({ style })} />
            </View>
          ) : null}
          {section === "personality" ? (
            <Field label={`How ${name} comes across, in words`} note="Anything the dials don't cover: manner, quirks, how they talk to you.">
              <Flash pulse={flashes.persona ?? 0} radius={radius.md}>
                <GrowingInput value={form.persona} onChangeText={(persona) => editProse({ persona })} style={[inputStyle, styles.long]} minHeight={220} collapsedLines={40} placeholderTextColor={colors.textFaint} placeholder="Calm, dry-witted, allergic to fuss…" />
              </Flash>
            </Field>
          ) : null}

          {section === "instructions" ? (
            <Field label="What they do and how" note={`${wordCount(form.system_prompt).toLocaleString()} words. Standing orders you give in chat are added on top of these.`}>
              <Flash pulse={flashes.system_prompt ?? 0} radius={radius.md}>
                <GrowingInput
                  value={form.system_prompt}
                  onChangeText={(system_prompt) => editProse({ system_prompt })}
                  style={[inputStyle, styles.long, { fontSize: scaledFont(15, fontScale), lineHeight: scaledFont(21, fontScale) }]}
                  minHeight={360}
                  collapsedLines={400}
                  placeholderTextColor={colors.textFaint}
                />
              </Flash>
            </Field>
          ) : null}

          {section === "schedule" ? (
            <Field label={`When ${name} works on their own`} note="Besides this, they always answer your messages.">
              <SchedulePicker value={form.cron} onChange={(cron) => update({ cron })} />
            </Field>
          ) : null}

          {section === "work" ? (
            <Field label="Standing work" note={`Picked up when ${name} is idle — one item at a time.`}>
              <View style={styles.items}>
                {form.backlog.map((item, i) => (
                  <View key={i} style={styles.itemRow}>
                    <Flash pulse={flashes.backlog ?? 0} radius={radius.md} style={styles.flex}>
                      <GrowingInput
                        value={item}
                        onChangeText={(text) => editProse({ backlog: form.backlog.map((x, j) => (j === i ? text : x)) })}
                        style={inputStyle}
                        minHeight={0}
                        collapsedLines={4}
                        placeholderTextColor={colors.textFaint}
                      />
                    </Flash>
                    <Pressable accessibilityRole="button" accessibilityLabel="Remove" onPress={() => editProse({ backlog: form.backlog.filter((_, j) => j !== i) })} hitSlop={6} style={styles.iconButton}>
                      <TrashIcon size={18} color={colors.textFaint} />
                    </Pressable>
                  </View>
                ))}
                <View style={styles.itemRow}>
                  <TextInput
                    value={newItem}
                    onChangeText={setNewItem}
                    placeholder="Add standing work…"
                    placeholderTextColor={colors.textFaint}
                    style={[...inputStyle, styles.flex]}
                    onSubmitEditing={() => {
                      if (!newItem.trim()) return;
                      editProse({ backlog: [...form.backlog, newItem.trim()] });
                      setNewItem("");
                    }}
                  />
                  <Pressable
                    accessibilityRole="button"
                    disabled={!newItem.trim()}
                    onPress={() => {
                      editProse({ backlog: [...form.backlog, newItem.trim()] });
                      setNewItem("");
                    }}
                    style={styles.iconButton}
                  >
                    <Text variant="body" color={newItem.trim() ? colors.info : colors.textFaint} style={styles.bold}>
                      Add
                    </Text>
                  </Pressable>
                </View>
                {!form.backlog.length ? <Text variant="caption">Nothing yet — {name} only works when asked.</Text> : null}
              </View>
            </Field>
          ) : null}

          {section === "tools" ? (
            <Group footer="Mail is always drafts-only: nothing is sent without you. GitHub is given to the reviewer you pick in Settings › Connectors; builds are granted by the coordinator.">
              {tools.map((tool) => {
                const on = form.tools.includes(tool);
                const info = TOOL_INFO[tool];
                return (
                  <Row
                    key={tool}
                    label={info?.label ?? tool}
                    icon={<ToolIcon tool={tool} />}
                    detail={info?.detail}
                    right={<Switch label={info?.label ?? tool} value={on} onChange={() => update({ tools: on ? form.tools.filter((t) => t !== tool) : [...form.tools, tool] })} />}
                  />
                );
              })}
            </Group>
          ) : null}

          {section === "mailboxes" ? <MailboxesSection name={name} value={form.mailboxes} onChange={(mailboxes) => update({ mailboxes })} /> : null}

          {section === "notify" ? (
            <Group
              title={`What reaches your phone from ${name}`}
              footer={[notifyStatsLine(manifest?.notify_stats), "Urgent problems always come through. Summary times and quiet hours are in Settings."].filter(Boolean).join(". ")}
            >
              {NOTIFY_LEVELS.map((level) => {
                const on = form.notify === level;
                return (
                  <Row
                    key={level}
                    label={NOTIFY_INFO[level].label}
                    detail={NOTIFY_INFO[level].detail}
                    onPress={() => update({ notify: level })}
                    accessibilityLabel={`${NOTIFY_INFO[level].label}${on ? ", selected" : ""}`}
                    right={<View style={styles.check}>{on ? <CheckIcon size={20} color={colors.accent} /> : null}</View>}
                  />
                );
              })}
            </Group>
          ) : null}

          {section === "budget" ? (
            <Field label="Tokens per day" note={capError ?? `Work stops for the day once ${name} has used this much. Today: ${shortTokens((manifest?.spend_today.input_tokens ?? 0) + (manifest?.spend_today.output_tokens ?? 0))}.`} noteColor={capError ? colors.urgent : undefined}>
              <View style={styles.presets}>
                {BUDGETS.map((b) => {
                  const on = Number(form.daily_token_cap) === b;
                  return (
                    <Pressable key={b} onPress={() => update({ daily_token_cap: String(b) })} accessibilityRole="radio" accessibilityState={{ selected: on }} style={[styles.preset, { backgroundColor: on ? colors.accent : colors.surfaceAlt }]}>
                      <Text variant="subtle" color={on ? colors.onAccent : colors.text} style={styles.bold}>
                        {shortTokens(b)}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <TextInput value={form.daily_token_cap} onChangeText={(daily_token_cap) => update({ daily_token_cap: daily_token_cap.replace(/[^\d]/g, "") })} keyboardType="number-pad" style={inputStyle} accessibilityLabel="Exact daily budget" />
            </Field>
          ) : null}
        </ScrollView>
      )}
    </Screen>
  );
}

/** Every mailbox (including ones connected later), or only some. */
function MailboxesSection({ name, value, onChange }: { name: string; value: string[] | null; onChange: (v: string[] | null) => void }) {
  const { api } = useSettings();
  const router = useRouter();
  const [mailboxes, setMailboxes] = useState<MailboxStatus[] | null>(null);
  useEffect(() => {
    api.connectors().then((o) => setMailboxes(o.outlook.mailboxes), () => setMailboxes([]));
  }, [api]);
  if (!mailboxes) return <Loading />;
  if (!mailboxes.length) {
    return (
      <Group footer="Connect a mailbox first; then choose here which ones they may use.">
        <Row label="Connect Outlook" onPress={() => router.push("/connectors/outlook" as never)} />
      </Group>
    );
  }
  const all = value === null;
  return (
    <>
      <Group footer={all ? `${name} can read and draft in every connected mailbox, including ones you add later.` : `${name} can only use the mailboxes switched on below.`}>
        <Row
          label="Every mailbox"
          right={<Switch label="Every mailbox" value={all} onChange={(on) => onChange(on ? null : mailboxes.map((m) => m.id))} />}
        />
      </Group>
      <Group title="Mailboxes">
        {mailboxes.map((m) => {
          const on = all || value!.includes(m.id);
          return (
            <Row
              key={m.id}
              label={m.label}
              detail={m.account ?? undefined}
              right={
                <Switch
                  label={m.label}
                  value={on}
                  disabled={all}
                  onChange={(next) => onChange(next ? [...value!, m.id] : value!.filter((id) => id !== m.id))}
                />
              }
            />
          );
        })}
      </Group>
    </>
  );
}

function Field({ label, note, noteColor, children }: { label: string; note?: string | null; noteColor?: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="label">{label}</Text>
      {children}
      {note ? (
        <Text variant="caption" color={noteColor}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bold: { fontWeight: "600" },
  dials: { borderRadius: radius.lg, padding: space.lg, gap: space.lg },
  check: { width: 24, alignItems: "center" },
  body: { padding: space.lg, gap: space.xl },
  headerButton: { paddingHorizontal: space.md, height: 36, justifyContent: "center" },
  field: { gap: space.sm },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  long: { textAlignVertical: "top" },
  items: { gap: space.sm },
  itemRow: { flexDirection: "row", alignItems: "flex-start", gap: space.sm },
  iconButton: { minWidth: 36, height: 44, alignItems: "center", justifyContent: "center" },
  presets: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  preset: { borderRadius: radius.pill, paddingHorizontal: space.lg, paddingVertical: space.sm },
});
