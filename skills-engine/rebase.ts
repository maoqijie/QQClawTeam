import { execFileSync, execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { clearBackup, createBackup, restoreBackup } from './backup.js';
import { BASE_DIR, NANOCLAW_DIR } from './constants.js';
import { copyDir } from './fs-utils.js';
import { acquireLock } from './lock.js';
import { mergeFile } from './merge.js';
import { computeFileHash, readState, writeState } from './state.js';
import type { RebaseResult } from './types.js';

function toPortableRelativePath(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
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

function getEmptyDiffPlaceholder(projectRoot: string): string {
  const placeholderPath = path.join(
    projectRoot,
    NANOCLAW_DIR,
    '.empty-diff-placeholder',
  );

  if (!fs.existsSync(placeholderPath)) {
    fs.mkdirSync(path.dirname(placeholderPath), { recursive: true });
    fs.writeFileSync(placeholderPath, '', 'utf-8');
  }

  return placeholderPath;
}

function runUnifiedDiff(
  oldPath: string | null,
  newPath: string | null,
  relativePath: string,
  projectRoot: string,
): string {
  const oldExists = oldPath !== null && fs.existsSync(oldPath);
  const newExists = newPath !== null && fs.existsSync(newPath);

  const emptyFilePath = getEmptyDiffPlaceholder(projectRoot);
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
          `diff error for ${relativePath}: diff exited with status 2`,
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

function walkDir(dir: string, root: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, root));
    } else {
      results.push(toPortableRelativePath(path.relative(root, fullPath)));
    }
  }
  return results;
}

function collectTrackedFiles(state: ReturnType<typeof readState>): Set<string> {
  const tracked = new Set<string>();

  for (const skill of state.applied_skills) {
    for (const relPath of Object.keys(skill.file_hashes)) {
      tracked.add(toPortableRelativePath(relPath));
    }
  }

  if (state.custom_modifications) {
    for (const mod of state.custom_modifications) {
      for (const relPath of mod.files_modified) {
        tracked.add(toPortableRelativePath(relPath));
      }
    }
  }

  return tracked;
}

