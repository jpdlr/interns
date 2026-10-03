"""graph-mail draft flow against a fake Graph — never touches a real mailbox.

    python3 scripts/graph-mail.test.py
"""
import importlib.machinery, importlib.util, json, os, sys, tempfile, types

sys.dont_write_bytecode = True  # no __pycache__ beside the extension-less tool

HERE = os.path.dirname(os.path.abspath(__file__))
loader = importlib.machinery.SourceFileLoader("graph_mail", os.path.join(HERE, "..", "tools", "graph-mail"))
spec = importlib.util.spec_from_loader("graph_mail", loader)
gm = importlib.util.module_from_spec(spec)
loader.exec_module(gm)

ME = "owner@northwind.example"
QUOTED = "<html><head></head><body><div id=\"quoted\">From: Ada ... earlier email</div></body></html>"


class FakeGraph:
    """Just enough of Graph's message API for the draft paths."""

    def __init__(self):
        self.messages = {
            "m1": {"id": "m1", "conversationId": "c1", "from": {"emailAddress": {"address": "ada@willowbrook-vet.example"}},
                   "isDraft": False, "receivedDateTime": "2026-09-29T10:00:00Z", "bodyPreview": "Hi JP, interested"},
            "m2": {"id": "m2", "conversationId": "c1", "from": {"emailAddress": {"address": ME}},
                   "isDraft": False, "receivedDateTime": "2026-09-29T11:00:00Z", "bodyPreview": "Thanks!"},
            "d0": {"id": "d0", "conversationId": "c1", "from": {"emailAddress": {"address": ME}},
                   "isDraft": True, "receivedDateTime": "2026-09-29T12:00:00Z", "bodyPreview": "unsent"},
            "lone": {"id": "lone", "conversationId": "c2", "from": {"emailAddress": {"address": ME}},
                     "isDraft": True, "receivedDateTime": "2026-09-29T12:00:00Z", "bodyPreview": "x"},
        }
        self.calls = []
        self.n = 0
        self.sent = []  # what the owner sent (Sent Items), for sent-drafts

    def __call__(self, token, path, method="GET", body=None, fatal=True, headers=None):
        self.calls.append((method, path.split("?")[0], body))
        base = path.split("?")[0]
        if base == "/me/mailFolders/sentitems/messages":
            if "internetMessageId eq '" in path:
                mid = path.split("internetMessageId eq '")[1].split("'")[0]
                return {"value": [m for m in self.sent if m.get("internetMessageId") == mid]}
            if "conversationId eq '" in path:
                conv = path.split("conversationId eq '")[1].split("'")[0]
                return {"value": [m for m in self.sent if m.get("conversationId") == conv]}
            return {"value": [{"from": {"emailAddress": {"address": ME}}}]}
        if base == "/me/messages" and method == "GET":
            conv = path.split("conversationId eq '")[1].split("'")[0]
            return {"value": [m for m in self.messages.values() if m["conversationId"] == conv]}
        if base == "/me/messages" and method == "POST":
            self.n += 1
            mid = f"new{self.n}"
            self.messages[mid] = {"id": mid, "conversationId": f"cn{self.n}", "isDraft": True, "subject": body["subject"],
                                  "toRecipients": body["toRecipients"], "body": body["body"], "webLink": f"https://owa/{mid}"}
            return self.messages[mid]
        parts = base.split("/")
        mid = parts[3]
        if len(parts) == 5 and parts[4] in ("createReply", "createReplyAll"):
            src = self.messages[mid]
            self.n += 1
            did = f"draft{self.n}"
            cc = [{"emailAddress": {"address": "lena@sideproject.example"}}] if parts[4] == "createReplyAll" else []
            self.messages[did] = {"id": did, "conversationId": src["conversationId"], "isDraft": True,
                                  "from": {"emailAddress": {"address": ME}}, "subject": "RE: ClinicFlow",
                                  "toRecipients": [src["from"]], "ccRecipients": cc,
                                  "body": {"contentType": "HTML", "content": QUOTED}, "webLink": f"https://owa/{did}",
                                  "receivedDateTime": "2026-09-30T00:00:00Z", "internetMessageId": f"<{did}@northwind.example>"}
            return {"id": did}
        if len(parts) == 5 and parts[4] == "move":
            if mid not in self.messages:
                raise gm.GraphError(f"graph POST {path}: HTTP 404 not found")
            self.messages.pop(mid)
            return {"id": mid}
        if method == "PATCH":
            self.messages[mid].update(body)
            return {}
        if mid not in self.messages:  # Graph: an id stops resolving once the message changes folder
            raise gm.GraphError(f"graph GET {path}: HTTP 404 not found")
        return self.messages[mid]


failures = 0


