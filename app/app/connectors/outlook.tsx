/**
 * Outlook: the mailboxes the crew can use, and adding one without a terminal.
 *
 * Adding a mailbox is Microsoft's device sign-in: name it, get a code, open
 * microsoft.com/devicelogin, sign in with that mailbox's account; this screen
 * polls and says when it's connected. Before the first one, the owner pastes
 * the client ID of their own Entra app registration (steps shown inline).
 */
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { MailboxStatus, OutlookConnector, OutlookLogin } from "../../src/api";
import { useSettings } from "../../src/settings";
import { radius, scaledFont, space, useAppTheme } from "../../src/theme";
import { relativeTime } from "../../src/time";
import { Button } from "../../src/ui/Button";
import { Group, Row, Segmented } from "../../src/ui/Grouped";
import { copyText } from "../../src/ui/Markdown";
import { EmptyState, ErrorNote, Loading, Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

const ENTRA_NEW_APP = "https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade";
type Audience = "organizations" | "common" | "consumers";
const AUDIENCE_LABEL: Record<string, string> = { organizations: "work or school accounts", common: "any Microsoft account", consumers: "personal accounts" };

/** How one mailbox is doing, in a few words. */
function mailboxState(m: MailboxStatus): { text: string; bad: boolean } {
  if (!m.signed_in) return { text: "Not signed in", bad: true };
  if ((m.check && !m.check.ok) || (m.health && m.health.failures >= 3)) return { text: "Needs signing in again", bad: true };
  if (m.check?.ok) return { text: `Working · ${m.check.unread ?? 0} unread · checked ${relativeTime(m.check.at)}`, bad: false };
  if (m.health?.last_ok_at) return { text: `Working · last read ${relativeTime(m.health.last_ok_at)}`, bad: false };
  return { text: "Connected", bad: false };
}

export default function OutlookConnectorScreen() {
  const { api, configured } = useSettings();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ add?: string }>();
  const [outlook, setOutlook] = useState<OutlookConnector | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(params.add === "1");
  /** "Sign in again" reuses the add flow with the mailbox's id, so its labels and ledger stay */
  const [reconnecting, setReconnecting] = useState<MailboxStatus | null>(null);

  const load = useCallback(() => {
    api.connectors().then(
      (o) => (setOutlook(o.outlook), setError(null)),
      (e) => setError(e),
    );
  }, [api]);
  useFocusEffect(
    useCallback(() => {
      if (configured) load();
    }, [configured, load]),
  );

  if (!configured) return <Screen><EmptyState title="Not connected" body="Add your API token in Settings › Connection." /></Screen>;
  if (!outlook) return <Screen>{error ? <EmptyState title="Couldn't load Outlook"><ErrorNote error={error} onRetry={load} /></EmptyState> : <Loading />}</Screen>;

  const pending = outlook.sessions[0];
  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxl }]} keyboardShouldPersistTaps="handled">
        {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}
        {!outlook.app.client_id ? (
          <MicrosoftAppSetup onSaved={setOutlook} />
        ) : (
          <>
            <Group
              title="Mailboxes"
              footer={
                outlook.mailboxes.length
                  ? "Interns read mail and write drafts here. Nothing is ever sent: you send drafts yourself from Outlook."
                  : "Add the mailbox your interns should work in. You can add more later, such as a second company or a shared inbox."
              }
            >
              {outlook.mailboxes.map((m) => {
                const state = mailboxState(m);
                return (
                  <View key={m.id}>
                    <Row
                      label={`${m.label}${m.default ? " · default" : ""}`}
                      detail={[m.account, state.text].filter(Boolean).join(" · ")}
                      value={open === m.id ? "Done" : undefined}
                      onPress={() => setOpen(open === m.id ? null : m.id)}
                    />
                    {state.bad && open !== m.id ? (
                      <Text variant="caption" color={colors.action} style={styles.inset}>
                        Tap to sign in again.
                      </Text>
                    ) : null}
                    {open === m.id ? (
                      <MailboxPanel
                        mailbox={m}
                        calendar={outlook.calendar_mailbox === m.id}
                        onChanged={(next) => setOutlook(next)}
                        onReconnect={() => (setOpen(null), setReconnecting(m), setAdding(true))}
                        onError={setError}
                      />
                    ) : null}
                  </View>
                );
              })}
              {!adding && !pending ? <Row label="Add a mailbox" onPress={() => setAdding(true)} /> : null}
            </Group>
            {adding || pending ? (
              <AddMailbox
                key={reconnecting?.id ?? "new"}
                resume={pending}
                reconnect={reconnecting}
                onDone={() => {
                  setAdding(false);
                  setReconnecting(null);
                  load();
                }}
              />
            ) : null}
            <Group footer={`Signs in through your app registration ${outlook.app.client_id.slice(0, 8)}… · ${AUDIENCE_LABEL[outlook.app.authority] ?? outlook.app.authority}.`}>
              <Row label="Microsoft app" value="Change" onPress={() => setOutlook({ ...outlook, app: { ...outlook.app, client_id: null } })} />
            </Group>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function MicrosoftAppSetup({ onSaved }: { onSaved: (o: OutlookConnector) => void }) {
  const { api } = useSettings();
  const { colors, fontScale } = useAppTheme();
  const [clientId, setClientId] = useState("");
  const [audience, setAudience] = useState<Audience>("organizations");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.setOutlookApp(clientId.trim(), audience));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const steps = [
    "Open Microsoft Entra › App registrations › New registration (button below).",
    "Name it “Interns”, choose who can sign in, and press Register.",
    "Under Authentication, turn on “Allow public client flows” and save.",
    "Under API permissions, add Microsoft Graph › Delegated: Mail.ReadWrite and Calendars.Read.",
    "Copy the Application (client) ID from Overview and paste it here.",
  ];
  return (
    <Group title="Set up Microsoft sign-in" footer="A one-time step: your interns sign in to Outlook through an app registration you own, so the keys never leave your Microsoft account.">
      <View style={styles.panel}>
        {steps.map((s, i) => (
          <View key={s} style={styles.step}>
            <Text variant="subtle" color={colors.text} style={styles.stepNo}>
              {i + 1}
            </Text>
            <Text variant="subtle" style={styles.flex}>
              {s}
            </Text>
          </View>
        ))}
        <Button label="Open Microsoft Entra" tone="neutral" small onPress={() => void Linking.openURL(ENTRA_NEW_APP)} />
        <Text variant="label">Application (client) ID</Text>
        <TextInput
          value={clientId}
          onChangeText={setClientId}
          placeholder="00000000-0000-0000-0000-000000000000"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale) }]}
          accessibilityLabel="Application (client) ID"
        />
        <Text variant="label">Who signs in</Text>
        <Segmented<Audience>
          label="Who signs in"
          value={audience}
          onChange={setAudience}
          options={[
            { value: "organizations", label: "Work or school" },
            { value: "common", label: "Any account" },
            { value: "consumers", label: "Personal" },
          ]}
        />
        {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}
        <Button label="Save" tone="primary" busy={busy} disabled={!clientId.trim()} onPress={() => void save()} />
      </View>
    </Group>
  );
}

