#!/usr/bin/env node
/**
 * Load-time integration check for the bundled OpenSpec skill provider.
 *
 * Boots the composed profile through dsh's own `runProfile` entry point — the
 * same path `dsh --profile <name>` takes — and then asks the mounted `skills`
 * registry what it can see. The probe workspace deliberately has **no `.git`
 * anywhere up the tree**, because that is exactly the condition under which
 * OpenSpec's own project-level install (`.agents/skills`) goes invisible to
 * DSH: `findProjectRoot` in dsh-skill-filesystem probes for `.git` and nothing
 * else. Passing here means the bundle's `bundledSkillDir` route works where the
 * naive install does not.
 *
 * Usage:
 *   npm run check-load -- --profile opstest
 *   npm run check-load -- --profile opstest --require propose,apply-change
 *
 * Prerequisites: the plugin installed into that profile
 * (`dsh plugin --profile opstest add <this-dir>`).
 *
 * Note: only *types* come from the plugin source; the skills under test are the
 * packaged `skills/` directory, which is what the installed bundle mounts.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** A discovery summary row, as returned by `ctx.skills.list()`. */
interface SkillSummary {
  readonly name: string;
  readonly description: string;
  readonly source: string;
}

/** A fully loaded skill body. */
interface LoadedSkill {
  readonly name: string;
  readonly content: string;
}

/** The slice of the skills registry this check uses. */
interface SkillsService {
  list(options: { cwd?: string }): Promise<readonly SkillSummary[]>;
  get(name: string, options: { cwd?: string }): Promise<LoadedSkill | undefined>;
}

/** The slice of a booted dsh context this check uses. */
interface BootedContext {
  get(service: string): unknown;
  fiber?: { dispose(): Promise<void> };
}

/** What `runProfile` resolves to. */
interface ProfileRun {
  readonly ctx: BootedContext;
  readonly shutdown?: { interrupt(code: number): void };
}

/** Parsed command-line options. */
interface Options {
  readonly profile: string;
  readonly cwd: string | undefined;
  readonly require: readonly string[];
  readonly settleMs: number;
}

/** Parse `--key value` arguments. */
function parseArgs(argv: readonly string[]): Options {
  let profile = 'opstest';
  let cwd: string | undefined;
  let required: readonly string[] = [];
  let settleMs = 3000;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === '--profile') {
      if (value === undefined) throw new Error('--profile requires a value');
      profile = value;
      index += 1;
    } else if (argument === '--cwd') {
      if (value === undefined) throw new Error('--cwd requires a value');
      cwd = value;
      index += 1;
    } else if (argument === '--require') {
      if (value === undefined) throw new Error('--require requires a value');
      required = value.split(',').filter(Boolean);
      index += 1;
    } else if (argument === '--settle-ms') {
      if (value === undefined) throw new Error('--settle-ms requires a value');
      settleMs = Number(value);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { profile, cwd, require: required, settleMs };
}

/**
 * Locate the installed `@deepseek-ai/dsh` package.
 *
 * CI and other machines have neither this developer's nvm prefix nor the same
 * release, so the location is resolved rather than assumed — `dsh` is found on
 * PATH and its install root derived from there. `DSH_INSTALL_DIR` overrides.
 */
function resolveDshInstall(): string {
  const override = process.env['DSH_INSTALL_DIR'];
  if (override !== undefined && override !== '') return override;
  const located = spawnSync('which', ['dsh'], { encoding: 'utf8' });
  if (located.status === 0) {
    // <prefix>/bin/dsh is a symlink into <prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js
    const binary = realpathSync(located.stdout.trim());
    const libDir = dirname(binary);
    const install = dirname(libDir);
    if (existsSync(join(install, 'package.json')) && existsSync(join(libDir, 'bin.js'))) return install;
  }
  throw new Error('cannot locate the dsh installation; set DSH_INSTALL_DIR to the @deepseek-ai/dsh package directory');
}

/**
 * Resolve the internal module that owns `runProfile`.
 *
 * dsh's build emits content-hashed filenames (`profile-boot-<hash>.js`) and a
 * stable `profile-boot.js` that merely re-exports from one of them. Which hash
 * exists varies by release, so the file is discovered by pattern instead of
 * pinned — pinning would make this check fail on every dsh upgrade for a reason
 * that has nothing to do with this plugin.
 */
