# Interns — animated avatars

Two themed sets, cross-linked from each gallery's header:

- **Blobs** (`avatar-01..20.svg`, `preview.html`) — abstract luminous gradient beings, below.
- **Bot faces** (`faces/face-01..20.svg`, `faces/preview.html`) — Grok-companion-style bot
  faces: matte rounded heads in varied shapes (TV, cloud, gear, spiky sun, gem, tower,
  bean, droplet, a tiny wanderer, a huge crop where only the eyes fit) and bold colors (about
  a third white/cream, the rest coral, teal, amber, violet, sky, mint, rose, navy…);
  dark heads get light eyes. Only the eyes carry expression. Each face runs a 11-19s
  choreographed idle loop — staggered natural blinking plus sequenced glances with held
  pauses, nods/tilts/bounces, drift, and mood shifts (squints, surprise widens, one wink)
  — and about half have one tiny feature (antenna, halo, beret, sprout, ear nubs,
  freckles, tail wisp, satellite dot). Animation is pure CSS keyframes inside each SVG
  (transform on groups, `transform-box: fill-box`) so faces keep moving on iOS Safari even
  in Low Power Mode, where SMIL is paused; no SMIL is used. < 4 KB each.

## Blobs

20 abstract luminous "beings" for the intern crew: fluid glowing gradient forms
on dark backgrounds (Grok-logo aesthetic — no faces, no strokes, no flat icons).
Each is a self-contained 256x256 SVG with a continuous SMIL idle animation
(4–10s eased loops: breathe, morph, orbit, shimmer). No external dependencies;
they animate even when embedded via `<img>`.

## The set

| id | vibe |
|----|------|
| avatar-01 | Milo — warm amber orb |
| avatar-02 | Nia — teal droplet |
| avatar-03 | Zara — magenta flame |
| avatar-04 | Kai — violet crystal |
| avatar-05 | Auric — gold halo ring |
| avatar-06 | Vesper — indigo ribbon |
| avatar-07 | Luna — lavender nebula |
| avatar-08 | Gemma — coral twin orbs |
| avatar-09 | Fern — emerald spiral |
| avatar-10 | Sterling — silver ripple orb |
| avatar-11 | Ember — red-orange ember |
| avatar-12 | Sage — spring green petal |
| avatar-13 | Marlow — deep blue wave |
| avatar-14 | Sol — warm white pulse star |
| avatar-15 | Selene — silver-blue crescent |
| avatar-16 | Citron — chartreuse ribbon flame |
| avatar-17 | Nova — cyan-magenta vortex ring |
| avatar-18 | Wren — pink-violet jelly |
| avatar-19 | Vega — ice blue comet |
| avatar-20 | Onyx — graphite knot |

## Viewing the gallery

```sh
cd avatars
python3 -m http.server 8080
# open http://localhost:8080/preview.html
```

The gallery has a light/dark background toggle to check both modes.
Both galleries fetch and inline the SVG markup into the page (each tile in its own
shadow root), which is the most reliable way to keep animations running on iOS. When
opened via file:// the fetch may be blocked; the pages then fall back to `<img>` tags
(fine on desktop, may freeze SMIL blobs on iOS — serve over http for the real thing).

## Conventions (for adding more)

- 256x256 viewBox, transparent background, content in `<g transform="translate(128 128)">`.
- Layered look: soft radial-gradient halo behind, gradient body, bright inner core.
- Stroke-free; glow via gradient opacity falloff or feGaussianBlur.
- SMIL animations, calcMode="spline" easing, 4–10s loops, nothing frantic.
- Dark outer gradient stops so shapes still read on white.