export async function rebase(newBasePath?: string): Promise<RebaseResult> {
  const projectRoot = process.cwd();
  const state = readState();

  if (state.applied_skills.length === 0) {
    return {
      success: false,
      filesInPatch: 0,
      error: 'No skills applied. Nothing to rebase.',
    };
  }

  const releaseLock = acquireLock();

  try {
    const trackedFiles = collectTrackedFiles(state);
    const baseAbsDir = path.join(projectRoot, BASE_DIR);

    // Include base dir files
    const baseFiles = walkDir(baseAbsDir, baseAbsDir);
    for (const f of baseFiles) {
      trackedFiles.add(f);
    }

    // Backup
    const filesToBackup: string[] = [];
    for (const relPath of trackedFiles) {
      const absPath = path.join(projectRoot, relPath);
      if (fs.existsSync(absPath)) filesToBackup.push(absPath);
      const baseFilePath = path.join(baseAbsDir, relPath);
      if (fs.existsSync(baseFilePath)) filesToBackup.push(baseFilePath);
    }
    const stateFilePath = path.join(projectRoot, NANOCLAW_DIR, 'state.yaml');
    filesToBackup.push(stateFilePath);
    createBackup(filesToBackup);

    try {
      // Generate unified diff: base vs working tree (archival record)
      let combinedPatch = '';
      let filesInPatch = 0;

      for (const relPath of trackedFiles) {
        const basePath = path.join(baseAbsDir, relPath);
        const workingPath = path.join(projectRoot, relPath);

        const oldPath = fs.existsSync(basePath) ? basePath : null;
        const newPath = fs.existsSync(workingPath) ? workingPath : null;

        if (oldPath === null && newPath === null) continue;

        const diff = runUnifiedDiff(oldPath, newPath, relPath, projectRoot);
        if (diff.trim()) {
          combinedPatch += diff;
          filesInPatch++;
        }
      }

      // Save combined patch
      const patchPath = path.join(projectRoot, NANOCLAW_DIR, 'combined.patch');
      fs.writeFileSync(patchPath, combinedPatch, 'utf-8');

      if (newBasePath) {
        // --- Rebase with new base: three-way merge with resolution model ---

        // Save current working tree content before overwriting
        const savedContent: Record<string, string> = {};
        for (const relPath of trackedFiles) {
          const workingPath = path.join(projectRoot, relPath);
          if (fs.existsSync(workingPath)) {
            savedContent[relPath] = fs.readFileSync(workingPath, 'utf-8');
          }
        }

        const absNewBase = path.resolve(newBasePath);

        // Replace base
        if (fs.existsSync(baseAbsDir)) {
          fs.rmSync(baseAbsDir, { recursive: true, force: true });
        }
        fs.mkdirSync(baseAbsDir, { recursive: true });
        copyDir(absNewBase, baseAbsDir);

        // Copy new base to working tree
        copyDir(absNewBase, projectRoot);

        // Three-way merge per file: new-base ← old-base → saved-working-tree
        const mergeConflicts: string[] = [];

        for (const relPath of trackedFiles) {
          const newBaseSrc = path.join(absNewBase, relPath);
          const currentPath = path.join(projectRoot, relPath);
          const saved = savedContent[relPath];

          if (!saved) continue; // No working tree content to merge
          if (!fs.existsSync(newBaseSrc)) {
            // File only existed in working tree, not in new base — restore it
            fs.mkdirSync(path.dirname(currentPath), { recursive: true });
            fs.writeFileSync(currentPath, saved);
            continue;
          }

          const newBaseContent = fs.readFileSync(newBaseSrc, 'utf-8');
          if (newBaseContent === saved) continue; // No diff

          // Find old base content from backup
          const oldBasePath = path.join(
            projectRoot,
            '.nanoclaw',
            'backup',
            BASE_DIR,
            relPath,
          );
          if (!fs.existsSync(oldBasePath)) {
            // No old base — keep saved content
            fs.writeFileSync(currentPath, saved);
            continue;
          }

          // Three-way merge: current(new base) ← old-base → saved(modifications)
          const tmpSaved = path.join(
            os.tmpdir(),
            `nanoclaw-rebase-${crypto.randomUUID()}-${path.basename(relPath)}`,
          );
          fs.writeFileSync(tmpSaved, saved);

          const result = mergeFile(currentPath, oldBasePath, tmpSaved);
          fs.unlinkSync(tmpSaved);

          if (!result.clean) {
            mergeConflicts.push(relPath);
          }
        }

        if (mergeConflicts.length > 0) {
          // Return with backup pending for Claude Code / user resolution
          return {
            success: false,
            patchFile: patchPath,
            filesInPatch,
            mergeConflicts,
            backupPending: true,
            error: `Merge conflicts in: ${mergeConflicts.join(', ')}. Resolve manually then call clearBackup(), or restoreBackup() + clearBackup() to abort.`,
          };
        }
      } else {
        // --- Rebase without new base: flatten into base ---
        // Update base to current working tree state (all skills baked in)
        for (const relPath of trackedFiles) {
          const workingPath = path.join(projectRoot, relPath);
          const basePath = path.join(baseAbsDir, relPath);

          if (fs.existsSync(workingPath)) {
            fs.mkdirSync(path.dirname(basePath), { recursive: true });
            fs.copyFileSync(workingPath, basePath);
          } else if (fs.existsSync(basePath)) {
            // File was removed by skills — remove from base too
            fs.unlinkSync(basePath);
          }
        }
      }

      // Update state
      const now = new Date().toISOString();

      for (const skill of state.applied_skills) {
        const updatedHashes: Record<string, string> = {};
        for (const relPath of Object.keys(skill.file_hashes)) {
          const absPath = path.join(projectRoot, relPath);
          if (fs.existsSync(absPath)) {
            updatedHashes[relPath] = computeFileHash(absPath);
          }
        }
        skill.file_hashes = updatedHashes;
      }

      delete state.custom_modifications;
      state.rebased_at = now;
      writeState(state);

      clearBackup();

      return {
        success: true,
        patchFile: patchPath,
        filesInPatch,
        rebased_at: now,
      };
    } catch (err) {
      restoreBackup();
      clearBackup();
      throw err;
    }
  } finally {
    releaseLock();
  }
}
