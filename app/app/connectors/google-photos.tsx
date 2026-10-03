/**
 * Google Photos: share photos with the crew through Google's own picker.
 *
 * Google no longer lets any app read a whole library, so the owner picks
 * albums or photos in Google's page and they're copied to the server
 * (orchestrator src/photos.ts). Setup is a Google Cloud OAuth client the
 * owner creates once; the steps and the exact redirect address are shown
 * inline. Then: sign in, choose photos, choose who may use them.
 */
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { GooglePhotosConnector, PhotoPick } from "../../src/api";
import { useSettings } from "../../src/settings";
import { radius, scaledFont, space, useAppTheme } from "../../src/theme";
import { relativeTime } from "../../src/time";
import { BrandLogo } from "../../src/ui/BrandLogo";
import { Button } from "../../src/ui/Button";
import { Group, Row, Switch } from "../../src/ui/Grouped";
import { copyText } from "../../src/ui/Markdown";
import { EmptyState, ErrorNote, Loading, Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

const PICKER_API = "https://console.cloud.google.com/apis/library/photospicker.googleapis.com";
const AUTH_PLATFORM = "https://console.cloud.google.com/auth/overview";
const CLIENTS = "https://console.cloud.google.com/auth/clients";

const origin = () => (Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : "");
const redirectUri = () => `${origin()}/oauth/google/callback`;

function confirm(title: string, body: string, action: string, run: () => void) {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    if (window.confirm(`${title}\n\n${body}`)) run();
    return;
  }
  Alert.alert(title, body, [
    { text: "Cancel", style: "cancel" },
    { text: action, style: "destructive", onPress: run },
  ]);
}