def check(name, fn):
    global failures
    try:
        fn()
        print(f"  ok  {name}")
    except SystemExit as e:
        failures += 1
        print(f"FAIL  {name}\n      exited {e.code}")
    except Exception as e:  # noqa: BLE001
        failures += 1
        print(f"FAIL  {name}\n      {type(e).__name__}: {e}")


def fresh():
    fake = FakeGraph()
    gm.graph = fake
    gm._ME.clear()
    d = tempfile.mkdtemp(prefix="graph-mail-test-")
    args = types.SimpleNamespace(mailbox="side", mailbox_dir=d, reply_to=None, body="", to="", subject="",
                                 sender_only=False, draft_id=None)
    return fake, args


def exits_with(code, fn):
    try:
        fn()
    except SystemExit as e:
        assert e.code == code, f"exit {e.code}, wanted {code}"
        return
    raise AssertionError(f"did not exit (wanted {code})")


def t_reply_all_keeps_thread():
    fake, args = fresh()
    args.reply_to, args.body = "m1", "Hi Ada,\n\nThanks for reaching out."
    out = gm.cmd_draft("tok", args)
    assert ("POST", "/me/messages/m1/createReplyAll", {}) in fake.calls, "must use createReplyAll"
    html_body = fake.messages[out["draft_id"]]["body"]["content"]
    assert 'id="quoted"' in html_body, "quoted history must survive"
    assert html_body.index("Thanks for reaching out") < html_body.index('id="quoted"'), "JP's text sits above the history"
    assert out["kind"] == "reply_all" and out["threaded"] and out["intended_reply"]
    assert out["cc"] == ["lena@sideproject.example"], out["cc"]
    assert out["subject"].startswith("RE:")
    assert out["in_reply_to"] == "m1"
    assert out["web_link"].startswith("https://owa/")
    assert out["thread"] and out["thread"][0]["from"] == ME, "thread previews newest first, drafts excluded"
    assert all(t["preview"] != "unsent" for t in out["thread"])
    assert out["draft_id"] in gm.load_ledger(args.mailbox_dir)


def t_walks_back_from_own_draft():
    fake, args = fresh()
    args.reply_to, args.body = "d0", "Following up"
    out = gm.cmd_draft("tok", args)
    assert out["in_reply_to"] == "m1", f"replied to {out['in_reply_to']} — must be the counterparty's newest"
    assert ("POST", "/me/messages/m1/createReplyAll", {}) in fake.calls


def t_no_target_fails_loudly():
    fake, args = fresh()
    args.reply_to, args.body = "lone", "x"
    exits_with(gm.EXIT_NO_TARGET, lambda: gm.cmd_draft("tok", args))
    assert not any(c[0] == "POST" and c[1] == "/me/messages" for c in fake.calls), "must not create a new email"


def t_sender_only():
    fake, args = fresh()
    args.reply_to, args.body, args.sender_only = "m1", "Just you", True
    out = gm.cmd_draft("tok", args)
    assert out["kind"] == "reply" and out["cc"] == []


def t_revise_keeps_one_draft():
    fake, args = fresh()
    args.reply_to, args.body = "m1", "First version"
    first = gm.cmd_draft("tok", args)
    args.draft_id, args.body = first["draft_id"], "Shorter version"
    second = gm.cmd_revise_draft("tok", args)
    assert second["replaces"] == first["draft_id"]
    assert first["draft_id"] not in fake.messages, "old draft moved out of Drafts"
    drafts = [m for m in fake.messages.values() if m.get("isDraft") and m["conversationId"] == "c1" and m["id"] != "d0"]
    assert len(drafts) == 1, f"{len(drafts)} drafts in the thread"
    body = drafts[0]["body"]["content"]
    assert "Shorter version" in body and "First version" not in body and 'id="quoted"' in body
    ledger = gm.load_ledger(args.mailbox_dir)
    assert second["draft_id"] in ledger and first["draft_id"] not in ledger


def t_revise_when_old_draft_already_gone():
    fake, args = fresh()
    args.reply_to, args.body = "m1", "First"
    first = gm.cmd_draft("tok", args)
    fake.messages.pop(first["draft_id"])  # JP sent or deleted it meanwhile
    args.draft_id, args.body = first["draft_id"], "Second"
    out = gm.cmd_revise_draft("tok", args)
    assert out["draft_id"] != first["draft_id"] and "warning" in out, out
    assert out["draft_id"] in gm.load_ledger(args.mailbox_dir)


def t_never_touches_jps_drafts():
    fake, args = fresh()
    args.draft_id, args.body = "d0", "x"
    exits_with(gm.EXIT_NOT_OURS, lambda: gm.cmd_revise_draft("tok", args))
    exits_with(gm.EXIT_NOT_OURS, lambda: gm.cmd_delete_draft("tok", args))
    assert "d0" in fake.messages


