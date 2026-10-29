import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { logInfo, logWarn } from './notifier.js';

/**
 * Recursively find all supported audio files in a directory, ignoring macOS dot-underscore files.
 */
export async function findAudioFiles(dirPath, supportedExtensions) {
  if (!fsSync.existsSync(dirPath)) {
    return [];
  }

  const results = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // Ignore .DS_Store, ._*, etc.

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const nested = await findAudioFiles(fullPath, supportedExtensions);
      results.push(...nested);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (supportedExtensions.includes(ext)) {
        results.push(fullPath);
      }
    }
  }

  return results.sort();
}

/**
 * Ingest audio files from the USB voice recorder directory into the local archive directory.
 */
export async function ingestFromRecorder(config) {
  const {
    recorderSourceDir,
    audioArchiveDir,
    supportedExtensions,
    deleteSourceFiles,
  } = config;

  await fs.mkdir(audioArchiveDir, { recursive: true });

  if (!fsSync.existsSync(recorderSourceDir)) {
    logInfo(
      `Recorder source directory not mounted/found (${recorderSourceDir}). Checking local archive only.`
    );
    return [];
  }

  const recorderFiles = await findAudioFiles(
    recorderSourceDir,
    supportedExtensions
  );
  if (recorderFiles.length === 0) {
    logInfo(`No new audio files found in recorder source: ${recorderSourceDir}`);
    return [];
  }

  const movedFiles = [];

  for (const srcPath of recorderFiles) {
    const stat = await fs.stat(srcPath);
    const baseName = path.basename(srcPath);
    let destPath = path.join(audioArchiveDir, baseName);

    // If a file with the same name exists in archive but has different size, disambiguate
    if (fsSync.existsSync(destPath)) {
      const destStat = await fs.stat(destPath);
      if (destStat.size === stat.size) {
        // Already copied
        if (deleteSourceFiles) {
          await fs.unlink(srcPath);
          logInfo(`Removed already-archived source file: ${srcPath}`);
        }
        movedFiles.push(destPath);
        continue;
      } else {
        const parsed = path.parse(baseName);
        const dateTag = stat.mtime
          .toISOString()
          .replace(/[:.]/g, '-')
          .slice(0, 19);
        destPath = path.join(
          audioArchiveDir,
          `${parsed.name}_${dateTag}${parsed.ext}`
        );
      }
    }

    await fs.copyFile(srcPath, destPath);
    // Preserve original modification timestamp from voice recorder
    await fs.utimes(destPath, stat.atime, stat.mtime);

    const copiedStat = await fs.stat(destPath);
    if (copiedStat.size === stat.size) {
      logInfo(`Copied from recorder: ${srcPath} -> ${destPath}`);
      if (deleteSourceFiles) {
        await fs.unlink(srcPath);
        logInfo(`Deleted source file from recorder: ${srcPath}`);
      }
      movedFiles.push(destPath);
    } else {
      logWarn(`Size mismatch after copying ${srcPath}, keeping source file.`);
    }
  }

  return movedFiles;
}
