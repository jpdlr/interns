/**
 * Connectors: one card per tool the crew can use, with where it stands and
 * one tap to connect or manage it. Outlook, GitHub, Instagram and Google Photos
 * run their whole setup from here (connectors/outlook, /github, /instagram,
 * /google-photos); anything else is a
 * conversation with the coordinator, whose builder can make a connector.
 */
import { useFocusEffect, useRouter } from "expo-router";
import React, { useCallback, useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ConnectorsOverview } from "../../src/api";
import { useCoordinatorName } from "../../src/owner";
import { useSettings } from "../../src/settings";
import { space } from "../../src/theme";
import { cachedOverview, ConnectorCard, githubSummary, googlePhotosSummary, instagramSummary, outlookSummary, rememberOverview } from "../../src/ui/ConnectorCard";
import { BrandLogo } from "../../src/ui/BrandLogo";
import { BulbIcon } from "../../src/ui/Icons";
import { EmptyState, ErrorNote, Loading, Screen } from "../../src/ui/Screen";
import { Text } from "../../src/ui/Text";

export default function ConnectorsScreen() {
  const { api, configured } = useSettings();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const coordinator = useCoordinatorName();
  // the last list this app saw draws at once; the fresh one replaces it
  const [overview, setOverview] = useState<ConnectorsOverview | null>(cachedOverview);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(() => {
    api.connectors().then(
      (o) => (setOverview(rememberOverview(o)), setError(null)),
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
  const instagram = instagramSummary(overview.instagram);
  const googlePhotos = googlePhotosSummary(overview.google_photos);
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
          icon={<BrandLogo brand="instagram" size={28} />}
          title="Instagram"
          description="Market research: public business and creator accounts, their posts and engagement, and what's under a hashtag. Read only."
          status={instagram}
          action={overview.instagram.connected ? "Manage" : "Connect"}
          onPress={() => router.push("/connectors/instagram" as never)}
        />
        <ConnectorCard
          icon={<BrandLogo brand="google-photos" size={28} />}
          title="Google Photos"
          description="Share albums or photos with the crew. They're copied to your server so interns can browse, tag and pick from them."
          status={googlePhotos}
          action={overview.google_photos?.connected ? "Manage" : "Connect"}
          onPress={() => router.push("/connectors/google-photos" as never)}
        />
        <ConnectorCard
          icon={<BulbIcon size={24} />}
          title="Something else?"
          description={`Tell the ${coordinator} what you'd like connected. Your builder intern can make a connector for it, with your approval at each step.`}
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
