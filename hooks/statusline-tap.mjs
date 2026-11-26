#!/usr/bin/env node
// statusline の前に挟み、入力の rate_limits を ~/.claude-dashboard/usage.json に記録してから
// 元の statusline コマンドに同じ入力を渡す。記録に失敗しても表示は止めない。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

const DIR = path.join(os.homedir(), '.claude-dashboard');
const ORIGINAL = path.join(DIR, 'statusline-original.json');

let input = '';
try { input = fs.readFileSync(0, 'utf8'); } catch { /* 入力が読めなくても元の statusline は動かす */ }

try {
  const d = JSON.parse(input || '{}');
  if (d.rate_limits) {
    fs.mkdirSync(DIR, { recursive: true });
    const snap = { at: Date.now(), rate_limits: d.rate_limits, session_id: d.session_id || null, model: d.model?.display_name || null };
    const tmp = path.join(DIR, `usage.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, path.join(DIR, 'usage.json'));
    // 推移用: 値が変わったときだけ1行追記する
    const key = JSON.stringify(['five_hour', 'seven_day'].map(k => d.rate_limits[k]?.used_percentage ?? null));
    const lastKeyFile = path.join(DIR, 'usage-last-key');
    let lastKey = '';
    try { lastKey = fs.readFileSync(lastKeyFile, 'utf8'); } catch {}
    if (key !== lastKey) {
      fs.appendFileSync(path.join(DIR, 'usage-history.jsonl'), JSON.stringify({ at: snap.at, rate_limits: d.rate_limits }) + '\n');
      fs.writeFileSync(lastKeyFile, key);
    }
  }
} catch { /* 記録できなくても続ける */ }

// 元の statusline をそのまま実行する
let original = null;
try { original = JSON.parse(fs.readFileSync(ORIGINAL, 'utf8')); } catch {}
if (!original?.command) process.exit(0);
const child = spawn(original.command, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
child.stdin.end(input);
child.on('exit', () => process.exit(0));
child.on('error', () => process.exit(0));
