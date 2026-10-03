/**
 * First run: welcome → connect (only without a token) → about you → first
 * intern. The Crew tab sends people here until GET /owner says setup is
 * complete (or a crew already exists). Everything it writes is ordinary
 * config: PATCH /owner for name, time zone and domains, then the normal hire
 * flow (?template=<id>) for the first intern.
 */
import { Stack, useRouter } from "expo-router";
import React, { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ApiError, createApi, type InternTemplate, type OwnerSettings } from "../src/api";
import { friendlyError } from "../src/errors";
import { DEFAULT_BASE_URL, useSettings } from "../src/settings";
import { radius, scaledFont, space, useAppTheme } from "../src/theme";
import { Button } from "../src/ui/Button";
import { InternFace } from "../src/ui/InternFace";
import { ErrorNote, Screen } from "../src/ui/Screen";
import { TemplatePicker, useTemplates } from "../src/ui/TemplatePicker";
import { Text } from "../src/ui/Text";

type Step = "welcome" | "connect" | "you" | "first";

const CREW = ["face-05", "face-11", "coordinator", "face-19", "face-14"];

const deviceZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
};

export default function SetupScreen() {
  const { colors, fontScale } = useAppTheme();
  const { api, ready, configured, settings, save } = useSettings();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [step, setStep] = useState<Step>("welcome");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);

  // connect
  const [token, setToken] = useState("");
  const [server, setServer] = useState(settings.baseUrl || DEFAULT_BASE_URL);
  const [showServer, setShowServer] = useState(false);

  // about you
  const [owner, setOwner] = useState<OwnerSettings | null>(null);
  const [name, setName] = useState("");
  const [zone, setZone] = useState(deviceZone());
  const [domains, setDomains] = useState("");

  const { templates } = useTemplates();
  const steps: Step[] = useMemo(() => (configured && step !== "connect" ? ["welcome", "you", "first"] : ["welcome", "connect", "you", "first"]), [configured, step]);

  useEffect(() => {
    if (!configured) return;
    let cancelled = false;
    api
      .owner()
      .then((o) => {
        if (cancelled) return;
        setOwner(o);
        // "Boss" is the default: an empty field asks the question better than a placeholder name does.
        setName((current) => current || (o.owner_name === "Boss" ? "" : o.owner_name));
        if (o.timezone_configured) setZone(o.timezone);
        setDomains((current) => current || o.own_domains.join(", "));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, configured]);

  const connect = async () => {
    setBusy(true);
    setError(null);
    const credentials = { baseUrl: server.trim().replace(/\/$/, ""), token: token.trim() };
    try {
      await createApi(credentials).ping();
      await save(credentials);
      setStep("you");
    } catch (e) {
      setError(
        e instanceof ApiError && e.isAuth
          ? "That token was rejected. Copy api_token again from ~/.interns/config.json."
          : friendlyError(e).message,
      );
    } finally {
      setBusy(false);
    }
  };

  const saveYou = async () => {
    setBusy(true);
    setError(null);
    try {
      const own = domains
        .split(/[\s,;]+/)
        .map((d) => d.trim().replace(/^@/, "").toLowerCase())
        .filter(Boolean);
      setOwner(await api.updateOwner({ owner_name: name.trim(), timezone: zone.trim(), own_domains: own }));
      setStep("first");
    } catch (e) {
      setError(e instanceof ApiError && e.status === 400 ? "Check the time zone (e.g. Europe/London) and the domains (e.g. example.com)." : e);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (next: string) => {
    setError(null);
    try {
      await api.updateOwner({ setup_complete: true });
      router.replace(next as never);
    } catch (e) {
      setError(e);
      setOpening(null);
    }
  };

  const pick = (template: InternTemplate) => {
    setOpening(template.id);
    void finish(`/hire?template=${encodeURIComponent(template.id)}`);
  };

  const input = [
    styles.input,
    { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontSize: scaledFont(17, fontScale) },
  ];
  const index = steps.indexOf(step);

  if (!ready) return <Screen>{null}</Screen>;

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: false }} />
      <ScrollView
        contentContainerStyle={[styles.body, { paddingTop: insets.top + space.xxl, paddingBottom: insets.bottom + space.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.column}>
          <View style={styles.dots} accessibilityLabel={`Step ${index + 1} of ${steps.length}`}>
            {steps.map((s, i) => (
              <View key={s} style={[styles.dot, { backgroundColor: i <= index ? colors.text : colors.border, width: i === index ? 22 : 8 }]} />
            ))}
          </View>

          {error ? <ErrorNote error={error} onDismiss={() => setError(null)} /> : null}

          {step === "welcome" ? (
            <View style={styles.group}>
              <View style={styles.crew}>
                {CREW.map((id) => (
                  <InternFace key={id} id={id} size={id === "coordinator" ? 60 : 44} clipToBounds />
                ))}
              </View>
              <Text variant="display">Meet your crew</Text>
              <Text variant="subtle">
                Interns are AI agents with names, faces and jobs. They read your mail, brief you before
                meetings, review code and keep track of who you owe a reply — and they ask before anything
                leaves the building.
              </Text>
              <Text variant="subtle">Two minutes of setup, then you hire your first one.</Text>
              <Button label="Get started" tone="primary" full onPress={() => setStep(configured ? "you" : "connect")} />
            </View>
          ) : null}

          {step === "connect" ? (
            <View style={styles.group}>
              <Text variant="display">Connect this device</Text>
              <Text variant="subtle">
                Paste the access token from the machine that runs Interns. It's the api_token value in
                ~/.interns/config.json, and it stays on this device.
              </Text>
              <TextInput
                value={token}
                onChangeText={setToken}
                placeholder="Paste api_token"
                placeholderTextColor={colors.textFaint}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                style={input}
                onSubmitEditing={() => token.trim() && void connect()}
              />
              {showServer ? (
                <TextInput
                  value={server}
                  onChangeText={setServer}
                  placeholder="http://127.0.0.1:7810"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  style={input}
                />
              ) : (
                <Pressable onPress={() => setShowServer(true)} accessibilityRole="button">
                  <Text variant="caption">Interns runs somewhere else? Set the server address</Text>
                </Pressable>
              )}
              <Button label="Connect" tone="primary" full busy={busy} disabled={!token.trim()} onPress={() => void connect()} />
            </View>
          ) : null}

          {step === "you" ? (
            <View style={styles.group}>
              <Text variant="display">About you</Text>
              <Field label="What should the crew call you?">
                <TextInput value={name} onChangeText={setName} placeholder="Your first name" placeholderTextColor={colors.textFaint} style={input} autoFocus />
              </Field>
              <Field label="Time zone" hint="For Today, meeting times and notification summaries.">
                <TextInput value={zone} onChangeText={setZone} placeholder="Europe/London" placeholderTextColor={colors.textFaint} autoCapitalize="none" autoCorrect={false} style={input} />
              </Field>
              <Field label="Your work email domains" hint="Optional. Meetings with anyone else count as external, so you get a brief beforehand.">
                <TextInput
                  value={domains}
                  onChangeText={setDomains}
                  placeholder="example.com"
                  placeholderTextColor={colors.textFaint}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="email-address"
                  style={input}
                />
              </Field>
              <Button label="Continue" tone="primary" full busy={busy} disabled={!name.trim()} onPress={() => void saveYou()} />
            </View>
          ) : null}

          {step === "first" ? (
            <View style={styles.group}>
              <Text variant="display">{owner?.owner_name && owner.owner_name !== "Boss" ? `Hi ${owner.owner_name}. Who's first?` : "Who's first?"}</Text>
              <Text variant="subtle">
                Pick a starter — you can change anything about them before they're hired — or describe
                someone in your own words.
              </Text>
              {templates.length ? <TemplatePicker templates={templates} busyId={opening} onPick={pick} /> : null}
              {templates.some((t) => !t.ready) ? (
                <Button label="Connect Outlook or GitHub" tone="neutral" small onPress={() => router.push("/connectors" as never)} />
              ) : null}
              <Button label="Describe my own" tone="neutral" full disabled={Boolean(opening)} onPress={() => void finish("/hire")} />
              <Button label="Skip for now" tone="ghost" full disabled={Boolean(opening)} onPress={() => void finish("/")} />
            </View>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Text variant="title">{label}</Text>
      {children}
      {hint ? <Text variant="caption">{hint}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { paddingHorizontal: space.xl, flexGrow: 1 },
  column: { width: "100%", maxWidth: 480, alignSelf: "center", gap: space.xl },
  group: { gap: space.lg },
  dots: { flexDirection: "row", gap: space.xs, alignItems: "center" },
  dot: { height: 8, borderRadius: radius.pill },
  crew: { flexDirection: "row", alignItems: "flex-end", justifyContent: "space-between", maxWidth: 320, marginBottom: space.sm },
  field: { gap: space.sm },
  input: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
  },
});
