/**
 * OpenSpec bridge for DeepSeek Harness.
 *
 * Two jobs, one per failure mode of installing OpenSpec the ordinary way:
 *
 * 1. **CLI resolution.** Every vendored `openspec-*` skill body calls the bare
 *    command `openspec`. OpenSpec assumes a global install; the profile's own
 *    `node_modules/.bin` is *not* on the PATH that DSH's bash tool sees, and
 *    `ctx.shellEnv` only injects `DSH_*`-prefixed keys, so a dependency alone
 *    would leave the command unresolved. {@link installShim} materializes a
 *    small launcher into a directory that is already on PATH.
 *
 * 2. **Failure visibility.** Without the CLI, the skills still load and the
 *    agent only discovers the problem at `openspec context --json`, mid-workflow.
 *    {@link apply} therefore probes resolution at load time and warns once.
 *
 * The `/openspec` human command exposes the same diagnosis, plus delegation, to
 * a user who would rather not ask the model.
 *
 * @module dsh-openspec
 */

import { access, constants, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

/** Cordis plugin name. */
export const name = 'dsh-openspec';

/**
 * The command registry is optional: a profile without `dsh-commands` still gets
 * the skill provider from `cordis.patch.yml` plus the load-time probe.
 */
export const inject = { optional: ['commands'] };

/** The upstream package whose `bin` this plugin resolves and launches. */
const UPSTREAM = '@fission-ai/openspec';

/** Name of the launcher this plugin installs onto PATH. */
const SHIM_NAME = 'openspec';

/**
 * Resolve a candidate install directory for the upstream package.
 *
 * Upstream declares an `exports` map exposing only `.`, so neither
 * `@fission-ai/openspec/package.json` nor `.../bin/openspec.js` can be resolved
 * through Node's package resolution. The directory is therefore derived from
 * this plugin's own module location, which yields the correct answer under both
 * the hoisted layout (`<profile>/node_modules`) and a nested one
 * (`<profile>/node_modules/dsh-openspec/node_modules`) without guessing which
 * link strategy pnpm chose.
 *
 * @returns Candidate directories, nearest first.
 */
function packageDirCandidates() {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, '..', 'node_modules', UPSTREAM),
    join(here, '..', '..', 'node_modules', UPSTREAM)
  ];
}

/**
 * Resolve the upstream package's install directory.
 *
 * @returns Absolute package directory, or undefined when unresolvable.
 */
