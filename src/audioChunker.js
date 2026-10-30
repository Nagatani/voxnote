import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { logInfo } from './notifier.js';

const execFileAsync = promisify(execFile);

/**
 * Get audio duration in seconds using ffprobe.
 */
export async function getAudioDurationSeconds(filePath) {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const seconds = parseFloat(stdout.trim());
  if (Number.isNaN(seconds)) {
    throw new Error(`Could not determine audio duration for: ${filePath}`);
  }
  return seconds;
}

/**
 * Format seconds as HH:MM:SS
 */
export function formatSeconds(totalSeconds) {
  const sec = Math.max(0, Math.floor(totalSeconds));
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/**
 * Split or normalize an audio file into manageable chunks for Gemini API transcription.
 * Includes chunk duration & overlap settings in the cache directory name so changing
 * `CHUNK_DURATION_SECONDS` never reuses mismatched audio chunks.
 */
export async function prepareAudioChunks(filePath, fileHash, config) {
  const {
    tmpChunksDir,
    chunkDurationSeconds = 600,
    chunkOverlapSeconds = 5,
    chunkAudioFormat = 'm4a',
  } = config;

  const duration = await getAudioDurationSeconds(filePath);
  const stat = await fs.stat(filePath);
  const cacheKey = `${fileHash.slice(0, 16)}_${chunkDurationSeconds}s_${chunkOverlapSeconds}s`;
  const fileWorkDir = path.join(tmpChunksDir, cacheKey);
  await fs.mkdir(fileWorkDir, { recursive: true });

  // Determine codec flags for compact speech representation (16kHz mono)
  const getCodecArgs = (format) => {
    if (format === 'mp3') {
      return ['-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k'];
    }
    if (format === 'wav') {
      return ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le'];
    }
    // Default m4a (AAC)
    return ['-ac', '1', '-ar', '16000', '-c:a', 'aac', '-b:a', '64k'];
  };

  // Case 1: Short audio that doesn't need multi-part chunking
  const MAX_INLINE_BYTES = 15 * 1024 * 1024;
  if (duration <= chunkDurationSeconds) {
    if (stat.size <= MAX_INLINE_BYTES) {
      return {
        duration,
        workDir: fileWorkDir,
        chunks: [
          {
            index: 0,
            startSeconds: 0,
            endSeconds: duration,
            audioPath: filePath,
            transcriptCachePath: path.join(fileWorkDir, 'chunk_000.txt'),
          },
        ],
      };
    }

    const compressedPath = path.join(
      fileWorkDir,
      `chunk_000.${chunkAudioFormat}`
    );
    if (!fsSync.existsSync(compressedPath)) {
      logInfo(
        `Compressing large audio file (${(stat.size / 1024 / 1024).toFixed(1)} MB) for optimal API transfer...`
      );
      await execFileAsync('ffmpeg', [
        '-y',
        '-i',
        filePath,
        ...getCodecArgs(chunkAudioFormat),
        compressedPath,
      ]);
    }

    return {
      duration,
      workDir: fileWorkDir,
      chunks: [
        {
          index: 0,
          startSeconds: 0,
          endSeconds: duration,
          audioPath: compressedPath,
          transcriptCachePath: path.join(fileWorkDir, 'chunk_000.txt'),
        },
      ],
    };
  }

  // Case 2: Long audio (> chunkDurationSeconds) -> split with overlap
  // Absorb tiny trailing remainder (<= minTrailingSeconds) into the final chunk
  const chunks = [];
  const step = Math.max(1, chunkDurationSeconds - chunkOverlapSeconds);
  const minTrailingSeconds = Math.min(
    60,
    Math.floor(chunkDurationSeconds * 0.15)
  );
  let index = 0;

  for (let start = 0; start < duration; start += step) {
    let end = Math.min(duration, start + chunkDurationSeconds);
    if (duration - end > 0 && duration - end <= minTrailingSeconds) {
      end = duration;
    }
    const chunkLen = end - start;
    const paddedIdx = String(index).padStart(3, '0');
    const chunkAudioPath = path.join(
      fileWorkDir,
      `chunk_${paddedIdx}.${chunkAudioFormat}`
    );
    const transcriptCachePath = path.join(
      fileWorkDir,
      `chunk_${paddedIdx}.txt`
    );

    if (!fsSync.existsSync(chunkAudioPath)) {
      logInfo(
        `Splitting chunk #${index + 1} [${formatSeconds(start)} - ${formatSeconds(end)}]...`
      );
      await execFileAsync('ffmpeg', [
        '-y',
        '-ss',
        String(start),
        '-t',
        String(chunkLen),
        '-i',
        filePath,
        ...getCodecArgs(chunkAudioFormat),
        chunkAudioPath,
      ]);
    }

    chunks.push({
      index,
      startSeconds: start,
      endSeconds: end,
      audioPath: chunkAudioPath,
      transcriptCachePath,
    });

    index += 1;
    if (end >= duration) break;
  }

  return {
    duration,
    workDir: fileWorkDir,
    chunks,
  };
}