function MailboxPanel({
  mailbox,
  calendar,
  onChanged,
  onReconnect,
  onError,
}: {
  mailbox: MailboxStatus;
  calendar: boolean;
  onChanged: (o: OutlookConnector) => void;
  onReconnect: () => void;
  onError: (e: unknown) => void;
}) {
  const { api } = useSettings();
  const { colors, fontScale } = useAppTheme();
  const [label, setLabel] = useState(mailbox.label);
  const [checking, setChecking] = useState(false);
  const problem = (mailbox.check && !mailbox.check.ok ? mailbox.check.error : null) ?? (mailbox.health && mailbox.health.failures ? mailbox.health.last_error : null);
  const act = async (fn: () => Promise<OutlookConnector>) => {
    try {
      onChanged(await fn());
    } catch (e) {
      onError(e);
    }
  };
  const check = async () => {
    setChecking(true);
    try {
      await api.checkMailbox(mailbox.id);
      onChanged((await api.connectors()).outlook);
    } catch (e) {
      onError(e);
    } finally {
      setChecking(false);
    }
  };
  const disconnect = () => {
    const what = `Interns stop reading ${mailbox.label}${mailbox.account ? ` (${mailbox.account})` : ""}. Its sign-in is forgotten; drafts already in Outlook stay there.`;
    const go = () => void act(() => api.removeMailbox(mailbox.id));
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(`Disconnect ${mailbox.label}?\n\n${what}`)) go();
      return;
    }
    Alert.alert(`Disconnect ${mailbox.label}?`, what, [
      { text: "Keep", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: go },
    ]);
  };
  return (
    <View style={[styles.panel, styles.panelInset]}>
      <Text variant="caption">{mailbox.used_by.length ? `Used by ${mailbox.used_by.map((u) => u.name).join(", ")}.` : "No intern with the mail tool uses it yet."}</Text>
      {problem ? (
        <Text variant="caption" color={colors.action} selectable>
          Last error: {problem}
        </Text>
      ) : null}
      <View style={styles.renameRow}>
        <TextInput
          value={label}
          onChangeText={setLabel}
          style={[styles.input, styles.flex, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale) }]}
          accessibilityLabel="Mailbox name"
        />
        <Button label="Rename" small tone="neutral" disabled={!label.trim() || label.trim() === mailbox.label} onPress={() => void act(() => api.updateMailbox(mailbox.id, { label: label.trim() }))} />
      </View>
      <View style={styles.buttons}>
        {calendar ? null : <Button label="Use its calendar" small tone="neutral" onPress={() => void act(() => api.updateMailbox(mailbox.id, { calendar: true }))} />}
        {mailbox.default ? null : <Button label="Make default" small tone="neutral" onPress={() => void act(() => api.updateMailbox(mailbox.id, { default: true }))} />}
        <Button label="Check now" small tone="neutral" busy={checking} onPress={() => void check()} />
        <Button label="Sign in again" small tone="neutral" onPress={onReconnect} />
        <Button label="Disconnect" small tone="danger" onPress={disconnect} />
      </View>
      {calendar ? <Text variant="caption">Today and meeting briefs use this mailbox's calendar.</Text> : null}
    </View>
  );
}

