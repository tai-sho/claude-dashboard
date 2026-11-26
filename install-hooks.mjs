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
const command = `node ${JSON.stringify(script)}`;
const MARK = 'claude-dashboard/hooks/record.mjs';
const EVENTS = ['Notification', 'PermissionRequest', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'];
const remove = process.argv.includes('--remove');

const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
const settings = JSON.parse(raw);
settings.hooks ||= {};

for (const ev of EVENTS) {
  const groups = (settings.hooks[ev] || [])
    .map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !String(h.command || '').includes(MARK)) }))
    .filter(g => g.hooks.length);
  if (!remove) groups.push({ hooks: [{ type: 'command', command, timeout: 3, async: true }] });
  if (groups.length) settings.hooks[ev] = groups; else delete settings.hooks[ev];
}

const backup = `${settingsPath}.bak.dashboard-${Date.now()}`;
fs.writeFileSync(backup, raw);
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? '削除' : '追加'}しました: ${settingsPath}`);
console.log(`バックアップ: ${backup}`);
console.log('新しく始めたセッションから有効になります。');
