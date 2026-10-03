/**
 * Renders an intern's animated avatar.
 *
 * WEB (today's target): the SVG markup is injected into the DOM so the CSS
 * keyframes inside it actually run. The faces animate via CSS transforms
 * only — no SMIL — which is what keeps them alive on iOS Safari, including
 * Low Power Mode, so a home-screen PWA still feels alive. Every placement
 * goes through this component for that reason: rendering a face as an <img>
 * or a background-image would freeze it.
 *
 * Faces are drawn on transparency by default. Dense layouts can opt into a
 * rounded clip so an unusually wide drawing or idle animation cannot escape
 * its allotted avatar column and overlap neighbouring content.
 *
 * On top of each face's own loop the wrapper adds a slow, small bob
 * (`interns-idle-bob`, defined in app/+html.tsx). Duration and negative delay
 * are derived from the face id and instance number so a screen full of faces
 * never pulses in unison, and the whole thing is disabled under
 * prefers-reduced-motion.
 *
 * NATIVE (later): react-native-svg's SvgXml renders the same markup but
 * ignores <style> keyframes, so the face is correct but static.
 * TODO(native): drive the idle loop with Reanimated — parse each face's
 * animated groups (class names f<NN>bl/nd/gl/dr…) into shared values, or
 * ship a per-face animation manifest generated alongside faces.generated.ts.
 */
import React, { useMemo } from "react";
import { Platform, View, type ViewStyle } from "react-native";
import { FACE_IDS, FACE_SVGS } from "../faces.generated";

export const COORDINATOR_FACE = "coordinator";

/**
 * Manifests may carry icon "default" (or an id we do not ship). Fall back to
 * a stable per-slug face so an intern always looks like itself.
 */
export function resolveFaceId(icon: string | undefined, slug: string): string {
  if (icon && FACE_SVGS[icon]) return icon;
  let hash = 0;
  for (let i = 0; i < slug.length; i += 1) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  return FACE_IDS[hash % FACE_IDS.length] ?? FACE_IDS[0];
}

const faceColorCache = new Map<string, string | null>();

/**
 * A face's body colour (its first saturated fill), so charts and other
 * per-intern accents can echo the face. Null for pale or grey faces.
 */
export function faceColor(id: string): string | null {
  if (faceColorCache.has(id)) return faceColorCache.get(id)!;
  const svg = FACE_SVGS[id] ?? "";
  let found: string | null = null;
  for (const match of svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)) {
    const hex = match[1]!;
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
    if (Math.max(r, g, b) - Math.min(r, g, b) >= 0.2) {
      found = hex;
      break;
    }
  }
  faceColorCache.set(id, found);
  return found;
}

/**
 * Ids inside a face (filter defs) are file-local, so two copies of the same
 * face on one page would collide in the DOM. Suffix them per instance.
 */
function uniquifyIds(svg: string, salt: string): string {
  const ids = new Set<string>();
  const idPattern = /\sid="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = idPattern.exec(svg)) !== null) ids.add(match[1]);
  let out = svg;
  for (const id of ids) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out
      .replace(new RegExp(`id="${escaped}"`, "g"), `id="${id}-${salt}"`)
      .replace(new RegExp(`url\\(#${escaped}\\)`, "g"), `url(#${id}-${salt})`);
  }
  return out;
}

let instanceCounter = 0;

export type FaceMood = "idle" | "thinking" | "away" | "glance-left" | "glance-right";
/** One-shot expressions layered over the mood; the caller bumps `reactionKey` to replay. */
export type FaceReaction = "wince" | "grin" | "yawn" | "nod";

