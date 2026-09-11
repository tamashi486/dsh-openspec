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
 *   node scripts/check-load.mjs --profile opstest
 *   node scripts/check-load.mjs --profile opstest --cwd /some/non-git/dir
 *   node scripts/check-load.mjs --profile opstest --require propose,apply-change
 *
 * Prerequisites: the plugin installed into that profile
 * (`dsh plugin --profile opstest add <this-dir>`).
 *
 * Note: `runProfile` installs SIGINT/SIGTERM handlers and expects to own process
 * lifetime, which is why this script shuts its context down explicitly and
 * exits rather than returning to a normal event loop.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Locate the installed `@deepseek-ai/dsh` package.
 *
 * CI and other machines have neither this developer's nvm prefix nor the same
 * release, so the location is resolved rather than assumed — `dsh` is found on
 * PATH and its install root derived from there. `DSH_INSTALL_DIR` overrides.
 */
function resolveDshInstall() {
  if (process.env.DSH_INSTALL_DIR !== undefined && process.env.DSH_INSTALL_DIR !== '') {
    return process.env.DSH_INSTALL_DIR;
  }
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
 *
 * @param libDir - The dsh package's `lib` directory.
 * @returns Absolute path to the module exporting `runProfile`.
 */
async function resolveProfileBoot(libDir) {
  const entries = await readdir(libDir);
  const candidates = entries.filter((entry) => /^profile-boot.*\.js$/.test(entry)).sort();
  if (candidates.length === 0) throw new Error(`no profile-boot module found in ${libDir}`);
  for (const candidate of candidates) {
    const module = await import(pathToFileURL(join(libDir, candidate)).href);
    if (typeof module.runProfile === 'function') return join(libDir, candidate);
  }
  throw new Error(`none of ${candidates.join(', ')} exported runProfile in ${libDir}`);
}

/** Parse `--key value` arguments. */
function parseArgs(argv) {
  const options = { profile: 'opstest', cwd: undefined, require: [], settleMs: 3000 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--profile') options.profile = argv[++index];
    else if (argument === '--cwd') options.cwd = argv[++index];
    else if (argument === '--require') options.require = argv[++index].split(',').filter(Boolean);
    else if (argument === '--settle-ms') options.settleMs = Number(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));

/** Walk up from `start` looking for a `.git` entry; undefined when there is none. */
function nearestGitDir(start) {
  let current = resolve(start);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

const DSH_INSTALL = resolveDshInstall();
const appBoot = await import(new URL('node_modules/@deepseek-ai/dsh-app-boot/lib/index.js', pathToFileURL(`${DSH_INSTALL}/`).href));
const { loadLayeredEnv } = appBoot;
const { runProfile } = await import(pathToFileURL(await resolveProfileBoot(join(DSH_INSTALL, 'lib'))).href);

const scratch = options.cwd === undefined ? await mkdtemp(join(tmpdir(), 'dsh-openspec-nogit-')) : undefined;
const workspace = options.cwd ?? scratch;

let ctx;
let shutdown;
let exitCode = 0;

try {
  ({ ctx, shutdown } = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: options.profile,
    patchFiles: [],
    args: []
  }));

  // The skills provider registers asynchronously once its fiber activates, so
  // an immediate read can legitimately race it.
  await new Promise((settle) => setTimeout(settle, options.settleMs));

  const skills = ctx.get('skills');
  const gitDir = nearestGitDir(workspace);
  console.log(`profile   : ${options.profile}`);
  console.log(`workspace : ${workspace}`);
  console.log(`git root  : ${gitDir ?? 'NONE (project-level skills would be invisible)'}`);

  if (skills === undefined) {
    console.error('FAIL: the skills service is not mounted after boot.');
    exitCode = 1;
  } else {
    const catalog = await skills.list({ cwd: workspace });
    const names = catalog.map((summary) => summary.name).sort();
    console.log(`skills    : ${names.length === 0 ? '(none)' : names.join(', ')}`);

    const openspecSkills = names.filter((name) => name.startsWith('openspec-'));
    const missing = options.require.map((suffix) => `openspec-${suffix}`).filter((name) => !openspecSkills.includes(name));

    if (openspecSkills.length === 0) {
      console.error('\nFAIL: no openspec-* skills visible');
      exitCode = 1;
    } else if (missing.length > 0) {
      console.error(`\nFAIL: missing required skills: ${missing.join(', ')}`);
      exitCode = 1;
    } else {
      // Reading a body proves the provider resolves files, not just names.
      const probe = openspecSkills.includes('openspec-propose') ? 'openspec-propose' : openspecSkills[0];
      const loaded = await skills.get(probe, { cwd: workspace });
      if (loaded === undefined || loaded.content.length === 0) {
        console.error(`\nFAIL: skill "${probe}" could not be loaded`);
        exitCode = 1;
      } else {
        console.log(`loaded    : ${probe} (${loaded.content.length} bytes)`);
        console.log('\nOK');
      }
    }
  }
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await ctx?.fiber?.dispose?.().catch(() => {});
  shutdown?.interrupt?.(0);
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
}

// `runProfile` registers signal handlers and timers that would otherwise keep
// the loop alive; the verdict is already decided.
process.exit(exitCode);
