/**
 * An intern's profile: who they are, when they work, what they can use, and
 * their limits — as a grouped list, like iOS Settings. Each row opens a
 * focused editor (./edit?section=…) with its own Save; switches and the face
 * save the moment they change. Standing orders and pages are live lists.
 *
 * A 404 most likely means the intern was archived or renamed while this was
 * open; it is reported as such, with a way back.
 */
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { InternManifestDetail, InternManifestPatch, InternWeek, PageKind } from "../../../src/api";
import { FACE_IDS } from "../../../src/faces.generated";
import { NOTIFY_INFO, notifyStatsLine, shortTokens, TOOL_INFO, useInternFile, wordCount } from "../../../src/internFile";
import { describeCron } from "../../../src/schedule";
import { useSettings } from "../../../src/settings";
import { radius, space, useAppTheme } from "../../../src/theme";
import { ArchiveModal } from "../../../src/ui/ArchiveModal";
import { Button } from "../../../src/ui/Button";
import { FacePicker } from "../../../src/ui/FacePicker";
import { Group, Row, Switch } from "../../../src/ui/Grouped";
import { BoardIcon, ChatIcon, ListIcon, PaperclipIcon, TableIcon, UsersIcon } from "../../../src/ui/Icons";
import { InternFace, resolveFaceId } from "../../../src/ui/InternFace";
import { EmptyState, ErrorNote, Loading, Screen } from "../../../src/ui/Screen";
import { styleSummary } from "../../../src/ui/hire/PersonalityCard";
import { InternPages, StandingOrders, useInternPages } from "../../../src/ui/StandingOrders";
import { Text } from "../../../src/ui/Text";

type Section = "about" | "personality" | "instructions" | "schedule" | "work" | "tools" | "budget" | "notify" | "mailboxes";

