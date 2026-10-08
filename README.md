# claude-mods

A collection of Claude Code mods, published as a plugin marketplace.

## Mods

| Mod | Description |
| --- | --- |
| [usage-meter](plugins/usage-meter) | Branch, worktree, model, effort and context above the prompt; 5h and weekly limits below it |

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
