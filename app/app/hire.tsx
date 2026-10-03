/**
 * Hiring, in the app. JP describes a need in his own words, the Chaos
 * Coordinator expands it into a full manifest (an LLM call — hence the wait
 * state), and JP edits anything he likes before committing.
 *
 * POST /hire drafts and writes nothing; POST /hire/confirm is the one that
 * creates the intern on disk and announces it, so it only fires from the Hire
 * button on a draft JP has actually seen.
 */
import { describeCron } from "../src/schedule";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CapabilityRequirement, InternManifest } from "../src/api";
import { nameConflict, useCrew } from "../src/crew";
import { shortTokens, TOOL_INFO, wordCount } from "../src/internFile";
import { useConfirmDiscard } from "../src/nav";
import { describeMentions, useNameCarry, type ProseField } from "../src/rename";
import { useSettings } from "../src/settings";
import { radius, scaledFont, space, useAppTheme } from "../src/theme";
import { Button } from "../src/ui/Button";
import { FacePicker } from "../src/ui/FacePicker";
import { Group, Row, Switch } from "../src/ui/Grouped";
import { TrashIcon } from "../src/ui/Icons";
import { SchedulePicker } from "../src/ui/SchedulePicker";
import { Flash, GrowingInput } from "../src/ui/GrowingInput";
import { InternFace, resolveFaceId } from "../src/ui/InternFace";
import { EmptyState, ErrorNote, Screen } from "../src/ui/Screen";
import { Text } from "../src/ui/Text";
import { ThinkingIndicator } from "../src/ui/ThinkingIndicator";

type Phase = "prompt" | "thinking" | "candidate";

/** Shown while the coordinator drafts; rotates so a long wait stays alive. */
const STATUS_LINES = [
  "Reading the job description…",
  "Sketching a personality…",
  "Checking who's already on the crew…",
  "Choosing which tools they can touch…",
  "Writing their standing orders…",
  "Drafting a starter backlog…",
  "Deciding how they'll report back…",
  "Almost ready to introduce them…",
];

const EXAMPLES = [
  "someone to watch my inbox for things I owe people",
  "a researcher who briefs me before meetings",
  "an ops watchdog for the servers",
];

