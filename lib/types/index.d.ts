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
import type { Context } from '@deepseek-ai/cordis';
/** Cordis plugin name. */
export declare const name = "dsh-openspec";
/**
 * The command registry is optional: a profile without `dsh-commands` still gets
 * the skill provider from `cordis.patch.yml` plus the load-time probe.
 */
export declare const inject: {
    optional: string[];
};
/** Outcome of installing the PATH launcher. */
export type ShimInstallResult = {
    readonly ok: true;
    readonly path: string;
    readonly entry: string;
} | {
    readonly ok: false;
    readonly reason: ShimFailureReason;
    readonly path?: string;
    readonly message: string;
};
/** Why the launcher could not be installed. */
export type ShimFailureReason = 'unresolved' | 'foreign' | 'shadowed' | 'no-writable-path-dir';
/**
 * What a shell resolves `openspec` to, and whether it is ours.
 *
 * A discriminated union rather than an optional `path`, because the two
 * resolvable states always have a path and the unresolvable one never does.
 */
export type ShimState = {
    readonly kind: 'absent';
} | {
    readonly kind: 'installed';
    readonly path: string;
} | {
    readonly kind: 'foreign';
    readonly path: string;
};
/** The kind alone, for callers that only branch on it. */
export type ShimStateKind = ShimState['kind'];
/** Outcome of removing the PATH launcher. */
export type ShimRemoveResult = {
    readonly ok: true;
    readonly path: string;
} | {
    readonly ok: false;
    readonly reason: ShimStateKind;
    readonly path: string | undefined;
};
/**
 * Resolve the CLI's entry script.
 *
 * The path comes from the package's own `bin` declaration rather than a
 * hardcoded `bin/openspec.js`, so an upstream rename is followed instead of
 * silently breaking.
 */
export declare function resolveCliEntry(): string | undefined;
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
export declare function installShim(): Promise<ShimInstallResult>;
/** Remove the launcher if this plugin installed it. */
export declare function removeShim(): Promise<ShimRemoveResult>;
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
export declare function apply(ctx: Context): void;
//# sourceMappingURL=index.d.ts.map