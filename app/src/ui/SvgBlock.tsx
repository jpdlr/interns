/**
 * Inline rendering for SVG an intern wrote in a ```svg fenced block (or an
 * uploaded .svg). Web draws it through an <img> with a data: URL, which is
 * the one SVG embedding the browser sandboxes completely (no scripts, no
 * external fetches, no access to the page). Native goes through
 * react-native-svg's SvgXml, which only understands drawing elements and
 * never executes anything. Both scale to the bubble width while keeping the
 * document's aspect ratio.
 */
import React, { useMemo, useState } from "react";
import { Image, Platform, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { SvgXml } from "react-native-svg";
import { radius, space, useAppTheme } from "../theme";
import { Text } from "./Text";

export interface SvgBlockProps {
  xml: string;
  /** cap the rendered height so a tall drawing does not take the whole thread */
  maxHeight?: number;
}

/** Aspect from width/height attributes, else the viewBox; 16:10 when neither parses. */
export function svgAspect(xml: string): number {
  const tag = /<svg[^>]*>/i.exec(xml)?.[0] ?? "";
  const w = Number(/\swidth=["']?([\d.]+)/i.exec(tag)?.[1]);
  const h = Number(/\sheight=["']?([\d.]+)/i.exec(tag)?.[1]);
  if (w > 0 && h > 0) return w / h;
  const vb = /viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(tag);
  if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) return Number(vb[1]) / Number(vb[2]);
  return 1.6;
}

/**
 * Make the markup safe and scalable: drop script/foreignObject/event handlers
 * and external hrefs, ensure the xmlns, and let it fill its box. The <img>
 * path would ignore scripts anyway; native has no scripting at all — this is
 * belt and braces plus the sizing fix.
 */
export function sanitizeSvg(raw: string): string {
  let xml = raw.trim();
  xml = xml.replace(/<\?xml[^>]*\?>/gi, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  xml = xml.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "");
  xml = xml.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, "");
  xml = xml.replace(/\s(xlink:href|href)\s*=\s*("(?:https?:|\/\/)[^"]*"|'(?:https?:|\/\/)[^']*')/gi, "");
  xml = xml.replace(/<svg\b([^>]*)>/i, (_m, attrs: string) => {
    let a = attrs;
    if (!/xmlns=/.test(a)) a += ' xmlns="http://www.w3.org/2000/svg"';
    if (!/viewBox=/i.test(a)) {
      const w = Number(/\swidth=["']?([\d.]+)/i.exec(a)?.[1]);
      const h = Number(/\sheight=["']?([\d.]+)/i.exec(a)?.[1]);
      if (w > 0 && h > 0) a += ` viewBox="0 0 ${w} ${h}"`;
    }
    a = a.replace(/\s(width|height)\s*=\s*("[^"]*"|'[^']*')/gi, "");
    return `<svg${a} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">`;
  });
  return xml;
}

export function svgDataUri(xml: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
}

function SvgBlockImpl({ xml, maxHeight = 360 }: SvgBlockProps) {
  const { colors } = useAppTheme();
  const [width, setWidth] = useState(0);
  const [broken, setBroken] = useState(false);
  const clean = useMemo(() => sanitizeSvg(xml), [xml]);
  const aspect = useMemo(() => svgAspect(xml), [xml]);
  const onLayout = (e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    if (w !== width) setWidth(w);
  };
  const height = width > 0 ? Math.min(maxHeight, Math.round(width / aspect)) : 0;
  const drawWidth = Math.min(width, Math.round(height * aspect));

  return (
    <View style={[styles.frame, { backgroundColor: colors.surface, borderColor: colors.border }]} onLayout={onLayout}>
      {width > 0 && !broken ? (
        <View style={{ width: drawWidth, height, alignSelf: "center" }}>
          {Platform.OS === "web" ? (
            <Image
              source={{ uri: svgDataUri(clean) }}
              style={{ width: drawWidth, height }}
              resizeMode="contain"
              accessibilityLabel="SVG drawing"
              onError={() => setBroken(true)}
            />
          ) : (
            <SvgXml xml={clean} width={drawWidth} height={height} onError={() => setBroken(true)} />
          )}
        </View>
      ) : broken ? (
        <Text variant="caption">This SVG could not be rendered — open it to view the source.</Text>
      ) : null}
    </View>
  );
}

export const SvgBlock = React.memo(SvgBlockImpl);

const styles = StyleSheet.create({
  frame: {
    width: "100%",
    minWidth: 220,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    padding: space.sm,
    marginVertical: space.xs,
    overflow: "hidden",
  },
});
