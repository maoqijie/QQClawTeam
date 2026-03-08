import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { parse, stringify } from 'yaml';

import { BASE_DIR, CUSTOM_DIR } from './constants.js';
import {
  computeFileHash,
  readState,
  recordCustomModification,
} from './state.js';

interface PendingCustomize {
  description: string;
  started_at: string;
  file_hashes: Record<string, string>;
}

function diffCommandExists(): boolean {
  try {
    execSync(process.platform === 'win32' ? 'where diff' : 'command -v diff', {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function runUnifiedDiff(
  oldPath: string,
  newPath: string,
  relativePath: string,
): string {
  const oldExists = oldPath !== '/dev/null' && fs.existsSync(oldPath);
  const newExists = newPath !== '/dev/null' && fs.existsSync(newPath);

  if (
    (oldExists && fs.statSync(oldPath).isDirectory()) ||
    (newExists && fs.statSync(newPath).isDirectory())
  ) {
    throw new Error(
      `diff error for ${relativePath}: cannot diff a directory path`,
    );
  }

  const emptyFilePath = path.join(
    process.cwd(),
    CUSTOM_DIR,
    '.empty-diff-placeholder',
  );
  if (!fs.existsSync(emptyFilePath)) {
    fs.writeFileSync(emptyFilePath, '', 'utf-8');
  }

  const safeOldPath = oldExists ? oldPath : emptyFilePath;
  const safeNewPath = newExists ? newPath : emptyFilePath;

  if (diffCommandExists()) {
    try {
      return execFileSync('diff', ['-ruN', safeOldPath, safeNewPath], {
        encoding: 'utf-8',
      });
    } catch (err: unknown) {
      const execErr = err as { status?: number; stdout?: string };
      if (execErr.status === 1 && execErr.stdout) {
        return execErr.stdout;
      }
      if (execErr.status === 2) {
        throw new Error(
          `diff error for ${relativePath}: diff exited with status 2 (check file permissions or encoding)`,
        );
      }
      throw err;
    }
  }

  try {
    return execFileSync(
      'git',
      ['diff', '--no-index', '--binary', safeOldPath, safeNewPath],
      {
        encoding: 'utf-8',
      },
    );
  } catch (err: unknown) {
    const execErr = err as { status?: number; stdout?: string };
    if (execErr.status === 1 && execErr.stdout) {
      return execErr.stdout;
    }
    throw new Error(
      `diff error for ${relativePath}: git diff failed${execErr.status ? ` with status ${execErr.status}` : ''}`,
    );
  }
}

function getPendingPath(): string {
  return path.join(process.cwd(), CUSTOM_DIR, 'pending.yaml');
}

export function isCustomizeActive(): boolean {
  return fs.existsSync(getPendingPath());
}

export function startCustomize(description: string): void {
  if (isCustomizeActive()) {
    throw new Error(
      'A customize session is already active. Commit or abort it first.',
    );
  }

  const state = readState();

  // Collect all file hashes from applied skills
  const fileHashes: Record<string, string> = {};
  for (const skill of state.applied_skills) {
    for (const [relativePath, hash] of Object.entries(skill.file_hashes)) {
      fileHashes[relativePath] = hash;
    }
  }

  const pending: PendingCustomize = {
    description,
    started_at: new Date().toISOString(),
    file_hashes: fileHashes,
  };

  const customDir = path.join(process.cwd(), CUSTOM_DIR);
  fs.mkdirSync(customDir, { recursive: true });
  fs.writeFileSync(getPendingPath(), stringify(pending), 'utf-8');
}

export function commitCustomize(): void {
  const pendingPath = getPendingPath();
  if (!fs.existsSync(pendingPath)) {
    throw new Error('No active customize session. Run startCustomize() first.');
  }

  const pending = parse(
    fs.readFileSync(pendingPath, 'utf-8'),
  ) as PendingCustomize;
  const cwd = process.cwd();

  // Find files that changed
  const changedFiles: string[] = [];
  for (const relativePath of Object.keys(pending.file_hashes)) {
    const fullPath = path.join(cwd, relativePath);
    if (!fs.existsSync(fullPath)) {
      // File was deleted — counts as changed
      changedFiles.push(relativePath);
      continue;
    }
    const currentHash = computeFileHash(fullPath);
    if (currentHash !== pending.file_hashes[relativePath]) {
      changedFiles.push(relativePath);
    }
  }

  if (changedFiles.length === 0) {
    console.log(
      'No files changed during customize session. Nothing to commit.',
    );
    fs.unlinkSync(pendingPath);
    return;
  }

  // Generate unified diff for each changed file
  const baseDir = path.join(cwd, BASE_DIR);
  let combinedPatch = '';

  for (const relativePath of changedFiles) {
    const basePath = path.join(baseDir, relativePath);
    const currentPath = path.join(cwd, relativePath);

    // Use /dev/null if either side doesn't exist
    const oldPath = fs.existsSync(basePath) ? basePath : '/dev/null';
    const newPath = fs.existsSync(currentPath) ? currentPath : '/dev/null';

    combinedPatch += runUnifiedDiff(oldPath, newPath, relativePath);
  }

  if (!combinedPatch.trim()) {
    console.log('Diff was empty despite hash changes. Nothing to commit.');
    fs.unlinkSync(pendingPath);
    return;
  }

  // Determine sequence number
  const state = readState();
  const existingCount = state.custom_modifications?.length ?? 0;
  const seqNum = String(existingCount + 1).padStart(3, '0');

  // Sanitize description for filename
  const sanitized = pending.description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const patchFilename = `${seqNum}-${sanitized}.patch`;
  const patchRelPath = path.join(CUSTOM_DIR, patchFilename);
  const patchFullPath = path.join(cwd, patchRelPath);

  fs.writeFileSync(patchFullPath, combinedPatch, 'utf-8');
  recordCustomModification(pending.description, changedFiles, patchRelPath);
  fs.unlinkSync(pendingPath);
}

export function abortCustomize(): void {
  const pendingPath = getPendingPath();
  if (fs.existsSync(pendingPath)) {
    fs.unlinkSync(pendingPath);
  }
}
