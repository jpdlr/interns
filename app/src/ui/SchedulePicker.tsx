/**
 * An intern's schedule, without cron: tap the days it should run (none = off),
 * then pick once-a-day-at-a-time or every-N through the day. On the web/PWA
 * the time and repeat open the phone's own pickers (iOS wheels). One quiet
 * line says it back with the next run. Raw cron hides behind "Advanced".
 */
import React, { useMemo, useState } from "react";
import { Platform, Pressable, StyleSheet, TextInput, View } from "react-native";
import {
  DAY_LETTERS,
  DAY_NAMES,
  describeSchedule,
  EVERY_DAY,
  formatLocal,
  INTERVALS,
  nextRun,
  parseSchedule,
  scheduleToCron,
  WEEKDAYS,
  type Schedule,
} from "../schedule";
import { useOwnerZone } from "../owner";
import { radius, scaledFont, space, useAppTheme } from "../theme";
import { Text } from "./Text";

/** Monday-first, the way a week reads. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];
const pad = (n: number) => String(n).padStart(2, "0");
const sameDays = (a: number[], b: number[]) => [...a].sort().join() === [...b].sort().join();

export function SchedulePicker({ value, onChange }: { value: string; onChange: (cron: string) => void }) {
  const { colors, fontScale } = useAppTheme();
  const s = useMemo(() => parseSchedule(value), [value]);
  const [advanced, setAdvanced] = useState(s.custom !== null);
  const set = (patch: Partial<Schedule>) => onChange(scheduleToCron({ ...s, custom: null, ...patch }));
  const zone = useOwnerZone();
  const next = useMemo(() => {
    const at = value.trim() ? nextRun(value, new Date(), zone) : null;
    return at ? formatLocal(at, zone) : null;
  }, [value, zone]);

  const toggleDay = (d: number) => {
    const days = s.custom !== null ? [d] : s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d];
    set({ days });
  };
  const fieldStyle = { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border };

  return (
    <View style={styles.wrap}>
      <View style={styles.days} accessibilityLabel="Days it runs">
        {WEEK.map((d) => {
          const on = s.custom === null && s.days.includes(d);
          return (
            <Pressable
              key={d}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={DAY_NAMES[d]}
              onPress={() => toggleDay(d)}
              style={[styles.day, { backgroundColor: on ? colors.accent : colors.surface, borderColor: on ? colors.accent : colors.border }]}
            >
              <Text variant="subtle" color={on ? colors.onAccent : colors.textDim} style={styles.bold}>
                {DAY_LETTERS[d]}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.shortcuts}>
        {[
          { label: "Weekdays", days: WEEKDAYS },
          { label: "Every day", days: EVERY_DAY },
        ].map((p) => (
          <Pressable key={p.label} onPress={() => set({ days: p.days })} accessibilityRole="button" hitSlop={6}>
            <Text variant="caption" color={s.custom === null && sameDays(s.days, p.days) ? colors.text : colors.info}>
              {p.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {s.custom === null && s.days.length > 0 ? (
        <View style={styles.when}>
          <RepeatField every={s.every} onChange={(every) => set({ every })} style={fieldStyle} fontSize={scaledFont(16, fontScale)} />
          {s.every !== null ? (
            <Pressable onPress={() => set({ allDay: !s.allDay })} accessibilityRole="switch" accessibilityState={{ checked: !s.allDay }} hitSlop={6}>
              <Text variant="caption" color={colors.info}>
                {s.allDay ? "Only 08:00–18:00" : "Around the clock"}
              </Text>
            </Pressable>
          ) : null}
          {s.every === null ? (
            <>
              <Text variant="subtle">at</Text>
              <TimeField hour={s.hour} minute={s.minute} onChange={(hour, minute) => set({ hour, minute })} style={fieldStyle} fontSize={scaledFont(16, fontScale)} />
            </>
          ) : null}
        </View>
      ) : null}

      <Text variant="caption">
        {s.custom === null && s.days.length === 0
          ? "Off — tap the days it should run. It still wakes for messages, mentions and mail."
          : `${describeSchedule(s)}${next ? ` · next ${next}` : " · never runs as written"}`}
      </Text>

      {advanced ? (
        <View style={styles.advanced}>
          <TextInput
            value={value}
            onChangeText={onChange}
            placeholder="0 7 * * 1-5"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.input, fieldStyle, { fontSize: scaledFont(15, fontScale) }]}
          />
          <Text variant="caption">{`Cron on your clock (${zone}): minute hour day month weekday.`}</Text>
        </View>
      ) : (
        <Pressable onPress={() => setAdvanced(true)} accessibilityRole="button" hitSlop={6} style={styles.advancedLink}>
          <Text variant="caption" color={colors.textFaint}>
            Advanced
          </Text>
        </Pressable>
      )}
    </View>
  );
}

type FieldStyle = { color: string; backgroundColor: string; borderColor: string };

/**
 * "Once a day" or "Every …". On the web this is a real <select>, which iOS
 * shows as its own picker; elsewhere a tap cycles the options.
 */
