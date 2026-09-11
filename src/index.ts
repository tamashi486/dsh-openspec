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

import { access, chmod, constants, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';

/** Cordis plugin name. */
export const name = 'dsh-openspec';

/**
 * The command registry is optional: a profile without `dsh-commands` still gets
 * the skill provider from `cordis.patch.yml` plus the load-time probe.
 */
export const inject = { optional: ['commands'] };

/** The upstream package whose `bin` this plugin resolves and launches. */
const UPSTREAM = '@fission-ai/openspec';

/** Name of the launcher this plugin installs onto PATH, and of the CLI's bin entry. */
const SHIM_NAME = 'openspec';

/** Exit code a POSIX shell reports for a missing command. */
const EXIT_NOT_FOUND = 127;

/** Outcome of installing the PATH launcher. */
export type ShimInstallResult =
  | { readonly ok: true; readonly path: string; readonly entry: string }
  | { readonly ok: false; readonly reason: ShimFailureReason; readonly path?: string; readonly message: string };

/** Why the launcher could not be installed. */
export type ShimFailureReason = 'unresolved' | 'foreign' | 'shadowed' | 'no-writable-path-dir';

/**
 * What a shell resolves `openspec` to, and whether it is ours.
 *
 * A discriminated union rather than an optional `path`, because the two
 * resolvable states always have a path and the unresolvable one never does.
 */
export type ShimState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'installed'; readonly path: string }
  | { readonly kind: 'foreign'; readonly path: string };

/** The kind alone, for callers that only branch on it. */
export type ShimStateKind = ShimState['kind'];

/** Outcome of removing the PATH launcher. */
export type ShimRemoveResult =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: ShimStateKind; readonly path: string | undefined };

/** The subset of a package manifest this plugin reads. */
interface PackageManifest {
  readonly version?: string;
  readonly bin?: string | Record<string, string>;
}

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
 */
function packageDirCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, '..', 'node_modules', UPSTREAM),
    join(here, '..', '..', 'node_modules', UPSTREAM)
  ];
}

/** Resolve the upstream package's install directory, or `undefined` when absent. */
function resolvePackageDir(): string | undefined {
  for (const candidate of packageDirCandidates()) {
    if (existsSync(join(candidate, 'package.json'))) return candidate;
  }
  return undefined;
}

/** Read and parse a manifest synchronously; `bin` resolution happens on the load path. */
function readManifestSync(directory: string): PackageManifest | undefined {
  try {
    return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as PackageManifest;
  } catch {
    return undefined;
  }
}