function resolvePackageDir() {
  for (const candidate of packageDirCandidates()) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/** Read the package manifest, or undefined when the dependency is absent. */
async function readManifest() {
  const directory = resolvePackageDir();
  if (directory === undefined) return undefined;
  try {
    return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Resolve the CLI's entry script.
 *
 * The path comes from the package's own `bin` declaration rather than a
 * hardcoded `bin/openspec.js`, so an upstream rename is followed instead of
 * silently breaking.
 *
 * @returns Absolute path to the CLI entry script, or undefined when unresolvable.
 */
function resolveCliEntry() {
  const directory = resolvePackageDir();
  if (directory === undefined) return undefined;
  const manifest = readManifestSync(directory);
  const bin = manifest?.bin;
  const relative = typeof bin === 'string' ? bin : bin?.[SHIM_NAME];
  return typeof relative === 'string' ? join(directory, relative) : undefined;
}

/**
 * Read and parse a manifest synchronously.
 *
 * `bin` resolution happens on the synchronous plugin-loading path, so this
 * cannot await.
 *
 * @param directory - Package directory holding `package.json`.
 * @returns Parsed manifest, or undefined when unreadable.
 */
function readManifestSync(directory) {
  try {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Read the installed upstream version, for doctor output and drift checks. */
async function readCliVersion() {
  const manifest = await readManifest();
  return typeof manifest?.version === 'string' ? manifest.version : undefined;
}

/**
 * Render the launcher script.
 *
 * `exec` is used so exit codes and signals pass through unchanged — the skills
 * inspect the CLI's exit status. The entry path is absolute because the plugin
 * location is stable for the life of an installation, and an absolute path
 * keeps the launcher correct regardless of the shell's working directory.
 *
 * @param entry - Absolute path to the CLI entry script.
 * @returns POSIX shell launcher text.
 */
function shimText(entry) {
  return `#!/bin/sh\n# Installed by dsh-openspec. Resolves the openspec CLI from the plugin's own\n# dependency tree; safe to delete, and regenerated by \`/openspec shim\`.\nexec node "${entry}" "$@"\n`;
}

/**
 * Candidate directories for the launcher, most specific first.
 *
 * Only directories already on the invoking PATH are eligible: the whole point
 * is to be resolvable from the agent's shell without a profile restart, and
 * writing outside PATH would silently not help.
 *
 * @returns Candidate directories, deduplicated, in preference order.
 */
function shimCandidates() {
  const pathEntries = (process.env.PATH ?? '').split(delimiter).filter((entry) => entry.length > 0);
  const preferred = [
    // The Node installation's bin dir sits on PATH and is user-writable under
    // a version manager, which is the common local setup.
    process.execPath === undefined ? undefined : dirname(process.execPath),
    // npm's global prefix, which the documented `npm i -g` path would also use.
    process.env.npm_config_prefix === undefined ? undefined : join(process.env.npm_config_prefix, 'bin'),
    join(process.env.HOME ?? '', '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ];
  const seen = new Set();
  const candidates = [];
  for (const candidate of preferred) {
    if (candidate === undefined || candidate === '' || !pathEntries.includes(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  // Anything else on PATH is a last resort, still before giving up.
  for (const entry of pathEntries) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    candidates.push(entry);
  }
  return candidates;
}

/** Whether a path exists and is executable by this process. */
async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Report the current state of the launcher without mutating anything.
 *
 * Distinguishes "already ours and correct" from "absent" and from "occupied by
 * someone else's openspec", because only the middle case may be overwritten.
 *
 * @returns `{ path, state }` where state is 'installed' | 'absent' | 'foreign'.
 */
async function shimStatus() {
  for (const directory of shimCandidates()) {
    const path = join(directory, SHIM_NAME);
    if (!(await isExecutable(path))) continue;
    let existing;
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      return { path, state: 'foreign' };
    }
    return { path, state: existing.includes('Installed by dsh-openspec') ? 'installed' : 'foreign' };
  }
  return { path: undefined, state: 'absent' };
}

/**
 * Write the launcher into the first writable PATH directory.
 *
 * An existing launcher that is not ours is never clobbered: a user's own
 * `openspec` (a real global install, a wrapper) outranks this convenience, and
 * the caller is told where it is so the conflict is legible.
 *
 * @returns Outcome describing what happened and where.
 */
export async function installShim() {
  const entry = resolveCliEntry();
  if (entry === undefined) {
    return {
      ok: false,
      reason: 'unresolved',
      message: `${UPSTREAM} is not installed in this plugin's dependency tree — run \`dsh plugin add ${UPSTREAM}\` (or reinstall dsh-openspec), then retry.`
    };
  }

  for (const directory of shimCandidates()) {
    const path = join(directory, SHIM_NAME);
    if (await isExecutable(path)) {
      let existing;
      try {
        existing = await readFile(path, 'utf8');
      } catch {
        existing = undefined;
      }
      if (existing !== undefined && !existing.includes('Installed by dsh-openspec')) {
        return {
          ok: false,
          reason: 'foreign',
          path,
          message: `${path} already exists and was not written by dsh-openspec; leaving it untouched.`
        };
      }
    }
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path, shimText(entry), { mode: 0o755 });
      return { ok: true, path, entry };
    } catch {
      continue;
    }
  }

  return {
    ok: false,
    reason: 'no-writable-path-dir',
    message: 'No writable directory on PATH was found; pass an explicit directory or add one to PATH.'
  };
}

/** Remove the launcher if this plugin installed it. */
export async function removeShim() {
  const { path, state } = await shimStatus();
  if (state !== 'installed') return { ok: false, reason: state, path };
  await unlink(path);
  return { ok: true, path };
}

/**
 * Run the CLI with an explicit working directory, capturing both streams.
 *
 * @param args - CLI arguments.
 * @param cwd - Absolute working directory the CLI must run in.
 * @returns Exit status plus captured output; status is 127 when unresolvable.
 */
function runCli(args, cwd) {
  const entry = resolveCliEntry();
  if (entry === undefined) {
    return Promise.resolve({ status: 127, stdout: '', stderr: `${UPSTREAM} is not resolvable from dsh-openspec.` });
  }
  return new Promise((settle) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => settle({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => settle({ status: status ?? 1, stdout, stderr }));
  });
}

/**
 * Compose a one-screen diagnosis of the plugin's runtime state.
 *
 * @returns Human-readable report, also returned verbatim by `/openspec doctor`.
 */
async function diagnose() {
  const installedVersion = await readCliVersion();
  const cli = resolveCliEntry();
  const shim = await shimStatus();
  const lines = [
    'dsh-openspec',
    `  skills        : bundled provider (skills/, ${await countSkills()} skill(s))`,
    `  CLI package   : ${installedVersion === undefined ? 'MISSING' : `${UPSTREAM}@${installedVersion}`}`,
    `  CLI entry     : ${cli ?? 'unresolved'}`,
    `  PATH launcher : ${shim.state}${shim.path === undefined ? '' : ` (${shim.path})`}`
  ];
  if (installedVersion === undefined) {
    lines.push('', `Fix: dsh plugin add ${UPSTREAM}`, 'Then: /openspec shim');
  } else if (shim.state !== 'installed') {
    lines.push('', 'The skills call the bare `openspec` command, which will not resolve', 'until the launcher is installed. Fix: /openspec shim');
  }
  return lines.join('\n');
}

/** Count bundled skill directories that carry a SKILL.md. */
async function countSkills() {
  const directory = pluginDir();
  if (directory === undefined) return 0;
  const root = join(directory, 'skills');
  try {
    const entries = await readdir(root, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        await access(join(root, entry.name, 'SKILL.md'), constants.R_OK);
        count += 1;
      } catch {
        // A directory without SKILL.md is not a skill; VENDORED.md is a file.
      }
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Resolve this plugin's own install directory.
 *
 * `lib/index.js` is resolved through a self-reference, which works because the
 * package declares an `exports` entry for `.`.
 *
 * @returns Absolute plugin directory, or undefined when unresolvable.
 */
function pluginDir() {
  try {
    return dirname(require.resolve('dsh-openspec/package.json'));
  } catch {
    return undefined;
  }
}

/** True when the PATH launcher resolves to this plugin's CLI. */
async function shimResolves() {
  return (await shimStatus()).state === 'installed';
}

/**
 * Load the plugin.
 *
 * The command surface is deliberately narrow, and every project-scoped
 * subcommand takes its directory as an explicit argument. A DSH human command
 * runs in the profile's own process, where `process.cwd()` is the server's
 * directory rather than the workspace, so a defaulted path would silently
 * operate on the wrong project. Workflow subcommands (`status`, `apply`,
 * `archive`) are left to the agent's bash tool for the same reason: there the
 * working directory is already the workspace.
 *
 * The load-time probe warns rather than throws. The skills are still worth
 * mounting when the CLI is missing — they are what tells the user to install it
 * — and a hard failure would take the whole profile down over a missing optional
 * dependency. A missing *launcher*, by contrast, is repaired in place.
 *
 * @param ctx - Cordis context owned by this plugin's fiber.
 */
export function apply(ctx) {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'openspec',
      description: 'Inspect or repair the OpenSpec integration (doctor | shim | uninstall-shim | init <path>)',
      input: { hint: 'doctor' },
      handler: async (invocation) => {
        const subcommand = invocation.rawInput.trim().split(/\s+/).filter((part) => part.length > 0)[0] ?? 'doctor';
        switch (subcommand) {
          case 'doctor':
            return { kind: 'success', text: await diagnose() };
          case 'shim': {
            const outcome = await installShim();
            return outcome.ok
              ? { kind: 'success', text: `Installed launcher at ${outcome.path}\nVerify with: openspec --version` }
              : { kind: 'error', text: outcome.message };
          }
          case 'uninstall-shim': {
            const outcome = await removeShim();
            return outcome.ok
              ? { kind: 'success', text: `Removed launcher at ${outcome.path}` }
              : { kind: 'error', text: `No launcher installed by dsh-openspec (state: ${outcome.reason}).` };
          }
          case 'init': {
            // A DSH human command runs in the profile's process, so the project
            // directory cannot be inferred — it is required, not defaulted.
            const target = invocation.rawInput.trim().split(/\s+/).filter((part) => part.length > 0)[1];
            if (target === undefined) {
              return { kind: 'error', text: 'usage: /openspec init <path>  (the project directory to initialize)' };
            }
            const result = await runCli(['init', '--tools', 'agents'], resolve(target));
            const output = `${result.stdout}${result.stderr}`.trim();
            return result.status === 0
              ? { kind: 'success', text: output.length > 0 ? output : '(no output)' }
              : { kind: 'error', text: output.length > 0 ? output : `openspec init exited with ${result.status}` };
          }
          default:
            return { kind: 'error', text: `unknown subcommand "${subcommand}"; expected doctor | shim | uninstall-shim | init` };
        }
      }
    });
  });

  // Probe once, asynchronously, so a missing CLI is reported at load rather than
  // discovered mid-workflow. A missing *launcher* is repaired in place: the
  // skills call the bare `openspec` command, so without it every bundled skill
  // is inert, and the repair is a small file this plugin owns and can remove.
  void (async () => {
    if (resolveCliEntry() === undefined) {
      ctx.logger?.warn?.(`${name}: ${UPSTREAM} is not installed; the openspec-* skills will not run. Install it with \`dsh plugin add ${UPSTREAM}\`.`);
      return;
    }
    if (await shimResolves()) return;
    const outcome = await installShim();
    if (outcome.ok) ctx.logger?.info?.(`${name}: installed the \`openspec\` launcher at ${outcome.path} (remove with \`/openspec uninstall-shim\`).`);
    else ctx.logger?.warn?.(`${name}: \`openspec\` is not on PATH and the launcher could not be installed (${outcome.reason}). Run \`/openspec doctor\`.`);
  })();
}
