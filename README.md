# voxnote

**Node.js (ES Modules / 標準ライブラリ)** と **Google Gemini API**・**ffmpeg** を用いて実装した、ボイスレコーダー自動文字起こし＆構造化要約システムです。

ボイスレコーダーや指定フォルダ内の音声データを取り込み、長時間音声の自動分割（チャンク化）・Gemini APIによる文字起こし＆要約・Markdownファイルの生成までを自動で行います。

---

## 主な特徴

| 機能 | 実装ファイル・仕様 |
| :--- | :--- |
| **ファイル取り込み** | [`src/fileMover.js`](./src/fileMover.js)（サイズ検証・タイムスタンプ保持・元ファイル削除設定対応） |
| **長時間音声の分割** | [`src/audioChunker.js`](./src/audioChunker.js)（`ffprobe` / `ffmpeg` によるオーバーラップ付きチャンク分割・AAC圧縮） |
| **文字起こし＆要約** | [`src/geminiService.js`](./src/geminiService.js)（Inline Data & Gemini File API 自動切替・429指数バックオフ再試行） |
| **中断キャッシュ＆履歴** | [`src/historyStore.js`](./src/historyStore.js)（SHA-256ハッシュによる二重処理防止 & チャンク単位の文字起こしキャッシュ） |
| **プロンプト管理** | [`prompts/transcribe_prompt.txt`](./prompts/transcribe_prompt.txt) / [`prompts/summary_prompt.txt`](./prompts/summary_prompt.txt) |
| **ディレクトリ監視** | [`src/index.js`](./src/index.js)（`--watch` による指定ディレクトリの監視モード） |

---

## 必要環境

- **Node.js**: v20 以上（`fetch` や `node:util` 標準搭載のため外部 npm パッケージのインストール不要でそのまま動作します）
- **ffmpeg / ffprobe**: 音声の長さ取得およびチャンク分割に使用します
  ```bash
  brew install ffmpeg
  ```
- **Google Gemini API Key**: Google AI Studio 等で取得した API キー

---

## セットアップ手順

1. **設定ファイル `.env` の作成**
   ```bash
   cp .env.example .env
   ```
   `.env` を開き、`GEMINI_API_KEY` やボイスレコーダーのマウントパス（`RECORDER_SOURCE_DIR`）、Markdownの出力先（`MARKDOWN_OUTPUT_DIR`）を設定します。

2. **ドライラン（APIを消費しない動作確認テスト）**
   ```bash
   npm test
   ```

---

## 使い方

### 1. バッチ実行（ボイスレコーダー取り込み → 未処理ファイルの文字起こし・要約）
```bash
npm start
# または
node src/index.js
```

### 2. 特定の音声ファイルを直接指定して文字起こし
```bash
node src/index.js --file /path/to/recording.wav
```

### 3. ディレクトリ監視モード (`--watch`)
プログラム起動中、指定したディレクトリ（`RECORDER_SOURCE_DIR` や `AUDIO_ARCHIVE_DIR`）への新規ファイル追加を検知して自動処理します。
```bash
npm run watch
```
