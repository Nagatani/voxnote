#!/usr/bin/env node
import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { logError, logInfo } from './notifier.js';
import { runPipelineBatch } from './pipeline.js';

function printHelp() {
  console.log(`
voxnote - ボイスレコーダー自動文字起こし＆要約パイプライン

使い方:
  node src/index.js [options]

オプション:
  -c, --config <path>   設定ファイル (.env または config.sh) のパスを指定
  -f, --file <path>     特定の音声ファイルを直接指定して処理 (複数指定可)
  -w, --watch           常駐監視モード (USBボイスレコーダーの接続や新規ファイル追加を検知)
      --force           処理済み履歴にあるファイルも再処理する
      --dry-run         Gemini APIを呼び出さずに音声分割・Markdown出力のテストを実行
  -h, --help            このヘルプを表示
`);
}

async function startWatchMode(config, options) {
  logInfo('Starting voxnote Watch Mode...');
  logInfo(`  Recorder Source Dir : ${config.recorderSourceDir}`);
  logInfo(`  Audio Archive Dir   : ${config.audioArchiveDir}`);
  logInfo(`  Markdown Output Dir : ${config.markdownOutputDir}`);

  let isRunning = false;
  const triggerRun = async (reason) => {
    if (isRunning) return;
    isRunning = true;
    try {
      logInfo(`Triggered pipeline scan (${reason})...`);
      await runPipelineBatch(config, options);
    } catch (err) {
      logError('Error during watch cycle:', err);
    } finally {
      isRunning = false;
    }
  };

  // Initial scan on startup
  await triggerRun('initial startup');

  // Poll every 10 seconds to detect newly mounted USB volumes (/Volumes/...) or new files
  let wasRecorderMounted = fs.existsSync(config.recorderSourceDir);
  setInterval(async () => {
    const isMountedNow = fs.existsSync(config.recorderSourceDir);
    if (isMountedNow && !wasRecorderMounted) {
      logInfo(`Detected USB recorder volume mounted: ${config.recorderSourceDir}`);
      wasRecorderMounted = true;
      await triggerRun('USB recorder mounted');
      return;
    }
    wasRecorderMounted = isMountedNow;
    await triggerRun('periodic check');
  }, 10000);
}

async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      file: { type: 'string', short: 'f', multiple: true },
      watch: { type: 'boolean', short: 'w', default: false },
      force: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  const config = loadConfig(values.config || null);
  const options = {
    files: values.file || [],
    force: Boolean(values.force),
    dryRun: Boolean(values['dry-run']),
  };

  if (values.watch) {
    await startWatchMode(config, options);
  } else {
    const results = await runPipelineBatch(config, options);
    const processedCount = results.filter((r) => !r.skipped).length;
    const skippedCount = results.filter((r) => r.skipped).length;
    logInfo(
      `Pipeline finished. Processed: ${processedCount}, Skipped: ${skippedCount}`
    );
  }
}

main().catch((err) => {
  logError('Fatal error:', err);
  process.exit(1);
});
