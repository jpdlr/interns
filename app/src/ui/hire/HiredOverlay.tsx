/**
 * The hire moment: their face grins, a little confetti falls, and then
 * you're in their chat. A tap skips ahead.
 */
import React, { useEffect, useMemo, useRef } from "react";
import { Animated, Easing, Modal, Pressable, StyleSheet, View } from "react-native";
import { space, useAppTheme } from "../../theme";
import { Button } from "../Button";
import { InternFace } from "../InternFace";
import { Text } from "../Text";

const PIECES = 22;
const COLORS = ["#f2b13d", "#6fb1e8", "#ef7561", "#7fd8a6", "#b18cf2", "#f2d13d"];

export function HiredOverlay({ visible, name, faceId, onDone }: { visible: boolean; name: string; faceId: string; onDone: () => void }) {
  const { colors } = useAppTheme();
  const fall = useRef(new Animated.Value(0)).current;
  const pop = useRef(new Animated.Value(0.6)).current;
  const pieces = useMemo(
    () => Array.from({ length: PIECES }, (_, i) => ({ left: `${(i * 37) % 100}%`, delay: (i * 53) % 400, color: COLORS[i % COLORS.length]!, size: 6 + ((i * 7) % 6), spin: i % 2 ? 1 : -1 })),
    [],
  );

  useEffect(() => {
    if (!visible) return;
    fall.setValue(0);
    pop.setValue(0.6);
    Animated.parallel([
      Animated.timing(fall, { toValue: 1, duration: 2600, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.spring(pop, { toValue: 1, friction: 4, tension: 120, useNativeDriver: true }),
    ]).start();
    const timer = setTimeout(onDone, 3000);
    return () => clearTimeout(timer);
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onDone}>
      <Pressable style={[styles.backdrop, { backgroundColor: colors.bg }]} onPress={onDone} accessibilityLabel={`${name} is hired. Open their chat.`}>
        {pieces.map((p, i) => (
          <Animated.View
            key={i}
            pointerEvents="none"
            style={[
              styles.piece,
              {
                left: p.left as `${number}%`,
                width: p.size,
                height: p.size * 1.6,
                backgroundColor: p.color,
                transform: [
                  { translateY: fall.interpolate({ inputRange: [0, 1], outputRange: [-40 - p.delay / 4, 700 + p.delay] }) },
                  { rotate: fall.interpolate({ inputRange: [0, 1], outputRange: ["0deg", `${p.spin * 540}deg`] }) },
                ],
                opacity: fall.interpolate({ inputRange: [0, 0.9, 1], outputRange: [1, 1, 0] }),
              },
            ]}
          />
        ))}
        <Animated.View style={[styles.center, { transform: [{ scale: pop }] }]}>
          <InternFace id={faceId} size={140} clipToBounds reaction="grin" reactionKey={visible ? 1 : 0} />
          <Text variant="display" center>
            Welcome, {name}!
          </Text>
          <Text variant="subtle" center>
            {name} just joined the crew. Say hi.
          </Text>
          <View style={styles.button}>
            <Button label={`Open ${name}'s chat`} tone="primary" onPress={onDone} />
          </View>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  piece: { position: "absolute", top: 0, borderRadius: 2 },
  center: { alignItems: "center", gap: space.md, paddingHorizontal: space.xl },
  button: { marginTop: space.md },
});
