#!/usr/bin/env python3
"""Builds the README art from the animated faces: hero.svg and crew.svg.

    python3 docs/images/build-art.py

Each face is inlined as a nested <svg> (their CSS class names and ids are
already unique per face), so the CSS animations keep running when GitHub
shows the file through an <img>.
"""
import os, re

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
FACES = os.path.join(ROOT, "avatars", "faces")
OUT = os.path.dirname(os.path.abspath(__file__))
FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"


def face(name, x, y, size):
    path = os.path.join(ROOT, "avatars", "coordinator.svg") if name == "coordinator" else os.path.join(FACES, f"{name}.svg")
    svg = open(path).read().strip()
    svg = re.sub(r"<\?xml[^>]*>", "", svg)
    return re.sub(r"^<svg\b", f'<svg x="{x}" y="{y}" width="{size}" height="{size}"', svg, count=1)


def background(w, h):
    return f'''<defs>
    <linearGradient id="art-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b0d12"/><stop offset="0.6" stop-color="#12151d"/><stop offset="1" stop-color="#1a1430"/>
    </linearGradient>
    <radialGradient id="art-glow" cx="0.5" cy="0.95" r="0.6">
      <stop offset="0" stop-color="#8b5cf6" stop-opacity="0.35"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="{w}" height="{h}" rx="24" fill="url(#art-bg)"/>
  <rect width="{w}" height="{h}" rx="24" fill="url(#art-glow)"/>'''


def sparkle(x, y, r, opacity):
    return (f'<path transform="translate({x} {y}) scale({r})" d="M0 -1 C0.12 -0.12 0.12 -0.12 1 0 C0.12 0.12 0.12 0.12 0 1 '
            f'C-0.12 0.12 -0.12 0.12 -1 0 C-0.12 -0.12 -0.12 -0.12 0 -1Z" fill="#fff" opacity="{opacity}"/>')


def hero():
    w, h = 1280, 340
    crew = ["face-05", "face-11", "face-02", "face-07", "coordinator", "face-19", "face-14", "face-01", "face-17"]
    size, big, gap = 104, 150, 18
    widths = [big if n == "coordinator" else size for n in crew]
    x = (w - sum(widths) - gap * (len(crew) - 1)) / 2
    faces = []
    for name, s in zip(crew, widths):
        faces.append(face(name, round(x), 318 - s, s))
        x += s + gap
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="Interns — a crew of AI agents that work for you">
  {background(w, h)}
  {sparkle(140, 70, 14, 0.35)}{sparkle(1150, 92, 18, 0.8)}{sparkle(1080, 40, 8, 0.3)}{sparkle(220, 150, 7, 0.25)}
  <text x="{w/2}" y="104" text-anchor="middle" font-family="{FONT}" font-size="76" font-weight="800" fill="#f5f6fa" letter-spacing="-1">Interns</text>
  <text x="{w/2}" y="150" text-anchor="middle" font-family="{FONT}" font-size="24" fill="#a8b1c2">A crew of AI agents that work for you, run by the Coordinator</text>
  <rect x="{w/2 - 60}" y="172" width="64" height="6" rx="3" fill="#8b5cf6"/><rect x="{w/2 + 12}" y="172" width="24" height="6" rx="3" fill="#f59e0b"/><rect x="{w/2 + 44}" y="172" width="12" height="6" rx="3" fill="#22c55e"/>
  {"".join(faces)}
</svg>
'''


def crew():
    cols, size, gap, pad = 10, 96, 16, 28
    names = [f"face-{i:02d}" for i in range(1, 21)]
    w = pad * 2 + cols * size + (cols - 1) * gap
    h = pad * 2 + 2 * size + gap
    faces = [face(n, pad + (i % cols) * (size + gap), pad + (i // cols) * (size + gap), size) for i, n in enumerate(names)]
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}" role="img" aria-label="The 20 animated intern faces">
  {background(w, h)}
  {"".join(faces)}
</svg>
'''


for name, svg in (("hero.svg", hero()), ("crew.svg", crew())):
    with open(os.path.join(OUT, name), "w") as f:
        f.write(svg)
    print(name, len(svg) // 1024, "KB")
