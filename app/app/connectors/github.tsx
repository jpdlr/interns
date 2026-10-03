/**
 * GitHub: create the crew's GitHub App, install it, choose where reviews
 * happen and who reviews — all from here.
 *
 * "Continue to GitHub" posts a prefilled App manifest to github.com (a
 * private App that can read code and checks and propose reviews). GitHub
 * sends the browser back to the orchestrator, then to the install page, then
 * back to this screen with ?connected=1. Reviews are proposals until the
 * owner approves them on a card.
 */
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import React, { useCallback, useState } from "react";
import { Alert, Linking, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { GithubConnector, Intern } from "../../src/api";
import { useSettings } from "../../src/settings";
import { radius, scaledFont, space, useAppTheme } from "../../src/theme";
import { Button } from "../../src/ui/Button";
import { Group, Row, Switch } from "../../src/ui/Grouped";
import { CheckIcon } from "../../src/ui/Icons";
import { EmptyState, ErrorNote, Loading, Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

/** Where this app is being used from: GitHub sends the browser back here. */
function appOrigin(baseUrl: string): string {
  if (Platform.OS === "web" && typeof window !== "undefined") return window.location.origin;
  return baseUrl;
}

/** Post the manifest to github.com the way GitHub's manifest flow expects: a plain form submit. */
function postToGithub(action: string, manifest: Record<string, unknown>): boolean {
  if (Platform.OS !== "web" || typeof document === "undefined") return false;
  const form = document.createElement("form");
  form.method = "post";
  form.action = action;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(manifest);
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
  return true;
}

function go(url: string) {
  if (Platform.OS === "web" && typeof window !== "undefined") window.location.href = url;
  else void Linking.openURL(url);
}

export default function GithubConnectorScreen() {
  const { api, configured, settings } = useSettings();
  const { colors, fontScale } = useAppTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ connected?: string }>();
  const [github, setGithub] = useState<GithubConnector | null>(null);
  const [crew, setCrew] = useState<Intern[]>([]);
  const [login, setLogin] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    Promise.all([api.githubConnector(), api.listInterns()]).then(
      ([g, interns]) => (setGithub(g), setCrew(interns.filter((i) => i.slug !== "coordinator")), setError(null)),
      (e) => setError(e),
    );
  }, [api]);
  useFocusEffect(
    useCallback(() => {
      if (configured) load();
    }, [configured, load]),
  );

  const run = async (key: string, fn: () => Promise<GithubConnector | void>) => {
    setBusy(key);
    setError(null);
    try {
      const next = await fn();
      if (next) setGithub(next);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  if (!configured) return <Screen><EmptyState title="Not connected" body="Add your API token in Settings › Connection." /></Screen>;
  if (!github) return <Screen>{error ? <EmptyState title="Couldn't load GitHub"><ErrorNote error={error} onRetry={load} /></EmptyState> : <Loading />}</Screen>;

  const origin = appOrigin(settings.baseUrl);
  const start = () =>
    run("setup", async () => {
      const { action, manifest } = await api.githubSetup(login.trim(), origin);
      if (!postToGithub(action, manifest)) throw new Error("Open the app in a browser to connect GitHub.");
    });
  const disconnect = () => {
    const what = "Reviews stop and the GitHub tool is taken back. The app stays on GitHub until you delete it there.";
    const doIt = () => void run("disconnect", () => api.disconnectGithub());
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(`Disconnect GitHub?\n\n${what}`)) doIt();
      return;
    }
    Alert.alert("Disconnect GitHub?", what, [
      { text: "Keep", style: "cancel" },
      { text: "Disconnect", style: "destructive", onPress: doIt },
    ]);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxl }]} keyboardShouldPersistTaps="handled">
        {params.connected === "1" && github.connected ? (
          <View style={[styles.banner, { backgroundColor: colors.successSoft }]}>
            <Text variant="subtle" color={colors.text}>
              GitHub is connected. Choose who reviews below.
            </Text>
          </View>
        ) : null}
        {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}

        {!github.connected ? (
          <Group title="Connect GitHub" footer="GitHub creates a private app for your crew. It can read code, pull requests and checks, and propose reviews. Nothing is published until you approve it in the app.">
            <View style={styles.panel}>
              {["Create the app on GitHub (everything is filled in for you).", "Install it on your account or organization.", "Come back here and choose who reviews."].map((s, i) => (
                <View key={s} style={styles.step}>
                  <Text variant="subtle" color={colors.text} style={styles.stepNo}>
                    {i + 1}
                  </Text>
                  <Text variant="subtle" style={styles.flex}>
                    {s}
                  </Text>
                </View>
              ))}
              <Text variant="label">GitHub username or organization</Text>
              <TextInput
                value={login}
                onChangeText={setLogin}
                placeholder="northwind"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                style={[styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale) }]}
                accessibilityLabel="GitHub username or organization"
                onSubmitEditing={() => void start()}
              />
              <Text variant="caption">The app is created under this account. Use an organization if its repositories are the ones to review.</Text>
              <Button label="Continue to GitHub" tone="primary" busy={busy === "setup"} disabled={!login.trim()} onPress={() => void start()} />
            </View>
          </Group>
        ) : (
          <>
            {github.app ? (
              <Group title="App">
                <Row label={github.app.name} detail={github.app.owner ? `Owned by ${github.app.owner}` : undefined} value="Open" onPress={() => void Linking.openURL(github.app!.html_url)} />
              </Group>
            ) : null}

            <Group
              title="Review pull requests in"
              footer={
                github.installations.length
                  ? `Your reviewer checks these for new pull requests every few minutes.${github.app?.owner ? ` Apps created here are private to ${github.app.owner}: to install it on another organization, make it public in its GitHub settings first.` : ""}`
                  : "Install the app on the account whose repositories should be reviewed."
              }
            >
              {github.installations.map((i) => (
                <Row
                  key={i.login}
                  label={i.login}
                  detail={[i.type === "Organization" ? "Organization" : "Account", i.all_repositories ? "all repositories" : "selected repositories", i.suspended ? "suspended" : null].filter(Boolean).join(" · ")}
                  right={<Switch label={`Reviews in ${i.login}`} value={i.enabled} disabled={i.suspended || busy !== null} onChange={(on) => void run("accounts", () => api.updateGithub({ accounts: { [i.login]: on } }))} />}
                />
              ))}
              <Row label={github.installations.length ? "Add an account or organization" : "Install the app"} onPress={() => void run("install", async () => go((await api.githubInstallUrl(origin)).url))} />
              <Row label={busy === "sync" ? "Refreshing…" : "Refresh from GitHub"} onPress={busy ? undefined : () => void run("sync", () => api.syncGithub())} />
            </Group>

            <Group title="Reviewer" footer="They get the GitHub tool. Their reviews arrive as cards for you to publish, edit or drop.">
              {crew.map((intern) => {
                const on = github.reviewer?.slug === intern.slug;
                return (
                  <Row
                    key={intern.slug}
                    label={intern.name}
                    detail={intern.role}
                    onPress={() => void run("reviewer", () => api.updateGithub({ reviewer: intern.slug }))}
                    accessibilityLabel={`${intern.name}${on ? ", reviewer" : ""}`}
                    right={<View style={styles.check}>{on ? <CheckIcon size={20} color={colors.accent} /> : null}</View>}
                  />
                );
              })}
            </Group>

            {github.error ? (
              <Text variant="caption" color={colors.action}>
                GitHub didn't answer: {github.error}
              </Text>
            ) : null}

            <Group>
              <Row label="Disconnect GitHub…" destructive onPress={disconnect} />
            </Group>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.xl },
  flex: { flex: 1 },
  banner: { borderRadius: radius.md, padding: space.md },
  panel: { padding: space.lg, gap: space.md },
  step: { flexDirection: "row", gap: space.sm },
  stepNo: { width: 18, fontWeight: "700" },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
  check: { width: 24, alignItems: "center" },
});
