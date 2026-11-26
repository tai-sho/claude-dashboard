#!/usr/bin/env node
// Claude Code hooks から呼ばれ、承認待ちに関わるイベントを ~/.claude-dashboard/events/ に記録する。
// - Notification       → <session_id>.notification.json
// - PermissionRequest  → <session_id>.permission.json
// - SessionEnd         → そのセッションの記録を消す
// 待ちが解けたかどうかはサーバーが会話記録の時刻と比べて判断するので、ここでは消さない。
// hooks は非同期で順不同に走るため、イベントごとに別ファイルへ丸ごと書き、読み書きの競合を避ける。
// どんな失敗でも Claude Code の動作を止めないよう、常に exit 0 で終わる。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.homedir(), '.claude-dashboard', 'events');

function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const id = String(input.session_id || '').replace(/[^A-Za-z0-9-]/g, '');
  if (id) {
    const at = Date.now();
    switch (input.hook_event_name) {
      case 'Notification':
        fs.mkdirSync(DIR, { recursive: true });
        writeAtomic(path.join(DIR, `${id}.notification.json`), { at, type: input.notification_type || null, message: String(input.message || '').slice(0, 200) });
        break;
      case 'PermissionRequest':
        fs.mkdirSync(DIR, { recursive: true });
        writeAtomic(path.join(DIR, `${id}.permission.json`), { at, tool: input.tool_name || null });
        break;
      case 'SessionEnd':
        for (const name of [`${id}.notification.json`, `${id}.permission.json`, `${id}.json`]) fs.rmSync(path.join(DIR, name), { force: true });
        break;
      // 以前の版で登録された他のイベントは何もしない
    }
  }
} catch { /* 何もしない */ }
process.exit(0);