/** Stable-ish jitter so a list of faces bobs out of phase. */
function bobStyle(seed: number, mode: FaceMood): Record<string, string> {
  if (mode === "away") {
    // Asleep at the desk: slow, low, tilted; the parent dims it.
    return {
      animationName: "interns-away-bob",
      animationDuration: `${(9 + (seed % 5) * 0.6).toFixed(2)}s`,
      animationDelay: `-${(seed % 7) * 0.4}s`,
      animationIterationCount: "infinite",
      animationTimingFunction: "cubic-bezier(.42,0,.58,1)",
    };
  }
  if (mode === "glance-left" || mode === "glance-right") {
    return {
      animationName: mode === "glance-left" ? "interns-glance-left" : "interns-glance-right",
      animationDuration: `${(4.5 + (seed % 4) * 0.3).toFixed(2)}s`,
      animationDelay: `-${(seed % 5) * 0.37}s`,
      animationIterationCount: "infinite",
      animationTimingFunction: "cubic-bezier(.42,0,.58,1)",
    };
  }
  if (mode === "thinking") {
    return {
      animationName: "interns-think-bob",
      animationDuration: `${(2.2 + (seed % 5) * 0.12).toFixed(2)}s`,
      animationDelay: `-${(seed % 7) * 0.19}s`,
      animationIterationCount: "infinite",
      animationTimingFunction: "cubic-bezier(.42,0,.58,1)",
    };
  }
  return {
    animationName: "interns-idle-bob",
    animationDuration: `${(7.5 + (seed % 9) * 0.45).toFixed(2)}s`,
    animationDelay: `-${(seed % 11) * 0.61}s`,
    animationIterationCount: "infinite",
    animationTimingFunction: "cubic-bezier(.42,0,.58,1)",
  };
}

export interface InternFaceProps {
  /** avatar id from the manifest, e.g. "face-05" or "coordinator" */
  id: string;
  size?: number;
  /** "thinking" = the livelier bob; "away" = dozing; "glance-*" = leaning toward a colleague */
  mood?: FaceMood;
  /** a one-shot expression; change `reactionKey` to replay the same reaction */
  reaction?: FaceReaction | null;
  reactionKey?: string | number;
  /** Keep the animated face inside a fixed, lightly rounded avatar viewport. */
  clipToBounds?: boolean;
  style?: ViewStyle;
}

const REACTION_MS: Record<FaceReaction, number> = { wince: 900, grin: 1100, yawn: 2400, nod: 800 };

function InternFaceImpl({ id, size = 44, mood = "idle", reaction = null, reactionKey, clipToBounds = false, style }: InternFaceProps) {
  const instance = useMemo(() => (instanceCounter += 1), []);
  // A reaction plays once, then the mood loop resumes.
  const [playing, setPlaying] = React.useState<FaceReaction | null>(null);
  React.useEffect(() => {
    if (!reaction) return;
    setPlaying(reaction);
    const timer = setTimeout(() => setPlaying(null), REACTION_MS[reaction]);
    return () => clearTimeout(timer);
  }, [reaction, reactionKey]);
  const salt = `i${instance}`;
  const svg = useMemo(() => {
    const raw = FACE_SVGS[id] ?? FACE_SVGS[COORDINATOR_FACE];
    return uniquifyIds(raw, salt);
  }, [id, salt]);

  const frame: ViewStyle = {
    width: size,
    height: size,
    overflow: clipToBounds ? "hidden" : "visible",
    ...(clipToBounds ? { borderRadius: Math.max(4, Math.round(size / 6)) } : {}),
  };

  if (Platform.OS === "web") {
    return (
      <View style={[frame, style]} pointerEvents="none">
        {/* eslint-disable-next-line react/no-danger */}
        {React.createElement("div", {
          style: {
            width: "100%",
            height: "100%",
            display: "flex",
            willChange: "transform",
            ...(playing
              ? {
                  animationName: `interns-react-${playing}`,
                  animationDuration: `${REACTION_MS[playing]}ms`,
                  animationIterationCount: "1",
                  animationTimingFunction: "cubic-bezier(.3,.7,.4,1)",
                  animationFillMode: "both",
                }
              : bobStyle(instance + id.length, mood)),
            ...(mood === "away" && !playing ? { opacity: 0.55, filter: "saturate(0.6)" } : {}),
          },
          dangerouslySetInnerHTML: { __html: svg },
        })}
      </View>
    );
  }
  return (
    <View style={[frame, style]} pointerEvents="none">
      <NativeFace svg={svg} size={size} />
    </View>
  );
}

/**
 * Memoised: a face re-mounting would restart its idle loop, and threads
 * re-render on every stream event. Mood and reaction changes do re-render.
 */
export const InternFace = React.memo(InternFaceImpl);

/** Static native rendering — see the TODO at the top of this file. */
function NativeFace({ svg, size }: { svg: string; size: number }) {
  // Required lazily so the web render path never touches the XML parser.
  const { SvgXml } = require("react-native-svg") as typeof import("react-native-svg");
  return <SvgXml xml={svg} width={size} height={size} />;
}
