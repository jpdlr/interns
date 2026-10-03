#!/usr/bin/env python3
"""Standalone test for graph-mail's unsent-draft detection.

No Graph, no token, no network — feeds canned Drafts-folder payloads straight
into the pure classifier.

    python3 scripts/graph-mail-drafts.test.py
"""
import importlib.util, importlib.machinery, os, sys
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
TOOL = os.path.join(HERE, "..", "tools", "graph-mail")
spec = importlib.util.spec_from_loader("graphmail",
    importlib.machinery.SourceFileLoader("graphmail", TOOL))
gm = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gm)

NOW = datetime(2026, 9, 7, 12, 0, 0, tzinfo=timezone.utc)
failures = 0


def check(name, fn):
    global failures
    try:
        fn()
        print(f"  ok  {name}")
    except AssertionError as e:
        failures += 1
        print(f"  FAIL {name}: {e}")
    except Exception as e:
        failures += 1
        print(f"  ERROR {name}: {type(e).__name__}: {e}")


def draft(id, hours_ago, to=("sam@client.com",), subject="Proposal", created_hours=None, **kw):
    stamp = (NOW - timedelta(hours=hours_ago)).strftime("%Y-%m-%dT%H:%M:%S.0000000Z")
    created = (NOW - timedelta(hours=created_hours if created_hours is not None else hours_ago)
               ).strftime("%Y-%m-%dT%H:%M:%S.0000000Z")
    m = {"id": id, "conversationId": "conv-" + id, "subject": subject,
         "toRecipients": [{"emailAddress": {"address": a}} for a in to],
         "createdDateTime": created, "lastModifiedDateTime": stamp,
         "bodyPreview": "hello", "webLink": "https://outlook/" + id}
    m.update(kw)
    return m


# --- timestamp parsing ------------------------------------------------------
def t_iso_7digit():
    d = gm._parse_iso("2026-08-11T12:00:00.0000000Z")
    assert d == datetime(2026, 8, 11, 12, 0, tzinfo=timezone.utc), d

def t_iso_plain_z():
    assert gm._parse_iso("2026-08-11T12:00:00Z") == datetime(2026, 8, 11, 12, 0, tzinfo=timezone.utc)

def t_iso_offset_preserved():
    # +02:00 is 10:00Z — a naive parse would report the wrong hour.
    assert gm._parse_iso("2026-08-11T12:00:00+02:00") == datetime(2026, 8, 11, 10, 0, tzinfo=timezone.utc)

def t_iso_garbage_is_none():
    for bad in (None, "", "not-a-date", "2026-13-99T99:99:99Z"):
        assert gm._parse_iso(bad) is None, bad


# --- staleness --------------------------------------------------------------
def t_fresh_not_stale():
    r = gm.classify_drafts([draft("a", 2)], NOW, 24.0)[0]
    assert r["age_hours"] == 2.0 and r["stale"] is False, r

def t_old_is_stale():
    r = gm.classify_drafts([draft("b", 48)], NOW, 24.0)[0]
    assert r["age_hours"] == 48.0 and r["stale"] is True, r

def t_threshold_is_inclusive():
    r = gm.classify_drafts([draft("c", 24)], NOW, 24.0)[0]
    assert r["stale"] is True, r

def t_unaddressed_never_stale():
    # 30 days old but no recipient — cannot be sent, so it is not a missed reply.
    r = gm.classify_drafts([draft("d", 720, to=())], NOW, 24.0)[0]
    assert r["sendable"] is False and r["stale"] is False, r

def t_age_from_modified_not_created():
    # Created 5 days ago, edited an hour ago: JP is working on it, not neglecting it.
    r = gm.classify_drafts([draft("e", 1, created_hours=120)], NOW, 24.0)[0]
    assert r["age_hours"] == 1.0 and r["stale"] is False, r

def t_missing_timestamps_degrade():
    m = draft("f", 5)
    m["lastModifiedDateTime"] = None
    m["createdDateTime"] = None
    r = gm.classify_drafts([m], NOW, 24.0)[0]
    assert r["age_hours"] is None and r["stale"] is False, r


# --- shape / ordering -------------------------------------------------------
def t_sorted_oldest_first_unknown_last():
    m = draft("unknown", 5); m["lastModifiedDateTime"] = None; m["createdDateTime"] = None
    rows = gm.classify_drafts([draft("young", 2), m, draft("old", 100)], NOW, 24.0)
    assert [r["draft_id"] for r in rows] == ["old", "young", "unknown"], [r["draft_id"] for r in rows]

def t_reply_detection():
    cases = {"RE: Proposal": True, "re: proposal": True, "Fwd: deck": True,
             "FW: deck": True, "Proposal": False, "Rewrite the deck": False}
    for subj, want in cases.items():
        got = gm.classify_drafts([draft("x", 1, subject=subj)], NOW, 24.0)[0]["looks_like_reply"]
        assert got is want, f"{subj!r} -> {got}, wanted {want}"

def t_row_carries_id_for_correlation():
    # Tessa matches these against the draft_ids she recorded when she created them.
    r = gm.classify_drafts([draft("g", 1)], NOW, 24.0)[0]
    for k in ("draft_id", "conversationId", "subject", "to", "web_link", "last_modified"):
        assert k in r, k
    assert r["to"] == ["sam@client.com"], r["to"]

def t_no_crash_on_empty():
    assert gm.classify_drafts([], NOW, 24.0) == []


# --- guardrail regression ---------------------------------------------------
def t_tool_still_has_no_send():
    src = open(TOOL).read()
    for forbidden in ("sendMail", '"DELETE"', "/send"):
        assert forbidden not in src, f"graph-mail must stay read-and-draft-only; found {forbidden}"

def t_drafts_path_is_read_only():
    # The drafts command must issue exactly one GET and no mutating verb.
    src = open(TOOL).read()
    start = src.index("def cmd_drafts")
    nxt = src.index("\ndef ", start + 1)          # stop at the NEXT function, not at main()
    body = src[start:nxt]
    assert "def cmd_draft(" not in body, "slice leaked into cmd_draft (the creator)"
    for verb in ('"POST"', '"PATCH"', '"DELETE"', '"PUT"'):
        assert verb not in body, f"cmd_drafts must not {verb}"


for name, fn in sorted((k, v) for k, v in globals().items() if k.startswith("t_")):
    check(name[2:], fn)

print(f"\n{'FAILED' if failures else 'PASSED'} — {failures} failure(s)")
sys.exit(1 if failures else 0)
