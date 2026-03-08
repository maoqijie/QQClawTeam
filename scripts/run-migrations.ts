#!/usr/bin/env tsx
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { compareSemver } from '../skills-engine/state.js';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

interface TsxCommand {
  command: string;
  prefixArgs: string[];
}

// Resolve tsx runner once to avoid npx race conditions across migrations
function resolveTsx(): TsxCommand {
  const localCli = path.resolve(scriptDir, '../node_modules/tsx/dist/cli.mjs');
  if (fs.existsSync(localCli)) {
    return {
      command: process.execPath,
      prefixArgs: [localCli],
    };
  }

  try {
    const lookupCommand =
      process.platform === 'win32' ? 'where tsx' : 'which tsx';
    const resolved = execSync(lookupCommand, { encoding: 'utf-8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (resolved) {
      return { command: resolved, prefixArgs: [] };
    }
  } catch {
    // ignore and fall back to npx
  }

  return {
    command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
    prefixArgs: ['tsx'],
  };
}

const tsxCommand = resolveTsx();

const fromVersion = process.argv[2];
const toVersion = process.argv[3];
const newCorePath = process.argv[4];

if (!fromVersion || !toVersion || !newCorePath) {
  console.error(
    'Usage: tsx scripts/run-migrations.ts <from-version> <to-version> <new-core-path>',
  );
  process.exit(1);
}

interface MigrationResult {
  version: string;
  success: boolean;
  error?: string;
}

const results: MigrationResult[] = [];

// Look for migrations in the new core
const migrationsDir = path.join(newCorePath, 'migrations');

if (!fs.existsSync(migrationsDir)) {
  console.log(JSON.stringify({ migrationsRun: 0, results: [] }, null, 2));
  process.exit(0);
}

// Discover migration directories (version-named)
const entries = fs.readdirSync(migrationsDir, { withFileTypes: true });
const migrationVersions = entries
  .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
  .map((e) => e.name)
  .filter(
    (v) =>
      compareSemver(v, fromVersion) > 0 && compareSemver(v, toVersion) <= 0,
  )
  .sort(compareSemver);

const projectRoot = process.cwd();

for (const version of migrationVersions) {
  const migrationIndex = path.join(migrationsDir, version, 'index.ts');
  if (!fs.existsSync(migrationIndex)) {
    results.push({
      version,
      success: false,
      error: `Migration ${version}/index.ts not found`,
    });
    continue;
  }

  try {
    execFileSync(
      tsxCommand.command,
      [...tsxCommand.prefixArgs, migrationIndex, projectRoot],
      {
        stdio: 'pipe',
        cwd: projectRoot,
        timeout: 120_000,
      },
    );
    results.push({ version, success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ version, success: false, error: message });
  }
}

console.log(
  JSON.stringify({ migrationsRun: results.length, results }, null, 2),
);

// Exit with error if any migration failed
if (results.some((r) => !r.success)) {
  process.exit(1);
}
