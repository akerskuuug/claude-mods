# sim-board

A Claude Code mod that keeps track of which iOS Simulators are booted, free, or in use for UI tests, shared by every Claude Code session on the Mac and by you.

- **`/sims`** prints a summary (`3 free · 1 held · 1 yours · 2 booted`) and opens the **Simulators** pane: simulators grouped by runtime, `●` booted / `○` shut down, and who holds each: `free`, `yours`, or the holding session's directory and branch with how long it has held it (`(stale)` once that session has stopped checking in). Buttons: **Claim** a free one for this session, **Release** your own, **Free** someone else's (for a session you know is gone), **Refresh** (`r`).
- **Tools for Claude:** `sims_list`, `sims_claim` (picks a free simulator, booted first, or one by udid / name / runtime; boots it unless told not to; answers with the `-destination` to use) and `sims_release`. A short system-prompt note tells each session to claim before UI tests and release when done.
- **Guard:** before Claude runs `xcodebuild test` / `test-without-building` or an `xcrun simctl` command on a simulator (by `id=`, `name=`/`OS=`, udid, name, `booted` or `all`), the mod checks the board:
  - held by another live session → the command is refused, naming who holds it and suggesting a free simulator;
  - free → it is claimed for this session, then the command runs (`simctl shutdown`/`erase`/`delete` only check, they don't claim);
  - no simulator destination, or one it can't resolve → the command runs untouched.
- The status line shows `sims: iPhone 17` while the session holds a claim.

Releasing leaves the simulator booted so the next test run starts warm. A session releases its claims when it ends (`/exit`, `/clear`); a session that crashed stops renewing its claim, which goes stale after 15 minutes and can then be taken.

## How claims are shared

Each claim is a directory, `~/.claude/sim-board/claims/<udid>/`, holding `owner.json` (session id, label, when claimed, last check-in). Every change to a claim (claiming, taking over a stale one, the check-in, releasing) runs in `hooks/claimctl.py` under an exclusive `flock` on `~/.claude/sim-board/claims/.lock-<udid>`. The kernel releases that lock when the process exits, however it exits, so two sessions can never both win the same simulator and no lock is ever left behind. A claim directory without an owner file (a session that died mid-claim) can be reclaimed after a minute.

Each session renews its claims every minute and re-reads simulators and claims every 15 seconds. You can inspect or clear claims by hand in that folder.

## Settings

In `/config` (or `pluginConfigs` in settings):

| Field | Default | Does |
| --- | --- | --- |
| `filter` | empty | Only list and pick simulators whose name or runtime matches this regular expression (case-insensitive), e.g. `iPhone.*\|iOS 26`. The guard still checks every simulator. |
| `staleMinutes` | `15` | How long a claim survives without its session checking in (at least 3: sessions check in every minute) |

Needs Xcode's command line tools (`xcrun simctl`, and the `python3` they ship). On a machine without them the mod shows the error in the pane and adds no tools or guard.

## Install

```
/plugin marketplace add akerskuuug/claude-mods
/plugin install sim-board@claude-mods
```

Pick the user scope when prompted, so every session on the Mac shares the board.

The mod runs as function hooks, which Claude Code only loads when they are switched on. Add this to `~/.claude/settings.json` (if the file already exists, merge `env` into it) and restart Claude Code:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

Without it the mod installs but shows nothing.

## Development

```sh
claude plugin test plugins/sim-board                                          # hooks
python3 -m unittest discover -s plugins/sim-board/hooks -p 'claimctl_test.py'  # claim locking, with real processes
```
