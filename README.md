# voxnote

**Node.js (ES Modules / 標準ライブラリ)** と **Google Gemini API**・**ffmpeg** を用いて実装した、ボイスレコーダー自動文字起こし＆構造化要約システムです。

ボイスレコーダーや指定フォルダ内の音声データを取り込み、長時間音声の自動分割（チャンク化）・音声認識専用モデル（`gemini-3.5-transcribe`）による文字起こし・`gemini-3.8-flash` による構造化要約・Markdownファイルの生成までを自動で行います。

---

## 主な特徴

| 機能 | 実装ファイル・仕様 |
| :--- | :--- |
| **ファイル取り込み** | [`src/fileMover.js`](./src/fileMover.js)（サイズ検証・タイムスタンプ保持・元ファイル削除設定・空白エスケープパスの自動補正対応） |
| **長時間音声の分割** | [`src/audioChunker.js`](./src/audioChunker.js)（`ffprobe` / `ffmpeg` によるオーバーラップ付きチャンク分割・端数秒の自動吸収・AAC圧縮） |
| **文字起こし＆要約** | [`src/geminiService.js`](./src/geminiService.js)（`gemini-3.5-transcribe` 専用モデル優先＋`gemini-3.8-flash` 自動フォールバック・ブロック時の90秒細分化リカバリ） |
| **中断キャッシュ＆履歴** | [`src/historyStore.js`](./src/historyStore.js)（SHA-256ハッシュによる二重処理防止 & 分割設定別のチャンク単位キャッシュ） |
| **Markdown生成** | [`src/markdownWriter.js`](./src/markdownWriter.js)（ファイル名からの録音開始日時自動抽出・連続スキップ/無音区間の自動集約） |
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
   `.env` を開き、`GEMINI_API_KEY` やボイスレコーダーのマウントパス（`RECORDER_SOURCE_DIR`）、Markdownの出力先（`MARKDOWN_OUTPUT_DIR`）などを設定します。

2. **設定項目一覧（`.env`）**

   | 変数名 | デフォルト値 | 説明 |
   | :--- | :--- | :--- |
   | `GEMINI_API_KEY` | （必須） | Google Gemini API キー |
   | `GEMINI_TRANSCRIBE_MODEL` | `gemini-3.5-transcribe` | 文字起こしに使用するモデル（専用モデル `gemini-3.5-transcribe` または汎用 `gemini-3.8-flash`） |
   | `GEMINI_MODEL` | `gemini-3.8-flash` | 要約・タイトル生成（および文字起こしフォールバック）に使用するモデル |
   | `CUSTOM_VOCABULARY` | （空） | 認識精度を高めたい専門用語・固有名詞のカンマ区切りリスト（例: `PySide6,pyenv,QApplication,LMS`） |
   | `RECORDER_SOURCE_DIR` | `/Volumes/NO NAME/RECORD` | ボイスレコーダーの録音データフォルダパス（空白を含むパスもそのまま指定可） |
   | `AUDIO_ARCHIVE_DIR` | `./audio_archive` | ローカルへの音声ファイル取り込み・保存先ディレクトリ |
   | `MARKDOWN_OUTPUT_DIR` | `./output_notes` | 生成された Markdown ファイルの出力先ディレクトリ |
   | `DELETE_SOURCE_FILES` | `false` | ローカルへ安全にコピーした後にボイスレコーダー側の元ファイルを削除するか（`true` / `false`） |
   | `CHUNK_DURATION_SECONDS` | `600` | 長時間音声を分割するチャンク秒数（デフォルト: `600`秒＝10分） |
   | `CHUNK_OVERLAP_SECONDS` | `5` | チャンク分割時に前後の文脈が途切れないように重複させる秒数 |
   | `ENABLE_MACOS_NOTIFICATION` | `true` | 処理開始・完了・エラー時の macOS デスクトップ通知（`true` / `false`） |

3. **テストの実行（APIを消費しない動作確認）**
   ```bash
   npm test
   ```

---

## 使い方

### 1. 通常バッチ実行（ボイスレコーダー取り込み → 未処理ファイルの文字起こし・要約）
まだ処理されていない音声ファイルのみを自動で検出し、文字起こしと要約を行います。
```bash
npm start
# または
node src/index.js
```

### 2. 特定の音声ファイルを直接指定して処理 (`--file`)
特定のファイルだけを指定して処理したい場合に使用します（複数指定も可能）。
```bash
node src/index.js --file ./audio_archive/2026-10-29-14-09-05.WAV
```

### 3. 処理済みファイルの強制再処理 (`--force`)
すでに `processed_files.json` に記録されている処理済みファイルも、プロンプトやモデル設定を変えた後に再生成したい場合は `--force` を付けます。
```bash
# 特定の1ファイルを再処理する場合
node src/index.js --file ./audio_archive/2026-10-29-14-09-05.WAV --force

# アーカイブ内の全ファイルを一括で再処理する場合
npm start -- --force
```

### 4. ディレクトリ監視モード (`--watch`)
プログラム起動中、指定したディレクトリ（`RECORDER_SOURCE_DIR` や `AUDIO_ARCHIVE_DIR`）への新規ファイル追加を10秒おきに検知して自動処理します。
```bash
npm run watch
```

### 5. ドライランモード (`--dry-run`)
Gemini API を呼び出さずに、音声の取り込み・チャンク分割・Markdown ファイル出力の一連の動作をテストします。
```bash
npm run dry-run
```

### 6. CLI オプション一覧
```text
  -c, --config <path>   設定ファイル (.env または config.sh) のパスを指定
  -f, --file <path>     特定の音声ファイルを直接指定して処理 (複数指定可)
  -w, --watch           監視モード (ボイスレコーダー接続や新規ファイル追加を検知)
      --force           処理済み履歴にあるファイルも強制的に再処理する
      --dry-run         Gemini APIを呼び出さずに音声分割・Markdown出力のテストを実行
  -h, --help            ヘルプを表示
```