export default function GooglePhotosScreen() {
  const { api, configured } = useSettings();
  const { colors } = useAppTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ connected?: string; error?: string }>();
  const [photos, setPhotos] = useState<GooglePhotosConnector | null>(null);
  const [pick, setPick] = useState<PhotoPick | null>(null);
  const [editingApp, setEditingApp] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(params.error ? new Error(params.error === "access_denied" ? "Google sign-in was cancelled." : `Google said: ${params.error}`) : null);

  const load = useCallback(() => {
    api.googlePhotos().then(
      (g) => {
        setPhotos(g);
        setPick((current) => current ?? g.sessions[0] ?? null);
      },
      (e) => setError(e),
    );
  }, [api]);
  useFocusEffect(
    useCallback(() => {
      if (configured) load();
    }, [configured, load]),
  );

  // While a pick is open, follow it: waiting for the owner, importing, done.
  useEffect(() => {
    if (!pick || (pick.state !== "waiting" && pick.state !== "importing")) return;
    const timer = setInterval(() => {
      api.photoPick(pick.id).then(
        (next) => {
          setPick(next);
          if (next.state === "done") load();
        },
        () => {},
      );
    }, 2500);
    return () => clearInterval(timer);
  }, [api, pick, load]);

  const run = async (key: string, fn: () => Promise<GooglePhotosConnector | void>) => {
    setBusy(key);
    setError(null);
    try {
      const next = await fn();
      if (next) setPhotos(next);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  if (!configured) return <Screen><EmptyState title="Not connected" body="Add your API token in Settings › Connection." /></Screen>;
  if (!photos) return <Screen>{error ? <EmptyState title="Couldn't load Google Photos"><ErrorNote error={error} onRetry={load} /></EmptyState> : <Loading />}</Screen>;

  const signIn = () =>
    run("signin", async () => {
      const { url } = await api.googlePhotosSignIn(origin());
      if (Platform.OS === "web") window.location.href = url;
      else await Linking.openURL(url);
    });
  const startPick = () =>
    run("pick", async () => {
      setPick(await api.startPhotoPick());
    });
  const openPicker = () => {
    if (!pick) return;
    // "/autoclose" closes Google's tab when the owner taps Done.
    const url = `${pick.picker_uri.replace(/\/$/, "")}/autoclose`;
    if (Platform.OS === "web") window.open(url, "_blank");
    else void Linking.openURL(url);
  };

  const signedIn = photos.connected;
  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxl }]} keyboardShouldPersistTaps="handled">
        {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}
        {params.connected && signedIn && !photos.library.count && !pick ? (
          <Text variant="subtle" color={colors.success}>
            Google Photos is connected. Choose some photos to share.
          </Text>
        ) : null}

        {!photos.app.configured || editingApp ? (
          <SetupApp
            existing={photos.app.client_id}
            onSaved={(next) => (setPhotos(next), setEditingApp(false))}
            onCancel={photos.app.configured ? () => setEditingApp(false) : undefined}
          />
        ) : !signedIn ? (
          <Group
            title={photos.needs_reconnect ? "Connect again" : "Sign in"}
            footer="Interns only ever see the photos you pick. Google asks you to allow Interns to view the photos you select."
          >
            <View style={styles.panel}>
              <Text variant="subtle">
                {photos.needs_reconnect
                  ? "Google signed Interns out. While your Google app is in testing, a sign-in lasts a week. Your shared photos are still here."
                  : "Sign in with the Google account whose photos you want to share."}
              </Text>
              <Button label="Sign in with Google" tone="primary" busy={busy === "signin"} onPress={() => void signIn()} />
            </View>
          </Group>
        ) : (
          <>
            <Group title="Shared photos" footer="Copies live on your server, so interns can look at them any time. Share more whenever you like; photos you've shared before aren't copied twice.">
              <Row
                icon={<BrandLogo brand="google-photos" size={24} />}
                label={photos.library.count ? `${photos.library.count} shared` : "Nothing shared yet"}
                detail={photos.library.last_import ? `Last added ${relativeTime(photos.library.last_import)}` : "Pick albums or photos in Google Photos"}
              />
              <View style={styles.panel}>
                <PickProgress pick={pick} onOpen={openPicker} onCancel={pick && pick.state === "waiting" ? () => void api.cancelPhotoPick(pick.id).then(() => setPick(null)) : undefined} />
                {!pick || pick.state === "done" || pick.state === "failed" || pick.state === "expired" ? (
                  <Button label={photos.library.count ? "Share more photos" : "Choose photos"} tone="primary" busy={busy === "pick"} onPress={() => void startPick()} />
                ) : null}
              </View>
            </Group>

            <Group title="Who can use them" footer="They get the photos tool: contact sheets of what you've shared, and tags they keep as they go. They never post anything.">
              {photos.interns.map((intern) => (
                <Row
                  key={intern.slug}
                  label={intern.name}
                  right={<Switch label={`${intern.name} can use your photos`} value={intern.enabled} disabled={busy !== null} onChange={(next) => void run("crew", () => api.updateGooglePhotos({ [intern.slug]: next }))} />}
                />
              ))}
            </Group>

            <Group>
              <Row label="Google client" detail={photos.app.client_id ?? ""} value="Change" onPress={() => setEditingApp(true)} />
              <Row
                label="Disconnect Google…"
                destructive
                onPress={() => confirm("Disconnect Google Photos?", "Interns keep the photos already shared. Sign in again to share more.", "Disconnect", () => void run("disconnect", () => api.disconnectGooglePhotos()))}
              />
              {photos.library.count ? (
                <Row
                  label="Delete shared photos…"
                  destructive
                  onPress={() =>
                    confirm("Delete the shared photos?", `The ${photos.library.count} copies on your server and the interns' tags are deleted. Your Google Photos aren't touched.`, "Delete", () =>
                      void run("delete", () => api.disconnectGooglePhotos({ library: true })),
                    )
                  }
                />
              ) : null}
            </Group>
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

/** Where the current pick stands. */
function PickProgress({ pick, onOpen, onCancel }: { pick: PhotoPick | null; onOpen: () => void; onCancel?: () => void }) {
  const { colors } = useAppTheme();
  if (!pick) return null;
  if (pick.state === "waiting") {
    return (
      <View style={styles.pick}>
        <Text variant="subtle" color={colors.text}>
          Pick photos or albums in Google Photos, then tap Done there. They'll appear here.
        </Text>
        <Button label="Open Google Photos" tone="primary" onPress={onOpen} />
        {onCancel ? <Button label="Cancel" tone="neutral" small onPress={onCancel} /> : null}
      </View>
    );
  }
  if (pick.state === "importing") {
    return (
      <Text variant="subtle" color={colors.text}>
        Copying {pick.imported} of {pick.total || "…"}…
      </Text>
    );
  }
  if (pick.state === "done") {
    return (
      <Text variant="subtle" color={colors.success}>
        Added {pick.imported} {pick.imported === 1 ? "photo" : "photos"}
        {pick.skipped ? ` (${pick.skipped} already shared or couldn't be copied)` : ""}.
      </Text>
    );
  }
  return (
    <Text variant="subtle" color={colors.action}>
      {pick.state === "expired" ? "That picker closed before anything was chosen." : `That didn't work: ${pick.error ?? "unknown error"}`}
    </Text>
  );
}

/** The one-time Google Cloud setup, with the exact redirect address to register. */
function SetupApp({ existing, onSaved, onCancel }: { existing: string | null; onSaved: (next: GooglePhotosConnector) => void; onCancel?: () => void }) {
  const { api } = useSettings();
  const { colors, fontScale } = useAppTheme();
  const [clientId, setClientId] = useState(existing ?? "");
  const [secret, setSecret] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.setGooglePhotosApp({ client_id: clientId.trim(), client_secret: secret.trim() }));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  const input = [styles.input, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(16, fontScale) }];
  const steps = [
    "In Google Cloud Console, pick or create a project and enable the Google Photos Picker API.",
    "Under Google Auth Platform, set up the consent screen: External, then add your own Google account as a test user.",
    "Under Clients, create a client of type Web application and add this authorised redirect URI:",
    "Paste the client ID and client secret below. Easiest on a computer.",
  ];
  return (
    <Group title={existing ? "Change Google client" : "Set up Google Photos"} footer="Only the picker permission is asked for: interns can see the photos you choose and nothing else in your library.">
      <View style={styles.panel}>
        {steps.map((s, i) => (
          <View key={s} style={styles.stepWrap}>
            <View style={styles.step}>
              <Text variant="subtle" color={colors.text} style={styles.stepNo}>
                {i + 1}
              </Text>
              <Text variant="subtle" style={styles.flex}>
                {s}
              </Text>
            </View>
            {i === 2 ? (
              <View style={[styles.uri, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
                <Text variant="subtle" color={colors.text} selectable>
                  {redirectUri()}
                </Text>
                <Button
                  label={copied ? "Copied" : "Copy"}
                  tone="neutral"
                  small
                  onPress={() => void copyText(redirectUri()).then((ok) => ok && (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
                />
              </View>
            ) : null}
          </View>
        ))}
        <View style={styles.buttons}>
          <Button label="Enable the Picker API" tone="neutral" small onPress={() => void Linking.openURL(PICKER_API)} />
          <Button label="Consent screen" tone="neutral" small onPress={() => void Linking.openURL(AUTH_PLATFORM)} />
          <Button label="Create a client" tone="neutral" small onPress={() => void Linking.openURL(CLIENTS)} />
        </View>
        <Text variant="label">Client ID</Text>
        <TextInput value={clientId} onChangeText={setClientId} placeholder="1234…apps.googleusercontent.com" placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} style={input} accessibilityLabel="Client ID" />
        <Text variant="label">Client secret</Text>
        <TextInput value={secret} onChangeText={setSecret} placeholder="GOCSPX-…" placeholderTextColor={colors.textFaint} secureTextEntry autoCapitalize="none" autoCorrect={false} style={input} accessibilityLabel="Client secret" />
        {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}
        <Button label="Save" tone="primary" busy={busy} disabled={!clientId.trim() || !secret.trim()} onPress={() => void save()} />
        {onCancel ? <Button label="Cancel" tone="neutral" onPress={onCancel} /> : null}
      </View>
    </Group>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.xl },
  flex: { flex: 1 },
  panel: { padding: space.lg, gap: space.md },
  pick: { gap: space.sm },
  stepWrap: { gap: space.sm },
  step: { flexDirection: "row", gap: space.sm },
  stepNo: { width: 18, fontWeight: "700" },
  // stacked: a URL has no spaces to wrap at, so a button beside it gets pushed off
  uri: { alignItems: "flex-start", gap: space.sm, borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, padding: space.md, marginLeft: 26 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: space.sm },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.lg, paddingVertical: space.md },
});
