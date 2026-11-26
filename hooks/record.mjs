#!/usr/bin/env node
// Claude Code hooks から呼ばれ、セッションごとの最新イベントを ~/.claude-dashboard/events/<session_id>.json に書く。
// どんな失敗でも Claude Code の動作を止めないよう、常に exit 0 で終わる。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DIR = path.join(os.homedir(), '.claude-dashboard', 'events');

try {
  const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
  const id = String(input.session_id || '').replace(/[^A-Za-z0-9-]/g, '');
  if (id) {
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, id + '.json');
    let state = {};
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const at = Date.now();
    switch (input.hook_event_name) {
      case 'Notification':
        state.notification = { at, type: input.notification_type || null, message: String(input.message || '').slice(0, 200) };
        break;
      case 'PermissionRequest':
        state.permissionRequest = { at, tool: input.tool_name || null };
        break;
      case 'UserPromptSubmit':
      case 'PreToolUse':
      case 'PostToolUse':
      case 'Stop':
        // 進んだので待ち状態を解除
        delete state.notification;
        delete state.permissionRequest;
        state.lastEvent = { at, name: input.hook_event_name };
        break;
      case 'SessionEnd':
        fs.rmSync(file, { force: true });
        process.exit(0);
    }
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }
} catch { /* 何もしない */ }
process.exit(0);