async function resolveProfileBoot(libDir: string): Promise<string> {
  const entries = await readdir(libDir);
  const candidates = entries.filter((entry) => /^profile-boot.*\.js$/.test(entry)).sort();
  if (candidates.length === 0) throw new Error(`no profile-boot module found in ${libDir}`);
  for (const candidate of candidates) {
    const full = join(libDir, candidate);
    // The module is untyped JS whose name carries a build hash; the shape this
    // check needs is asserted here and validated by the export probe below.
    const module = (await import(pathToFileURL(full).href)) as { runProfile?: unknown };
    if (typeof module.runProfile === 'function') return full;
  }
  throw new Error(`none of ${candidates.join(', ')} exported runProfile in ${libDir}`);
}

/** Walk up from `start` looking for a `.git` entry; undefined when there is none. */
function nearestGitDir(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

const options = parseArgs(process.argv.slice(2));

const DSH_INSTALL = resolveDshInstall();
const appBoot = (await import(
  new URL('node_modules/@deepseek-ai/dsh-app-boot/lib/index.js', pathToFileURL(`${DSH_INSTALL}/`).href).href
)) as { loadLayeredEnv(binName: string): unknown };
const { runProfile } = (await import(pathToFileURL(await resolveProfileBoot(join(DSH_INSTALL, 'lib'))).href)) as {
  runProfile(input: { environment: unknown; profile: string; patchFiles: readonly string[]; args: readonly string[] }): Promise<ProfileRun>;
};

const scratch = options.cwd === undefined ? await mkdtemp(join(tmpdir(), 'dsh-openspec-nogit-')) : undefined;
const workspace = options.cwd ?? scratch;
if (workspace === undefined) throw new Error('unreachable: workspace resolved from cwd or scratch');

let ctx: BootedContext | undefined;
let shutdown: ProfileRun['shutdown'];
let exitCode = 0;

try {
  const run = await runProfile({
    environment: appBoot.loadLayeredEnv('dsh'),
    profile: options.profile,
    patchFiles: [],
    args: []
  });
  ctx = run.ctx;
  shutdown = run.shutdown;

  // The skills provider registers asynchronously once its fiber activates, so
  // an immediate read can legitimately race it.
  await new Promise((settle) => setTimeout(settle, options.settleMs));

  const skills = ctx.get('skills') as SkillsService | undefined;
  const gitDir = nearestGitDir(workspace);
  process.stdout.write(`profile   : ${options.profile}\n`);
  process.stdout.write(`workspace : ${workspace}\n`);
  process.stdout.write(`git root  : ${gitDir ?? 'NONE (project-level skills would be invisible)'}\n`);

  if (skills === undefined) {
    process.stderr.write('FAIL: the skills service is not mounted after boot.\n');
    exitCode = 1;
  } else {
    const catalog = await skills.list({ cwd: workspace });
    const names = catalog.map((summary) => summary.name).sort();
    process.stdout.write(`skills    : ${names.length === 0 ? '(none)' : names.join(', ')}\n`);

    const openspecSkills = names.filter((skillName) => skillName.startsWith('openspec-'));
    const missing = options.require.map((suffix) => `openspec-${suffix}`).filter((skillName) => !openspecSkills.includes(skillName));

    if (openspecSkills.length === 0) {
      process.stderr.write('\nFAIL: no openspec-* skills visible\n');
      exitCode = 1;
    } else if (missing.length > 0) {
      process.stderr.write(`\nFAIL: missing required skills: ${missing.join(', ')}\n`);
      exitCode = 1;
    } else {
      // Reading a body proves the provider resolves files, not just names.
      const probe = openspecSkills.includes('openspec-propose') ? 'openspec-propose' : openspecSkills[0];
      if (probe === undefined) throw new Error('unreachable: non-empty openspec skills');
      const loaded = await skills.get(probe, { cwd: workspace });
      if (loaded === undefined || loaded.content.length === 0) {
        process.stderr.write(`\nFAIL: skill "${probe}" could not be loaded\n`);
        exitCode = 1;
      } else {
        process.stdout.write(`loaded    : ${probe} (${loaded.content.length} bytes)\n`);
        process.stdout.write('\nOK\n');
      }
    }
  }
} catch (error) {
  process.stderr.write(`FAIL: ${error instanceof Error ? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  await ctx?.fiber?.dispose().catch(() => {});
  shutdown?.interrupt(0);
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
}

// `runProfile` registers signal handlers and timers that would otherwise keep
// the loop alive; the verdict is already decided.
process.exit(exitCode);
