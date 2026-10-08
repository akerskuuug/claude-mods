# claude-mods

A collection of Claude Code mods, published as a plugin marketplace.

## Mods

| Mod | Description |
| --- | --- |
| [usage-meter](plugins/usage-meter) | Directory, branch, worktree, model and effort, with 5h and weekly limits (subscription) or cost (pay-per-token), above the prompt; context below it |

## Install

Add the marketplace once:

```
/plugin marketplace add akerskuuug/claude-mods
```

Then install any mod from it:

```
/plugin install usage-meter@claude-mods
```

## Adding a mod

Create `plugins/<name>/` with a `.claude-plugin/plugin.json` and its `hooks/`, then add an entry to `.claude-plugin/marketplace.json`.

## License

MIT — see [LICENSE](LICENSE).