export default function HireScreen() {
  const { colors, fontScale } = useAppTheme();
  const { api, configured } = useSettings();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const { role: roleParam } = useLocalSearchParams<{ role?: string }>();
  const [phase, setPhase] = useState<Phase>("prompt");
  const [roughRole, setRoughRole] = useState(typeof roleParam === "string" ? roleParam : "");
  const [draft, setDraft] = useState<InternManifest | null>(null);
  const [requiredCapabilities, setRequiredCapabilities] = useState<CapabilityRequirement[]>([]);
  const [icon, setIcon] = useState("default");
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState<"persona" | "prompt" | "schedule" | "work" | null>(null);
  const toggle = (section: NonNullable<typeof open>) => setOpen((current) => (current === section ? null : section));
  const [statusIndex, setStatusIndex] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [hiring, setHiring] = useState(false);
  const nameCarry = useNameCarry();
  const [renameNote, setRenameNote] = useState<string | null>(null);
  const [flashes, setFlashes] = useState<Partial<Record<ProseField, number>>>({});
  const { members } = useCrew();
  // A drafted candidate takes the Coordinator a minute; don't lose it to a stray back swipe.
  const allowLeave = useConfirmDiscard(phase === "candidate" && !hiring, "this candidate");

  useEffect(() => {
    if (phase !== "thinking") return;
    setStatusIndex(0);
    const timer = setInterval(() => setStatusIndex((i) => (i + 1) % STATUS_LINES.length), 3_500);
    return () => clearInterval(timer);
  }, [phase]);

  const runHire = useCallback(async () => {
    const role = roughRole.trim();
    if (role.length < 3) {
      setError("Tell me a little more than that.");
      return;
    }
    setError(null);
    setPhase("thinking");
    try {
      const { draft: next, required_capabilities } = await api.hire(role);
      nameCarry.reset();
      setRenameNote(null);
      setOpen(null);
      setDraft(next);
      setRequiredCapabilities(required_capabilities ?? []);
      // The coordinator always drafts icon "default"; give them a face
      // straight away so the candidate has a character to react to.
      setIcon(next.icon && next.icon !== "default" ? next.icon : resolveFaceId(undefined, next.name));
      setPhase("candidate");
    } catch (e) {
      setError(e);
      setPhase("prompt");
    }
  }, [api, nameCarry, roughRole]);

  // Arriving from a coordinator suggestion: the role is prefilled, so draft immediately.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !configured || typeof roleParam !== "string" || roleParam.trim().length < 3) return;
    autoStarted.current = true;
    void runHire();
  }, [configured, roleParam, runHire]);

  const nameError = draft ? nameConflict(draft.name, members) : null;

  const confirm = useCallback(async () => {
    if (!draft || nameError) return;
    if (!draft.name.trim() || !draft.role.trim() || !draft.system_prompt.trim()) {
      setError("Name, role and system prompt cannot be empty.");
      return;
    }
    setHiring(true);
    setError(null);
    try {
      const result = await api.confirmHire(draft, icon, requiredCapabilities);
      allowLeave();
      router.replace(`/chat/${result.slug}` as never);
    } catch (e) {
      setError(e);
      setHiring(false);
    }
  }, [allowLeave, api, draft, icon, nameError, requiredCapabilities, router]);

  const update = (patch: Partial<InternManifest>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  // Typing a new name rewrites it in the role, persona and system prompt too.
  const rename = (name: string) => {
    if (!draft) return;
    const { patch, changed, mentions } = nameCarry.rename(draft, name);
    setDraft({ ...draft, ...patch });
    setRenameNote(describeMentions(mentions));
    if (changed.length) {
      setFlashes((current) => ({ ...current, ...Object.fromEntries(changed.map((f) => [f, (current[f] ?? 0) + 1])) }));
    }
  };
  const editProse = (patch: Partial<InternManifest>) => {
    nameCarry.settle();
    setRenameNote(null);
    update(patch);
  };

  const faceId = useMemo(() => resolveFaceId(icon, draft?.name ?? "candidate"), [icon, draft?.name]);
  const inputStyle = (size: number, line: number) => [
    styles.input,
    { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(size, fontScale), lineHeight: scaledFont(line, fontScale) },
  ];

  return (
    <Screen>
      <Stack.Screen options={{ title: phase === "candidate" ? "Your candidate" : "Hire an intern" }} />
      {!configured ? (
        <EmptyState title="Not connected" body="Add your API token in Settings › Connection." />
      ) : (
        <View style={styles.flex}>
          <ScrollView
            contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxl }]}
            keyboardShouldPersistTaps="handled"
          >
            {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}

            {phase === "prompt" ? (
              <View style={styles.group}>
                <Text variant="display">Who do you need?</Text>
                <Text variant="subtle">
                  Describe it roughly — the Coordinator writes the job description, picks their
                  tools and drafts a personality. You get to edit all of it before anyone is hired.
                </Text>
                <TextInput
                  value={roughRole}
                  onChangeText={setRoughRole}
                  placeholder="someone to watch my inbox…"
                  placeholderTextColor={colors.textFaint}
                  style={[styles.roleInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(17, fontScale) }]}
                  multiline
                  autoFocus
                />
                <View style={styles.examples}>
                  {EXAMPLES.map((example) => (
                    <Button
                      key={example}
                      small
                      tone="neutral"
                      label={example}
                      onPress={() => setRoughRole(example)}
                    />
                  ))}
                </View>
                <Button
                  label="Find someone"
                  tone="primary"
                  full
                  disabled={roughRole.trim().length < 3}
                  onPress={() => void runHire()}
                />
              </View>
            ) : null}

            {phase === "thinking" ? (
              <View style={styles.waiting}>
                <ThinkingIndicator
                  faceId="coordinator"
                  name="The Coordinator"
                  size={72}
                  caption={STATUS_LINES[statusIndex]}
                />
                <Text variant="caption" center>
                  Drafting a manifest for “{roughRole.trim()}”. This takes a few seconds.
                </Text>
              </View>
            ) : null}

            {phase === "candidate" && draft ? (
              <View style={styles.candidate}>
                <View style={styles.candidateHead}>
                  <Pressable onPress={() => setPicking(true)} accessibilityRole="button" accessibilityLabel="Change face">
                    <InternFace id={faceId} size={88} clipToBounds />
                  </Pressable>
                  <Text variant="display" center>
                    {draft.name.trim() || "Your candidate"}
                  </Text>
                  <Text variant="subtle" center numberOfLines={2} style={styles.headRole}>
                    {draft.role}
                  </Text>
                  <Text variant="caption" center>
                    Tap the face to change it. Anything below can still be changed.
                  </Text>
                </View>

                <Group title="Who they are">
                  <View style={styles.inset}>
                    <Field
                      label="Name"
                      value={draft.name}
                      onChangeText={rename}
                      onBlur={nameCarry.settle}
                      note={nameError ?? renameNote}
                      noteColor={nameError ? colors.danger : undefined}
                    />
                    <Field label="Role" value={draft.role} onChangeText={(role) => editProse({ role })} multiline flash={flashes.role} />
                  </View>
                  <Expandable label="Personality" detail={firstLine(draft.persona) || "Not set"} open={open === "persona"} onToggle={() => toggle("persona")} flash={flashes.persona}>
                    <GrowingInput
                      value={draft.persona}
                      onChangeText={(persona) => editProse({ persona })}
                      style={inputStyle(16, 22)}
                      minHeight={FIELD_MIN_HEIGHT}
                      collapsedLines={FIELD_COLLAPSED_LINES}
                      placeholderTextColor={colors.textFaint}
                      autoFocus
                    />
                  </Expandable>
                  <Expandable label="Instructions" value={`${wordCount(draft.system_prompt)} words`} open={open === "prompt"} onToggle={() => toggle("prompt")} flash={flashes.system_prompt}>
                    <GrowingInput
                      value={draft.system_prompt}
                      onChangeText={(system_prompt) => editProse({ system_prompt })}
                      style={[inputStyle(14, 20), styles.promptInput]}
                      minHeight={PROMPT_MIN_HEIGHT}
                      collapsedLines={PROMPT_COLLAPSED_LINES}
                      autoFocus
                    />
                  </Expandable>
                </Group>

                <Group title="When they work">
                  <Expandable label="Schedule" value={describeCron(draft.triggers.cron)} open={open === "schedule"} onToggle={() => toggle("schedule")}>
                    <SchedulePicker
                      value={draft.triggers.cron ?? ""}
                      onChange={(cron) => {
                        const { cron: _old, ...rest } = draft.triggers;
                        update({ triggers: cron ? { ...rest, cron } : rest });
                      }}
                    />
                  </Expandable>
                  {draft.tools.includes("mail") ? (
                    <Row
                      label="Wake on new mail"
                      right={<Switch label="Wake on new mail" value={draft.triggers.mail_push ?? false} onChange={(mail_push) => update({ triggers: { ...draft.triggers, mail_push } })} />}
                    />
                  ) : null}
                  <Expandable
                    label="Standing work"
                    value={draft.backlog.length ? `${draft.backlog.length} item${draft.backlog.length === 1 ? "" : "s"}` : "None"}
                    open={open === "work"}
                    onToggle={() => toggle("work")}
                    flash={flashes.backlog}
                  >
                    {draft.backlog.length ? (
                      draft.backlog.map((item, i) => (
                        <View key={`${i}-${item}`} style={styles.workItem}>
                          <Text variant="subtle" color={colors.text} style={styles.flex}>
                            {item}
                          </Text>
                          <Pressable
                            onPress={() => update({ backlog: draft.backlog.filter((_, j) => j !== i) })}
                            accessibilityRole="button"
                            accessibilityLabel={`Remove “${item}”`}
                            hitSlop={8}
                          >
                            <TrashIcon size={17} color={colors.textFaint} />
                          </Pressable>
                        </View>
                      ))
                    ) : (
                      <Text variant="caption">Nothing standing — add some on their profile later.</Text>
                    )}
                  </Expandable>
                </Group>

                <Group title="What they can use" footer="Picked by the Coordinator for this job. You can change tools on their profile after hiring.">
                  {draft.tools.length ? (
                    draft.tools.map((tool) => <Row key={tool} label={TOOL_INFO[tool]?.label ?? tool} detail={TOOL_INFO[tool]?.detail} />)
                  ) : (
                    <Row label="No tools" detail="Conversation only" />
                  )}
                </Group>

                {requiredCapabilities.length ? (
                  <Group title="Needs your approval" footer="Hiring creates approval cards. Nothing is connected, installed or published automatically.">
                    {requiredCapabilities.map((capability) => (
                      <Row key={capability.id} label={TOOL_INFO[capability.id]?.label ?? capability.id} detail={capability.reason} />
                    ))}
                  </Group>
                ) : null}

                <Group title="Limits" footer="Change these on their profile after hiring.">
                  <Row label="Daily budget" value={`${shortTokens(draft.guardrails.daily_token_cap)} tokens`} />
                  <Row label="Drafts only" value={draft.guardrails.drafts_only ? "On" : "Off"} />
                </Group>

                <View style={styles.actions}>
                  <Button
                    label={`Hire ${draft.name.trim() || "them"}`}
                    tone="primary"
                    full
                    busy={hiring}
                    disabled={!!nameError}
                    onPress={() => void confirm()}
                  />
                  <Button label="Try someone else" tone="ghost" full disabled={hiring} onPress={() => void runHire()} />
                </View>
                <Text variant="caption" center>
                  Hiring writes their manifest and memory folder, and announces them in Discord.
                </Text>
              </View>
            ) : null}
          </ScrollView>
        </View>
      )}

      <FacePicker
        visible={picking}
        selected={faceId}
        onSelect={setIcon}
        onClose={() => setPicking(false)}
      />
    </Screen>
  );
}

