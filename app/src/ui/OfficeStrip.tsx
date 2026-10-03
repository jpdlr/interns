/**
 * Who's busy right now, above the Crew list: interns working on something
 * bob at their desk, and the members of a group chat that is active right
 * now lean toward each other. Idle interns are already in the list below,
 * so the strip only appears when it has something the list doesn't say —
 * and disappears again when the office is quiet. Tap a face to open its
 * thread.
 */
import { useRouter } from "expo-router";
import React, { useMemo } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { Intern, RoomListEntry } from "../api";
import { space, useAppTheme } from "../theme";
import { InternFace, resolveFaceId, type FaceMood } from "./InternFace";
import { Text } from "./Text";

const AWAY_AFTER_MS = 3 * 86_400_000;
const ROOM_ACTIVE_MS = 20 * 60_000;

export interface OfficeStripProps {
  interns: Intern[];
  rooms: RoomListEntry[];
  /** last message timestamp per thread key */
  lastSeen: Record<string, string | undefined>;
}

export function OfficeStrip({ interns, rooms, lastSeen }: OfficeStripProps) {
  const { colors } = useAppTheme();
  const router = useRouter();
  const now = Date.now();

  const seats = useMemo(() => {
    // Members of the most recently active room sit together and glance at one another.
    const activeRoom = rooms
      .filter((r) => r.last_message && now - Date.parse(r.last_message.ts) < ROOM_ACTIVE_MS)
      .sort((a, b) => (b.last_message?.ts ?? "").localeCompare(a.last_message?.ts ?? ""))[0];
    const huddle = activeRoom ? activeRoom.members.filter((m) => interns.some((i) => i.slug === m)) : [];
    const ordered = [...interns].sort((a, b) => {
      const ai = huddle.indexOf(a.slug);
      const bi = huddle.indexOf(b.slug);
      if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
      return (b.running - a.running) || a.name.localeCompare(b.name);
    });
    return ordered.map((intern) => {
      const working = intern.running > 0;
      const last = lastSeen[intern.slug];
      const idleFor = last ? now - Date.parse(last) : Infinity;
      const inHuddle = huddle.indexOf(intern.slug);
      let mood: FaceMood = "idle";
      let status = "at desk";
      if (working) {
        mood = "thinking";
        status = intern.activity?.label.replace(/^(Paused|Queued|Priority):\s*/, "").slice(0, 22) ?? "working";
      } else if (inHuddle !== -1 && huddle.length > 1) {
        // Lean toward the middle of the huddle so the group reads as facing each other.
        mood = inHuddle < huddle.length / 2 ? "glance-right" : "glance-left";
        status = `in ${activeRoom!.name}`;
      } else if (idleFor > AWAY_AFTER_MS && !last) {
        mood = "away";
        status = "new hire";
      } else if (idleFor > AWAY_AFTER_MS) {
        mood = "away";
        status = "away";
      }
      return { intern, mood, status, working, huddle: inHuddle !== -1 && huddle.length > 1 };
    }).filter((seat) => seat.working || seat.huddle);
  }, [interns, rooms, lastSeen, now]);

  if (seats.length === 0) return null;

  return (
    <View style={styles.strip}>
    <Text variant="label" style={styles.heading}>Busy now</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
      {seats.map((seat, i) => (
        <Pressable
          key={seat.intern.slug}
          onPress={() => router.push(`/chat/${seat.intern.slug}` as never)}
          accessibilityRole="button"
          accessibilityLabel={`${seat.intern.name}, ${seat.status}`}
          style={({ pressed }) => [
            styles.seat,
            seat.huddle && i > 0 && seats[i - 1]!.huddle ? styles.seatHuddled : null,
            { opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <View style={[styles.desk, { backgroundColor: seat.working ? colors.accentSoft : colors.surfaceAlt, borderColor: colors.borderSoft }]}>
            <InternFace id={resolveFaceId(seat.intern.icon, seat.intern.slug)} size={44} mood={seat.mood} clipToBounds />
            {seat.working ? <View style={[styles.lamp, { backgroundColor: colors.success, borderColor: colors.bg }]} /> : null}
          </View>
          <Text variant="caption" numberOfLines={1} style={styles.name}>
            {seat.intern.name.split(" ")[0]}
          </Text>
          <Text variant="caption" numberOfLines={1} style={styles.status}>
            {seat.status}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { flexGrow: 0, marginBottom: space.md },
  heading: { marginHorizontal: space.md, marginBottom: space.sm },
  row: { paddingHorizontal: space.sm, gap: space.md, alignItems: "flex-start" },
  seat: { alignItems: "center", width: 68 },
  seatHuddled: { marginLeft: -space.sm },
  desk: { width: 56, height: 56, borderRadius: 16, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  lamp: { position: "absolute", right: -3, top: -3, width: 12, height: 12, borderRadius: 6, borderWidth: 2 },
  name: { marginTop: 4, fontWeight: "600" },
  status: {},
});
