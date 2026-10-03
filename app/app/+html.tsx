/**
 * The HTML shell for every statically-exported web page (expo-router web
 * convention). This is where the PWA lives: manifest link, iOS home-screen
 * meta tags, a hard dark background so there is no white flash on launch, the
 * safe-area inset every screen sits inside, and the one global keyframe the
 * faces layer onto their own idle loops.
 *
 * There is deliberately no JavaScript here. Earlier versions mirrored
 * visualViewport geometry into custom properties to keep the composer above
 * the iOS keyboard; three rounds of that never survived contact with a real
 * iPhone, so the app now stays in ordinary document flow and lets iOS move the
 * page itself when the keyboard opens. See "The thread screen on iOS" in the
 * README.
 */
import { ScrollViewStyleReset } from "expo-router/html";
import React from "react";

export default function Root({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        {/* viewport-fit=cover is what makes env(safe-area-inset-*) non-zero in
            a standalone PWA; without it iOS letterboxes the app instead. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
        />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#09090b" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff" />
        <meta name="color-scheme" content="dark light" />

        {/* Draw below the translucent iOS status bar. The standalone 100vh
            override below works around WebKit reporting dynamic viewport units
            one inset too short. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Interns" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.json" />

        {/* Keeps body scroll from fighting react-native-web ScrollViews. */}
        <ScrollViewStyleReset />
        <style dangerouslySetInnerHTML={{ __html: bodyStyle }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

const bodyStyle = `
/* Bumped whenever this stylesheet changes so the Settings diagnostics can say
   which shell an installed PWA is actually running (they cache aggressively). */
:root {
  --interns-shell: "shadcn-theme-v1";
  --interns-bg: #ffffff;
  --interns-focus: #18181b;
  background-color: var(--interns-bg);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --interns-bg: #09090b;
    --interns-focus: #fafafa;
    color-scheme: dark;
  }
}
:root[data-theme="light"] {
  --interns-bg: #ffffff;
  --interns-focus: #18181b;
  color-scheme: light;
}
:root[data-theme="dark"] {
  --interns-bg: #09090b;
  --interns-focus: #fafafa;
  color-scheme: dark;
}
html, body {
  background-color: var(--interns-bg);
  height: 100%;
  overflow: hidden;
  /* Kills the rubber-band scroll without pinning the body. A fixed body was
     part of the old keyboard machinery and is exactly what stopped iOS from
     moving the page to reveal the focused composer. */
  overscroll-behavior: none;
  -webkit-tap-highlight-color: transparent;
}
/* Ordinary document flow, one screen tall. Nothing is transformed and nothing
   listens to the viewport: when the keyboard opens iOS pans the page itself,
   which is the behaviour we want. */
#root {
  background-color: var(--interns-bg);
  height: 100%;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  /* The edge-to-edge app draws below the status bar, so clear the clock once
     here rather than in every screen header. */
  box-sizing: border-box;
  padding-top: env(safe-area-inset-top);
}
/* WebKit bug 254868: in an installed PWA, 100dvh/100svh can resolve to the
   physical screen height minus a safe-area inset, while 100vh includes the
   complete standalone canvas. The affected phone reports 812px from dvh on
   an 874px screen, which is the exact 62px gap visible below the tab bar. */
@media (display-mode: standalone) {
  html, body, #root {
    height: 100vh;
  }
}
/* React Navigation owns the tab bar's position, height, and safe-area padding.
   In particular, do not trim its bottom inset: on a correctly aligned iOS
   viewport that would put the labels on top of the home indicator. */
input, textarea { -webkit-user-select: text; }
/* The default focus ring reads as a stray white box on a dark chat screen;
   the field already changes nothing else, so tint its own border instead. */
input:focus, textarea:focus { outline: none; border-color: var(--interns-focus) !important; }
/* The composer is a real textarea so iOS offers a return key for newlines. */
textarea { resize: none; }
/* Long-press opens the app's own message menu; iOS must not also start a text
   selection or show its Copy/Look Up callout. Inputs, and anything the app
   marks selectable (code blocks), keep normal selection. */
body { -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; }
input, textarea, [style*="user-select: text"], [style*="-webkit-user-select: text"] { -webkit-user-select: text !important; user-select: text !important; -webkit-touch-callout: default; }

/* A slow, small, staggered bob layered on top of each face's own idle loop —
   enough to read as alive, not enough to be a fidget. */
@keyframes interns-idle-bob {
  0%   { transform: translate3d(0, 0, 0) rotate(0deg); }
  25%  { transform: translate3d(0, -4%, 0) rotate(-1.1deg); }
  50%  { transform: translate3d(0, 1.5%, 0) rotate(0.5deg); }
  75%  { transform: translate3d(0, -2.5%, 0) rotate(0.9deg); }
  100% { transform: translate3d(0, 0, 0) rotate(0deg); }
}
@keyframes interns-think-bob {
  0%   { transform: translate3d(0, 0, 0) rotate(0deg); }
  30%  { transform: translate3d(0, -9%, 0) rotate(-2deg); }
  60%  { transform: translate3d(0, 3%, 0) rotate(1.4deg); }
  100% { transform: translate3d(0, 0, 0) rotate(0deg); }
}
/* Moods: dozing at the desk; leaning toward a colleague. */
@keyframes interns-away-bob {
  0%   { transform: translate3d(0, 4%, 0) rotate(7deg); }
  50%  { transform: translate3d(0, 6%, 0) rotate(9deg); }
  100% { transform: translate3d(0, 4%, 0) rotate(7deg); }
}
@keyframes interns-glance-left {
  0%   { transform: translate3d(0, 0, 0) rotate(0deg); }
  35%  { transform: translate3d(-9%, -2%, 0) rotate(-8deg); }
  70%  { transform: translate3d(-7%, 0, 0) rotate(-6deg); }
  100% { transform: translate3d(0, 0, 0) rotate(0deg); }
}
@keyframes interns-glance-right {
  0%   { transform: translate3d(0, 0, 0) rotate(0deg); }
  35%  { transform: translate3d(9%, -2%, 0) rotate(8deg); }
  70%  { transform: translate3d(7%, 0, 0) rotate(6deg); }
  100% { transform: translate3d(0, 0, 0) rotate(0deg); }
}
/* One-shot reactions: wince (recoil + shake), grin (bounce + stretch), yawn (slow stretch back), nod. */
@keyframes interns-react-wince {
  0%   { transform: translate3d(0, 0, 0) rotate(0deg) scale(1, 1); }
  15%  { transform: translate3d(-6%, 3%, 0) rotate(-9deg) scale(1.05, 0.9); }
  35%  { transform: translate3d(6%, 3%, 0) rotate(8deg) scale(1.05, 0.9); }
  55%  { transform: translate3d(-4%, 2%, 0) rotate(-5deg) scale(1.03, 0.94); }
  75%  { transform: translate3d(3%, 1%, 0) rotate(3deg) scale(1.01, 0.98); }
  100% { transform: translate3d(0, 0, 0) rotate(0deg) scale(1, 1); }
}
@keyframes interns-react-grin {
  0%   { transform: translate3d(0, 0, 0) scale(1, 1); }
  25%  { transform: translate3d(0, -16%, 0) scale(0.94, 1.1) rotate(-3deg); }
  45%  { transform: translate3d(0, 3%, 0) scale(1.1, 0.92) rotate(2deg); }
  65%  { transform: translate3d(0, -8%, 0) scale(0.98, 1.04) rotate(-1deg); }
  100% { transform: translate3d(0, 0, 0) scale(1, 1) rotate(0deg); }
}
@keyframes interns-react-yawn {
  0%   { transform: translate3d(0, 0, 0) scale(1, 1) rotate(0deg); }
  30%  { transform: translate3d(0, -5%, 0) scale(0.96, 1.12) rotate(-4deg); }
  60%  { transform: translate3d(0, -4%, 0) scale(0.97, 1.1) rotate(-3deg); }
  100% { transform: translate3d(0, 2%, 0) scale(1, 1) rotate(0deg); }
}
@keyframes interns-react-nod {
  0%   { transform: translate3d(0, 0, 0) rotate(0deg); }
  30%  { transform: translate3d(0, 8%, 0) rotate(4deg); }
  60%  { transform: translate3d(0, -3%, 0) rotate(-2deg); }
  100% { transform: translate3d(0, 0, 0) rotate(0deg); }
}
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; }
}
`;
