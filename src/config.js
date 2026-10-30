import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Simple .env / config.sh parser that supports `KEY=VALUE` and `export KEY="VALUE"`
 */
export function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const result = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;

    const eqIndex = normalized.indexOf('=');
    if (eqIndex === -1) continue;

    const key = normalized.slice(0, eqIndex).trim();
    let val = normalized.slice(eqIndex + 1).trim();

    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }

  return result;
}

/**
 * Load configuration from optional custom config file, default .env, and process.env
 */
export function loadConfig(customConfigPath = null, overrides = {}) {
  const defaultEnvPath = path.join(PROJECT_ROOT, '.env');
  const fileEnv = {
    ...parseEnvFile(defaultEnvPath),
    ...(customConfigPath ? parseEnvFile(path.resolve(customConfigPath)) : {}),
  };

  const get = (key, fallback) => {
    if (overrides[key] !== undefined) return overrides[key];
    if (process.env[key] !== undefined && process.env[key] !== '') return process.env[key];
    if (fileEnv[key] !== undefined && fileEnv[key] !== '') return fileEnv[key];
    return fallback;
  };

  const resolveDir = (dirPath) => {
    let normalized = String(dirPath).trim().replace(/\\ /g, ' ');
    if (normalized.startsWith('~/')) {
      normalized = path.join(os.homedir(), normalized.slice(2));
    }
    return path.isAbsolute(normalized)
      ? normalized
      : path.resolve(PROJECT_ROOT, normalized);
  };

  const apiKey = get('GEMINI_API_KEY', get('GOOGLE_API_KEY', ''));

  return {
    geminiApiKey: apiKey,
    geminiModel: get('GEMINI_MODEL', 'gemini-3.8-flash'),
    recorderSourceDir: resolveDir(get('RECORDER_SOURCE_DIR', './input_recorder')),
    audioArchiveDir: resolveDir(get('AUDIO_ARCHIVE_DIR', './audio_archive')),
    markdownOutputDir: resolveDir(get('MARKDOWN_OUTPUT_DIR', './output_notes')),
    tmpChunksDir: resolveDir(get('TMP_CHUNKS_DIR', './.tmp_chunks')),
    historyFilePath: resolveDir(get('HISTORY_FILE_PATH', './processed_files.json')),
    transcribePromptPath: resolveDir(
      get('TRANSCRIBE_PROMPT_PATH', './prompts/transcribe_prompt.txt')
    ),
    summaryPromptPath: resolveDir(
      get('SUMMARY_PROMPT_PATH', './prompts/summary_prompt.txt')
    ),
    deleteSourceFiles:
      String(get('DELETE_SOURCE_FILES', 'false')).toLowerCase() === 'true',
    chunkDurationSeconds: Number(get('CHUNK_DURATION_SECONDS', 1200)),
    chunkOverlapSeconds: Number(get('CHUNK_OVERLAP_SECONDS', 5)),
    chunkAudioFormat: get('CHUNK_AUDIO_FORMAT', 'm4a'),
    enableMacosNotification:
      String(get('ENABLE_MACOS_NOTIFICATION', 'true')).toLowerCase() === 'true',
    supportedExtensions: [
      '.wav',
      '.mp3',
      '.m4a',
      '.aac',
      '.flac',
      '.ogg',
      '.mp4',
      '.wma',
      '.webm',
    ],
  };
}