/** Read the installed upstream manifest, or `undefined` when the dependency is absent. */
async function readManifest(): Promise<PackageManifest | undefined> {
  const directory = resolvePackageDir();
  if (directory === undefined) return undefined;
  try {
    return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as PackageManifest;
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
 */
export function resolveCliEntry(): string | undefined {
  const directory = resolvePackageDir();
  if (directory === undefined) return undefined;
  const bin = readManifestSync(directory)?.bin;
  const relative = typeof bin === 'string' ? bin : bin?.[SHIM_NAME];
  return typeof relative === 'string' ? join(directory, relative) : undefined;
}

/** Read the installed upstream version, for doctor output and drift checks. */
async function readCliVersion(): Promise<string | undefined> {
  const version = (await readManifest())?.version;
  return typeof version === 'string' ? version : undefined;
}

/**
 * Render the launcher script.
 *
 * `exec` is used so exit codes and signals pass through unchanged — the skills
 * inspect the CLI's exit status. Both paths are absolute: the Node binary is
 * baked in from the running process rather than resolved via PATH, because the
 * launcher must not depend on PATH already containing a Node that happens to be
 * the right one, and an absolute entry path keeps it correct regardless of the
 * shell's working directory.
 */
function shimText(entry: string): string {
  return `#!/bin/sh\n# Installed by dsh-openspec. Resolves the openspec CLI from the plugin's own\n# dependency tree; safe to delete, and regenerated by \`/openspec shim\`.\nexec "${process.execPath}" "${entry}" "$@"\n`;
}

/**
 * Directories on PATH, in the order a shell resolves them.
 *
 * Order is load-bearing: a shell runs the *first* matching `openspec` it finds,
 * so any statement about which command will run has to come from this order and
 * nothing else.
 */
function pathDirs(): string[] {
  return (process.env['PATH'] ?? '').split(delimiter).filter((entry) => entry.length > 0);
}

/**
 * Where to *write* the launcher, first choice first.
 *
 * This is a preference order, deliberately not PATH order: any candidate is
 * already on PATH, so all else being equal the most conventional location wins.
 * It must not be used to decide which command a shell would resolve — see
 * {@link pathDirs} for that.
 */
function installDirPreference(): string[] {
  const pathEntries = pathDirs();
  const preferred = [
    // The Node installation's bin dir sits on PATH and is user-writable under a
    // version manager, which is the common local setup.
    dirname(process.execPath),
    // npm's global prefix, which the documented `npm i -g` path would also use.
    process.env['npm_config_prefix'] === undefined ? undefined : join(process.env['npm_config_prefix'], 'bin'),
    process.env['HOME'] === undefined ? undefined : join(process.env['HOME'], '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ];
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const candidate of preferred) {
    if (candidate === undefined || candidate === '' || !pathEntries.includes(candidate)) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  return candidates;
}

/** Whether a path exists and is executable by this process. */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Report what a shell resolves `openspec` to, without mutating anything.
 *
 * The scan follows PATH order, because that is the only order that answers the
 * question. A launcher this plugin wrote is *not* automatically the one that
 * runs: a directory earlier on PATH wins, and reporting "installed" for a
 * shadowed launcher would be a false positive — the skills would silently call
 * whatever CLI came first instead.
 */
async function shimStatus(): Promise<ShimState> {
  for (const directory of pathDirs()) {
    const path = join(directory, SHIM_NAME);
    if (!(await isExecutable(path))) continue;
    let existing: string;
    try {
      existing = await readFile(path, 'utf8');
    } catch {
      return { kind: 'foreign', path };
    }
    return existing.includes('Installed by dsh-openspec') ? { kind: 'installed', path } : { kind: 'foreign', path };
  }
  return { kind: 'absent' };
}

/**
 * Install the launcher so that it is what a shell actually resolves.
 *
 * Three things this deliberately does *not* do:
 *
 * - It never overwrites an `openspec` this plugin did not write. A user's own
 *   install outranks this convenience, so that case is reported rather than
 *   papered over.
 * - It does not treat "the file was written" as success. The launcher only helps
 *   if it is the *first* `openspec` on PATH, so the result is re-probed in PATH
 *   order after writing and a shadowed launcher is reported as such.
 * - It does not rely on `mode` to make the file executable. `mode` is ignored
 *   for a path that already exists, so a launcher that lost its execute bit
 *   would be rewritten and still not run; the mode is applied explicitly.
 */
export async function installShim(): Promise<ShimInstallResult> {
  const entry = resolveCliEntry();
  if (entry === undefined) {
    return {
      ok: false,
      reason: 'unresolved',
      message: `${UPSTREAM} is not installed in this plugin's dependency tree — run \`dsh plugin add ${UPSTREAM}\` (or reinstall dsh-openspec), then retry.`
    };
  }

  // A foreign command anywhere on PATH means the shell already resolves
  // `openspec`; writing ours would either be shadowed by it or shadow it.
  const existing = await shimStatus();
  if (existing.kind === 'foreign') {
    return {
      ok: false,
      reason: 'foreign',
      path: existing.path,
      message: `${existing.path} already provides \`openspec\` and was not written by dsh-openspec; leaving it untouched. The skills will call that binary.`
    };
  }

  for (const directory of installDirPreference()) {
    const path = join(directory, SHIM_NAME);
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(path, shimText(entry));
      await chmod(path, 0o755);
    } catch {
      continue;
    }
    const resolved = await shimStatus();
    if (resolved.kind === 'installed' && resolved.path === path) return { ok: true, path, entry };
    // Written, but something earlier on PATH still wins. Report it rather than
    // claiming a success the skills would not see.
    return {
      ok: false,
      reason: 'shadowed',
      path,
      message: `Wrote ${path}, but \`openspec\` still resolves to ${resolved.kind === 'absent' ? 'nothing' : resolved.path}. Earlier PATH entries take precedence; put ${directory} first on PATH, or remove the other install.`
    };
  }

  return {
    ok: false,
    reason: 'no-writable-path-dir',
    message: `None of the preferred PATH directories (${installDirPreference().join(', ') || 'none on PATH'}) is writable. Make one writable (for example ~/.local/bin) and put it on PATH, or install OpenSpec globally with \`npm i -g ${UPSTREAM}\`.`
  };
}

/** Remove the launcher if this plugin installed it. */
export async function removeShim(): Promise<ShimRemoveResult> {
  const state = await shimStatus();
  if (state.kind !== 'installed') return { ok: false, reason: state.kind, path: state.kind === 'foreign' ? state.path : undefined };
  await unlink(state.path);
  return { ok: true, path: state.path };
}

/** A captured CLI execution. */
interface CliRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Run the CLI with an explicit working directory, capturing both streams.
 *
 * `cwd` is explicit rather than inherited: a DSH human command runs in the
 * profile's process, whose working directory is the server's, not a workspace.
 */
function runCli(args: readonly string[], cwd: string): Promise<CliRun> {
  const entry = resolveCliEntry();
  if (entry === undefined) {
    return Promise.resolve({ status: EXIT_NOT_FOUND, stdout: '', stderr: `${UPSTREAM} is not resolvable from dsh-openspec.` });
  }
  return new Promise((settle) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error: Error) => settle({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status: number | null) => settle({ status: status ?? 1, stdout, stderr }));
  });
}

/**
 * Resolve this plugin's own install directory.
 *
 * `require.resolve` is created against this module's URL, and the
 * `./package.json` export makes the self-reference resolvable.
 */
function pluginDir(): string | undefined {
  try {
    return dirname(createRequire(import.meta.url).resolve('dsh-openspec/package.json'));
  } catch {
    return undefined;
  }
}

/** Count bundled skill directories that carry a `SKILL.md`. */
async function countSkills(): Promise<number> {
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
 * Compose a one-screen diagnosis of the plugin's runtime state.
 *
 * The launcher line reports what a shell actually resolves, and the advice is
 * chosen from that. A `foreign` result is *not* a fault: `openspec` resolves
 * fine, it is simply someone else's binary, so telling the user to run
 * `/openspec shim` would both misdescribe the state and prescribe a repair that
 * refuses to act.
 *
 * @returns Human-readable report, also returned verbatim by `/openspec doctor`.
 */
async function diagnose(): Promise<string> {
  const installedVersion = await readCliVersion();
  const cli = resolveCliEntry();
  const shim = await shimStatus();
  const launcher =
    shim.kind === 'absent' ? 'absent' : `${shim.kind} (${shim.path})`;
  const lines = [
    'dsh-openspec',
    `  skills        : bundled provider (skills/, ${await countSkills()} skill(s))`,
    `  CLI package   : ${installedVersion === undefined ? 'MISSING' : `${UPSTREAM}@${installedVersion}`}`,
    `  CLI entry     : ${cli ?? 'unresolved'}`,
    `  PATH resolves : ${launcher}`
  ];
  if (installedVersion === undefined) {
    lines.push('', `The CLI dependency is missing, so no \`openspec\` can run. Fix: dsh plugin add ${UPSTREAM}`, 'Then: /openspec shim');
  } else if (shim.kind === 'absent') {
    lines.push('', 'The skills call the bare `openspec` command, which will not resolve', 'until the launcher is installed. Fix: /openspec shim');
  } else if (shim.kind === 'foreign') {
    lines.push(
      '',
      `\`openspec\` resolves to ${shim.path}, which dsh-openspec did not write.`,
      'The skills will call that binary. If it is an OpenSpec version whose output',
      `differs from this plugin's vendored skills (${installedVersion}), install the`,
      'launcher into a directory earlier on PATH, or remove the other install and',
      'run /openspec shim.'
    );
  }
  return lines.join('\n');
}

/** Whether a shell resolves `openspec` at all, whoever provides it. */
async function openspecResolves(): Promise<boolean> {
  return (await shimStatus()).kind !== 'absent';
}

/** Split a command invocation's raw input into whitespace-separated arguments. */
function inputArgs(rawInput: string): string[] {
  return rawInput.trim().split(/\s+/).filter((part) => part.length > 0);
}

/** The `/openspec` human command. */
function openspecCommand(): CommandDefinition {
  return {
    name: 'openspec',
    description: 'Inspect or repair the OpenSpec integration (doctor | shim | uninstall-shim | init <path>)',
    input: { hint: 'doctor' },
    handler: async (invocation) => {
      const [subcommand = 'doctor', ...rest] = inputArgs(invocation.rawInput);
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
          // directory cannot be inferred: a relative path would resolve against
          // the server's cwd, not the workspace. Requiring an absolute path is
          // the only honest option — guessing would initialize the wrong tree.
          const target = rest[0];
          if (target === undefined) {
            return { kind: 'error', text: 'usage: /openspec init <absolute-path>  (the project directory to initialize)' };
          }
          if (!isAbsolute(target)) {
            return {
              kind: 'error',
              text: `"${target}" is not an absolute path. This command runs in the profile's process, so a relative path would resolve against ${process.cwd()} rather than your workspace. Pass an absolute path.`
            };
          }
          const result = await runCli(['init', '--tools', 'agents'], target);
          const output = `${result.stdout}${result.stderr}`.trim();
          return result.status === 0
            ? { kind: 'success', text: output.length > 0 ? output : '(no output)' }
            : { kind: 'error', text: output.length > 0 ? output : `openspec init exited with ${result.status}` };
        }

        default:
          return { kind: 'error', text: `unknown subcommand "${subcommand}"; expected doctor | shim | uninstall-shim | init` };
      }
    }
  };
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
 */
export function apply(ctx: Context): void {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register(openspecCommand());
  });

  // Probe once, asynchronously, so a missing CLI is reported at load rather than
  // discovered mid-workflow. The catch is not decoration: this promise is
  // detached, so an unexpected rejection would surface as an unhandled rejection
  // in the profile process rather than as a log line.
  void (async () => {
    if (resolveCliEntry() === undefined) {
      ctx.logger.warn(`${name}: ${UPSTREAM} is not installed; the openspec-* skills will not run. Install it with \`dsh plugin add ${UPSTREAM}\`.`);
      return;
    }
    // "Resolves" is the question, not "resolves to ours": a user's own global
    // openspec is a working setup, so warning about it on every load would be a
    // false alarm.
    if (await openspecResolves()) return;
    const outcome = await installShim();
    if (outcome.ok) ctx.logger.info(`${name}: installed the \`openspec\` launcher at ${outcome.path} (remove with \`/openspec uninstall-shim\`).`);
    else ctx.logger.warn(`${name}: \`openspec\` does not resolve and the launcher could not be installed (${outcome.reason}). ${outcome.message}`);
  })().catch((error: unknown) => {
    ctx.logger.warn(`${name}: the load-time check failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}
