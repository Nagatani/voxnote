import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { prepareAudioChunks, formatSeconds } from './audioChunker.js';
import { findAudioFiles, ingestFromRecorder } from './fileMover.js';
import { summarizeTranscript, transcribeAudioChunk } from './geminiService.js';
import { computeFileHash, HistoryStore } from './historyStore.js';
import {
  collapseConsecutivePlaceholders,
  writeMarkdownNote,
} from './markdownWriter.js';
import {
  logError,
  logInfo,
  sendMacNotification,
} from './notifier.js';

/**
 * Process a single audio file through the voxnote pipeline:
 * Hash check -> Chunking -> Transcription (with per-chunk caching) -> Summarization -> Markdown generation
 */
export async function processAudioFile(
  audioPath,
  config,
  historyStore,
  options = {}
) {
  const { force = false, dryRun = false } = options;
  const fileName = path.basename(audioPath);

  const fileHash = await computeFileHash(audioPath);
  if (!force && historyStore.isProcessed(fileHash)) {
    const existing = historyStore.getRecord(fileHash);
    logInfo(
      `Skipping already processed file: ${fileName} (Output: ${existing?.markdownPath || 'done'})`
    );
    return { skipped: true, audioPath, fileHash };
  }

  logInfo(`Starting processing for: ${fileName} (SHA-256: ${fileHash.slice(0, 12)}...)`);
  await sendMacNotification(
    'voxnote 文字起こし開始',
    `${fileName} の処理を開始しました`,
    config.enableMacosNotification
  );

  const transcribePrompt = fsSync.existsSync(config.transcribePromptPath)
    ? await fs.readFile(config.transcribePromptPath, 'utf8')
    : '以下の音声を日本語で正確に文字起こししてください。';

  const summaryPrompt = fsSync.existsSync(config.summaryPromptPath)
    ? await fs.readFile(config.summaryPromptPath, 'utf8')
    : '以下の文字起こしテキストを要約してください。先頭行に TITLE: タイトル を出力してください。';

  // 1. Inspect duration & split into chunks if needed
  const { duration, workDir, chunks } = await prepareAudioChunks(
    audioPath,
    fileHash,
    config
  );
  logInfo(
    `Audio duration: ${formatSeconds(duration)} (${chunks.length} chunk(s))`
  );

  // 2. Transcribe each chunk (with disk cache for crash resilience)
  const chunkTranscripts = [];
  for (const chunk of chunks) {
    if (!force && fsSync.existsSync(chunk.transcriptCachePath)) {
      logInfo(
        `Using cached transcript for chunk #${chunk.index + 1}/${chunks.length}`
      );
      const cachedText = await fs.readFile(chunk.transcriptCachePath, 'utf8');
      chunkTranscripts.push(cachedText);
      continue;
    }

    logInfo(
      `Transcribing chunk #${chunk.index + 1}/${chunks.length} [${formatSeconds(
        chunk.startSeconds
      )} - ${formatSeconds(chunk.endSeconds)}]...`
    );
    const chunkText = await transcribeAudioChunk(
      chunk,
      chunks.length,
      transcribePrompt,
      config,
      { dryRun }
    );

    await fs.writeFile(chunk.transcriptCachePath, chunkText, 'utf8');
    chunkTranscripts.push(chunkText);
  }

  const fullTranscript = chunkTranscripts
    .map((text, idx) => {
      const cleaned = collapseConsecutivePlaceholders(text);
      return chunks.length > 1
        ? `### Part ${idx + 1} (${formatSeconds(chunks[idx].startSeconds)} - ${formatSeconds(chunks[idx].endSeconds)})\n\n${cleaned}`
        : cleaned;
    })
    .join('\n\n');

  // 3. Summarize full transcript
  logInfo(`Generating summary for: ${fileName}...`);
  const { title, summaryMarkdown } = await summarizeTranscript(
    fullTranscript,
    summaryPrompt,
    config,
    { dryRun }
  );

  // 4. Write Markdown output
  const stat = await fs.stat(audioPath);
  const recordedAt = stat.birthtimeMs && stat.birthtimeMs < stat.mtimeMs
    ? stat.birthtime
    : stat.mtime;

  const markdownPath = await writeMarkdownNote({
    outputDir: config.markdownOutputDir,
    audioPath,
    recordedAt,
    durationSeconds: duration,
    title,
    summaryMarkdown,
    fullTranscript,
    modelName: config.geminiModel,
    transcribeModelName: config.geminiTranscribeModel,
  });

  logInfo(`Saved Markdown note: ${markdownPath}`);

  // 5. Record in history & clean up temporary chunk directory
  if (!dryRun) {
    historyStore.markProcessed(fileHash, {
      fileName,
      audioPath,
      markdownPath,
      title,
      durationSeconds: duration,
    });
  }

  try {
    await fs.rm(workDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }

  await sendMacNotification(
    'voxnote 文字起こし完了',
    `「${title}」のノートを作成しました`,
    config.enableMacosNotification
  );

  return {
    skipped: false,
    audioPath,
    markdownPath,
    title,
    duration,
    fileHash,
  };
}

/**
 * Run a full batch pass:
 * 1. Ingest from USB recorder (`RECORDER_SOURCE_DIR`) into `AUDIO_ARCHIVE_DIR`
 * 2. Process all unprocessed audio files in `AUDIO_ARCHIVE_DIR`
 */
export async function runPipelineBatch(config, options = {}) {
  const historyStore = new HistoryStore(config.historyFilePath);

  // If explicit single file(s) provided via CLI `--file`
  if (options.files && options.files.length > 0) {
    const results = [];
    for (const file of options.files) {
      const resolvedPath = path.resolve(file);
      const res = await processAudioFile(
        resolvedPath,
        config,
        historyStore,
        options
      );
      results.push(res);
    }
    return results;
  }

  // Step 1: Move/copy files from USB recorder mount if present
  await ingestFromRecorder(config);

  // Step 2: Find all audio files in local archive directory
  const archiveFiles = await findAudioFiles(
    config.audioArchiveDir,
    config.supportedExtensions
  );

  if (archiveFiles.length === 0) {
    logInfo(`No audio files found in archive directory: ${config.audioArchiveDir}`);
    return [];
  }

  const results = [];
  for (const audioPath of archiveFiles) {
    try {
      const res = await processAudioFile(
        audioPath,
        config,
        historyStore,
        options
      );
      results.push(res);
    } catch (err) {
      logError(`Failed to process ${audioPath}:`, err);
      await sendMacNotification(
        'voxnote エラー',
        `${path.basename(audioPath)} の処理中にエラーが発生しました`,
        config.enableMacosNotification
      );
    }
  }

  return results;
}
