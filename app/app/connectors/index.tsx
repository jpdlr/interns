/**
 * Connectors: one card per tool the crew can use, with where it stands and
 * one tap to connect or manage it. Outlook and GitHub run their whole setup
 * from here (connectors/outlook, connectors/github); anything else is a
 * conversation with the Coordinator, whose builder can make a connector.
 */
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConnectorsOverview } from "../../src/api";
import { useSettings } from "../../src/settings";
import { space } from "../../src/theme";
import { ConnectorCard, githubSummary, outlookSummary } from "../../src/ui/ConnectorCard";
import { BrandLogo } from "../../src/ui/BrandLogo";
import { BulbIcon } from "../../src/ui/Icons";
import { EmptyState, ErrorNote, Loading, Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

export default function ConnectorsScreen() {
  const { api, configured } = useSettings();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [overview, setOverview] = useState<ConnectorsOverview | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    api.connectors().then(
      (o) => (setOverview(o), setError(null)),
      (e) => setError(e),
    );
  }, [api]);
  useFocusEffect(
    useCallback(() => {
      if (configured) load();
    }, [configured, load]),
  );

  if (!configured) return <Screen><EmptyState title="Not connected" body="Add your API token in Settings › Connection." /></Screen>;
  if (!overview) return <Screen>{error ? <EmptyState title="Couldn't load connectors"><ErrorNote error={error} onRetry={load} /></EmptyState> : <Loading />}</Screen>;

  const outlook = outlookSummary(overview.outlook);
  const github = githubSummary(overview.github);
  return (
    <Screen>
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + space.xxl }]}>
        <Text variant="subtle">Connect the tools your interns work in. Everything they write there is a draft or a proposal until you approve it.</Text>
        <ConnectorCard
          icon={<BrandLogo brand="outlook" size={28} />}
          title="Outlook"
          description="Mail and calendar: triage, drafts in your voice, follow-ups, meeting briefs. One or several mailboxes."
          status={outlook}
          action={overview.outlook.mailboxes.length ? "Manage" : "Connect"}
          onPress={() => router.push("/connectors/outlook" as never)}
        />
        <ConnectorCard
          icon={<BrandLogo brand="github" size={28} />}
          title="GitHub"
          description="Pull request reviews. Your reviewer reads the diff and checks, and proposes a review for you to publish."
          status={github}
          action={overview.github.connected ? "Manage" : "Connect"}
          onPress={() => router.push("/connectors/github" as never)}
        />
        <ConnectorCard
          icon={<BulbIcon size={24} />}
          title="Something else?"
          description="Tell the Coordinator what you'd like connected. Your builder intern can make a connector for it, with your approval at each step."
          action="Ask"
          onPress={() => router.push("/chat/coordinator" as never)}
        />
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  body: { padding: space.lg, gap: space.lg },
});
