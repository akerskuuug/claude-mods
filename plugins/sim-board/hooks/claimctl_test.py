"""Tests for claimctl.py, run as real processes against a temporary folder.

    python3 -m unittest discover -s plugins/sim-board/hooks -p 'claimctl_test.py'
"""

import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "claimctl.py")
UDID = "CCCC-26"
NOW = 1_000_000_000
STALE = {"staleMs": 15 * 60_000, "orphanMs": 60_000}


def ctl(root, command, me, now=NOW, udid=UDID, **extra):
    args = dict(STALE, me=me, now=now, owner={"label": me}, **extra)
    out = subprocess.run(
        [sys.executable, SCRIPT, command, root, udid, json.dumps(args)],
        capture_output=True, text=True, check=True,
    ).stdout
    return json.loads(out)


def owner(root, udid=UDID):
    with open(os.path.join(root, udid, "owner.json")) as f:
        return json.load(f)


def put(root, sessionId, heartbeatAt, udid=UDID):
    os.makedirs(os.path.join(root, udid), exist_ok=True)
    with open(os.path.join(root, udid, "owner.json"), "w") as f:
        json.dump({"sessionId": sessionId, "label": sessionId, "claimedAt": heartbeatAt, "heartbeatAt": heartbeatAt}, f)


class ClaimTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.root = os.path.join(self.dir.name, "claims")

    def tearDown(self):
        self.dir.cleanup()

    def test_claims_a_free_simulator(self):
        self.assertEqual(ctl(self.root, "claim", "a"), {"ok": True})
        self.assertEqual(owner(self.root)["sessionId"], "a")

    def test_refuses_a_live_claim_and_names_the_holder(self):
        put(self.root, "a", NOW)
        result = ctl(self.root, "claim", "b")
        self.assertFalse(result["ok"])
        self.assertEqual(result["holder"]["sessionId"], "a")

    def test_takes_over_a_stale_claim(self):
        put(self.root, "a", NOW - 20 * 60_000)
        self.assertEqual(ctl(self.root, "claim", "b"), {"ok": True})
        self.assertEqual(owner(self.root)["sessionId"], "b")

    def test_a_renewed_claim_is_no_longer_takeable(self):
        put(self.root, "a", NOW - 20 * 60_000)
        self.assertEqual(ctl(self.root, "renew", "a"), {"ok": True})
        self.assertFalse(ctl(self.root, "claim", "b")["ok"])

    def test_orphan_directory_is_held_then_reclaimed(self):
        os.makedirs(os.path.join(self.root, UDID))
        mtime = os.stat(os.path.join(self.root, UDID)).st_mtime * 1000
        self.assertEqual(ctl(self.root, "claim", "b", now=mtime + 1000), {"ok": False, "holder": None})
        self.assertEqual(ctl(self.root, "claim", "b", now=mtime + 120_000), {"ok": True})

    def test_renew_and_release_leave_another_sessions_claim_alone(self):
        put(self.root, "b", NOW)  # b took over a's claim
        self.assertEqual(ctl(self.root, "renew", "a"), {"ok": False})
        self.assertFalse(ctl(self.root, "release", "a")["ok"])
        self.assertEqual(owner(self.root)["sessionId"], "b")

    def test_release_and_forced_release(self):
        put(self.root, "a", NOW)
        self.assertEqual(ctl(self.root, "release", "a"), {"ok": True})
        put(self.root, "a", NOW)
        self.assertEqual(ctl(self.root, "release", "b", force=True), {"ok": True})
        self.assertFalse(os.path.exists(os.path.join(self.root, UDID)))

    def test_rejects_a_udid_that_is_not_one(self):
        out = subprocess.run([sys.executable, SCRIPT, "claim", self.root, "../x", "{}"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 2)

    def test_exactly_one_of_many_concurrent_takeovers_wins(self):
        for _ in range(5):
            put(self.root, "gone", NOW - 20 * 60_000)
            results = {}

            def take(me):
                results[me] = ctl(self.root, "claim", me)["ok"]

            threads = [threading.Thread(target=take, args=("s%d" % i,)) for i in range(8)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            winners = [me for me, ok in results.items() if ok]
            self.assertEqual(len(winners), 1, results)
            self.assertEqual(owner(self.root)["sessionId"], winners[0])

    def test_a_lock_holder_that_dies_leaves_no_lock_behind(self):
        put(self.root, "gone", NOW - 20 * 60_000)
        lock = os.path.join(self.root, ".lock-" + UDID)
        # A process takes the lock and is killed while holding it.
        holder = subprocess.Popen([sys.executable, "-c", (
            "import fcntl,sys,time;f=open(sys.argv[1],'a');fcntl.flock(f,fcntl.LOCK_EX);print('held',flush=True);time.sleep(60)"
        ), lock], stdout=subprocess.PIPE, text=True)
        self.assertEqual(holder.stdout.readline().strip(), "held")
        holder.kill()
        holder.wait()
        start = time.time()
        self.assertEqual(ctl(self.root, "claim", "b"), {"ok": True})
        self.assertLess(time.time() - start, 5)


if __name__ == "__main__":
    unittest.main()
