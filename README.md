# dsh-openspec

English | [中文](README.zh.md)

[OpenSpec](https://github.com/Fission-AI/OpenSpec) — the spec-driven development
workflow (explore → propose → apply → archive) — as a DeepSeek Harness plugin:
**six `openspec-*` skills** in the skill catalog, plus the **`openspec` CLI**
resolvable from the agent's shell. No global install, no per-project
`.agents/skills` copy, and the skills work even outside a git repository.

## What you get

Six vendored skills, routed by their descriptions, so plain language triggers
them:

| Skill | What it does |
|---|---|
| `openspec-explore` | Thinking partner: explore ideas, investigate problems, clarify requirements — before or during a change |
| `openspec-propose` | Create a change and all its planning artifacts (proposal, spec deltas, design, tasks) in one step |
| `openspec-apply-change` | Implement the tasks of a change |
| `openspec-update-change` | Revise an existing change's planning artifacts (never touches code) |
| `openspec-sync-specs` | Fold a change's delta specs into the main specs, without archiving |
| `openspec-archive-change` | Finalize and archive a completed change |

Plus the CLI wiring. The plugin carries `@fission-ai/openspec` as its own
dependency and, at profile load, installs a small `openspec` launcher into a
directory that is already on your PATH — so the bare `openspec` command every
skill calls actually resolves:

```sh
#!/bin/sh
exec "/abs/path/to/node" "/abs/path/to/node_modules/@fission-ai/openspec/bin/openspec.js" "$@"
```

Candidate directories are only ones already on PATH, preferring the Node
installation's bin dir, npm's global prefix, `~/.local/bin`, and the
Homebrew/system prefixes. An `openspec` the plugin did not write is never
touched.

## Install

```bash
dsh plugin add /path/to/dsh-openspec
```

Restart the profile (or let `patchReload: live` pick it up). On load the
plugin:

1. mounts the six skills as a **bundled** provider — visible from every
   workspace, git or not;
2. probes the CLI dependency and, if `openspec` is not yet on PATH, installs
   the launcher (logged; remove anytime with `/openspec uninstall-shim`).

Verify with `/openspec doctor`.

## Quick start

Initialize a project once — from the project's own shell:

```bash
openspec init --tools agents     # scaffolds openspec/ and the project config
```

Or just ask in a conversation: the skills detect a missing OpenSpec root and
offer to run `openspec init` for you (`/openspec init <path>` works too).

Then drive the workflow in plain language:

- "help me think through how to add dark mode" → `openspec-explore`
- "propose add-dark-mode" → `openspec-propose`
- "apply the change" → `openspec-apply-change`
- "archive it" → `openspec-archive-change`

Note the planning boundary (upstream's design): `propose` stops when the
artifacts are ready. Implementation starts only when you explicitly ask to
apply.

## The `/openspec` command

| Command | Purpose |
|---|---|
| `/openspec doctor` | One-screen diagnosis: skill count, CLI version and entry, launcher state |
| `/openspec shim` | (Re)install the `openspec` launcher onto PATH |
| `/openspec uninstall-shim` | Remove the launcher (only if this plugin wrote it) |
| `/openspec init <path>` | Run `openspec init --tools agents` in a project directory. Pass an **absolute** path — a relative one resolves against the profile server's cwd, not your workspace |

## Troubleshooting

Run `/openspec doctor` and match what it says:

| Diagnosis | Meaning / fix |
|---|---|
| `CLI package : MISSING` | The CLI dependency didn't install. Re-run `dsh plugin add` for this plugin (or `dsh plugin add @fission-ai/openspec`), then `/openspec shim`. |
| `PATH launcher : absent` | The skills' bare `openspec` won't resolve. Fix: `/openspec shim`. |
| `PATH launcher : foreign (<path>)` | An `openspec` this plugin did not write is already on PATH; it is left untouched. If it comes first on PATH, that binary — not the plugin's — is what the skills will call. |
| launcher `could not be installed (no-writable-path-dir)` | No directory on your PATH is writable. Add one (e.g. `~/.local/bin`), reload the profile, and retry — or install OpenSpec globally yourself. |

Precedence note: after `openspec init` inside a **git** repository, DSH also
discovers the project's own `.agents/skills` copies, which outrank the bundled
ones — same content, no action needed. Outside git repositories only the
bundled copies are visible, which is exactly the case this plugin exists for.

## Why a plugin instead of the plain install

OpenSpec's own installer assumes two things that do not hold inside DSH. Both
are verified against the current sources, not assumed:

**1. Project-level skills are invisible outside a git repository.**
`openspec init` writes skills to `<project>/.agents/skills/`. DSH discovers
project skills via `findProjectRoot` in `dsh-skill-filesystem`, which probes
for a `.git` entry and nothing else:

```js
if (await pathExists(join(current, '.git'), fs)) return current;
```

In a non-git directory the generated skills exist on disk but are never seen.
This plugin mounts them through `bundledSkillDir` instead, which is
independent of project-root detection.

**2. The bare `openspec` command is not on the agent's PATH.**
Every vendored skill body calls `openspec …`. The profile's own
`node_modules/.bin` is not on the PATH the bash tool sees, and `ctx.shellEnv`
injects only `DSH_*`-prefixed keys — so a declared dependency alone leaves the
command unresolved. Hence the launcher described above, which never clobbers
an `openspec` it did not write.

Two consequences fall out of this arrangement:

- **No contested directory.** `.agents/skills/` is shared with Codex and Zed
  Agent, which rewrite each other's trees there. This plugin never writes to
  it.
- **One copy, upgraded in one place.** `dsh plugin update` refreshes the
  skills for every project at once, instead of `openspec update` per
  repository.

What is deliberately *not* taken over: `openspec/` stays in your project and
stays in git. The plugin distributes capability; it does not own your specs.

## Maintaining

`src/` is the source of truth; `lib/` is the compiled output and **is
committed** — `dsh plugin add` loads the package as-is, and pnpm blocks a
git-hosted plugin's `prepare` script by default, so a build step at install
time would force every consumer to edit `allowBuilds` first.

```bash
npm ci
npm run typecheck    # src/ + scripts/ (includes the contract test)
npm run build        # src/ -> lib/ (+ lib/types/)
```

CI fails if `lib/` is stale relative to `src/`, so always commit the rebuild.

**Vendoring the skills.** The skills under `skills/` are generated: upstream
renders them per tool at install time and ships no skills tree in its npm
package. `scripts/vendor-skills.ts` therefore runs upstream's own installer in
a throwaway git repo (`--tools agents` — the vendor-neutral, skills-only
target, which generates no `opsx-*` command files and renders cross-references
as skill names, matching how DSH addresses its catalog) and copies the result:

```bash
npm run vendor-skills                              # latest published version
npm run vendor-skills -- --version 1.13.0
```

Then align `dependencies["@fission-ai/openspec"]` in `package.json` with the
version the script prints. `skills/VENDORED.md` records the provenance.

**Checking the wiring.** `scripts/checks/plugin-contract.ts` is a compile-time
contract test: `npm run typecheck` fails if the plugin stops satisfying
cordis's plugin shape or dsh-commands' `CommandDefinition`. For the full
integration check (requires the plugin installed into a profile):

```bash
dsh plugin --profile opstest add "$PWD"
npm run check-load -- --profile opstest --require propose,apply-change
```

It boots the profile through dsh's real `runProfile` path and asserts the
skills are visible **from a workspace with no `.git`** — the case the plain
install fails.

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Plugin source: CLI resolution, PATH launcher, `/openspec` command |
| `lib/` | Compiled output (committed; what dsh loads) |
| `cordis.patch.yml` | Registers the bundled skill provider |
| `skills/` | Vendored `openspec-*/SKILL.md` (generated; see `skills/VENDORED.md`) |
| `scripts/vendor-skills.ts` | Re-vendor `skills/` from upstream (run via `tsx`) |
| `scripts/check-load.ts` | Load-time integration check (run via `tsx`) |
| `scripts/checks/plugin-contract.ts` | Compile-time contract test for the cordis seam |

## Licence

MIT. OpenSpec itself is MIT-licensed and is consumed here as an unmodified
dependency; the vendored skill text under `skills/` is generated from it.
