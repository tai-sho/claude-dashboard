# CLAUDE.md

Claude Code の並列セッションを一覧するローカルダッシュボード。使い方と画面の説明は README.md にある。ここには変更するときに守ることを書く。

## 原則

- **依存パッケージを入れない。** Node.js 20 以上の標準モジュールだけで動かす。ビルド工程もない。画面は `public/` の素の HTML / CSS / JS。
- **外部に送信しない。** 読むのはローカルのファイルだけ。新しいデータ源を足すときもローカルに限る。
- **待ち受けは `127.0.0.1` のみ。** `server.mjs` の Host ヘッダー検査を外さない。
- **hooks と statusline のスクリプトは Claude Code を止めない。** `hooks/` のスクリプトは、どんな失敗でも exit 0 で終わり、例外を外に出さない。statusline の記録に失敗しても、元の statusline の表示は必ず行う。
- **ユーザーの設定は壊さない。** `~/.claude/settings.json` を書き換えるのは `install-*.mjs` だけ。既存の hooks や statusLine を残し、書き換え前にバックアップを作り、`--remove` で元に戻せるようにする。
- **公開リポジトリ。** 実際の会話内容、セッション名、社名や個人名、ユーザー固有の絶対パスを、コード・テスト用データ・ドキュメント・スクリーンショットに入れない。確認用のデータは合成して作る。

## 構成とデータの流れ

```
~/.claude/sessions/<pid>.json ─┐
~/.claude/projects/**/*.jsonl ─┼─> lib/transcripts.mjs（索引） ─┐
~/.claude-dashboard/events/*   ─┤                               ├─> server.mjs ─ SSE / JSON API ─> public/js/main.js
アプリの claude-code-sessions  ─┴─> lib/sessions.mjs（状態判定）─┘
```

- `lib/transcripts.mjs`: jsonl をファイルごとに読んだ位置（offset）を覚え、追記分だけ読む。`user` / `assistant` / `custom-title` 以外の行は JSON.parse しない（巨大な行があるため）。1セッションあたりの保持量は `TEXT_CAP` と `TIMELINE_CAP` で抑えている。
- `lib/sessions.mjs`: `~/.claude/sessions/*.json` の busy / idle と、索引・hooks のイベント・`git status` から表示用の状態（`waiting` / `stalled` / `working` / `yours` / `idle`）と「閉じてよい」の4条件を決める。
- `lib/review.mjs`: タイムラインから「作業中」と「あなたの番」の区間を組み立て、ふりかえりの集計をする。カレンダーのまとまり（`blocksOf`）は、作業中の区間を30分未満のあなたの番でつないだもの。
- `server.mjs`: `fs.watch` とポーリング（5秒）で変化を検知し、`/api/events`（SSE）で稼働中セッションを配信する。`/api/history`、`/api/search`、`/api/ledger`、`/api/session`、`/api/usage`、`/api/review`、`/api/calendar` は都度計算する。
- `public/js/` は素の ES modules（`<script type="module">`）で、ビルドなしでそのまま配る。入口は `main.js` で、配信を受けて各画面に渡し、画面の切り替えとクリックを受け付ける。グローバル変数で画面どうしをつながず、必要なものを import する。
  - DOM に触らない: `format.js`（文字の整形と `esc()`）、`lanes.js`（盤面の列とプロジェクト別の並べ方）、`quota.js`（使用枠の計算）、`planet.js`（プロジェクトごとの惑星の種類と色。眺めるモードと盤面の印で共有）、`calendar.js`（ふりかえりのカレンダーの期間・日ごとの切り分け・重なりの並べ方・プロジェクトの色の割り当て）。`test/public.test.mjs` が node:test から直接読み込んで確かめる。DOM や `localStorage` を使う処理はここに入れない。
  - 共有の状態: `live.js`（最新のデータと「確認した」の記録）、`dom.js`（`$`、`getJson`、`cssVar`、`reduceMotion` など）。
  - 画面: `board.js`（呼び出し盤。前回との差分から、移動・吊り下がり・判子・めくれ・縁の光・タイプライターを出す。一度きりの動きは始まった時刻で覚え、描き直しても負の `animation-delay` で続きから動かす）、`fx.js`（盤面に重ねる演出。描く前の位置を覚えて差を埋める移動、ちぎれて落ちる伝票、伝票刺しへ飛ぶ伝票、紙吹雪）、`ledger.js`、`history.js`、`usage.js`、`detail.js`、`alerts.js`（音と通知）、`map.js`（つながり）、`review.js`（ふりかえり。日・週・月のカレンダーと7日間のまとめ）、`orbit.js`（眺めるモード）。画面のモジュールは `init` / `show` / `hide` / `update` のうち必要なものを持つ（`main.js` 冒頭に説明がある）。
