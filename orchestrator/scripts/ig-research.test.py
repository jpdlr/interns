"""ig-research against a local fake Graph API: profiles, hashtags, quota and errors in plain words.

    python3 scripts/ig-research.test.py

No network: IG_GRAPH_BASE points the tool at a server on 127.0.0.1.
"""
import json, os, subprocess, tempfile, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

TOOL = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "tools", "ig-research")
requests = []


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
                    {"id": "m1", "caption": "x" * 1500, "like_count": 40, "comments_count": 10, "media_type": "IMAGE"},
                    {"id": "m2", "caption": "hidden likes", "comments_count": 2, "media_type": "VIDEO"},
                ]}}, "id": "ig1"})
        if url.path == "/ig1":
            return self.send(200, {"username": "studio", "name": "Studio", "followers_count": 12, "media_count": 3, "id": "ig1"})
        if url.path == "/ig_hashtag_search":
            if q.get("q") == "full":
                return self.send(400, {"error": {"message": "reached maximum number of hashtags", "code": 24, "error_subcode": 2207042}})
            return self.send(200, {"data": [{"id": "h1"}] if q.get("q") != "nothing" else []})
        if url.path in ("/h1/top_media", "/h1/recent_media"):
            n = int(q.get("limit", "25"))
            return self.send(200, {"data": [{"id": f"{url.path}-{i}", "caption": "#capetown", "like_count": i} for i in range(n + 5)]})
        if url.path == "/ig1/recently_searched_hashtags":
            return self.send(200, {"data": [{"id": "h1", "name": "capetown"}, {"id": "h2", "name": "coffee"}]})
        return self.send(404, {"error": {"message": f"unexpected {url.path}", "code": 100}})


server = HTTPServer(("127.0.0.1", 0), FakeGraph)
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
check("profile: long captions are trimmed", len(out["recent_posts"][0]["caption"]) == 1001 and out["recent_posts"][0]["caption"].endswith("…"))
check("profile: engagement skips hidden likes", out["engagement"] == {"posts_counted": 2, "avg_likes": 40.0, "avg_comments": 6.0, "engagement_rate_pct": 4.6, "likes_hidden_on": 1}, out["engagement"])

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
