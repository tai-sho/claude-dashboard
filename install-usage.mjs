#!/usr/bin/env node
// 使用枠を記録するため、~/.claude/settings.json の statusLine の前に記録用スクリプトを挟む。
// 元のコマンドは ~/.claude-dashboard/statusline-original.json に退避し、表示はそのまま元のコマンドが行う。
// 使い方: node install-usage.mjs          … 挟む
//         node install-usage.mjs --remove … 元に戻す
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const settingsPath = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
const stateDir = path.join(os.homedir(), '.claude-dashboard');
const originalPath = path.join(stateDir, 'statusline-original.json');
const tap = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hooks', 'statusline-tap.mjs');
const MARK = 'claude-dashboard/hooks/statusline-tap.mjs';
const remove = process.argv.includes('--remove');

const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
const settings = JSON.parse(raw);
const current = settings.statusLine;
const installed = String(current?.command || '').includes(MARK);

if (remove) {
  if (!installed) { console.log('挟まっていません。変更なし。'); process.exit(0); }
  let original = null;
  try { original = JSON.parse(fs.readFileSync(originalPath, 'utf8')); } catch {}
  if (original?.statusLine) settings.statusLine = original.statusLine; else delete settings.statusLine;
} else {
  if (installed) { console.log('すでに挟まっています。変更なし。'); process.exit(0); }
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(originalPath, JSON.stringify({ command: current?.command || null, statusLine: current || null }, null, 2));
  settings.statusLine = { ...(current || {}), type: 'command', command: `node ${JSON.stringify(tap)}` };
}

const backup = `${settingsPath}.bak.dashboard-${Date.now()}`;
fs.writeFileSync(backup, raw);
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(`${remove ? '元に戻しました' : '記録用スクリプトを挟みました'}: ${settingsPath}`);
console.log(`バックアップ: ${backup}`);
