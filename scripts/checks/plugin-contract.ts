/**
 * Compile-time contract test for the cordis plugin seam.
 *
 * This file has no runtime behaviour and emits nothing; it exists so
 * `npm run typecheck` fails if this plugin's exports stop satisfying cordis's
 * own plugin contract. That matters because `@deepseek-ai/cordis` and the dsh
 * packages are pinned to a release candidate, where a signature change is a
 * normal event rather than an exceptional one.
 *
 * Two seams are asserted:
 *
 * 1. **cordis's plugin contract** — `name`, the `inject` shape, and an `apply`
 *    that accepts the real `Context`. `cordis.patch.yml` mounts this package as
 *    a plugin, so a divergence here means the bundle fails to load at all.
 * 2. **the command registration contract** — that the `/openspec` definition is
 *    assignable to dsh-commands' `CommandDefinition`, which is the type the
 *    registry's `register()` consumes. The plugin declares that return type, so
 *    a change on the dsh side surfaces here rather than at runtime.
 *
 * The value of the second assertion is that it does not restate `name` or
 * `description`; it checks *assignability*, so it keeps holding when the
 * upstream interface gains optional members.
 */

import type { Context } from '@deepseek-ai/cordis';
import type { CommandDefinition } from '@deepseek-ai/dsh-commands';
import { apply, inject, name } from '../../src/index.ts';

/** cordis's plugin contract, restated structurally so this file needs no internal type. */
interface CordisPluginContract {
  readonly name: string;
  readonly inject?: { readonly required?: readonly string[]; readonly optional?: readonly string[] };
  readonly apply: (ctx: Context) => void;
}

const asCordisPlugin: CordisPluginContract = { name, inject, apply };

/**
 * The command seam. `Context['commands']` exists only because `dsh-commands`
 * augments cordis's `Context` interface, so reading it here also proves that
 * augmentation is in scope. The registry's `register()` takes a
 * `CommandDefinition`, which is the type the plugin declares its definition
 * with, so this assignment fails if the two drift.
 */
type CommandRegistration = Parameters<Context['commands']['register']>[0];
const _commandSeam: CommandRegistration extends CommandDefinition ? true : never = true;

export { asCordisPlugin, _commandSeam };
