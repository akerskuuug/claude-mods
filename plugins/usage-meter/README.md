# usage-meter

A Claude Code mod that shows, around the prompt:

- **Above:** the current directory and git branch (with a `●` when dirty and a label when in a worktree) on the left; model and effort on the right, followed by the usage meter:
  - **Subscription:** 5-hour and weekly rate limits as bars with the percent left and time until reset.
  - **Pay-per-token:** a `Cost` control. Press the period button to switch between Session, Today, 7 days and 30 days (the list opens on the right, below the meter); `ⓘ` explains how the estimate works.
- **Below:** context as a bar twice as wide as the limit bars (fills as the window is used; green, then yellow, then red as little is left), with used/window beside it.

## Subscription or metered?

The mod infers billing from what Claude Code reports: rate-limit windows (`five_hour`, `seven_day`) exist only on a subscription. With none, and a priced response already in, billing is treated as metered. Before the first response it can't tell, so it uses the mode it saw last (remembered across sessions); on first use it shows neither until it knows.

## Cost estimates

- **Session** is the exact cost Claude Code reports.
- **Today / 7 days / 30 days** are estimates (marked `~` and `est.`). `hooks/scan.mjs` scans local logs in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) and the Cowork sessions folder (macOS and Windows), counts each message once and prices it at public API list prices per model (including fast mode, US-only inference, server-side compaction, Haiku 5.5's long-prompt rates and web searches). Discounts, other machines and logs older than 30 days are not reflected; unrecognised models are priced as Sonnet. Refreshed at most once a minute, and only for metered users.
- Requires `node` on the PATH. Per-model prices are hardcoded in `hooks/scan.mjs` and need updating when pricing changes.

## Install

```
/plugin marketplace add akerskuuug/claude-mods
/plugin install usage-meter@claude-mods
```

Pick the user scope when prompted.
