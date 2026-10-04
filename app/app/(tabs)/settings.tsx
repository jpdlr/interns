/**
 * Where the app is pointed at an orchestrator. Nothing here is baked into
 * the bundle: the same build works against localhost during development and
 * a Tailscale address from the phone.
 */
import { useFocusEffect, useRouter, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { ApiError, createApi, type ConnectorsOverview, type Intern, type NotifySettings } from "../../src/api";
import { NOTIFY_INFO } from "../../src/internFile";
import { friendlyError } from "../../src/errors";
import { useLive } from "../../src/live";
import { useCoordinatorName } from "../../src/owner";
import { usePushNotifications } from "../../src/push";
import { DEFAULT_BASE_URL, useSettings } from "../../src/settings";
import { radius, scaledFont, space, useAppTheme, type TextSize, type ThemeMode } from "../../src/theme";
import { Button } from "../../src/ui/Button";
import { ConnectionPill } from "../../src/ui/ConnectionPill";
import { cachedOverview, githubSummary, googlePhotosSummary, instagramSummary, outlookSummary, rememberOverview } from "../../src/ui/ConnectorCard";
import { Group, Row, Segmented, Switch } from "../../src/ui/Grouped";
import { BrandLogo } from "../../src/ui/BrandLogo";
import { BulbIcon, CheckIcon } from "../../src/ui/Icons";
import { ErrorNote, Screen, ScreenTitle } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; interns: number; openCards: number }
  | { kind: "error"; message: string };


/**
 * On-device layout readout. The standalone tab bar measured ~150px tall on
 * JP's iPhone when it should be 49 + the home-indicator inset, and headless
 * emulation has never reproduced it — so measure the real thing instead of
 * guessing a fourth fix.
 */