const firstLine = (text: string) => text.split(/\n/).find((l) => l.trim())?.trim() ?? "";

/** A grouped row that opens in place to edit what it summarises. */
function Expandable({
  label,
  value,
  detail,
  open,
  onToggle,
  flash,
  children,
}: {
  label: string;
  value?: string;
  detail?: string;
  open: boolean;
  onToggle: () => void;
  /** bump to highlight (a rename just rewrote it) */
  flash?: number;
  children: React.ReactNode;
}) {
  return (
    <Flash pulse={flash ?? 0} radius={0}>
      <Row label={label} value={open ? "Done" : value} detail={open ? undefined : detail} onPress={onToggle} accessibilityLabel={open ? `Done editing ${label}` : `Edit ${label}`} />
      {open ? <View style={styles.inset}>{children}</View> : null}
    </Flash>
  );
}

function Field({
  label,
  value,
  onChangeText,
  onBlur,
  multiline,
  flash,
  note,
  noteColor,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  onBlur?: () => void;
  multiline?: boolean;
  /** bump to highlight the field (a rename just rewrote it) */
  flash?: number;
  /** a caption under the input */
  note?: string | null;
  noteColor?: string;
}) {
  const { colors, fontScale } = useAppTheme();
  const inputStyle = [
    styles.input,
    { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale), lineHeight: scaledFont(22, fontScale) },
  ];
  return (
    <View style={styles.field}>
      <Text variant="label">{label}</Text>
      <Flash pulse={flash ?? 0} radius={radius.md}>
        {multiline ? (
          <GrowingInput
            value={value}
            onChangeText={onChangeText}
            onBlur={onBlur}
            style={inputStyle}
            minHeight={FIELD_MIN_HEIGHT}
            collapsedLines={FIELD_COLLAPSED_LINES}
            placeholderTextColor={colors.textFaint}
          />
        ) : (
          <TextInput
            value={value}
            onChangeText={onChangeText}
            onBlur={onBlur}
            style={inputStyle}
            placeholderTextColor={colors.textFaint}
          />
        )}
      </Flash>
      {note ? (
        <Text variant="caption" color={noteColor}>
          {note}
        </Text>
      ) : null}
    </View>
  );
}

/** Multiline boxes: compact while reading, full height once tapped. */
const FIELD_MIN_HEIGHT = 72;
const FIELD_COLLAPSED_LINES = 4;
const PROMPT_MIN_HEIGHT = 120;
const PROMPT_COLLAPSED_LINES = 9;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  body: { padding: space.xl, gap: space.xl },
  group: { gap: space.lg },
  candidate: { gap: space.xl },
  waiting: { paddingTop: space.xxxl, gap: space.md },
  candidateHead: { alignItems: "center", gap: space.xs },
  headRole: { maxWidth: 320 },
  inset: { padding: space.lg, gap: space.md },
  workItem: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  field: { gap: space.xs },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    fontSize: 16,
  },
  promptInput: { fontSize: 14, textAlignVertical: "top" },
  roleInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: space.lg,
    fontSize: 17,
    minHeight: 96,
    textAlignVertical: "top",
  },
  examples: { gap: space.sm, alignItems: "flex-start" },
  actions: { gap: space.sm, marginTop: space.sm },
});