export default function InternProfile() {
  const { colors } = useAppTheme();
  const { slug } = useLocalSearchParams<{ slug: string }>();
  const { api, ready, configured } = useSettings();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { manifest, meta, loading, notFound, error, load, patch, setManifest } = useInternFile(slug);
  const [picking, setPicking] = useState(false);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [archiving, setArchiving] = useState(false);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [archiveError, setArchiveError] = useState<unknown>(null);
  const [week, setWeek] = useState<InternWeek | null>(null);
  const pages = useInternPages(slug ?? "");
  const shortcuts = pages.filter((p) => p.kind !== "draft");
  const [gridWidth, setGridWidth] = useState(0);
  /** four equal tiles per row */
  const tileWidth = gridWidth ? Math.floor((gridWidth - 3 * space.sm) / 4) : undefined;
  /** connected mailbox labels, for the Mailboxes row */
  const [mailboxLabels, setMailboxLabels] = useState<Record<string, string> | null>(null);
  const outlookUser = Boolean(manifest && (manifest.tools.includes("mail") || manifest.tools.includes("calendar")));
  useEffect(() => {
    if (!configured || !outlookUser) return;
    let live = true;
    api.connectors().then(
      (o) => live && setMailboxLabels(Object.fromEntries(o.outlook.mailboxes.map((m) => [m.id, m.label]))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, configured, outlookUser, manifest?.mailboxes]);

  // "This week" is a nice-to-have: a failure just leaves the section out.
  useEffect(() => {
    if (!slug || !configured) return;
    let live = true;
    api.getInternWeek(slug).then((w) => live && setWeek(w), () => live && setWeek(null));
    return () => {
      live = false;
    };
  }, [api, configured, slug, manifest?.spend_today.output_tokens]);

  const open = useCallback((section: Section) => router.push(`/intern/${slug}/edit?section=${section}` as never), [router, slug]);

  /** Switches and the face: show the change at once, save it, put it back if the save fails. */
  const quickSave = useCallback(
    async (optimistic: (m: InternManifestDetail) => InternManifestDetail, p: InternManifestPatch) => {
      if (!manifest) return;
      const before = manifest;
      setManifest(optimistic(manifest));
      setSaveError(null);
      try {
        await patch(p);
      } catch (e) {
        setManifest(before);
        setSaveError(e);
      }
    },
    [manifest, patch, setManifest],
  );

  const setDraftsOnly = useCallback(
    (next: boolean) => {
      const apply = () => void quickSave((m) => ({ ...m, guardrails: { ...m.guardrails, drafts_only: next } }), { guardrails: { drafts_only: next, daily_token_cap: manifest!.guardrails.daily_token_cap } });
      if (next || !manifest) return apply();
      const what = `${manifest.name} will be able to act without your approval: send mail, run commands — whatever their tools allow.`;
      if (Platform.OS === "web" && typeof window !== "undefined") {
        if (window.confirm(`Turn off drafts only?\n\n${what}`)) apply();
        return;
      }
      Alert.alert("Turn off drafts only?", what, [
        { text: "Keep drafts only", style: "cancel" },
        { text: "Turn off", style: "destructive", onPress: apply },
      ]);
    },
    [manifest, quickSave],
  );

  const confirmArchive = useCallback(async () => {
    if (!slug) return;
    setArchiveBusy(true);
    setArchiveError(null);
    try {
      const result = await api.archiveIntern(slug);
      setArchiving(false);
      router.replace({ pathname: "/", params: { archived: result.name } });
    } catch (e) {
      setArchiveError(e);
    } finally {
      setArchiveBusy(false);
    }
  }, [api, router, slug]);

  const faceId = useMemo(() => resolveFaceId(manifest?.icon, slug ?? ""), [manifest?.icon, slug]);
  const iconIds = meta?.icons.length ? meta.icons.map((i) => i.id) : FACE_IDS;
  const iconLabels = useMemo(() => Object.fromEntries((meta?.icons ?? []).map((i) => [i.id, i.label])), [meta]);

  if (!ready) return <Loading />;
  if (!configured) return <Screen><EmptyState title="Not connected" body="Add your API token in Settings › Connection." /></Screen>;
  if (loading && !manifest) return <Screen><Loading /></Screen>;
  if (notFound) {
    return (
      <Screen>
        <EmptyState title="This intern isn't here any more" body="They may have been archived or renamed.">
          <Button label="Back to crew" tone="primary" onPress={() => router.replace("/" as never)} />
        </EmptyState>
      </Screen>
    );
  }
  if (!manifest) {
    return (
      <Screen>
        <EmptyState title="Couldn't load this profile">
          <ErrorNote error={error} onRetry={() => void load()} />
        </EmptyState>
      </Screen>
    );
  }

  const spent = manifest.spend_today.input_tokens + manifest.spend_today.output_tokens;
  const extra = manifest.budget?.extra_today ?? 0;
  const held = manifest.budget?.held ?? 0;
  const cap = manifest.guardrails.daily_token_cap + extra;
  const paused = manifest.paused ?? false;
  const used = Math.min(1, cap ? spent / cap : 0);
  const hasMail = manifest.tools.includes("mail");
  const hasCalendar = manifest.tools.includes("calendar");
  const mailboxValue = (() => {
    const connected = mailboxLabels ? Object.keys(mailboxLabels) : null;
    if (connected && connected.length === 0) return "None connected";
    if (!manifest.mailboxes) return "All";
    if (manifest.mailboxes.length === 0) return "None";
    return manifest.mailboxes.map((id) => mailboxLabels?.[id] ?? id).join(", ");
  })();
  const toolNames = manifest.tools.map((t) => TOOL_INFO[t]?.label ?? t);
  const firstLine = (text: string) => text.split(/\n/).find((l) => l.trim())?.trim() ?? "";

  return (
    <Screen>
      <Stack.Screen options={{ title: "" }} />
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxl }]}>
        <View style={styles.header}>
          <Pressable onPress={() => setPicking(true)} accessibilityRole="button" accessibilityLabel="Change face">
            <InternFace id={faceId} size={76} clipToBounds />
          </Pressable>
          <Text variant="display" center>
            {manifest.name}
          </Text>
          <Text variant="subtle" center numberOfLines={2} style={styles.role}>
            {manifest.role}
          </Text>
          {paused ? (
            <View style={[styles.pausedPill, { backgroundColor: colors.actionSoft }]}>
              <Text variant="caption" color={colors.action} style={styles.pausedText}>
                Paused
              </Text>
            </View>
          ) : null}
          {/* Chat, Files and their living pages (people, boards, tables, lists), four to a row; drafts stay in Pages below. */}
          <View style={styles.grid} onLayout={(e) => setGridWidth(e.nativeEvent.layout.width)}>
            <QuickAction width={tileWidth} label="Chat" icon={<ChatIcon size={18} color={colors.text} />} onPress={() => router.push(`/chat/${slug}` as never)} />
            <QuickAction width={tileWidth} label="Files" icon={<PaperclipIcon size={18} color={colors.text} />} onPress={() => router.push(`/files/${slug}` as never)} />
            {shortcuts.map((page) => {
              const Glyph = PAGE_GLYPH[page.kind] ?? ListIcon;
              return (
                <QuickAction
                  key={page.id}
                  width={tileWidth}
                  label={page.title}
                  icon={<Glyph size={18} color={colors.text} />}
                  onPress={() => router.push(`/page/${page.id}` as never)}
                />
              );
            })}
          </View>
          <View style={styles.budget} accessibilityLabel={`Today ${shortTokens(spent)} of ${shortTokens(cap)} tokens`}>
            <View style={[styles.bar, { backgroundColor: colors.surfaceAlt }]}>
              <View style={[styles.barFill, { width: `${Math.max(used * 100, spent ? 2 : 0)}%`, backgroundColor: used >= 0.9 ? colors.urgent : used >= 0.7 ? colors.action : colors.accent }]} />
            </View>
            <Text variant="caption" center>
              {`Today ${shortTokens(spent)} of ${shortTokens(cap)} tokens${extra ? ` (+${shortTokens(extra)} today)` : ""} · $${manifest.spend_today.cost_usd.toFixed(2)}`}
            </Text>
            {held ? (
              <Text variant="caption" center color={colors.action}>
                {`At the limit · ${held} task${held === 1 ? "" : "s"} waiting for your OK in their chat`}
              </Text>
            ) : null}
          </View>
        </View>

        {saveError ? <ErrorNote error={saveError} onDismiss={() => setSaveError(null)} /> : null}

        {week ? <ThisWeek week={week} /> : null}

        <Group title="About">
          <Row label="Name and role" value={manifest.name} onPress={() => open("about")} />
          <Row label="Personality" detail={styleSummary(manifest.style) || firstLine(manifest.persona) || "Not set"} onPress={() => open("personality")} />
          <Row label="Instructions" value={`${wordCount(manifest.system_prompt).toLocaleString()} words`} onPress={() => open("instructions")} />
        </Group>

        <Group title="When they work" footer={paused ? `Paused: no schedule, mail, meetings, reviews or standing work. ${manifest.name} still answers when you message them.` : undefined}>
          <Row
            label={`Pause ${manifest.name}`}
            detail={paused ? undefined : "Stops all automatic work until you turn it back on"}
            right={<Switch label={`Pause ${manifest.name}`} value={paused} onChange={(v) => void quickSave((m) => ({ ...m, paused: v }), { paused: v })} />}
          />
          <Row label="Schedule" value={describeCron(manifest.triggers.cron)} onPress={() => open("schedule")} />
          <Row
            label="Colleagues can @mention them"
            detail="Your own @mentions always reach them"
            right={<Switch label="Colleagues can @mention them" value={manifest.triggers.mentions !== false} onChange={(v) => void quickSave((m) => ({ ...m, triggers: { ...m.triggers, mentions: v } }), { triggers: { mentions: v } })} />}
          />
          <Row
            label="Wake on new mail"
            detail={hasMail ? undefined : "Needs the Outlook mail tool"}
            right={<Switch label="Wake on new mail" disabled={!hasMail && !manifest.triggers.mail_push} value={manifest.triggers.mail_push ?? false} onChange={(v) => void quickSave((m) => ({ ...m, triggers: { ...m.triggers, mail_push: v } }), { triggers: { mail_push: v } })} />}
          />
          {hasCalendar ? (
            <Row
              label="Meeting briefs"
              detail="A short brief before meetings with people from outside"
              right={<Switch label="Meeting briefs" value={manifest.triggers.meeting_brief ?? false} onChange={(v) => void quickSave((m) => ({ ...m, triggers: { ...m.triggers, meeting_brief: v } }), { triggers: { meeting_brief: v } })} />}
            />
          ) : null}
          <Row label="Standing work" value={manifest.backlog.length ? `${manifest.backlog.length} item${manifest.backlog.length === 1 ? "" : "s"}` : "None"} onPress={() => open("work")} />
        </Group>

        <Group title="Notifications" footer={notifyStatsLine(manifest.notify_stats)}>
          <Row label="On your phone" value={NOTIFY_INFO[manifest.notify ?? "needs_you"].label} onPress={() => open("notify")} />
        </Group>

        <Group title="What they can use">
          <Row label="Tools" value={toolNames.length <= 2 ? toolNames.join(", ") || "None" : `${toolNames.length} on`} onPress={() => open("tools")} />
          {hasMail || hasCalendar ? <Row label="Mailboxes" value={mailboxValue} onPress={() => open("mailboxes")} /> : null}
        </Group>

        <StandingOrders slug={slug!} name={manifest.name} />
        <InternPages slug={slug!} pages={pages} />

        <Group
          title="Limits"
          footer={manifest.guardrails.drafts_only ? "Drafts only: anything going out to other people waits for your approval." : "Drafts only is OFF — they can act without asking you."}
        >
          <Row label="Daily budget" value={`${shortTokens(cap)} tokens`} onPress={() => open("budget")} />
          <Row label="Drafts only" right={<Switch label="Drafts only" value={manifest.guardrails.drafts_only} onChange={setDraftsOnly} />} />
        </Group>

        <Group>
          <Row label={`Archive ${manifest.name}…`} destructive onPress={() => { setArchiveError(null); setArchiving(true); }} />
        </Group>
      </ScrollView>

      <FacePicker
        visible={picking}
        selected={faceId}
        onSelect={(icon) => void quickSave((m) => ({ ...m, icon }), { icon })}
        onClose={() => setPicking(false)}
        ids={iconIds}
        labels={iconLabels}
      />
      <ArchiveModal
        visible={archiving}
        name={manifest.name}
        slug={manifest.slug}
        busy={archiveBusy}
        error={archiveError}
        onCancel={() => !archiveBusy && setArchiving(false)}
        onConfirm={() => void confirmArchive()}
      />
    </Screen>
  );
}

