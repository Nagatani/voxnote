import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
  getAudioDurationSeconds,
  prepareAudioChunks,
} from '../src/audioChunker.js';
import { loadConfig } from '../src/config.js';
import { parseTitleAndSummary } from '../src/geminiService.js';
import {
  collapseConsecutivePlaceholders,
  extractRecordedDateFromFilename,
} from '../src/markdownWriter.js';
import { runPipelineBatch } from '../src/pipeline.js';

const execFileAsync = promisify(execFile);

test('voxnote Node.js Pipeline End-to-End Test (with ffmpeg audio chunking & Markdown output)', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'voxnote-test-'));
  const recorderDir = path.join(tmpDir, 'recorder');
  const archiveDir = path.join(tmpDir, 'archive');
  const outputDir = path.join(tmpDir, 'output');
  const chunksDir = path.join(tmpDir, '.tmp_chunks');
  const historyPath = path.join(tmpDir, 'processed_files.json');

  await fs.mkdir(recorderDir, { recursive: true });

  // Synthesize a 12-second sine wave WAV file with a timestamp filename
  const sampleWavPath = path.join(recorderDir, '2026-10-29-12-09-00.WAV');
  await execFileAsync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=12',
    '-ac',
    '1',
    '-ar',
    '16000',
    sampleWavPath,
  ]);

  const duration = await getAudioDurationSeconds(sampleWavPath);
  assert.ok(duration >= 11.5 && duration <= 12.5, `Expected ~12s duration, got ${duration}`);

  // Configure chunkDurationSeconds = 5s so a 12s file splits into 3 overlapping chunks
  const config = loadConfig(null, {
    RECORDER_SOURCE_DIR: recorderDir,
    AUDIO_ARCHIVE_DIR: archiveDir,
    MARKDOWN_OUTPUT_DIR: outputDir,
    TMP_CHUNKS_DIR: chunksDir,
    HISTORY_FILE_PATH: historyPath,
    DELETE_SOURCE_FILES: 'true',
    CHUNK_DURATION_SECONDS: '5',
    CHUNK_OVERLAP_SECONDS: '1',
    ENABLE_MACOS_NOTIFICATION: 'false',
  });

  // Test chunk splitting directly
  const prepared = await prepareAudioChunks(
    sampleWavPath,
    'test_hash_1234567890',
    config
  );
  assert.equal(prepared.chunks.length, 3);
  for (const chunk of prepared.chunks) {
    assert.ok(fsSync.existsSync(chunk.audioPath), `Chunk file should exist: ${chunk.audioPath}`);
  }

  // Run full batch pipeline in dryRun mode
  const results = await runPipelineBatch(config, { dryRun: true });
  assert.equal(results.length, 1);
  assert.equal(results[0].skipped, false);
  assert.ok(fsSync.existsSync(results[0].markdownPath));

  // Verify filename uses the timestamp from 2026-10-29-12-09-00.WAV
  assert.match(path.basename(results[0].markdownPath), /^2026-10-29_120900_/);

  // Verify source file on recorder was deleted after safe copy to archive
  assert.equal(fsSync.existsSync(sampleWavPath), false);
  assert.equal(
    fsSync.existsSync(path.join(archiveDir, '2026-10-29-12-09-00.WAV')),
    true
  );

  // Verify Markdown output content
  const mdContent = await fs.readFile(results[0].markdownPath, 'utf8');
  assert.match(mdContent, /# ドライラン音声テストメモ/);
  assert.match(mdContent, /- \*\*録音日時\*\*: 2026-10-29 12:09:00/);
  assert.match(mdContent, /## 要約/);
  assert.match(mdContent, /## 全文文字起こし/);
  assert.match(mdContent, /### Part 1/);
  assert.match(mdContent, /### Part 2/);
  assert.match(mdContent, /### Part 3/);

  // Clean up test directory
  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('parseTitleAndSummary extracts TITLE line and Markdown body cleanly', () => {
  const sample = `TITLE: プロジェクト定例会議メモ\n\n## 概要\n- テスト内容`;
  const parsed = parseTitleAndSummary(sample);
  assert.equal(parsed.title, 'プロジェクト定例会議メモ');
  assert.equal(parsed.summaryMarkdown, '## 概要\n- テスト内容');
});

test('loadConfig unescapes shell-escaped spaces in directory paths', () => {
  const config = loadConfig(null, {
    RECORDER_SOURCE_DIR: '/Volumes/NO\\ NAME/RECORD',
  });
  assert.equal(config.recorderSourceDir, '/Volumes/NO NAME/RECORD');
});

test('extractRecordedDateFromFilename parses YYYY-MM-DD-HH-mm-ss filenames accurately', () => {
  const fallback = new Date(2020, 0, 1);
  const parsed = extractRecordedDateFromFilename(
    '/path/to/2026-10-29-12-09-00.WAV',
    fallback
  );
  assert.equal(parsed.getFullYear(), 2026);
  assert.equal(parsed.getMonth(), 9); // October (0-indexed)
  assert.equal(parsed.getDate(), 29);
  assert.equal(parsed.getHours(), 12);
  assert.equal(parsed.getMinutes(), 9);
  assert.equal(parsed.getSeconds(), 0);
});

test('collapseConsecutivePlaceholders merges contiguous skip ranges and duplicate [発話なし]', () => {
  const raw = [
    '[※ 00:00:00 〜 00:01:30 の区間は背景音またはAPI制限によりスキップされました]',
    '[※ 00:01:30 〜 00:03:00 の区間は背景音またはAPI制限によりスキップされました]',
    '[※ 00:03:00 〜 00:04:30 の区間は背景音またはAPI制限によりスキップされました]',
    'こんにちは。テスト発話です。',
    '[発話なし]',
    '[発話なし]',
  ].join('\n\n');

  const cleaned = collapseConsecutivePlaceholders(raw);
  assert.equal(
    cleaned,
    [
      '[※ 00:00:00 〜 00:04:30 の区間は背景音またはAPI制限によりスキップされました]',
      'こんにちは。テスト発話です。',
      '[発話なし]',
    ].join('\n\n')
  );
});
