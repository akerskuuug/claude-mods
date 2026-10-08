# claude-mods

A Claude Code plugin marketplace. Each mod is a plugin of function hooks under `plugins/<name>/`.

Load the `plugin-authoring` skill before writing or debugging a mod's hooks.

## Layout

- `.claude-plugin/marketplace.json` — lists every mod; `source` points at `./plugins/<name>`.
- `plugins/<name>/.claude-plugin/plugin.json` — the mod's manifest (name, version, description, `"license": "MIT"`, `types`).
- `plugins/<name>/hooks/hooks.json` — `{ "modules": [...] }`, the entry modules.
- `plugins/<name>/hooks/*.tsx` — hooks; pure helpers are exported so tests can import them.
- `plugins/<name>/hooks/*.test.ts` — tests using `claude-code/testing`.
- `plugins/<name>/types/index.d.ts` — shared types, and the mod's `PluginState` augmentation of `'claude-code'`.

## Adding a mod

1. Create `plugins/<name>/` (`claude plugin init <name>` scaffolds one), keeping the layout above.
2. Namespace state atoms with the mod's name: `atom({ plugin: '<name>', key: '...' } as const, null)`, and declare them in `types/index.d.ts`.
3. Add an entry to `.claude-plugin/marketplace.json` and a row to the table in `README.md`.
4. Give the mod its own `README.md` with what it shows and the install command (`/plugin install <name>@claude-mods`).

## Checks

Run before committing:

```sh
claude plugin validate .                    # marketplace
claude plugin validate plugins/<name>       # each changed mod
claude plugin test plugins/<name>           # each changed mod's tests
```

Bump `version` in the mod's `plugin.json` when shipping a user-visible change.

## Local development

Add the marketplace from the local checkout (`/plugin marketplace add <path to this repo>`) so edits go live after `/reload-plugins` without pushing.

## Git

`main` is protected: force-push and deletion are blocked for everyone; PRs are required except for the repo admin.