function RepeatField({ every, onChange, style, fontSize }: { every: number | null; onChange: (every: number | null) => void; style: FieldStyle; fontSize: number }) {
  const options: (number | null)[] = [null, ...INTERVALS];
  // Short labels: the select is as wide as its longest option, and the time sits beside it.
  const label = (e: number | null) => (e === null ? "Once" : e < 60 ? `Every ${e} min` : e === 60 ? "Hourly" : `Every ${e / 60} h`);
  if (Platform.OS === "web") {
    return React.createElement(
      "select",
      {
        value: every === null ? "once" : String(every),
        onChange: (e: { target: { value: string } }) => onChange(e.target.value === "once" ? null : Number(e.target.value)),
        "aria-label": "How often",
        style: { ...webField(style, fontSize), paddingRight: 28 },
      },
      options.map((o) => React.createElement("option", { key: String(o), value: o === null ? "once" : String(o) }, label(o))),
    );
  }
  const index = options.indexOf(every);
  return (
    <Pressable onPress={() => onChange(options[(index + 1) % options.length] ?? null)} accessibilityRole="button" style={[styles.nativeField, { backgroundColor: style.backgroundColor, borderColor: style.borderColor }]}>
      <Text variant="body">{label(every)}</Text>
    </Pressable>
  );
}

/**
 * The time of day. On the web an <input type="time"> (the iOS time wheel, in
 * 5-minute steps); elsewhere − / + in 15 minutes.
 */
function TimeField({ hour, minute, onChange, style, fontSize }: { hour: number; minute: number; onChange: (hour: number, minute: number) => void; style: FieldStyle; fontSize: number }) {
  const value = `${pad(hour)}:${pad(minute)}`;
  if (Platform.OS === "web") {
    return React.createElement("input", {
      type: "time",
      value,
      step: 300,
      "aria-label": "Time",
      onChange: (e: { target: { value: string } }) => {
        const m = /^(\d{1,2}):(\d{2})/.exec(e.target.value);
        if (m) onChange(Number(m[1]) % 24, Number(m[2]) % 60);
      },
      style: webField(style, fontSize),
    });
  }
  const step = (delta: number) => {
    const total = (hour * 60 + minute + delta + 1440) % 1440;
    onChange(Math.floor(total / 60), total % 60);
  };
  return (
    <View style={[styles.nativeField, styles.stepper, { backgroundColor: style.backgroundColor, borderColor: style.borderColor }]}>
      <Pressable onPress={() => step(-15)} accessibilityRole="button" accessibilityLabel="Earlier" hitSlop={6}>
        <Text variant="title">−</Text>
      </Pressable>
      <Text variant="body" style={styles.clock}>
        {value}
      </Text>
      <Pressable onPress={() => step(15)} accessibilityRole="button" accessibilityLabel="Later" hitSlop={6}>
        <Text variant="title">+</Text>
      </Pressable>
    </View>
  );
}

function webField(style: FieldStyle, fontSize: number): Record<string, unknown> {
  return {
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    fontSize,
    fontWeight: 600,
    color: style.color,
    backgroundColor: style.backgroundColor,
    border: `1px solid ${style.borderColor}`,
    borderRadius: radius.lg,
    padding: "9px 10px",
    minHeight: 44,
    colorScheme: "light dark",
  };
}

const styles = StyleSheet.create({
  wrap: { gap: space.sm },
  bold: { fontWeight: "600" },
  days: { flexDirection: "row", gap: 6 },
  day: { flex: 1, maxWidth: 44, aspectRatio: 1, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  shortcuts: { flexDirection: "row", gap: space.lg },
  when: { flexDirection: "row", alignItems: "center", gap: space.sm, flexWrap: "wrap" },
  nativeField: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.lg, paddingHorizontal: space.md, minHeight: 44, justifyContent: "center" },
  stepper: { flexDirection: "row", alignItems: "center", gap: space.md },
  clock: { minWidth: 56, textAlign: "center", fontVariant: ["tabular-nums"], fontWeight: "600" },
  advanced: { gap: space.xs },
  advancedLink: { alignSelf: "flex-start" },
  input: { borderWidth: StyleSheet.hairlineWidth, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
});
