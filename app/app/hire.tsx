/**
 * Hiring, in the app: build a crew member the way you'd brief a new hire.
 *
 * Start: describe the job (the coordinator drafts a full candidate — an LLM
 * call, hence the wait), open a starter, or start from scratch. Then the
 * builder: face and name, personality dials with a live sample, the job,
 * when they work, the tools they get, limits and notifications — and an
 * interview, to hear them answer before deciding. Hiring plays a short
 * welcome and opens their chat.
 *
 * POST /hire drafts and writes nothing; POST /hire/confirm creates the
 * intern and announces it, so it only fires from the Hire button on a
 * candidate the owner has seen. POST /hire/template and ?template=<id>
 * (setup) skip the model call; ?role=… (a coordinator suggestion) drafts
 * straight away.
 */
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { CapabilityRequirement, InternManifest, InternTemplate, NotifyLevel } from "../src/api";
import { nameConflict, useCrew } from "../src/crew";
import { FALLBACK_TOOLS, NOTIFY_INFO, NOTIFY_LEVELS, shortTokens, wordCount } from "../src/internFile";
import { useConfirmDiscard } from "../src/nav";
import { useCoordinatorName, useOwner } from "../src/owner";
import { describeMentions, useNameCarry, type ProseField } from "../src/rename";
import { describeCron } from "../src/schedule";
import { useSettings } from "../src/settings";
import { DEFAULT_STYLE } from "../src/style";
import { radius, scaledFont, space, useAppTheme } from "../src/theme";
import { Button } from "../src/ui/Button";
import { Group, Row, Segmented, Switch } from "../src/ui/Grouped";
import { Flash, GrowingInput } from "../src/ui/GrowingInput";
import { HiredOverlay } from "../src/ui/hire/HiredOverlay";
import { IdentityHero } from "../src/ui/hire/IdentityHero";
import { InterviewCard } from "../src/ui/hire/InterviewCard";
import { PersonalityCard } from "../src/ui/hire/PersonalityCard";
import { Section } from "../src/ui/hire/Section";
import { StarterGrid } from "../src/ui/hire/StarterGrid";
import { ToolTiles } from "../src/ui/hire/ToolTiles";
import { PlusIcon, TrashIcon } from "../src/ui/Icons";
import { resolveFaceId } from "../src/ui/InternFace";
import { SchedulePicker } from "../src/ui/SchedulePicker";
import { EmptyState, ErrorNote, Screen } from "../src/ui/Screen";
import { Text } from "../src/ui/Text";
import { useTemplates } from "../src/ui/TemplatePicker";
import { ThinkingIndicator } from "../src/ui/ThinkingIndicator";

type Phase = "start" | "thinking" | "candidate";
type Source = "ai" | "template" | "blank";

/** Shown while the coordinator drafts; rotates so a long wait stays alive. */
const STATUS_LINES = [
  "Reading the job description…",
  "Sketching a personality…",
  "Setting their dials…",
  "Checking who's already on the crew…",
  "Choosing which tools they can touch…",
  "Drafting a starter backlog…",
  "Deciding how they'll report back…",
  "Almost ready to introduce them…",
];

const EXAMPLES = ["Someone to watch my inbox for things I owe people", "A researcher who briefs me before meetings", "An ops watchdog for the servers"];
const BUDGETS = [50_000, 100_000, 200_000, 500_000, 1_000_000];
/** Granted outside the hire screen (Connectors, approval cards), so not offered as tiles. */
const MANAGED = new Set(["github", "integration.build"]);
const NOTIFY_SHORT: Record<NotifyLevel, string> = { all: "All", needs_you: "Needs you", summary: "Summary", off: "Off" };

/** Free names for a starter whose own name is already on the crew. */
const NAME_POOL = ["Wren", "Juno", "Ezra", "Lena", "Theo", "Ivy", "Sol", "Kai", "Mara", "Remy", "Nell", "Arlo"];

