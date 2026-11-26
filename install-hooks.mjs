#!/usr/bin/env node
// ~/.claude/settings.json に「承認待ち」検知用の hooks を追記する（既存の hooks は残す）。
// 使い方: node install-hooks.mjs        … 追加
//         node install-hooks.mjs --remove … このダッシュボードの hooks だけ削除
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hooks', 'record.mjs');
// シェルで展開されないよう単一引用符で囲む
const shQuote = v => `'${String(v).replace(/'/g, `'\\''`)}'`;
// 末尾のシェルコメントは自分の登録の印。フォルダ名や置き場所が変わっても見分けられるようにする
const TAG = '# claude-dashboard:record';
const command = `node ${shQuote(script)} ${TAG}`;
// 印の無い以前の版の登録は、フォルダ名が claude-dashboard の場合だけ見分けられる
const LEGACY_MARK = 'claude-dashboard/hooks/record.mjs';
const isMine = h => [TAG, LEGACY_MARK].some(m => String(h.command || '').includes(m));
// 登録するイベント。以前の版で登録した他のイベントの分は、再実行で取り除かれる
const EVENTS = ['Notification', 'PermissionRequest', 'SessionEnd'];
const LEGACY_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'];
const remove = process.argv.includes('--remove');

const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
const settings = JSON.parse(raw);
settings.hooks ||= {};

for (const ev of [...EVENTS, ...LEGACY_EVENTS]) {
  const groups = (settings.hooks[ev] || [])
    .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isMine(h)) }))
    .filter(g => g.hooks.length);
  if (!remove && EVENTS.includes(ev)) groups.push({ hooks: [{ type: 'command', command, timeout: 3, async: true }] });
  if (groups.length) settings.hooks[ev] = groups; else delete settings.hooks[ev];
}

const backup = `${settingsPath}.bak.dashboard-${Date.now()}`;
fs.writeFileSync(backup, raw);
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? '削除' : '追加'}しました: ${settingsPath}`);
console.log(`バックアップ: ${backup}`);
console.log('新しく始めたセッションから有効になります。');
