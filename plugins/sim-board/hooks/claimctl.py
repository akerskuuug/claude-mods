#!/usr/bin/env python3
"""Claims on simulators, shared by every Claude Code session on this machine.

Each claim is <root>/<udid>/owner.json. Every change to a claim runs here, in
one process, under an exclusive flock(2) on <root>/.lock-<udid>. The kernel
drops the lock when the process exits, however it exits, so no lock is ever
left behind and none has to be broken: reading a claim, deciding, and writing
or removing it can't interleave with another session doing the same.

Usage: claimctl.py <claim|renew|release> <root> <udid> '<json args>'
Prints one JSON object. Needs only the Python 3.9 that ships with Xcode's
command line tools.
"""

import fcntl
import json
import os
import re
import shutil
import sys

UDID = re.compile(r"^[A-Fa-f0-9-]+$")


def read_entry(path):
    """('none', None) | ('claim', dict) | ('orphan', mtime_ms)"""
    try:
        with open(os.path.join(path, "owner.json")) as f:
            owner = json.load(f)
        if isinstance(owner.get("sessionId"), str) and isinstance(owner.get("heartbeatAt"), (int, float)):
            return "claim", owner
    except (OSError, ValueError):
        pass
    try:
        return "orphan", os.stat(path).st_mtime * 1000
    except OSError:
        return "none", None


def write_owner(path, owner):
    os.makedirs(path, exist_ok=True)
    tmp = os.path.join(path, ".owner.%d.tmp" % os.getpid())
    with open(tmp, "w") as f:
        json.dump(owner, f)
    # Readers outside the lock see the old file or the new one, never half.
    os.replace(tmp, os.path.join(path, "owner.json"))


def takeable(kind, value, args):
    if args.get("force"):
        return kind != "none"
    if kind == "orphan":
        return args["now"] - value >= args["orphanMs"]
    if kind == "claim":
        return args["now"] - value["heartbeatAt"] > args["staleMs"]
    return False


def claim(path, args):
    me = args["me"]
    kind, value = read_entry(path)
    owner = dict(args["owner"])
    owner["sessionId"] = me
    owner["heartbeatAt"] = args["now"]
    if kind == "claim" and value["sessionId"] == me:
        owner["claimedAt"] = value.get("claimedAt", args["now"])
        if not owner.get("purpose") and value.get("purpose"):
            owner["purpose"] = value["purpose"]
        write_owner(path, owner)
        return {"ok": True}
    if kind == "none" or takeable(kind, value, args):
        if kind != "none":
            shutil.rmtree(path, ignore_errors=True)
        owner["claimedAt"] = args["now"]
        write_owner(path, owner)
        return {"ok": True}
    return {"ok": False, "holder": value if kind == "claim" else None}


def renew(path, args):
    kind, value = read_entry(path)
    if kind != "claim" or value["sessionId"] != args["me"]:
        return {"ok": False}
    value["heartbeatAt"] = args["now"]
    write_owner(path, value)
    return {"ok": True}


def release(path, args):
    kind, value = read_entry(path)
    if kind == "none":
        return {"ok": True}
    if (kind == "claim" and value["sessionId"] == args["me"]) or args.get("force"):
        shutil.rmtree(path, ignore_errors=True)
        return {"ok": True}
    return {"ok": False, "holder": value if kind == "claim" else None}


COMMANDS = {"claim": claim, "renew": renew, "release": release}


def main(argv):
    if len(argv) != 5 or argv[1] not in COMMANDS or not UDID.match(argv[3]):
        print(json.dumps({"ok": False, "error": "usage: claimctl.py <claim|renew|release> <root> <udid> <json>"}))
        return 2
    command, root, udid, args = argv[1], argv[2], argv[3], json.loads(argv[4])
    os.makedirs(root, exist_ok=True)
    with open(os.path.join(root, ".lock-" + udid), "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result = COMMANDS[command](os.path.join(root, udid), args)
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
