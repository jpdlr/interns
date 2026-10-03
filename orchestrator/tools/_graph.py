"""Shared plumbing for graph-login, graph-mail and graph-cal.

Settings come from ~/.interns/config.json (INTERNS_HOME overrides the base
dir), the same file the orchestrator reads:

    "mailboxes": ["work", "personal"],      # first one is the default
    "graph": {"client_id": "<app id>", "authority": "organizations"},
    "timezone": "Europe/London"             # empty = this machine's zone

Each mailbox id is a directory, ~/.interns/mailboxes/<id>/, holding that
mailbox's MSAL device-flow token cache (token.json) and a small config.json
(mailbox_label, optional per-mailbox client_id). `graph-login` creates both.
"""
import json, os, sys

TOOLS_DIR = os.path.dirname(os.path.realpath(__file__))
MAIL_SCOPES = ["https://graph.microsoft.com/Mail.ReadWrite"]
CAL_SCOPES = ["https://graph.microsoft.com/Calendars.Read"]


def interns_home():
    return os.environ.get("INTERNS_HOME") or os.path.expanduser("~/.interns")


def settings():
    try:
        with open(os.path.join(interns_home(), "config.json")) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def mailbox_dirs():
    """{id: dir} for every configured mailbox (or every directory, if none are listed)."""
    root = os.path.join(interns_home(), "mailboxes")
    ids = [m for m in settings().get("mailboxes") or [] if isinstance(m, str)]
    if not ids and os.path.isdir(root):
        ids = sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
    return {m: os.path.join(root, m) for m in ids}


def default_mailbox(mailboxes):
    return next(iter(mailboxes), None)


def local_timezone():
    """IANA zone for calendar times: config `timezone`, else TZ, else this machine's zone."""
    tz = settings().get("timezone") or os.environ.get("TZ", "").lstrip(":")
    if tz:
        return tz
    try:
        with open("/etc/timezone") as f:
            tz = f.read().strip()
        if tz:
            return tz
    except OSError:
        pass
    try:
        link = os.path.realpath("/etc/localtime")
        if "zoneinfo/" in link:
            return link.split("zoneinfo/", 1)[1]
    except OSError:
        pass
    return "UTC"


def mailbox_config(mailbox_dir):
    try:
        with open(os.path.join(mailbox_dir, "config.json")) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def client_settings(mailbox_dir):
    """(client_id, authority) for a mailbox: its own config.json, then config.json's graph block, then env."""
    graph = settings().get("graph") or {}
    client_id = (mailbox_config(mailbox_dir).get("client_id") or graph.get("client_id")
                 or os.environ.get("INTERNS_GRAPH_CLIENT_ID"))
    authority = graph.get("authority") or "organizations"
    return client_id, f"https://login.microsoftonline.com/{authority}"


def ensure_msal():
    """Re-run this tool under orchestrator/.venv (or INTERNS_PYTHON) when msal is not importable here."""
    try:
        import msal  # noqa: F401
        return
    except ImportError:
        pass
    python = os.environ.get("INTERNS_PYTHON") or os.path.join(TOOLS_DIR, "..", ".venv", "bin", "python")
    # a venv's python is usually a symlink to this very interpreter, so guard with a marker, not paths
    if os.path.exists(python) and not os.environ.get("_INTERNS_REEXEC"):
        os.environ["_INTERNS_REEXEC"] = "1"
        os.execv(python, [python, os.path.realpath(sys.argv[0]), *sys.argv[1:]])
    print(json.dumps({"error": "the msal package is missing — run: python3 -m venv orchestrator/.venv && "
                               "orchestrator/.venv/bin/pip install -r orchestrator/tools/requirements.txt"}))
    sys.exit(1)


def get_token(mailbox_dir, scopes, tool, die):
    """A Graph access token from the mailbox's device-flow cache; refreshes and atomically rewrites it."""
    import msal
    cache_path = os.path.join(mailbox_dir, "token.json")
    cache = msal.SerializableTokenCache()
    try:
        raw = open(cache_path).read()
    except FileNotFoundError:
        die(f"no token cache at {cache_path} — run tools/graph-login --mailbox {os.path.basename(mailbox_dir)} first")
    except PermissionError:
        die(f"permission denied reading {cache_path} — this mailbox dir belongs to a different OS user; "
            f"{tool} cannot access it as the current user, this is not an auth problem")
    cache.deserialize(raw)
    client_id, authority = client_settings(mailbox_dir)
    if not client_id:
        die("no Microsoft Graph client id — set graph.client_id in ~/.interns/config.json (see README › Outlook)")
    app = msal.PublicClientApplication(client_id, authority=authority, token_cache=cache)
    accounts = app.get_accounts()
    result = app.acquire_token_silent(scopes, account=accounts[0]) if accounts else None
    if cache.has_state_changed:
        tmp = cache_path + ".tmp"
        with open(tmp, "w") as f:
            f.write(cache.serialize())
        os.replace(tmp, cache_path)
        os.chmod(cache_path, 0o600)
    if not result or "access_token" not in result:
        die(f"Graph token unavailable — re-run tools/graph-login --mailbox {os.path.basename(mailbox_dir)}")
    return result["access_token"]
