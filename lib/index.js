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
function packageDirCandidates() {
    const here = dirname(fileURLToPath(import.meta.url));
    return [
        join(here, '..', 'node_modules', UPSTREAM),
        join(here, '..', '..', 'node_modules', UPSTREAM)
    ];
}
/** Resolve the upstream package's install directory, or `undefined` when absent. */
function resolvePackageDir() {
    for (const candidate of packageDirCandidates()) {
        if (existsSync(join(candidate, 'package.json')))
            return candidate;
    }
    return undefined;
}
/** Read and parse a manifest synchronously; `bin` resolution happens on the load path. */
function readManifestSync(directory) {
    try {
        return JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    }
    catch {
        return undefined;
    }
}
/** Read the installed upstream manifest, or `undefined` when the dependency is absent. */
async function readManifest() {
    const directory = resolvePackageDir();
    if (directory === undefined)
        return undefined;
    try {
        return JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    }
    catch {
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
export function resolveCliEntry() {
    const directory = resolvePackageDir();
    if (directory === undefined)
        return undefined;
    const bin = readManifestSync(directory)?.bin;
    const relative = typeof bin === 'string' ? bin : bin?.[SHIM_NAME];
    return typeof relative === 'string' ? join(directory, relative) : undefined;
}
/** Read the installed upstream version, for doctor output and drift checks. */
async function readCliVersion() {
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
function shimText(entry) {
    return `#!/bin/sh\n# Installed by dsh-openspec. Resolves the openspec CLI from the plugin's own\n# dependency tree; safe to delete, and regenerated by \`/openspec shim\`.\nexec "${process.execPath}" "${entry}" "$@"\n`;
}
/**
 * Candidate directories for the launcher, most specific first.
 *
 * Only directories already on the invoking PATH are eligible: the whole point
 * is to be resolvable from the agent's shell without a profile restart, and
 * writing outside PATH would silently not help.
 */
function shimCandidates() {
    const pathEntries = (process.env['PATH'] ?? '').split(delimiter).filter((entry) => entry.length > 0);
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
    const seen = new Set();
    const candidates = [];
    for (const candidate of preferred) {
        if (candidate === undefined || candidate === '' || !pathEntries.includes(candidate))
            continue;
        if (seen.has(candidate))
            continue;
        seen.add(candidate);
        candidates.push(candidate);
    }
    // Anything else on PATH is a last resort, still before giving up.
    for (const entry of pathEntries) {
        if (seen.has(entry))
            continue;
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
    }
    catch {
        return false;
    }
}
/**
 * Report the current state of the launcher without mutating anything.
 *
 * Distinguishes "already ours and correct" from "absent" and from "occupied by
 * someone else's openspec", because only the middle case may be overwritten.
 */
async function shimStatus() {
    for (const directory of shimCandidates()) {
        const path = join(directory, SHIM_NAME);
        if (!(await isExecutable(path)))
            continue;
        let existing;
        try {
            existing = await readFile(path, 'utf8');
        }
        catch {
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
            }
            catch {
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
        }
        catch {
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
    if (state !== 'installed' || path === undefined)
        return { ok: false, reason: state, path };
    await unlink(path);
    return { ok: true, path };
}
/**
 * Run the CLI with an explicit working directory, capturing both streams.
 *
 * `cwd` is explicit rather than inherited: a DSH human command runs in the
 * profile's process, whose working directory is the server's, not a workspace.
 */
function runCli(args, cwd) {
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
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', (error) => settle({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
        child.on('close', (status) => settle({ status: status ?? 1, stdout, stderr }));
    });
}
/**
 * Resolve this plugin's own install directory.
 *
 * `require.resolve` is created against this module's URL, and the
 * `./package.json` export makes the self-reference resolvable.
 */
function pluginDir() {
    try {
        return dirname(createRequire(import.meta.url).resolve('dsh-openspec/package.json'));
    }
    catch {
        return undefined;
    }
}
/** Count bundled skill directories that carry a `SKILL.md`. */
async function countSkills() {
    const directory = pluginDir();
    if (directory === undefined)
        return 0;
    const root = join(directory, 'skills');
    try {
        const entries = await readdir(root, { withFileTypes: true });
        let count = 0;
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            try {
                await access(join(root, entry.name, 'SKILL.md'), constants.R_OK);
                count += 1;
            }
            catch {
                // A directory without SKILL.md is not a skill; VENDORED.md is a file.
            }
        }
        return count;
    }
    catch {
        return 0;
    }
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
    }
    else if (shim.state !== 'installed') {
        lines.push('', 'The skills call the bare `openspec` command, which will not resolve', 'until the launcher is installed. Fix: /openspec shim');
    }
    return lines.join('\n');
}
/** True when the PATH launcher is present and owned by this plugin. */
async function shimResolves() {
    return (await shimStatus()).state === 'installed';
}
/** Split a command invocation's raw input into whitespace-free arguments. */
function inputArgs(rawInput) {
    return rawInput.trim().split(/\s+/).filter((part) => part.length > 0);
}
/** The `/openspec` human command. */
function openspecCommand() {
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
                    // directory cannot be inferred — it is required, not defaulted.
                    const target = rest[0];
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
export function apply(ctx) {
    ctx.inject(['commands'], (commandCtx) => {
        commandCtx.commands.register(openspecCommand());
    });
    // Probe once, asynchronously, so a missing CLI is reported at load rather than
    // discovered mid-workflow.
    void (async () => {
        if (resolveCliEntry() === undefined) {
            ctx.logger.warn(`${name}: ${UPSTREAM} is not installed; the openspec-* skills will not run. Install it with \`dsh plugin add ${UPSTREAM}\`.`);
            return;
        }
        if (await shimResolves())
            return;
        const outcome = await installShim();
        if (outcome.ok)
            ctx.logger.info(`${name}: installed the \`openspec\` launcher at ${outcome.path} (remove with \`/openspec uninstall-shim\`).`);
        else
            ctx.logger.warn(`${name}: \`openspec\` is not on PATH and the launcher could not be installed (${outcome.reason}). Run \`/openspec doctor\`.`);
    })();
}
//# sourceMappingURL=index.js.map