- 眺めるモードの 3D は、ライブラリを使わず WebGL 2 を直接使って描く（依存を入れないため）。惑星は四角形の上で光線と球の交差を解いて描き、表面の模様もシェーダーの中でノイズから作る（プロジェクトごとに種類と模様が決まる）。奥行きを書き出してからピントのぼかしと太陽のまぶしさを仕上げで足す。名前・観測の印・観測カードへの線は、上に重ねた Canvas 2D に描く。太陽は世界に固定。背景の星雲と天の川は、開く前の空き時間に全天のパノラマとして作っておく。
- 起動時に `~/.claude/projects` 全体の索引を作る（千件規模で数秒）。

## 非公開の形式に依存している箇所

Claude Code とデスクトップアプリの内部ファイルを読んでいる。形式が変わったらここを直す。

| 依存先 | 使っている項目 | 場所 |
| --- | --- | --- |
| `~/.claude/sessions/<pid>.json` | `pid`, `sessionId`, `cwd`, `status`（busy / idle）, `statusUpdatedAt`, `name`, `entrypoint`, `hostSessionId` | `lib/sessions.mjs` |
| 会話記録 jsonl | `type`, `message.content`, `timestamp`, `isSidechain`, `isMeta`, `gitBranch`, `cwd`, `entrypoint`, `custom-title` 行 | `lib/transcripts.mjs` |
| 引き継ぎ文 | デスクトップアプリの `mcp__ccd_turn__wrap_up` ツール呼び出しの `input.recap` | `lib/transcripts.mjs` の `HANDOFF_TOOL` |
| アプリのセッション記録 | `claude-code-sessions/**/local_*.json` の `sessionId`, `cliSessionId`, `priorCliSessionIds`, `title`, `isArchived` | `lib/sessions.mjs` の `loadAppSessions` |
| アプリを開くリンク | `claude://code/continue?session=local_…` | `public/js/format.js` の `appUrl` |
| 使用枠 | statusline の入力の `rate_limits.<窓>.used_percentage` と `resets_at`（秒・ミリ秒・ISO 文字列のどれでも読めるようにしている） | `hooks/statusline-tap.mjs`, `public/js/quota.js` |

## 画面のデザイン

- 色・余白は `public/app.css` 冒頭の CSS 変数で管理する。ライトとダークの両方を必ず定義する。例外は眺めるモードで、宇宙を眺める画面なのでテーマに関係なく暗い。その色は `.ambient` の中だけで定義する。状態の色は、承認待ち・停滞が `--call`、あなたの番が `--turn`、作業中が `--work`。ふりかえりのカレンダーはプロジェクトを `--cal-0`〜`--cal-7` で塗り分ける（同じ画面のプロジェクトどうしは重ならないように割り当てる）。
- 書体は IBM Plex Sans JP の1書体。数字は `.num`（等幅数字）。
- 文言は日本語。利用者から見た言葉で書き、内部の用語（busy、jsonl など）を画面に出さない。すべて大文字のラベル、見出し上の小さなラベル、中黒でつないだメタ情報は使わない。
- 動きは、**状態が変わったことを伝えるもの**（伝票の移動、呼ばれた伝票の吊り下がり、待ち時間の桁のめくれ、判子、伝票刺し、ちぎれて落ちる伝票）と、**作業が続いていることを示すもの**（作業中の点、心電図、電光掲示、縁を走る光、星座図の光、眺めるモードの公転）を中心にする。眺めて楽しめることも大事にしているので、飾りの動き（時間帯の空の色、紙吹雪、眺めるモードの流れる雲や流れ星）も入れてよい。ただし、読む・押すの邪魔をしないこと（文字を読める速さで止まる、押す場所が動き続けない、数秒で終わる）。
- `prefers-reduced-motion` を尊重する。めくれ・判子・明滅は止め、Canvas の画面は動かさずに1枚だけ描く。
- Canvas の描画は、画面が隠れているとき（`document.hidden`、別の画面を開いているとき）は止める。色は `CB.cssVar()` で CSS 変数から読み、ライトとダークの両方で見えるようにする。
- 画面に出す値はすべて `esc()` を通す。`innerHTML` に生の文字列を入れない。

## 確認の仕方

```bash
for f in server.mjs install-*.mjs lib/*.mjs hooks/*.mjs public/js/*.js; do node --check "$f" || echo "NG: $f"; done
npm test                    # node:test。HOME と CLAUDE_CONFIG_DIR を一時ディレクトリに向けて合成データで動かす
PORT=4399 node server.mjs   # 動いている本番と別のポートで起動して確認する
```

- テストは `test/` にある。依存パッケージは使わず `node:test` で書く。実際の `~/.claude` を読まないよう、`test/helpers.mjs` の `sandboxEnv()` を対象モジュールの import より前に呼ぶ。
- API は `curl -s localhost:4399/api/state` などで確認できる。
- 使用枠や hooks の動作は、`HOME` を一時ディレクトリに向け、`CLAUDE_CONFIG_DIR` を実際の `~/.claude` に向けて起動すると、合成データで確認できる（`~/.claude-dashboard` の読み書き先だけが入れ替わる）。
- `install-*.mjs` は、`HOME` を一時ディレクトリに向け、そこに用意した `settings.json` で追加と `--remove` の往復を試してから使う。
- 画面を変えたら、ライト・ダークの両方と、幅 720px 以下の表示を確認する。
