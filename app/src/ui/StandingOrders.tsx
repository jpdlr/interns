/**
 * The intern's file: its standing orders (docs/features/04-standing-orders.md)
 * and the pages it keeps (02-pages.md). Self-contained — toggles apply at
 * once, outside the manifest form's Save, because a standing order is a
 * conversation outcome, not a setting being drafted.
 */
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { PageHeader, Rule } from "../api";
import { useLiveEvents } from "../live";
import { useSettings } from "../settings";
import { space, useAppTheme } from "../theme";
import { relativeTime } from "../time";
import { Group, Row, Switch } from "./Grouped";
import { TrashIcon } from "./Icons";
import { Text } from "./Text";

const TYPE_LABEL: Record<Rule["type"], string> = {
  mute_repo: "Mute repo",
  mute_sender: "Mute sender",
  quiet_hours: "Quiet hours",
  hold_until: "Hold until",
  guidance: "Guidance",
};

export function StandingOrders({ slug, name }: { slug: string; name: string }) {
  const { colors } = useAppTheme();
  const { api, configured } = useSettings();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(() => {
    if (!configured) return;
    api.listRules(slug).then(setRules).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [api, configured, slug]);
  useEffect(load, [load]);
  useLiveEvents((event) => {
    if (event.type === "rule" && (event.data as Rule | undefined)?.intern === slug) load();
  });

  const toggle = async (rule: Rule) => {
    setRules((list) => list?.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r)) ?? null);
    try {
      await api.setRuleEnabled(rule.id, !rule.enabled);
    } catch {
      load();
    }
  };
  const remove = async (rule: Rule) => {
    setRules((list) => list?.filter((r) => r.id !== rule.id) ?? null);
    await api.removeRule(rule.id).catch(load);
  };

  if (!rules) return error ? <Text variant="caption" color={colors.urgent}>{error}</Text> : null;
  const shown = showAll ? rules : rules.slice(0, 4);
  return (
    <Group
      title={rules.length ? `Standing orders · ${rules.length}` : "Standing orders"}
      footer={rules.length ? undefined : `None yet. Tell ${name} something lasting in chat — “ignore webapp PRs from now on” — and it's saved here.`}
    >
      {shown.map((rule) => {
        const hits = rule.hits_7d ?? 0;
        return (
          <Row
            key={rule.id}
            label={rule.text}
            detail={[
              TYPE_LABEL[rule.type],
              rule.kind === "hard" ? (hits ? `${verb(rule)} ${hits} this week` : "enforced") : "in their instructions",
              rule.last_hit_at ? `last ${relativeTime(rule.last_hit_at)}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
            right={
              <View style={styles.ruleRight}>
                <Switch label={`${rule.enabled ? "Pause" : "Resume"}: ${rule.text}`} value={rule.enabled} onChange={() => void toggle(rule)} />
                <Pressable accessibilityRole="button" accessibilityLabel={`Remove: ${rule.text}`} onPress={() => void remove(rule)} hitSlop={8} style={styles.trash}>
                  <TrashIcon size={17} color={colors.textFaint} />
                </Pressable>
              </View>
            }
          />
        );
      })}
      {rules.length > 4 ? <Row label={showAll ? "Show fewer" : `Show all ${rules.length}`} onPress={() => setShowAll((v) => !v)} /> : null}
    </Group>
  );
}

function verb(rule: Rule): string {
  return rule.type === "quiet_hours" ? "Held pings" : rule.type === "hold_until" ? "Held" : "Muted";
}

export function InternPages({ slug }: { slug: string }) {
  const router = useRouter();
  const { api, configured } = useSettings();
  const [pages, setPages] = useState<PageHeader[]>([]);
  const load = useCallback(() => {
    if (!configured) return;
    api.listPages(slug).then((list) => setPages(list.filter((p) => p.intern === slug))).catch(() => {});
  }, [api, configured, slug]);
  useEffect(load, [load]);
  useLiveEvents((event) => {
    if (event.type === "page") load();
  });
  if (pages.length === 0) return null;
  return (
    <Group title="Pages">
      {pages.map((page) => (
        <Row
          key={page.id}
          label={page.title}
          detail={[page.summary, `updated ${relativeTime(page.updated_at)}`].filter(Boolean).join(" · ")}
          onPress={() => router.push(`/page/${page.id}` as never)}
        />
      ))}
    </Group>
  );
}

const styles = StyleSheet.create({
  ruleRight: { flexDirection: "row", alignItems: "center", gap: space.sm },
  trash: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
});
