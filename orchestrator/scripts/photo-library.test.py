"""photo-library against a temporary library: stats, sheets, tagging by sheet number.

    python3 scripts/photo-library.test.py
"""
import json, os, subprocess, tempfile

from PIL import Image

TOOL = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "tools", "photo-library")
home = tempfile.mkdtemp(prefix="interns-photos-")
lib = os.path.join(home, "photos")
os.makedirs(os.path.join(lib, "img"))
os.makedirs(os.path.join(lib, "thumb"))
items = []
for n in range(5):
    for folder, size in (("img", 800), ("thumb", 200)):
        Image.new("RGB", (size, size * 2 // 3), (40 * n, 90, 160)).save(os.path.join(lib, folder, f"p{n}.jpg"))
    items.append({"id": f"p{n}", "file": f"img/p{n}.jpg", "thumb": f"thumb/p{n}.jpg", "type": "photo", "filename": f"IMG_{n}.jpg",
                  "created_at": f"2026-0{n + 1}-10T08:00:00Z", "width": 800, "height": 533, "camera": "Fujifilm X100V",
                  "imported_at": "2026-10-03T10:00:00Z", "batch": "s1"})
with open(os.path.join(lib, "library.json"), "w") as f:
    json.dump({"items": items}, f)

env = {**os.environ, "INTERNS_HOME": home, "INTERNS_INTERN": "milo"}
failures = 0


def run(*args, ok=True):
    out = subprocess.run([TOOL, *args], capture_output=True, text=True, env=env)
    if ok and out.returncode != 0:
        raise AssertionError(f"{args}: exit {out.returncode}: {out.stdout} {out.stderr}")
    lines = [json.loads(l) for l in out.stdout.splitlines() if l.strip()]
    return lines[0] if len(lines) == 1 else lines


def rows(*args):
    out = run(*args)
    return out if isinstance(out, list) else [out]


def check(name, fn):
    global failures
    try:
        fn()
        print(f"  ok  {name}")
    except Exception as err:  # noqa: BLE001
        failures += 1
        print(f"FAIL  {name}\n      {err}")


def stats():
    s = run("stats")
    assert s["photos"] == 5 and s["tagged"] == 0 and s["from"] == "2026-01-10" and s["to"] == "2026-05-10", s


def sheet_then_tag_by_number():
    s = run("sheet", "--untagged", "--limit", "3")
    assert os.path.exists(s["sheet"]) and s["count"] == 3, s
    assert [p["id"] for p in s["photos"]] == ["p4", "p3", "p2"], "newest first"
    with Image.open(s["sheet"]) as im:
        assert im.width > 3 * 300, im.size
    t = run("tag", "2", "--tags", "Watch, travel ,watch", "--note", "Alpinist on the dash", "--pick")
    assert t["id"] == "p3" and t["tags"] == ["travel", "watch"] and t["pick"] is True and t["by"] == "milo", t


def filters():
    assert [r["id"] for r in rows("list", "--tag", "watch")] == ["p3"]
    assert rows("list", "--picks")[0]["note"] == "Alpinist on the dash"
    assert len(rows("list", "--untagged")) == 4
    assert run("stats")["top_tags"] == [["travel", 1], ["watch", 1]]


def errors():
    assert "no photo 9" in run("tag", "9", "--tags", "x", ok=False)["error"]
    assert "no photo nope" in run("tag", "nope", "--tags", "x", ok=False)["error"]
    assert run("sheet", "--tag", "nothing", ok=False)["error"] == "no photos match"


check("stats: counts and date range", stats)
check("a contact sheet, then tag a photo by its number on it", sheet_then_tag_by_number)
check("filters: by tag, picks, untagged; top tags", filters)
check("errors are plain JSON", errors)
print("\nall photo-library checks passed" if not failures else f"\n{failures} photo-library check(s) FAILED")
raise SystemExit(1 if failures else 0)