const BLANK: InternManifest = {
  name: "",
  role: "",
  icon: "default",
  persona: "",
  system_prompt: "",
  tools: ["cards"],
  triggers: { mentions: true },
  backlog: [],
  guardrails: { drafts_only: true, daily_token_cap: 200_000 },
  style: DEFAULT_STYLE,
};

export default function HireScreen() {
  const { colors, fontScale } = useAppTheme();
  const { api, configured } = useSettings();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const coordinator = useCoordinatorName();
  const owner = useOwner();

  const { role: roleParam, template: templateParam } = useLocalSearchParams<{ role?: string; template?: string }>();
  const { templates } = useTemplates();
  const [phase, setPhase] = useState<Phase>("start");
  const [source, setSource] = useState<Source>("ai");
  const [roughRole, setRoughRole] = useState(typeof roleParam === "string" ? roleParam : "");
  const [opening, setOpening] = useState<string | null>(null);
  const [draft, setDraft] = useState<InternManifest | null>(null);
  const [requiredCapabilities, setRequiredCapabilities] = useState<CapabilityRequirement[]>([]);
  const [icon, setIcon] = useState("default");
  const [open, setOpen] = useState<"prompt" | "schedule" | null>(null);
  const [newWork, setNewWork] = useState("");
  const [statusIndex, setStatusIndex] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const [hiring, setHiring] = useState(false);
  const [hired, setHired] = useState<{ slug: string; name: string } | null>(null);
  const [catalog, setCatalog] = useState<string[]>(FALLBACK_TOOLS);
  const [outlookConnected, setOutlookConnected] = useState<boolean | null>(null);
  const [instagramConnected, setInstagramConnected] = useState<boolean | null>(null);
  const nameCarry = useNameCarry();
  const [renameNote, setRenameNote] = useState<string | null>(null);
  const [flashes, setFlashes] = useState<Partial<Record<ProseField, number>>>({});
  const { members } = useCrew();
  // A drafted candidate takes the coordinator a minute; don't lose it to a stray back swipe.
  const allowLeave = useConfirmDiscard(phase === "candidate" && !hiring && !hired, "this candidate");

  useEffect(() => {
    if (!configured) return;
    api.getMeta().then((m) => m.tools?.length && setCatalog(m.tools), () => {});
    api.connectors().then(
      (c) => (setOutlookConnected(c.outlook.mailboxes.length > 0), setInstagramConnected(c.instagram.connected)),
      () => {},
    );
  }, [api, configured]);

  useEffect(() => {
    if (phase !== "thinking") return;
    setStatusIndex(0);
    const timer = setInterval(() => setStatusIndex((i) => (i + 1) % STATUS_LINES.length), 3_500);
    return () => clearInterval(timer);
  }, [phase]);

  const showCandidate = useCallback(
    (from: Source, { draft: next, required_capabilities }: { draft: InternManifest; required_capabilities?: CapabilityRequirement[] }) => {
      nameCarry.reset();
      setRenameNote(null);
      setOpen(null);
      setSource(from);
      let candidate: InternManifest = { ...next, style: next.style ?? DEFAULT_STYLE };
      // A starter whose name is already on the crew gets a free one, carried into its prose.
      if (from === "template" && nameConflict(candidate.name, members)) {
        const free = NAME_POOL.find((n) => !nameConflict(n, members));
        if (free) {
          const taken = candidate.name;
          candidate = { ...candidate, ...nameCarry.rename(candidate, free).patch };
          nameCarry.settle();
          setRenameNote(`${taken} is already on the crew, so this one is ${free}. Rename them if you like.`);
        }
      }
      setDraft(candidate);
      setRequiredCapabilities(required_capabilities ?? []);
      // The coordinator always drafts icon "default": give them a face straight away.
      setIcon(next.icon && next.icon !== "default" ? next.icon : resolveFaceId(undefined, next.name || "new-hire"));
      setPhase("candidate");
    },
    [members, nameCarry],
  );

  const runHire = useCallback(async () => {
    const role = roughRole.trim();
    if (role.length < 3) {
      setError("Tell me a little more than that.");
      return;
    }
    setError(null);
    setPhase("thinking");
    try {
      showCandidate("ai", await api.hire(role));
    } catch (e) {
      setError(e);
      setPhase("start");
    }
  }, [api, roughRole, showCandidate]);

  const openTemplate = useCallback(
    async (id: string) => {
      setError(null);
      setOpening(id);
      try {
        showCandidate("template", await api.hireFromTemplate(id));
      } catch (e) {
        setError(e);
      } finally {
        setOpening(null);
      }
    },
    [api, showCandidate],
  );

  // Arriving from setup (a starter) or a coordinator suggestion (a role): skip the start screen.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (autoStarted.current || !configured) return;
    if (typeof templateParam === "string" && templateParam) {
      autoStarted.current = true;
      void openTemplate(templateParam);
    } else if (typeof roleParam === "string" && roleParam.trim().length >= 3) {
      autoStarted.current = true;
      void runHire();
    }
  }, [configured, openTemplate, roleParam, runHire, templateParam]);

  const nameError = draft ? nameConflict(draft.name, members) : null;
  const update = (patch: Partial<InternManifest>) => setDraft((current) => (current ? { ...current, ...patch } : current));

  // Typing a new name rewrites it in the role, persona and instructions too.
  const rename = (name: string) => {
    if (!draft) return;
    const { patch, changed, mentions } = nameCarry.rename(draft, name);
    setDraft({ ...draft, ...patch });
    setRenameNote(describeMentions(mentions));
    if (changed.length) setFlashes((current) => ({ ...current, ...Object.fromEntries(changed.map((f) => [f, (current[f] ?? 0) + 1])) }));
  };
  const editProse = (patch: Partial<InternManifest>) => {
    nameCarry.settle();
    setRenameNote(null);
    update(patch);
  };

  const confirm = useCallback(async () => {
    if (!draft || nameError) return;
    const name = draft.name.trim();
    const role = draft.role.trim();
    if (!name || !role) {
      setError("Give them a name and say what they do.");
      return;
    }
    // A from-scratch hire may not have written instructions: start them from the role.
    const system_prompt =
      draft.system_prompt.trim() ||
      `You are ${name}, ${owner?.owner_name && owner.owner_name !== "Boss" ? `${owner.owner_name}'s` : "the owner's"} ${role}. Do the job well, report back briefly, and ask when you're unsure.`;
    setHiring(true);
    setError(null);
    try {
      const result = await api.confirmHire({ ...draft, name, role, system_prompt }, icon, requiredCapabilities);
      allowLeave();
      setHired({ slug: result.slug, name });
    } catch (e) {
      setError(e);
      setHiring(false);
    }
  }, [allowLeave, api, draft, icon, nameError, owner, requiredCapabilities]);

  const faceId = useMemo(() => resolveFaceId(icon, draft?.name || "new-hire"), [icon, draft?.name]);
  const tiles = useMemo(() => [...new Set([...catalog, ...(draft?.tools ?? [])])].filter((t) => !MANAGED.has(t)), [catalog, draft?.tools]);
  const input = [styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale) }];

  if (!configured) return <Screen><EmptyState title="Not connected" body="Add your API token in Settings › Connection." /></Screen>;

  return (
    <Screen>
      <Stack.Screen options={{ title: phase === "candidate" ? (source === "blank" ? "New crew member" : "Your candidate") : "Hire" }} />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + (phase === "candidate" ? 120 : space.xxl) }]}
        keyboardShouldPersistTaps="handled"
      >
        {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}

        {phase === "start" ? (
          <>
            <View style={styles.intro}>
              <Text variant="display">Who do you need?</Text>
              <Text variant="subtle">Describe the job, start from one of the starters, or build someone from scratch. You can change everything before they're hired.</Text>
            </View>

            <Section title="Describe the job" hint={`The ${coordinator} drafts a full candidate: personality, instructions, tools and starter work.`}>
              <TextInput
                value={roughRole}
                onChangeText={setRoughRole}
                placeholder="Someone to watch my inbox…"
                placeholderTextColor={colors.textFaint}
                multiline
                accessibilityLabel="Describe the job"
                style={[styles.describe, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(17, fontScale) }]}
              />
              <View style={styles.chips}>
                {EXAMPLES.map((example) => (
                  <Pressable key={example} onPress={() => setRoughRole(example)} accessibilityRole="button" style={({ pressed }) => [styles.chip, { borderColor: colors.border, backgroundColor: pressed ? colors.accentSoft : colors.surface }]}>
                    <Text variant="caption" color={colors.text}>
                      {example}
                    </Text>
                  </Pressable>
                ))}
              </View>
              <Button label="Draft a candidate" tone="primary" full disabled={roughRole.trim().length < 3} onPress={() => void runHire()} />
            </Section>

            {templates.length ? (
              <View style={styles.block}>
                <View style={styles.blockHead}>
                  <Text variant="label">Starters</Text>
                  <Text variant="caption">Ready-made crew members. Open one to adjust them.</Text>
                </View>
                <StarterGrid templates={templates} busyId={opening} onPick={(t: InternTemplate) => void openTemplate(t.id)} />
              </View>
            ) : null}

            <Group>
              <Row label="Start from scratch" detail="A blank crew member: you set everything." icon={<PlusIcon size={22} />} onPress={() => showCandidate("blank", { draft: BLANK })} />
            </Group>
          </>
        ) : null}

        {phase === "thinking" ? (
          <View style={styles.waiting}>
            <ThinkingIndicator faceId="coordinator" name={`The ${coordinator}`} size={72} caption={STATUS_LINES[statusIndex]} />
            <Text variant="caption" center>
              Drafting a candidate for “{roughRole.trim()}”. This takes a few seconds.
            </Text>
          </View>
        ) : null}

        {phase === "candidate" && draft ? (
          <>
            <IdentityHero
              faceId={faceId}
              onFace={setIcon}
              name={draft.name}
              onName={rename}
              onNameBlur={nameCarry.settle}
              nameNote={nameError ?? renameNote}
              nameNoteColor={nameError ? colors.danger : undefined}
              role={draft.role}
              onRole={(role) => editProse({ role })}
            />

            <Flash pulse={flashes.persona ?? 0} radius={radius.lg}>
              <PersonalityCard
                name={draft.name}
                faceId={faceId}
                style={draft.style}
                onStyle={(style) => update({ style })}
                persona={draft.persona}
                onPersona={(persona) => editProse({ persona })}
              />
            </Flash>

            <Section title="The job" hint="Their instructions, and the standing work they pick up when they're free.">
              <Pressable onPress={() => setOpen(open === "prompt" ? null : "prompt")} accessibilityRole="button" style={styles.inlineRow}>
                <Text variant="body" style={styles.flex}>
                  Instructions
                </Text>
                <Text variant="subtle">{open === "prompt" ? "Done" : draft.system_prompt.trim() ? `${wordCount(draft.system_prompt)} words` : "Write them"}</Text>
              </Pressable>
              {open === "prompt" ? (
                <Flash pulse={flashes.system_prompt ?? 0} radius={radius.md}>
                  <GrowingInput
                    value={draft.system_prompt}
                    onChangeText={(system_prompt) => editProse({ system_prompt })}
                    placeholder={`What ${draft.name.trim() || "they"} should do, how, and what to leave alone.`}
                    placeholderTextColor={colors.textFaint}
                    style={[...input, styles.prompt, { lineHeight: scaledFont(20, fontScale), fontSize: scaledFont(14, fontScale) }]}
                    minHeight={120}
                    collapsedLines={9}
                    autoFocus
                  />
                </Flash>
              ) : null}
              <View style={styles.work}>
                <Text variant="body">Starter work</Text>
                {draft.backlog.map((item, i) => (
                  <View key={`${i}-${item}`} style={styles.workItem}>
                    <Text variant="subtle" color={colors.text} style={styles.flex}>
                      {item}
                    </Text>
                    <Pressable onPress={() => update({ backlog: draft.backlog.filter((_, j) => j !== i) })} accessibilityRole="button" accessibilityLabel={`Remove “${item}”`} hitSlop={8}>
                      <TrashIcon size={17} color={colors.textFaint} />
                    </Pressable>
                  </View>
                ))}
                <View style={styles.addRow}>
                  <TextInput
                    value={newWork}
                    onChangeText={setNewWork}
                    placeholder="Add standing work…"
                    placeholderTextColor={colors.textFaint}
                    accessibilityLabel="New standing work"
                    onSubmitEditing={() => {
                      if (newWork.trim()) update({ backlog: [...draft.backlog, newWork.trim()] });
                      setNewWork("");
                    }}
                    style={[...input, styles.flex]}
                  />
                  <Button
                    label="Add"
                    small
                    tone="neutral"
                    disabled={!newWork.trim()}
                    onPress={() => {
                      update({ backlog: [...draft.backlog, newWork.trim()] });
                      setNewWork("");
                    }}
                  />
                </View>
              </View>
            </Section>

            <Section title="When they work" flush>
              <Row label="Schedule" value={open === "schedule" ? "Done" : describeCron(draft.triggers.cron)} onPress={() => setOpen(open === "schedule" ? null : "schedule")} />
              {open === "schedule" ? (
                <View style={styles.inset}>
                  <SchedulePicker
                    value={draft.triggers.cron ?? ""}
                    onChange={(cron) => {
                      const { cron: _old, ...rest } = draft.triggers;
                      update({ triggers: cron ? { ...rest, cron } : rest });
                    }}
                  />
                </View>
              ) : null}
              {draft.tools.includes("mail") ? (
                <Row label="Wake on new mail" right={<Switch label="Wake on new mail" value={draft.triggers.mail_push ?? false} onChange={(mail_push) => update({ triggers: { ...draft.triggers, mail_push } })} />} />
              ) : null}
              {draft.tools.includes("calendar") ? (
                <Row
                  label="Meeting briefs"
                  detail="A short brief before meetings with people from outside"
                  right={<Switch label="Meeting briefs" value={draft.triggers.meeting_brief ?? false} onChange={(meeting_brief) => update({ triggers: { ...draft.triggers, meeting_brief } })} />}
                />
              ) : null}
              <Row
                label="Colleagues can @mention them"
                right={<Switch label="Colleagues can @mention them" value={draft.triggers.mentions !== false} onChange={(mentions) => update({ triggers: { ...draft.triggers, mentions } })} />}
              />
            </Section>

            <Section title="Tools" hint="What they can use. Mail is always drafts-only.">
              <ToolTiles
                tools={tiles}
                selected={draft.tools}
                outlookConnected={outlookConnected}
                instagramConnected={instagramConnected}
                onToggle={(tool) => update({ tools: draft.tools.includes(tool) ? draft.tools.filter((t) => t !== tool) : [...draft.tools, tool] })}
              />
              {requiredCapabilities.length ? (
                <View style={[styles.capabilities, { borderColor: colors.border }]}>
                  <Text variant="subtle" color={colors.text} style={styles.bold}>
                    After hiring
                  </Text>
                  {requiredCapabilities.map((c) => (
                    <Text key={c.id} variant="caption">
                      {c.id === "github" ? "GitHub: pick them as the reviewer in Settings › Connectors › GitHub." : `${c.id}: ${c.reason} You'll get an approval card.`}
                    </Text>
                  ))}
                </View>
              ) : null}
            </Section>

            <Section title="Limits and notifications">
              <View style={styles.stack}>
                <Text variant="body">Daily budget</Text>
                <View style={styles.budgets}>
                  {BUDGETS.map((b) => {
                    const on = draft.guardrails.daily_token_cap === b;
                    return (
                      <Pressable
                        key={b}
                        onPress={() => update({ guardrails: { ...draft.guardrails, daily_token_cap: b } })}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: on }}
                        style={[styles.budget, { backgroundColor: on ? colors.accent : colors.surface, borderColor: on ? colors.accent : colors.border }]}
                      >
                        <Text variant="subtle" color={on ? colors.onAccent : colors.text} style={styles.bold}>
                          {shortTokens(b)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text variant="caption">Tokens a day. When they hit it, they ask before going over.</Text>
              </View>
              <View style={styles.switchRow}>
                <View style={styles.flex}>
                  <Text variant="body">Drafts only</Text>
                  <Text variant="caption">Anything going out to other people waits for you.</Text>
                </View>
                <Switch label="Drafts only" value={draft.guardrails.drafts_only} onChange={(drafts_only) => update({ guardrails: { ...draft.guardrails, drafts_only } })} />
              </View>
              <View style={styles.stack}>
                <Text variant="body">Notifications</Text>
                <Segmented<NotifyLevel>
                  label="Notifications"
                  value={draft.notify ?? "needs_you"}
                  onChange={(notify) => update({ notify })}
                  options={NOTIFY_LEVELS.map((level) => ({ value: level, label: NOTIFY_SHORT[level] }))}
                />
                <Text variant="caption">{NOTIFY_INFO[draft.notify ?? "needs_you"].detail}</Text>
              </View>
            </Section>

            <InterviewCard draft={draft} faceId={faceId} />

            <Text variant="caption" center>
              Hiring writes their file and memory folder, and introduces them to the crew.
            </Text>
          </>
        ) : null}
      </ScrollView>

      {phase === "candidate" && draft ? (
        <View style={[styles.bar, { paddingBottom: insets.bottom + space.md, backgroundColor: colors.bg, borderTopColor: colors.border }]}>
          {source === "ai" ? <Button label="Try someone else" tone="ghost" disabled={hiring} onPress={() => void runHire()} /> : null}
          <View style={styles.flex}>
            <Button label={`Hire ${draft.name.trim() || "them"}`} tone="primary" full busy={hiring} disabled={Boolean(nameError) || !draft.name.trim() || !draft.role.trim()} onPress={() => void confirm()} />
          </View>
        </View>
      ) : null}

      <HiredOverlay
        visible={Boolean(hired)}
        name={hired?.name ?? ""}
        faceId={faceId}
        onDone={() => hired && router.replace(`/chat/${hired.slug}` as never)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  bold: { fontWeight: "600" },
  body: { padding: space.lg, gap: space.xl },
  intro: { gap: space.sm },
  block: { gap: space.sm },
  blockHead: { gap: 2, paddingHorizontal: space.md },
  describe: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, padding: space.lg, minHeight: 96, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  chip: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 },
  waiting: { paddingTop: space.xxxl, gap: space.md },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  prompt: { textAlignVertical: "top" },
  inlineRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  work: { gap: space.sm },
  workItem: { flexDirection: "row", alignItems: "flex-start", gap: space.md },
  addRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  inset: { padding: space.lg },
  capabilities: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, gap: 4 },
  stack: { gap: space.sm },
  budgets: { flexDirection: "row", gap: space.xs },
  budget: { flex: 1, alignItems: "center", borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.pill, paddingVertical: space.sm },
  switchRow: { flexDirection: "row", alignItems: "center", gap: space.md },
  bar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    paddingTop: space.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
