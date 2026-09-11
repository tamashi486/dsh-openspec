#!/usr/bin/env node
/**
 * Re-vendor the OpenSpec agent skills into `skills/`.
 *
 * Upstream keeps the skill bodies in TypeScript source and renders them per
 * tool at install time, so the npm package ships no `.agents/skills/` tree to
 * copy. The only faithful way to obtain the rendered Markdown is to run
 * upstream's own installer and take what it writes — which is what this script
 * does, rather than re-implementing the tool-specific transformer here (that
 * transformer decides, among other things, whether cross-references render as
 * `/opsx:apply`, `/openspec-*`, or plain prose, and duplicating it would drift).
 *
 * `--tools agents` is deliberately the target: it is upstream's vendor-neutral
 * skills-only option. It generates no `opsx-*` command files at all, so the
 * rendered skill bodies reference sibling skills by name — which is exactly how
 * DSH's skill catalog is addressed.
 *
 * Usage:
 *   npm run vendor-skills                              # latest published version
 *   npm run vendor-skills -- --version 1.13.0
 *   npm run vendor-skills -- --keep-temp               # inspect the scratch dir
 *
 * After vendoring, align `dependencies["@fission-ai/openspec"]` in package.json
 * with the version printed by this script.
 */

import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = join(PACKAGE_ROOT, 'skills');
const SKILL_PREFIX = 'openspec-';

/** Parsed command-line options. */
interface Options {
  readonly version: string;
  readonly keepTemp: boolean;
}

/** Parse `--key value` / `--flag` arguments without pulling in a dependency. */
function parseArgs(argv: readonly string[]): Options {
  let version = 'latest';
  let keepTemp = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--version') {
      const value = argv[index + 1];
      if (value === undefined) throw new Error('--version requires a value');
      version = value;
      index += 1;
    } else if (argument === '--keep-temp') {
      keepTemp = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return { version, keepTemp };
}

/** Run a command, inheriting stdio, and fail loudly on a non-zero exit. */
function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, [...args], { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

/** The rendered result of one vendoring pass. */
interface RenderResult {
  readonly skills: readonly string[];
  readonly rendered: string;
}

const options = parseArgs(process.argv.slice(2));

/**
 * Render the skills by running upstream's installer in a throwaway git repo.
 *
 * The repo matters: upstream's own project-root probe also keys off `.git`, and
 * without it the installer may not treat the scratch directory as a project.
 * The `openspec/` tree it creates alongside is discarded — this bundle ships
 * skills only, never project data.
 */
async function renderSkills(version: string): Promise<RenderResult> {
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-openspec-vendor-'));
  try {
    run('git', ['init', '-q'], scratch);
    run('npx', ['-y', `@fission-ai/openspec@${version}`, 'init', '--tools', 'agents'], scratch);

    const generatedRoot = join(scratch, '.agents', 'skills');
    const entries = await readdir(generatedRoot, { withFileTypes: true });
    const skills = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(SKILL_PREFIX))
      .map((entry) => entry.name)
      .sort();

    if (skills.length === 0) {
      throw new Error(`no ${SKILL_PREFIX}* skill directories found under ${generatedRoot}`);
    }

    await rm(SKILLS_DIR, { recursive: true, force: true });
    for (const skill of skills) {
      await cp(join(generatedRoot, skill), join(SKILLS_DIR, skill), { recursive: true });
    }

    // Upstream stamps the rendering version into each skill's frontmatter, so
    // read it back rather than trusting the requested spec (e.g. `latest`).
    const first = skills[0];
    if (first === undefined) throw new Error('unreachable: non-empty skills');
    const sample = await readFile(join(SKILLS_DIR, first, 'SKILL.md'), 'utf8');
    const rendered = /generatedBy:\s*"([^"]+)"/.exec(sample)?.[1] ?? 'unknown';
    return { skills, rendered };
  } finally {
    if (options.keepTemp) process.stderr.write(`dsh-openspec: scratch dir kept at ${scratch}\n`);
    else await rm(scratch, { recursive: true, force: true });
  }
}

const { skills, rendered } = await renderSkills(options.version);

await writeFile(
  join(SKILLS_DIR, 'VENDORED.md'),
  `# Vendored OpenSpec skills\n\n` +
    `Generated by \`scripts/vendor-skills.ts\` — do not edit by hand.\n\n` +
    `- Upstream: \`@fission-ai/openspec@${rendered}\`\n` +
    `- Rendered with: \`openspec init --tools agents\` (skills-only, vendor-neutral target)\n` +
    `- Skills: ${skills.map((name) => `\`${name}\``).join(', ')}\n\n` +
    `Re-run \`npm run vendor-skills\` to refresh, then align the\n` +
    `\`@fission-ai/openspec\` dependency range in \`package.json\` with the version above.\n`,
  'utf8'
);

process.stdout.write(`dsh-openspec: vendored ${skills.length} skills from openspec@${rendered}\n`);
for (const name of skills) process.stdout.write(`  ${name}\n`);