def t_new_email_needs_to():
    fake, args = fresh()
    args.body = "hello"
    exits_with(gm.EXIT_USAGE, lambda: gm.cmd_draft("tok", args))
    args.to, args.subject = "a@b.co", "Hi"
    out = gm.cmd_draft("tok", args)
    assert out["kind"] == "new" and not out["intended_reply"] and out["to"] == ["a@b.co"]


def t_sent_drafts_pairs_the_interns_text_with_what_was_sent():
    fake, args = fresh()
    os.environ["INTERNS_INTERN"] = "milo"
    try:
        args.reply_to, args.body = "m1", "Hi Ada, Thursday at 10:00 works for the demo. Kind regards, Sam"
        out = gm.cmd_draft("tok", args)
    finally:
        del os.environ["INTERNS_INTERN"]
    entry = gm.load_ledger(args.mailbox_dir)[out["draft_id"]]
    assert entry["intern"] == "milo" and entry["body"].startswith("Hi Ada") and entry["internet_message_id"], entry
    assert gm.cmd_sent_drafts("tok", args)["sent"] == [], "still in Drafts: nothing yet"

    # the owner edits and sends it: the draft leaves Drafts, a copy with the same Message-ID lands in Sent Items
    fake.messages.pop(out["draft_id"])
    fake.sent.append({"id": "s1", "internetMessageId": entry["internet_message_id"], "conversationId": "c1",
                      "subject": "RE: ClinicFlow", "sentDateTime": "2099-01-01T09:00:00Z",
                      "toRecipients": [{"emailAddress": {"address": "ada@willowbrook-vet.example"}}],
                      "uniqueBody": {"content": "Hi Ada, Thursday 10:00 works.\n\nCheers, Sam"}})
    got = gm.cmd_sent_drafts("tok", args)["sent"]
    assert len(got) == 1, got
    assert got[0]["intern"] == "milo" and got[0]["intern_body"].endswith("Kind regards, Sam")
    assert got[0]["sent_body"] == "Hi Ada, Thursday 10:00 works.\n\nCheers, Sam"
    assert got[0]["to"] == ["ada@willowbrook-vet.example"]
    assert gm.cmd_sent_drafts("tok", args)["sent"] == [], "each draft is reported once"


def t_sent_drafts_falls_back_to_the_conversation_and_gives_up_on_deleted_drafts():
    fake, args = fresh()
    args.to, args.subject, args.body = "ada@willowbrook-vet.example", "Demo", "Hello Ada, a new note."
    out = gm.cmd_draft("tok", args)
    fake.messages.pop(out["draft_id"])
    fake.sent.append({"id": "s2", "internetMessageId": "<rewritten@client>", "conversationId": out["conversation_id"],
                      "subject": "Demo", "sentDateTime": "2099-01-01T09:00:00Z", "toRecipients": [],
                      "uniqueBody": {"content": "Hi Ada, short note."}})
    got = gm.cmd_sent_drafts("tok", args)["sent"]
    assert [g["sent_body"] for g in got] == ["Hi Ada, short note."], got

    # deleted unsent, a week ago: dropped quietly
    args.body = "Never sent."
    gone = gm.cmd_draft("tok", args)
    fake.messages.pop(gone["draft_id"])
    ledger = gm.load_ledger(args.mailbox_dir)
    ledger[gone["draft_id"]]["created_at"] = "2000-01-01T00:00:00Z"
    gm.save_ledger(args.mailbox_dir, ledger)
    assert gm.cmd_sent_drafts("tok", args)["sent"] == []
    ledger = gm.load_ledger(args.mailbox_dir)
    assert "harvest" not in ledger[gone["draft_id"]], "older than the lookback: left alone"
    from datetime import datetime, timedelta, timezone
    ledger[gone["draft_id"]]["created_at"] = (datetime.now(timezone.utc) - timedelta(days=8)).strftime("%Y-%m-%dT%H:%M:%SZ")
    gm.save_ledger(args.mailbox_dir, ledger)
    gm.cmd_sent_drafts("tok", args)
    assert gm.load_ledger(args.mailbox_dir)[gone["draft_id"]]["harvest"] == "gone"


def t_pure_helpers():
    assert gm.splice_reply_body("<p>q</p>", "a").endswith("<p>q</p>")
    assert "&lt;b&gt;" in gm.text_to_html("<b>")
    spliced = gm.splice_reply_body(QUOTED, "one")
    assert gm.strip_reply_block(spliced) == QUOTED
    assert gm.pick_reply_target([], ME) is None


for name, fn in list(globals().items()):
    if name.startswith("t_"):
        check(name[2:].replace("_", " "), fn)
print("\nall graph-mail checks passed" if failures == 0 else f"\n{failures} graph-mail check(s) FAILED")
sys.exit(1 if failures else 0)
