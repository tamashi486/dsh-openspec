# dsh-openspec

English | [中文](README.zh.md)

[OpenSpec](https://github.com/Fission-AI/OpenSpec) (spec-driven development) as a
DeepSeek Harness plugin.

Ships OpenSpec's agent skills as a **bundled skill provider** and resolves the
`openspec` CLI from the plugin's own dependency tree — so there is no global
install and no per-project `.agents/skills` copy.

## Install

```bash
dsh plugin add /path/to/dsh-openspec
```

Restart the profile (or let `patchReload: live` pick it up). The six `openspec-*`
skills appear in the skill catalog immediately.

## Use

```bash
# In any project directory:
openspec init --tools agents     # scaffold openspec/ and project config
```

Then drive the workflow from the agent — the skills route on their
descriptions, so plain language works:

- "help me think through how to add dark mode" → `openspec-explore`
- "propose add-dark-mode" → `openspec-propose`
- "apply the change" → `openspec-apply-change`
- "archive it" → `openspec-archive-change`

There is also one human command for the integration itself:

| Command | Purpose |
|---|---|
| `/openspec doctor` | Show CLI version, resolved entry, launcher state |
| `/openspec shim` | (Re)install the `openspec` launcher onto PATH |
| `/openspec uninstall-shim` | Remove the launcher |
| `/openspec init <path>` | Run `openspec init --tools agents` in a project directory |

## Why a plugin instead of the plain install

OpenSpec's own installer assumes two things that do not hold inside DSH. Both are
verified against the current sources, not assumed:

**1. Project-level skills are invisible outside a git repository.**
`openspec init` writes skills to `<project>/.agents/skills/`. DSH discovers
project skills via `findProjectRoot` in `dsh-skill-filesystem`, which probes for
a `.git` entry and nothing else:

```js
if (await pathExists(join(current, '.git'), fs)) return current;
```

In a non-git directory the generated skills exist on disk but are never seen. This
bundle mounts them through `bundledSkillDir` instead, which is independent of the
workspace's project-root detection.

**2. The bare `openspec` command is not on PATH.**
Every vendored skill body calls `openspec …`. OpenSpec assumes a global install;
meanwhile the profile's own `node_modules/.bin` is *not* on the PATH that DSH's
bash tool sees, and `ctx.shellEnv` only injects `DSH_*`-prefixed keys, so a
declared dependency alone would leave the command unresolved. The plugin
therefore materializes a small launcher — into a directory already on PATH, never
clobbering an `openspec` it did not write:

```sh
#!/bin/sh
exec node "/abs/path/to/node_modules/@fission-ai/openspec/bin/openspec.js" "$@"
```

Two further consequences fall out of this arrangement:

- **No contested directory.** `.agents/skills/` is shared with Codex and Zed Agent,
  which rewrite each other's trees there. This plugin never writes to it.
- **One copy, upgraded in one place.** `dsh plugin update` refreshes the skills for
  every project at once, instead of `openspec update` per repository.

What is deliberately *not* taken over: `openspec/` stays in your project and stays
in git. The plugin distributes capability; it does not own your specs.

## Maintaining

The skills are vendored from upstream, because upstream renders them per tool at
install time and ships no `.agents/skills/` tree in its npm package. To refresh:

```bash
node scripts/vendor-skills.mjs                 # latest published version
node scripts/vendor-skills.mjs --version 1.13.0
```

This runs upstream's own installer in a throwaway directory with
`--tools agents` — upstream's vendor-neutral, skills-only target, which generates
no `opsx-*` command files and therefore renders cross-references as skill names,
matching how DSH addresses its skill catalog. Then align the
`@fission-ai/openspec` range in `package.json` with the version it prints.

To re-check the wiring after a change (requires the plugin installed into a
profile):

```bash
dsh plugin --profile opstest add "$PWD"
node scripts/check-load.mjs --profile opstest --require propose,apply-change
```

The check boots the profile through dsh's real `runProfile` path and asserts the
skills are visible **from a workspace with no `.git`** — the case the plain
install fails.

## Layout

| Path | Role |
|---|---|
| `cordis.patch.yml` | Registers the bundled skill provider |
| `skills/` | Vendored `openspec-*/SKILL.md` (generated; see `skills/VENDORED.md`) |
| `lib/index.js` | CLI resolution, PATH launcher, `/openspec` command |
| `scripts/vendor-skills.mjs` | Re-vendors `skills/` from upstream |
| `scripts/check-load.mjs` | Load-time integration check |

## Licence

MIT. OpenSpec itself is MIT-licensed and is consumed here as an unmodified
dependency; the vendored skill text under `skills/` is generated from it.
