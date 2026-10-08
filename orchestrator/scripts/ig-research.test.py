"""ig-research against a local fake Graph API: profiles, hashtags, quota, saved media and errors in plain words.

    python3 scripts/ig-research.test.py

No network: IG_GRAPH_BASE points the tool at a server on 127.0.0.1.
"""
import glob, io, json, os, subprocess, tempfile, threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

TOOL = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "tools", "ig-research")
requests = []
media_hits = []
VIDEO = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 4000
CAP = 25 * 1024 * 1024


class FakeGraph(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.startswith(("/img/", "/vid/")):
            media_hits.append(url.path)
        if url.path.startswith("/img/"):
            from PIL import Image
            buf = io.BytesIO()
            # "full-" images stand for a post's full-size media_url; the rest for covers and thumbnails
            Image.new("RGB", (1080, 1350) if "/full-" in url.path else (640, 640), (200, 120, 40)).save(buf, "JPEG")
            raw = buf.getvalue()
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            return self.wfile.write(raw)
        if url.path.startswith("/vid/"):
            self.send_response(200)
            self.send_header("Content-Type", "video/mp4")
            try:
                if url.path == "/vid/huge.mp4":  # says up front it's too big
                    self.send_header("Content-Length", str(CAP + 1024 * 1024))
                    self.end_headers()
                    return self.wfile.write(VIDEO)
                if url.path == "/vid/endless.mp4":  # no length: only reading finds out
                    self.end_headers()
                    for _ in range(CAP // len(VIDEO) + 300):
                        self.wfile.write(VIDEO)
                    return
                self.send_header("Content-Length", str(len(VIDEO)))
                self.end_headers()
                return self.wfile.write(VIDEO)
            except (BrokenPipeError, ConnectionResetError):
                return
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        requests.append((url.path, q))
        if q.get("access_token") != "PAGE-TOKEN":
            return self.send(400, {"error": {"message": "Invalid OAuth access token.", "code": 190}})
        fields = q.get("fields", "")
        if url.path == "/ig1" and "business_discovery.username(personalfriend)" in fields:
            return self.send(400, {"error": {"message": "Invalid user id", "code": 110, "error_subcode": 2207013}})
        if url.path == "/ig1" and "business_discovery.username(rival)" in fields:
            return self.send(200, {"business_discovery": {
                "username": "rival", "name": "Rival Co", "followers_count": 1000, "media_count": 3, "id": "ig9",
                "media": {"data": [
                    {"id": "m1", "caption": "x" * 1500, "like_count": 40, "comments_count": 10, "media_type": "IMAGE", "media_url": f"{base}/img/m1.jpg"},
                    {"id": "m2", "caption": "hidden likes", "comments_count": 2, "media_type": "VIDEO", "media_url": f"{base}/vid/m2.mp4", "thumbnail_url": f"{base}/img/m2.jpg"},
                ]}}, "id": "ig1"})
        if url.path == "/ig1" and "business_discovery.username(saver)" in fields:
            slides = "children{media_type,media_url,thumbnail_url}" in fields
            posts = [
                {"id": "s1", "media_type": "IMAGE", "media_url": f"{base}/img/full-s1.jpg", "permalink": "https://www.instagram.com/p/s1/"},
                {"id": "s2", "media_type": "VIDEO", "media_product_type": "REELS", "media_url": f"{base}/vid/s2.mp4", "thumbnail_url": f"{base}/img/s2-cover.jpg"},
                {"id": "s3", "media_type": "VIDEO", "media_product_type": "REELS", "thumbnail_url": f"{base}/img/s3-cover.jpg"},  # copyrighted audio: no media_url
                {"id": "s4", "media_type": "CAROUSEL_ALBUM", "media_url": f"{base}/img/full-s4.jpg", **({"children": {"data": [
                    {"id": "s4a", "media_type": "IMAGE", "media_url": f"{base}/img/full-s4a.jpg"},
                    {"id": "s4b", "media_type": "VIDEO", "media_url": f"{base}/vid/s4b.mp4", "thumbnail_url": f"{base}/img/s4b-cover.jpg"},
                    {"id": "s4c", "media_type": "IMAGE"},
                ]}} if slides else {})},
                {"id": "s5", "media_type": "VIDEO", "media_url": f"{base}/vid/huge.mp4", "thumbnail_url": f"{base}/img/s5-cover.jpg"},
                {"id": "s6", "media_type": "VIDEO", "media_url": f"{base}/vid/endless.mp4"},
            ]
            limit = int(fields.split("media.limit(")[1].split(")")[0])
            return self.send(200, {"business_discovery": {"username": "saver", "followers_count": 10, "media": {"data": posts[:limit]}}, "id": "ig1"})
        if url.path == "/ig1":
            return self.send(200, {"username": "studio", "name": "Studio", "followers_count": 12, "media_count": 3, "id": "ig1"})
        if url.path == "/ig_hashtag_search":
            if q.get("q") == "full":
                return self.send(400, {"error": {"message": "reached maximum number of hashtags", "code": 24, "error_subcode": 2207042}})
            return self.send(200, {"data": [{"id": "h2" if q.get("q") == "noslides" else "h1"}] if q.get("q") != "nothing" else []})
        if url.path in ("/h1/top_media", "/h1/recent_media"):
            n = int(q.get("limit", "25"))
            posts = [{"id": f"{url.path}-{i}", "caption": "#capetown", "like_count": i} for i in range(n + 5)]
            if "children{" in fields:
                posts[0].update({"media_type": "CAROUSEL_ALBUM", "media_url": f"{base}/img/full-t1.jpg", "children": {"data": [
                    {"media_type": "IMAGE", "media_url": f"{base}/img/full-t1a.jpg"}, {"media_type": "VIDEO", "media_url": f"{base}/vid/t1b.mp4"}]}})
            return self.send(200, {"data": posts})
        if url.path == "/h2/top_media":  # an endpoint that refuses the nested children field
            if "children" in fields:
                return self.send(400, {"error": {"message": "(#100) Tried accessing nonexisting field (children)", "code": 100}})
            return self.send(200, {"data": [{"id": "t9", "media_type": "CAROUSEL_ALBUM", "media_url": f"{base}/img/full-t9.jpg"}]})
        if url.path == "/ig1/recently_searched_hashtags":
            return self.send(200, {"data": [{"id": "h1", "name": "capetown"}, {"id": "h2", "name": "coffee"}]})
        return self.send(404, {"error": {"message": f"unexpected {url.path}", "code": 100}})


server = ThreadingHTTPServer(("127.0.0.1", 0), FakeGraph)
threading.Thread(target=server.serve_forever, daemon=True).start()
home = tempfile.mkdtemp(prefix="interns-ig-")
base = f"http://127.0.0.1:{server.server_port}"


def run(*args):
    env = {**os.environ, "INTERNS_HOME": home, "IG_GRAPH_BASE": base}
    p = subprocess.run([TOOL, *args], env=env, capture_output=True, text=True, timeout=30)
    try:
        return p.returncode, json.loads(p.stdout)
    except ValueError:
        return p.returncode, {"raw": p.stdout + p.stderr}


failures = 0


def check(name, cond, detail=""):
    global failures
    print(f"  ok  {name}" if cond else f"FAIL  {name} {detail}")
    failures += 0 if cond else 1


code, out = run("whoami")
check("not connected says where to connect", code == 1 and "Settings › Connectors › Instagram" in out.get("error", ""), out)

os.makedirs(os.path.join(home, "instagram"))
with open(os.path.join(home, "instagram", "config.json"), "w") as f:
    json.dump({"ig_user_id": "ig1", "ig_username": "studio", "page_name": "Studio", "page_token": "PAGE-TOKEN", "user_token": "USER"}, f)

code, out = run("whoami")
check("whoami uses the Page token", code == 0 and out["username"] == "studio" and out["page"] == "Studio", out)

code, out = run("profile", "@rival", "--posts", "2")
check("profile: business discovery with the posts asked for", code == 0 and out["username"] == "rival" and len(out["recent_posts"]) == 2, out)
check("profile: media.limit is passed", "media.limit(2)" in requests[-1][1]["fields"], requests[-1])
check("profile: carousel slides are only asked for with --save", "children" not in requests[-1][1]["fields"], requests[-1])
check("profile: long captions are trimmed", len(out["recent_posts"][0]["caption"]) == 1001 and out["recent_posts"][0]["caption"].endswith("…"))
check("profile: image URLs are left out of the answer", all("media_url" not in p and "thumbnail_url" not in p for p in out["recent_posts"]), out["recent_posts"])
check("profile: engagement skips hidden likes", out["engagement"] == {"posts_counted": 2, "avg_likes": 40.0, "avg_comments": 6.0, "engagement_rate_pct": 4.6, "likes_hidden_on": 1}, out["engagement"])

code, out = run("profile", "rival", "--posts", "2", "--sheet")
check("profile --sheet: the posts as one contact sheet (a video by its cover)", code == 0 and out.get("sheet", {}).get("images") == 2 and os.path.exists(out["sheet"]["path"]), out.get("sheet"))
check("profile --sheet: kept under INTERNS_HOME", out.get("sheet", {}).get("path", "").startswith(os.path.join(home, "instagram", "sheets")), out.get("sheet"))
post_images = out.get("sheet", {}).get("post_images", "")
check("profile --sheet: each post's own image beside the sheet, to attach", all(os.path.exists(post_images.replace("<number>", str(n))) for n in (1, 2)), out.get("sheet"))


def name(f):
    return os.path.basename(f["path"]) if f else None


code, out = run("profile", "saver", "--posts", "6", "--save")
posts = out.get("recent_posts", [])
folder = out.get("saved", {}).get("folder", "")
check("profile --save: asks for carousel slides", "children{media_type,media_url,thumbnail_url}" in requests[-1][1]["fields"], requests[-1])
check("profile --save: one folder under INTERNS_HOME/instagram/posts", code == 0 and os.path.dirname(folder) == os.path.join(home, "instagram", "posts")
      and os.path.basename(folder).startswith("saver-"), out.get("saved") or out)
check("profile --save: media URLs still left out of the answer", len(posts) == 6 and all(not {"media_url", "thumbnail_url", "children"} & set(p) for p in posts), posts)
p1, p2, p3, p4, p5, p6 = (posts + [{}] * 6)[:6]
check("profile --save: an image as <n>.jpg", [(name(f), f["kind"], f["cover"]) for f in p1.get("files", [])] == [("1.jpg", "image", None)] and "files_error" not in p1, p1)
try:
    from PIL import Image
    with Image.open(p1["files"][0]["path"]) as im:
        size = im.size
except Exception as e:
    size = e
check("profile --save: the full-size media_url, not a thumbnail", size == (1080, 1350), size)
f2 = (p2.get("files") or [{}])[0]
check("profile --save: a reel as <n>.mp4 with its cover", [(name(f), f["kind"], os.path.basename(f["cover"] or "")) for f in p2.get("files", [])] == [("2.mp4", "video", "2-cover.jpg")]
      and open(f2["path"], "rb").read() == VIDEO and os.path.exists(f2["cover"]), p2)
check("profile --save: no media_url (copyrighted audio) says why, keeps the cover, carries on",
      p3.get("files") == [] and "no media URL" in p3.get("files_error", "") and os.path.join(folder, "3-cover.jpg") in p3.get("files_error", "")
      and os.path.exists(os.path.join(folder, "3-cover.jpg")), p3)
check("profile --save: every carousel slide, in order, video with its cover",
      [(name(f), f["kind"], os.path.basename(f["cover"] or "")) for f in p4.get("files", [])] == [("4-1.jpg", "image", ""), ("4-2.mp4", "video", "4-2-cover.jpg")]
      and all(os.path.exists(f["path"]) for f in p4["files"]), p4)
check("profile --save: a slide without media is listed as skipped", "slide 3: " in p4.get("files_skipped", "") and "files_error" not in p4, p4)
check("profile --save: a video whose Content-Length is over 25 MB is skipped",
      p5.get("files") == [] and "26.0 MB, over the chat's 25 MB" in p5.get("files_error", "") and not glob.glob(os.path.join(folder, "5.*")), p5)
check("profile --save: a video without a length stops at 25 MB",
      p6.get("files") == [] and "over the chat's 25 MB" in p6.get("files_error", "") and not glob.glob(os.path.join(folder, "6.*")), p6)
check("profile --save: the count of files kept", out.get("saved", {}).get("files") == 4 and "note" not in out.get("saved", {}), out.get("saved"))

hits = len(media_hits)
code, out = run("profile", "saver", "--posts", "4", "--save", "--sheet")
check("profile --save --sheet: both, the sheet from what --save downloaded", code == 0 and out.get("saved", {}).get("files") == 4 and out.get("sheet", {}).get("images") == 4
      and len(media_hits) - hits == 7, (out.get("sheet"), media_hits[hits:]))

code, out = run("profile", "personalfriend")
check("profile: a personal account is explained", code == 1 and "Personal and private accounts" in out["error"], out)
code, out = run("profile", "not a name!")
check("profile: a bad username never reaches Instagram", code == 1 and "isn't an Instagram username" in out["error"], out)

n = len(requests)
code, out = run("hashtag", "#CapeTown", "--limit", "3")
check("hashtag: normalised, top posts, limited", code == 0 and out["hashtag"] == "capetown" and out["sort"] == "top" and len(out["posts"]) == 3, out)
check("hashtag: searched as lowercase without #", requests[n][1]["q"] == "capetown", requests[n])
code, out = run("hashtag", "capetown", "--recent")
check("hashtag: --recent reads recent_media", code == 0 and out["sort"] == "recent" and requests[-1][0] == "/h1/recent_media", requests[-1])
n = len(requests)
code, out = run("hashtag", "capetown", "--limit", "1", "--save")
post = (out.get("posts") or [{}])[0]
check("hashtag --save: a carousel's slides, under posts/tag-<tag>-<stamp>",
      code == 0 and [(name(f), f["kind"]) for f in post.get("files", [])] == [("1-1.jpg", "image"), ("1-2.mp4", "video")]
      and os.path.basename(out["saved"]["folder"]).startswith("tag-capetown-") and "children{" in requests[-1][1]["fields"], out)
check("hashtag --save: a slide video without a cover", post.get("files", [{}, {}])[1].get("cover") is None, post)
n = len(requests)
code, out = run("hashtag", "noslides", "--limit", "1", "--save")
post = (out.get("posts") or [{}])[0]
check("hashtag --save: where slides are refused, the carousel's first image and a note",
      code == 0 and [(name(f), f["kind"]) for f in post.get("files", [])] == [("1.jpg", "image")] and "first slide" in out.get("saved", {}).get("note", ""), out)
check("hashtag --save: tries slides with covers, then without, then none",
      [("children{media_type,media_url,thumbnail_url}" in q["fields"], "children{media_type,media_url}" in q["fields"]) for path, q in requests[n:] if path == "/h2/top_media"]
      == [(True, False), (False, True), (False, False)], requests[n:])

code, out = run("hashtag", "cape town")
check("hashtag: spaces are refused before searching", code == 1 and "no spaces or emoji" in out["error"], out)
code, out = run("hashtag", "full")
check("hashtag: the weekly limit is explained", code == 1 and "30 hashtag searches" in out["error"], out)
code, out = run("hashtag", "nothing")
check("hashtag: an unknown hashtag", code == 1 and "no hashtag #nothing" in out["error"], out)

code, out = run("quota")
check("quota: used and remaining", code == 0 and out["used"] == 2 and out["remaining"] == 28 and out["searched"] == ["capetown", "coffee"], out)

with open(os.path.join(home, "instagram", "config.json"), "w") as f:
    json.dump({"ig_user_id": "ig1", "page_token": "REVOKED"}, f)
code, out = run("whoami")
check("a revoked token says to reconnect", code == 1 and "expired or was revoked" in out["error"], out)

server.shutdown()
print("\nall ig-research checks passed" if failures == 0 else f"\n{failures} ig-research check(s) FAILED")
raise SystemExit(1 if failures else 0)
