/**
 * Instagram: research through the owner's own Business or Creator account.
 *
 * Instagram's API only answers a professional account linked to a Facebook
 * Page, through a Meta app the owner creates. The steps are shown inline;
 * the owner pastes the app's ID and secret and a token from Graph API
 * Explorer, and the orchestrator keeps a Page token that doesn't expire.
 * Then they choose who researches. Interns only ever read.
 */
import { useFocusEffect } from "expo-router";
import React, { useCallback, useState } from "react";
import { Alert, Linking, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { InstagramConnector, Intern } from "../../src/api";
import { useSettings } from "../../src/settings";
import { radius, scaledFont, space, useAppTheme } from "../../src/theme";
import { relativeTime } from "../../src/time";
import { Button } from "../../src/ui/Button";
import { BrandLogo } from "../../src/ui/BrandLogo";
import { Group, Row, Switch } from "../../src/ui/Grouped";
import { EmptyState, ErrorNote, Loading, Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

const META_APPS = "https://developers.facebook.com/apps";
const GRAPH_EXPLORER = "https://developers.facebook.com/tools/explorer";
const PERMISSIONS = ["instagram_basic", "pages_show_list", "pages_read_engagement", "instagram_manage_insights", "business_management"];

/** How the connection is doing, in a few words. */
function accountState(i: InstagramConnector): { text: string; bad: boolean } {
  if (i.check && !i.check.ok) return { text: i.check.error ?? "Not working", bad: true };
  const token = i.token_expires_at ? `token valid until ${new Date(i.token_expires_at).toLocaleDateString()}` : "token doesn't expire";
  if (i.check?.ok) return { text: `Working · ${i.check.followers ?? 0} followers · checked ${relativeTime(i.check.at)}`, bad: false };
  return { text: [i.account?.page ? `Page: ${i.account.page}` : null, token].filter(Boolean).join(" · "), bad: false };
}

export default function InstagramConnectorScreen() {
  const { api, configured } = useSettings();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const [instagram, setInstagram] = useState<InstagramConnector | null>(null);
  const [crew, setCrew] = useState<Intern[]>([]);
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    Promise.all([api.instagramConnector(), api.listInterns()]).then(
      ([i, interns]) => (setInstagram(i), setCrew(interns.filter((x) => x.slug !== "coordinator")), setError(null)),
      (e) => setError(e),
    );
  }, [api]);
  useFocusEffect(
    useCallback(() => {
      if (configured) load();
    }, [configured, load]),
  );

  const run = async (key: string, fn: () => Promise<InstagramConnector | void>) => {
    setBusy(key);
    setError(null);
    try {
      const next = await fn();
      if (next) setInstagram(next);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  if (!configured) return <Screen><EmptyState title="Not connected" body="Add your API token in Settings › Connection." /></Screen>;
  if (!instagram) return <Screen>{error ? <EmptyState title="Couldn't load Instagram"><ErrorNote error={error} onRetry={load} /></EmptyState> : <Loading />}</Screen>;

  const disconnect = () => {
    const what = "Research stops and the saved tokens are deleted. Interns keep the tool, so connecting again gives it back to them.";
    const doIt = () => void run("disconnect", () => api.disconnectInstagram());
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(`Disconnect Instagram?\n\n${what}`)) doIt();
      return;
    }
    Alert.alert("Disconnect Instagram?", what, [
      { text: "Keep", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: doIt },
    ]);
  };
  const check = () =>
    run("check", async () => {
      const result = await api.checkInstagram();
      return { ...instagram, check: result };
    });

  const state = accountState(instagram);
  const using = new Set(instagram.used_by.map((u) => u.slug));
  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxl }]} keyboardShouldPersistTaps="handled">
        {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}

        {!instagram.connected || reconnecting ? (
          <ConnectInstagram
            reconnect={instagram.connected ? instagram : null}
            onConnected={(next) => (setInstagram(next), setReconnecting(false))}
            onCancel={instagram.connected ? () => setReconnecting(false) : undefined}
          />
        ) : (
          <>
            <Group title="Account" footer="Interns research through this account. Instagram only shows them public business and creator accounts, and hashtags.">
              <Row
                icon={<BrandLogo brand="instagram" size={24} />}
                label={`@${instagram.account?.username ?? ""}`}
                detail={state.text}
                value={busy === "check" ? "Checking…" : "Check"}
                onPress={busy ? undefined : () => void check()}
              />
              {state.bad ? (
                <Text variant="caption" color={colors.action} style={styles.inset}>
                  Connect again below with a fresh token.
                </Text>
              ) : null}
            </Group>

            {instagram.missing.length ? (
              <View style={[styles.banner, { borderColor: colors.action }]}>
                <Text variant="subtle" color={colors.action}>
                  The token is missing {instagram.missing.join(", ")}.{" "}
                  {instagram.missing.includes("instagram_manage_insights") ? "Profile lookups won't work without it. " : ""}
                  Connect again with a token that has it.
                </Text>
              </View>
            ) : null}

            <Group
              title="Who researches"
              footer="They get the Instagram research tool. Instagram allows 30 different hashtags a week for the whole crew; searching one again is free."
            >
              {crew.map((intern) => {
                const on = using.has(intern.slug);
                return (
                  <Row
                    key={intern.slug}
                    label={intern.name}
                    detail={intern.role}
                    right={<Switch label={`${intern.name} researches Instagram`} value={on} disabled={busy !== null} onChange={(next) => void run("crew", () => api.updateInstagram({ [intern.slug]: next }))} />}
                  />
                );
              })}
            </Group>

            {instagram.acting.length ? (
              <Text variant="caption">
                This token could also act on @{instagram.account?.username} ({instagram.acting.join(", ")}). Research never uses those permissions; leave them out next time you connect if you don't need them for anything else.
              </Text>
            ) : null}

            <Group>
              <Row label="Connect again" detail="A new token, another account, or a reset app secret" onPress={() => setReconnecting(true)} />
              <Row label="Disconnect Instagram…" destructive onPress={disconnect} />
            </Group>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function ConnectInstagram({
  reconnect,
  onConnected,
  onCancel,
}: {
  /** the current connection when connecting again: its app is prefilled and its secret may stay */
  reconnect: InstagramConnector | null;
  onConnected: (next: InstagramConnector) => void;
  onCancel?: () => void;
}) {
  const { api } = useSettings();
  const { colors, fontScale } = useAppTheme();
  const [appId, setAppId] = useState(reconnect?.app_id ?? "");
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const keepSecret = Boolean(reconnect?.app_id && reconnect.app_id === appId.trim());

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      onConnected(
        await api.connectInstagram({
          app_id: appId.trim(),
          token: token.trim(),
          ...(secret.trim() ? { app_secret: secret.trim() } : {}),
          ...(username.trim() ? { username: username.trim() } : {}),
        }),
      );
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const input = [styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale) }];
  const steps = [
    "Switch your Instagram account to Creator or Business (Settings › Account type and tools). It has to be public; you can hide the category and contact buttons.",
    "Link it to a Facebook Page: in Instagram, Edit profile › Page. A new, empty Page is fine.",
    "Create an app on Meta for Developers (use case “Other”, type Business) and add the Instagram product. Easiest on a computer.",
    `In Graph API Explorer, pick your app, choose User Token, add ${PERMISSIONS.join(", ")}, then Generate Access Token. Select your Page and Instagram account when asked.`,
    "Paste the App ID and App secret (App settings › Basic) and the token below.",
  ];
  return (
    <Group
      title={reconnect ? "Connect again" : "Connect Instagram"}
      footer="Research only: interns look up public business and creator accounts and hashtags. Nothing is posted, liked or sent. The tokens stay on your server; the short-lived token you paste is swapped for one that doesn't expire."
    >
      <View style={styles.panel}>
        {reconnect ? null : (
          <>
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
            <View style={styles.buttons}>
              <Button label="Meta for Developers" tone="neutral" small onPress={() => void Linking.openURL(META_APPS)} />
              <Button label="Graph API Explorer" tone="neutral" small onPress={() => void Linking.openURL(GRAPH_EXPLORER)} />
            </View>
          </>
        )}
        {reconnect ? (
          <Text variant="subtle">
            Generate a new token in Graph API Explorer with {PERMISSIONS.join(", ")}.{" "}
            <Text variant="subtle" color={colors.info} onPress={() => void Linking.openURL(GRAPH_EXPLORER)}>
              Open Graph API Explorer
            </Text>
          </Text>
        ) : null}

        <Text variant="label">App ID</Text>
        <TextInput value={appId} onChangeText={setAppId} placeholder="1234567890123456" placeholderTextColor={colors.textFaint} keyboardType="number-pad" autoCapitalize="none" autoCorrect={false} style={input} accessibilityLabel="App ID" />
        <Text variant="label">App secret</Text>
        <TextInput
          value={secret}
          onChangeText={setSecret}
          placeholder={keepSecret ? "Leave empty to keep the saved secret" : "32 letters and digits"}
          placeholderTextColor={colors.textFaint}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          style={input}
          accessibilityLabel="App secret"
        />
        <Text variant="label">Access token</Text>
        <TextInput value={token} onChangeText={setToken} placeholder="EAA…" placeholderTextColor={colors.textFaint} secureTextEntry autoCapitalize="none" autoCorrect={false} style={input} accessibilityLabel="Access token" />
        <Text variant="label">Instagram account (optional)</Text>
        <TextInput value={username} onChangeText={setUsername} placeholder="@yourname" placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} style={input} accessibilityLabel="Instagram account" />
        <Text variant="caption">Only needed if your Facebook manages more than one Instagram account.</Text>

        {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}
        <Button label="Connect" tone="primary" busy={busy} disabled={!appId.trim() || !token.trim() || (!secret.trim() && !keepSecret)} onPress={() => void connect()} />
        {onCancel ? <Button label="Cancel" tone="neutral" onPress={onCancel} /> : null}
      </View>
    </Group>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.xl },
  flex: { flex: 1 },
  inset: { paddingHorizontal: space.lg, paddingBottom: space.md },
  banner: { borderWidth: 1, borderRadius: radius.md, padding: space.md },
  panel: { padding: space.lg, gap: space.md },
  step: { flexDirection: "row", gap: space.sm },
  stepNo: { width: 18, fontWeight: "700" },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
});
