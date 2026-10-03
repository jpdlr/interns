"""graph-mail / graph-cal honour an intern's mailbox limit (INTERNS_MAILBOXES, set by the engine).

    python3 scripts/graph-mailboxes.test.py

No network and no msal needed: every case stops before a token is used.
"""
import json, os, subprocess, sys, tempfile

TOOLS = os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "tools")


def run(tool, args, mailboxes):
    # an empty stand-in for msal: every case stops before a token is used, so CI needs no msal
    env = {**os.environ, "INTERNS_HOME": home, "PYTHONPATH": stub}
    env.pop("INTERNS_MAILBOXES", None)
    if mailboxes is not None:
        env["INTERNS_MAILBOXES"] = mailboxes
    p = subprocess.run([os.path.join(TOOLS, tool), *args], env=env, capture_output=True, text=True, timeout=30)
    return p.returncode, p.stdout, p.stderr


home = tempfile.mkdtemp(prefix="interns-mailboxes-")
stub = os.path.join(home, "stub")
os.makedirs(stub)
with open(os.path.join(stub, "msal.py"), "w") as f:
    f.write("class SerializableTokenCache:\n    def deserialize(self, raw): pass\n")
for m in ("work", "home"):
    os.makedirs(os.path.join(home, "mailboxes", m))
with open(os.path.join(home, "config.json"), "w") as f:
    json.dump({"mailboxes": ["work", "home"]}, f)

failures = 0


def check(name, cond, detail=""):
    global failures
    print(f"  ok  {name}" if cond else f"FAIL  {name} {detail}")
    failures += 0 if cond else 1


code, out, err = run("graph-mail", ["--mailbox", "work", "whoami"], "home")
check("a mailbox outside the limit is not a choice", code == 2 and "invalid choice: 'work'" in err, err)

code, out, err = run("graph-cal", ["--mailbox", "home", "next"], "work")
check("graph-cal too", code == 2 and "invalid choice: 'home'" in err, err)

code, out, err = run("graph-mail", ["--mailbox", "work", "whoami"], "")
check("an empty limit means no mailbox at all", code != 0 and "no access to mailbox 'work'" in json.loads(out)["error"], out + err)

code, out, err = run("graph-mail", ["whoami"], "home")
check("the default is the first allowed mailbox", code != 0 and "mailboxes/home/token.json" in json.loads(out)["error"], out + err)

code, out, err = run("graph-mail", ["whoami"], None)
check("no limit: the first configured mailbox", code != 0 and "mailboxes/work/token.json" in json.loads(out)["error"], out + err)

print("\nall mailbox-limit checks passed" if failures == 0 else f"\n{failures} mailbox-limit check(s) FAILED")
sys.exit(1 if failures else 0)