/** Name → code → waiting → connected. Polls the sign-in until Microsoft says yes. */
function AddMailbox({ resume, reconnect, onDone }: { resume?: OutlookLogin; reconnect: MailboxStatus | null; onDone: () => void }) {
  const { api } = useSettings();
  const { colors, fontScale } = useAppTheme();
  const [label, setLabel] = useState(reconnect?.label ?? "");
  const [login, setLogin] = useState<OutlookLogin | null>(resume ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setLogin(await api.startOutlookLogin(label.trim() || "Outlook", reconnect?.id));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!login || login.state !== "waiting") return;
    timer.current = setInterval(() => {
      api.outlookLogin(login.id).then(setLogin, () => {});
    }, 2000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
  }, [api, login?.id, login?.state]); // eslint-disable-line react-hooks/exhaustive-deps

  const finish = onDone;
  const cancel = () => {
    if (login?.state === "waiting") void api.cancelOutlookLogin(login.id);
    finish();
  };

  if (login?.state === "connected") {
    return (
      <Group title={login.label}>
        <View style={styles.panel}>
          <Text variant="body">Connected{login.account ? ` as ${login.account}` : ""}.</Text>
          <Text variant="subtle">Interns with the mail tool can use it now. Choose who on each intern's profile, under Mailboxes.</Text>
          <Button label="Done" tone="primary" onPress={finish} />
        </View>
      </Group>
    );
  }

  if (login && login.state === "waiting") {
    return (
      <Group title={`Sign in to ${login.label}`} footer="Use the account of the mailbox you're adding. This page updates by itself once you're signed in.">
        <View style={styles.panel}>
          <Text variant="subtle">Enter this code at {login.verification_uri.replace(/^https?:\/\//, "")}:</Text>
          <Text selectable style={[styles.code, { color: colors.text, fontSize: scaledFont(32, fontScale) }]} accessibilityLabel={`Code ${login.user_code.split("").join(" ")}`}>
            {login.user_code}
          </Text>
          <View style={styles.buttons}>
            <Button
              label={copied ? "Copied" : "Copy code"}
              tone="neutral"
              onPress={() => void copyText(login.user_code).then((ok) => ok && setCopied(true))}
            />
            <Button
              label="Open Microsoft sign-in"
              tone="primary"
              onPress={() => {
                void copyText(login.user_code).then((ok) => ok && setCopied(true));
                void Linking.openURL(login.verification_uri);
              }}
            />
          </View>
          <View style={styles.waiting}>
            <ActivityIndicator color={colors.textDim} />
            <Text variant="caption">Waiting for you to sign in… the code works until {new Date(login.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</Text>
          </View>
          <Pressable onPress={cancel} accessibilityRole="button" hitSlop={8}>
            <Text variant="caption">Cancel</Text>
          </Pressable>
        </View>
      </Group>
    );
  }

  return (
    <Group title={reconnect ? `Sign in to ${reconnect.label} again` : "Add a mailbox"}>
      <View style={styles.panel}>
        {login && (login.state === "failed" || login.state === "cancelled") ? (
          <Text variant="subtle" color={colors.urgent}>
            {login.state === "cancelled" ? "Cancelled." : `That didn't work: ${login.error ?? "sign-in failed"}`}
          </Text>
        ) : null}
        {reconnect ? null : (
          <>
            <Text variant="label">Name</Text>
            <TextInput
              value={label}
              onChangeText={setLabel}
              placeholder="Work"
              placeholderTextColor={colors.textFaint}
              autoFocus
              style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale) }]}
              accessibilityLabel="Mailbox name"
              onSubmitEditing={() => void start()}
            />
            <Text variant="caption">What you and your interns call it, like “Work” or the company's name.</Text>
          </>
        )}
        {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}
        <View style={styles.buttons}>
          <Button label="Get a sign-in code" tone="primary" busy={busy} onPress={() => void start()} />
          <Button label="Cancel" tone="ghost" onPress={cancel} />
        </View>
      </View>
    </Group>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.xl },
  flex: { flex: 1 },
  inset: { paddingHorizontal: space.lg, paddingBottom: space.sm },
  panel: { padding: space.lg, gap: space.md },
  panelInset: { paddingTop: 0 },
  step: { flexDirection: "row", gap: space.sm },
  stepNo: { width: 18, fontWeight: "700" },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  renameRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  code: { fontWeight: "700", letterSpacing: 4, fontVariant: ["tabular-nums"], textAlign: "center", paddingVertical: space.sm },
  waiting: { flexDirection: "row", alignItems: "center", gap: space.sm },
});