function LayoutDiagnostics(): React.ReactElement | null {
  const [lines, setLines] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const { colors } = useAppTheme();
  useEffect(() => {
    if (!open || Platform.OS !== "web" || typeof window === "undefined") return;
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;" +
      "padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)";
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const root = document.getElementById("root");
    // react-navigation renders the bar as the last direct child of the screen container
    // Measure the real bar, not a wrapper: the first heuristic picked an outer
    // container whose box did reach 812, which hid the fact that the visible bar
    // stopped short of it.
    const bar = document.querySelector('[role="tablist"]') as HTMLElement | null;
    const barRect = bar?.getBoundingClientRect();
    // Which shell is actually running? An installed PWA can sit on a cached
    // index.html for a long time, which makes a deployed CSS fix look like a
    // no-op. The marker below is bumped by hand whenever the tab-bar CSS changes.
    const shellMarker = getComputedStyle(document.documentElement).getPropertyValue("--interns-shell").trim();
    setLines([
      `shell: ${shellMarker || "pre-marker (stale cache)"}`,
      `display-mode: ${window.matchMedia("(display-mode: standalone)").matches ? "standalone" : "browser"}`,
      `innerHeight ${window.innerHeight} · clientHeight ${document.documentElement.clientHeight}`,
      `visualViewport ${Math.round(window.visualViewport?.height ?? 0)} @ off ${Math.round(window.visualViewport?.offsetTop ?? 0)}`,
      `env inset top ${cs.paddingTop} · bottom ${cs.paddingBottom}`,
      `#root height ${root ? Math.round(root.getBoundingClientRect().height) : "?"}`,
      barRect
        ? `tabbar h ${Math.round(barRect.height)} · top ${Math.round(barRect.top)} · bottom ${Math.round(barRect.bottom)}`
        : "tabbar: not identified",
    ]);
    probe.remove();
  }, [open]);
  if (Platform.OS !== "web") return null;
  return (
    <View>
      <Row label={open ? "Hide layout diagnostics" : "Layout diagnostics"} onPress={() => setOpen((v) => !v)} accessibilityLabel="Layout diagnostics" />
      {open ? (
        <View style={styles.inset}>
          {lines.map((l) => (
            <Text key={l} variant="caption" selectable>
              {l}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const [suggesting, setSuggesting] = useState(false);
  const [suggestNote, setSuggestNote] = useState<string | null>(null);
  const askSuggestions = async () => {
    setSuggesting(true);
    setSuggestNote(null);
    try {
      // The pass takes a minute or more; the server answers at once and we poll.
      let status = await api.runSuggestions();
      const startedAt = status.started_at;
      setSuggestNote("The coordinator is reading the last two weeks… this takes a minute or two.");
      while (status.running) {
        await new Promise((r) => setTimeout(r, 3000));
        status = await api.getSuggestStatus();
      }
      const last = status.last;
      if (!last || (startedAt && status.finished_at && status.finished_at < startedAt)) {
        setSuggestNote("The pass did not run.");
        return;
      }
      if (last.error) {
        setSuggestNote(`The pass failed: ${last.error}`);
        return;
      }
      const es = last.evidence_summary;
      const summary = `Looked at ${es.jp_messages ?? 0} of your messages over ${es.window_days ?? 14} days.`;
      if (last.created === 0) {
        setSuggestNote(`${summary} Nothing worth suggesting right now${last.skipped.length ? ` (${last.skipped.length} idea${last.skipped.length === 1 ? "" : "s"} already decided)` : ""}.`);
      } else {
        setSuggestNote(`${summary} ${last.created} suggestion${last.created === 1 ? "" : "s"} added to Today.`);
        router.push("/today" as never);
      }
    } catch (e) {
      setSuggestNote(friendlyError(e).message);
    } finally {
      setSuggesting(false);
    }
  };
  const { colors, mode, scheme, setMode, textSize, setTextSize } = useAppTheme();
  const { settings, ready, save, api, configured } = useSettings();
  const { status, detail } = useLive();
  const pushNotifications = usePushNotifications(api);
  const params = useLocalSearchParams<{ tab?: string }>();
  const coordinator = useCoordinatorName();

  const [baseUrl, setBaseUrl] = useState(settings.baseUrl);
  const [token, setToken] = useState(settings.token);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [saved, setSaved] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // The token editor is folded away once connected; nothing works until it is set.
  const [editingToken, setEditingToken] = useState(params.tab === "connect" || params.tab === "connection");

  useEffect(() => {
    if (params.tab === "connect" || params.tab === "connection") setEditingToken(true);
  }, [params.tab]);

  useEffect(() => {
    if (ready) {
      setBaseUrl(settings.baseUrl);
      setToken(settings.token);
    }
  }, [ready, settings.baseUrl, settings.token]);

  const dirty = baseUrl !== settings.baseUrl || token !== settings.token;
  const showEditor = editingToken || (ready && !configured);

  const onSave = async () => {
    await save({ baseUrl: baseUrl.trim(), token: token.trim() });
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
    // Saving is when JP wants to know it worked; don't make it a second tap.
    void onTest();
  };

  const onTest = async () => {
    setTest({ kind: "testing" });
    try {
      // Test what is typed, not what is saved, so a bad edit is caught first.
      const result = await createApi({ baseUrl: baseUrl.trim(), token: token.trim() }).ping();
      setTest({ kind: "ok", ...result });
    } catch (e) {
      setTest({
        kind: "error",
        message:
          e instanceof ApiError && e.isAuth
            ? "Reached the orchestrator, but it rejected this token. Copy api_token again from its config."
            : friendlyError(e).message,
      });
    }
  };

  const liveWords =
    status === "live" ? "Live" : status === "polling" ? "Every 10 seconds" : status === "connecting" ? "Connecting…" : configured ? "Retrying" : "Not connected";
  const liveFooter =
    status === "polling"
      ? "Instant updates aren't getting through, so the app checks every 10 seconds. It switches back on its own."
      : status !== "live" && configured
        ? "The app keeps retrying in the background."
        : undefined;

  const connectionEditor = (
    <View style={styles.editor}>
      <Field
        label="Access token"
        value={token}
        onChangeText={setToken}
        placeholder="Paste api_token"
        hint="It's the api_token value in ~/.interns/config.json on the orchestrator machine. Stored only on this device."
        autoCapitalize="none"
        secureTextEntry
      />
      {showAdvanced || baseUrl !== DEFAULT_BASE_URL ? (
        <Field
          label="Server address"
          value={baseUrl}
          onChangeText={setBaseUrl}
          placeholder={DEFAULT_BASE_URL}
          hint="Leave as is: the app talks to the server it was opened from. Change it only when developing against another orchestrator."
          autoCapitalize="none"
          keyboardType="url"
        />
      ) : (
        <Pressable onPress={() => setShowAdvanced(true)} accessibilityRole="button" hitSlop={8} style={styles.advanced}>
          <Text variant="caption">Advanced: use a different server…</Text>
        </Pressable>
      )}
      <View style={styles.actions}>
        <Button label={saved ? "Saved" : "Save"} tone="primary" small disabled={!dirty && !saved} onPress={() => void onSave()} />
        <Button label="Test connection" tone="neutral" small busy={test.kind === "testing"} onPress={() => void onTest()} />
        {configured ? <Button label="Done" tone="ghost" small onPress={() => setEditingToken(false)} /> : null}
      </View>
      {test.kind === "ok" ? (
        <Text variant="subtle" color={colors.success}>
          Connected — {test.interns} intern{test.interns === 1 ? "" : "s"}, {test.openCards} open card{test.openCards === 1 ? "" : "s"}.
        </Text>
      ) : null}
      {test.kind === "error" ? (
        <Text variant="subtle" color={colors.urgent}>
          {test.message}
        </Text>
      ) : null}
    </View>
  );

  const connection = (
    <Group title="Connection" footer={showEditor ? undefined : liveFooter}>
      <Row label="Live updates" value={liveWords} detail={detail && status !== "live" ? detail : undefined} />
      {showEditor ? connectionEditor : <Row label="Access token" value={configured ? "Saved on this device" : "Not set"} onPress={() => setEditingToken(true)} />}
    </Group>
  );

  return (
    <Screen>
      <View style={styles.headerRow}>
        <ScreenTitle title="Settings" />
        <View style={styles.pill}>
          <ConnectionPill />
        </View>
      </View>

      <ScrollView contentContainerStyle={styles.body}>
        {/* Nothing else works until the token is in: put it first. */}
        {ready && !configured ? connection : null}
        {configured ? <ConnectorsGroup /> : null}

        <Group title="Appearance" footer={mode === "system" ? `Following this device · currently ${scheme}.` : undefined}>
          <Row
            label="Theme"
            right={
              <Segmented
                label="Theme"
                value={mode}
                onChange={(v) => void setMode(v)}
                options={(["system", "light", "dark"] as ThemeMode[]).map((v) => ({ value: v, label: v === "system" ? "Auto" : v[0]!.toUpperCase() + v.slice(1) }))}
              />
            }
          />
          <Row
            label="Text size"
            right={
              <Segmented
                label="Text size"
                value={textSize}
                onChange={(v) => void setTextSize(v)}
                options={(["small", "medium", "large"] as TextSize[]).map((v) => ({ value: v, label: "Aa", textStyle: { fontSize: v === "small" ? 12 : v === "medium" ? 15 : 18 } }))}
              />
            }
          />
        </Group>

        <PushGroup push={pushNotifications} />
        {configured ? <NotifyPrefs /> : null}

        <Group title="Crew" footer={suggestNote ?? undefined}>
          <Row label="Spend" detail="What the crew costs, per intern and per conversation" onPress={() => router.push("/spend" as never)} />
          <Row
            label={suggesting ? "Looking at the evidence…" : "Ask for suggestions"}
            detail={`A hire, an integration or a schedule. The ${coordinator} also looks every Monday.`}
            onPress={suggesting ? undefined : () => void askSuggestions()}
          />
        </Group>

        {ready && configured ? connection : null}

        <Group title="About" footer="Your access token is stored only on this device.">
          <Row label="Version" value={`Interns 0.1.0 · ${Platform.OS === "web" ? "web / PWA" : Platform.OS}`} />
          <LayoutDiagnostics />
        </Group>
      </ScrollView>
    </Screen>
  );
}

/** Each connector with where it stands, opening its own screen (app/connectors), and the full list. */
function ConnectorsGroup() {
  const { api } = useSettings();
  const router = useRouter();
  const [overview, setOverview] = useState<ConnectorsOverview | null>(cachedOverview);
  useFocusEffect(
    useCallback(() => {
      let live = true;
      api.connectors().then((o) => live && setOverview(rememberOverview(o)), () => {});
      return () => {
        live = false;
      };
    }, [api]),
  );
  const outlook = overview ? outlookSummary(overview.outlook) : null;
  const github = overview ? githubSummary(overview.github) : null;
  const instagram = overview ? instagramSummary(overview.instagram) : null;
  const photos = overview ? googlePhotosSummary(overview.google_photos) : null;
  return (
    <Group title="Connectors" footer="The tools your interns work in. Mail stays drafts and reviews stay proposals until you approve them.">
      <Row label="Outlook" icon={<BrandLogo brand="outlook" size={24} />} detail={outlook?.text} onPress={() => router.push("/connectors/outlook" as never)} />
      <Row label="GitHub" icon={<BrandLogo brand="github" size={24} />} detail={github?.text} onPress={() => router.push("/connectors/github" as never)} />
      <Row label="Instagram" icon={<BrandLogo brand="instagram" size={24} />} detail={instagram?.text} onPress={() => router.push("/connectors/instagram" as never)} />
      <Row label="Google Photos" icon={<BrandLogo brand="google-photos" size={24} />} detail={photos?.text} onPress={() => router.push("/connectors/google-photos" as never)} />
      <Row label="All connectors" icon={<BulbIcon size={22} />} detail="Or ask for a new one" onPress={() => router.push("/connectors" as never)} />
    </Group>
  );
}

const SUMMARY_PRESETS: { times: string[]; label: string }[] = [
  { times: ["12:30", "17:30"], label: "Lunch and end of day" },
  { times: ["17:30"], label: "End of day" },
  { times: ["08:30", "12:30", "17:30"], label: "Morning, lunch and end of day" },
  { times: [], label: "Never — I'll check the app" },
];

/**
 * When held updates arrive (summaries), quiet hours, and each intern's level
 * (orchestrator notify.ts). Each intern's row opens their notification editor.
 */
function NotifyPrefs() {
  const { colors } = useAppTheme();
  const { api } = useSettings();
  const router = useRouter();
  const [settings, setSettings] = useState<NotifySettings | null>(null);
  const [crew, setCrew] = useState<Intern[]>([]);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      Promise.all([api.getNotifySettings(), api.listInterns()]).then(
        ([s, interns]) => live && (setSettings(s), setCrew(interns)),
        (e) => live && setError(e),
      );
      return () => {
        live = false;
      };
    }, [api]),
  );

  const save = async (patch: Parameters<typeof api.patchNotifySettings>[0], optimistic: NotifySettings) => {
    const before = settings;
    setSettings(optimistic);
    setError(null);
    try {
      setSettings(await api.patchNotifySettings(patch));
    } catch (e) {
      setSettings(before);
      setError(e);
    }
  };

  if (!settings) return error ? <ErrorNote error={error} subject="notification settings" /> : null;
  const preset = SUMMARY_PRESETS.find((p) => p.times.join() === [...settings.summary_times].sort().join());
  const summaryLabel = preset?.label ?? settings.summary_times.join(", ");
  return (
    <>
      <Group title="Summaries" footer="Updates that don't need you right away are collected and sent as one notification.">
        <Row label="Send a summary" value={choosing ? "Done" : summaryLabel} onPress={() => setChoosing((v) => !v)} />
        {choosing
          ? SUMMARY_PRESETS.map((p) => {
              const on = p === preset;
              return (
                <Row
                  key={p.label}
                  label={p.label}
                  detail={p.times.length ? p.times.join(" · ") : "Held updates just wait in the app"}
                  onPress={() => void save({ summary_times: p.times }, { ...settings, summary_times: p.times })}
                  accessibilityLabel={`${p.label}${on ? ", selected" : ""}`}
                  right={<View style={styles.check}>{on ? <CheckIcon size={20} color={colors.accent} /> : null}</View>}
                />
              );
            })
          : null}
        <Row
          label="Quiet hours"
          detail={`${settings.quiet.from}–${settings.quiet.to}: only urgent problems buzz; the rest arrives as one summary at ${settings.quiet.to}.`}
          right={
            <Switch
              label="Quiet hours"
              value={settings.quiet.enabled}
              onChange={(enabled) => void save({ quiet: { enabled } }, { ...settings, quiet: { ...settings.quiet, enabled } })}
            />
          }
        />
      </Group>
      {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}
      {crew.length ? (
        <Group title="From each intern" footer="When they need you: replies, questions and decisions buzz; everything else waits for your summary.">
          {crew.map((intern) => (
            <Row
              key={intern.slug}
              label={intern.name}
              value={NOTIFY_INFO[intern.notify ?? "needs_you"].label}
              onPress={() => router.push(`/intern/${intern.slug}/edit?section=notify` as never)}
            />
          ))}
        </Group>
      ) : null}
    </>
  );
}

/**
 * Card cries/messages ring JP's lock screen only once this is on — see
 * app/README.md for why iOS demands a home-screen install first.
 */
function PushGroup({ push }: { push: ReturnType<typeof usePushNotifications> }) {
  const { colors } = useAppTheme();
  const { state, serverStatus, testResult, subscribe, unsubscribe, test } = push;
  const health = serverStatus
    ? `${serverStatus.configured ? "Server ready" : "Push isn't set up on the orchestrator yet"} · ${serverStatus.subscriptions} device${serverStatus.subscriptions === 1 ? "" : "s"} subscribed.`
    : undefined;
  const testLine = testResult
    ? testResult.subscriptions === 0
      ? "No subscribed devices are registered with the orchestrator."
      : testResult.sent > 0 && testResult.failed === 0
        ? `Test delivered to ${testResult.sent} device${testResult.sent === 1 ? "" : "s"}.`
        : `Test failed: ${testResult.failed} failed, ${testResult.sent} sent.${testResult.errors[0] ? ` ${testResult.errors[0]}` : ""}`
    : undefined;

  let value: string | undefined;
  let footer: string | undefined;
  switch (state.kind) {
    case "checking":
      value = "Checking…";
      break;
    case "not-installed":
      value = "Install the app first";
      footer =
        "Safari can't show notifications. Share (the box with the up arrow) → Add to Home Screen → open Interns from the new icon, then come back here. iOS 16.4+ only notifies installed apps.";
      break;
    case "unsupported":
      value = "Not available";
      footer = state.reason;
      break;
    case "denied":
      value = "Blocked";
      footer = "iOS Settings → Notifications → Interns → Allow Notifications (or Safari → Advanced → Website Data if it still shows there), then reload this page.";
      break;
    case "ready":
      footer = ["Cards and intern messages won't reach your lock screen until this is on.", health].filter(Boolean).join(" ");
      break;
    case "subscribed":
      footer = [testLine, health].filter(Boolean).join(" ");
      break;
    case "busy":
      value = "Working…";
      break;
    case "error":
      value = "Error";
      footer = state.message;
      break;
  }
  const canToggle = state.kind === "ready" || state.kind === "subscribed" || state.kind === "busy";
  return (
    <Group title="Notifications" footer={footer || undefined}>
      <Row
        label="Lock screen notifications"
        value={canToggle ? undefined : value}
        right={
          canToggle ? (
            <Switch
              label="Lock screen notifications"
              value={state.kind === "subscribed"}
              disabled={state.kind === "busy"}
              onChange={(on) => void (on ? subscribe() : unsubscribe())}
            />
          ) : undefined
        }
      />
      {state.kind === "subscribed" ? <Row label="Send a test" onPress={() => void test()} /> : null}
      {state.kind === "error" ? (
        <Text variant="caption" color={colors.urgent} style={styles.inset}>
          {state.message}
        </Text>
      ) : null}
    </Group>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  hint?: string;
  autoCapitalize?: "none" | "sentences";
  secureTextEntry?: boolean;
  keyboardType?: "default" | "url";
}

function Field({ label, hint, ...input }: FieldProps) {
  const { colors, fontScale } = useAppTheme();
  return (
    <View style={styles.field}>
      <Text variant="subtle">{label}</Text>
      <TextInput
        {...input}
        autoCorrect={false}
        placeholderTextColor={colors.textFaint}
        style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale) }]}
      />
      {hint ? <Text variant="caption">{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pill: { paddingRight: space.xl, paddingTop: space.lg },
  // No safe-area inset here: the tab bar already covers the home indicator.
  body: { paddingHorizontal: space.lg, paddingTop: space.lg, paddingBottom: space.xxl, gap: space.xl },
  editor: { padding: space.lg, gap: space.md },
  inset: { paddingHorizontal: space.lg, paddingBottom: space.md, gap: 2 },
  check: { width: 24, alignItems: "center" },
  field: { gap: space.xs },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    fontSize: 16,
  },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  advanced: { alignSelf: "flex-start" },
});