/** The last seven days: a line of what they did, spend per day, and the numbers worth knowing. */
function ThisWeek({ week }: { week: InternWeek }) {
  const { colors } = useAppTheme();
  const max = Math.max(...week.days.map((d) => d.tokens), 1);
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  const pages = [week.pages_created && `${week.pages_created} new`, week.pages_updated && `${week.pages_updated} updated`].filter(Boolean).join(" · ");
  const quiet = !week.summary && !week.messages && !week.draft_count && !week.cards_raised && !week.tokens;
  return (
    <Group title="This week" footer={quiet ? undefined : `${shortTokens(week.tokens)} tokens · $${week.cost_usd.toFixed(2)} over seven days`}>
      <View style={styles.week}>
        <Text variant="body">{quiet ? "Nothing yet this week." : week.summary || "No finished work yet this week."}</Text>
        {quiet ? null : (
          <View style={styles.chart} accessibilityLabel={`Tokens per day: ${week.days.map((d) => shortTokens(d.tokens)).join(", ")}`}>
            {week.days.map((d, i) => (
              <View key={d.day} style={styles.barCol}>
                <View style={styles.barSlot}>
                  <View style={[styles.dayBar, { height: `${Math.max((d.tokens / max) * 100, d.tokens ? 4 : 0)}%`, backgroundColor: i === week.days.length - 1 ? colors.accent : colors.textFaint }]} />
                </View>
                <Text variant="caption" style={styles.dayLabel}>
                  {"SMTWTFS"[new Date(`${d.day}T12:00:00Z`).getUTCDay()]}
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
      {week.messages ? <Row label="Messages to you" value={String(week.messages)} /> : null}
      {week.draft_count ? <Row label="Drafts written" value={String(week.draft_count)} /> : null}
      {week.cards_raised ? <Row label="Asked you to decide" value={`${week.cards_raised} new${week.cards_decided ? ` · ${week.cards_decided} decided` : ""}`} /> : null}
      {pages ? <Row label="Pages" value={pages} /> : null}
      {week.failed ? <Row label="Failed" value={plural(week.failed, "task")} /> : null}
    </Group>
  );
}

const PAGE_GLYPH: Partial<Record<PageKind, typeof ListIcon>> = { people: UsersIcon, board: BoardIcon, table: TableIcon, list: ListIcon };

function QuickAction({ label, icon, onPress, width }: { label: string; icon: React.ReactNode; onPress: () => void; width?: number }) {
  const { colors } = useAppTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.quick, width ? { width } : styles.quickFallback, { backgroundColor: pressed ? colors.accentSoft : colors.surfaceAlt }]}
    >
      {icon}
      <Text variant="caption" color={colors.text} style={styles.quickLabel} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.xl },
  header: { alignItems: "center", gap: space.xs, marginTop: -space.md },
  role: { maxWidth: 320 },
  grid: { alignSelf: "stretch", flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md },
  quick: { alignItems: "center", gap: 4, paddingVertical: space.sm, paddingHorizontal: space.xs, borderRadius: radius.lg },
  /** before the grid is measured (first frame) */
  quickFallback: { width: "22%" },
  quickLabel: { fontWeight: "600" },
  budget: { alignSelf: "stretch", gap: 6, marginTop: space.md, paddingHorizontal: space.xl },
  pausedPill: { marginTop: space.xs, paddingHorizontal: space.md, paddingVertical: 3, borderRadius: radius.pill },
  pausedText: { fontWeight: "700" },
  week: { paddingHorizontal: space.lg, paddingVertical: space.md, gap: space.md },
  chart: { flexDirection: "row", alignItems: "flex-end", gap: space.sm, height: 64 },
  barCol: { flex: 1, alignItems: "center", gap: 4, height: "100%" },
  barSlot: { flex: 1, alignSelf: "stretch", justifyContent: "flex-end" },
  dayBar: { borderRadius: 3, alignSelf: "stretch" },
  dayLabel: { fontSize: 11 },
  bar: { height: 6, borderRadius: 3, overflow: "hidden" },
  barFill: { height: 6, borderRadius: 3 },
});
