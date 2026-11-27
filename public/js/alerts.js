// 呼ばれたときの音とデスクトップ通知、そのオンとオフ。タブのアイコンの件数もここで描く。
import { $, store, cssVar } from './dom.js';
import { plain, appUrl } from './format.js';

let soundOn = store.get('sound', false);
let audioCtx;

function chime(urgent) {
  if (!soundOn) return;
  try {
    audioCtx ||= new AudioContext();
    (urgent ? [880, 660, 880] : [660, 880]).forEach((f, i) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      const t = audioCtx.currentTime + i * 0.16;
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.02); g.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
      o.connect(g).connect(audioCtx.destination); o.start(t); o.stop(t + 0.55);
    });
  } catch {}
}

// 承認や確認を求めているものがあれば、強めの音にする。通知は画面を見ていないときだけ
export function alertUser(list) {
  chime(list.some(s => s.state.key !== 'yours'));
  if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    for (const s of list.slice(0, 3)) {
      const n = new Notification(`${s.state.label}: ${s.name}`, { body: s.state.key === 'yours' ? plain(s.handoff?.text || s.lastReply).slice(0, 120) : s.state.reason, tag: s.sessionId });
      if (s.hostSessionId) n.onclick = () => { location.href = appUrl(s.hostSessionId); };
    }
  }
}

// タブのアイコンに待っている件数を載せる（タブが並んでいても、どのウィンドウが呼んでいるか分かるように）
let icon = null, badge = { calls: 0, turns: 0 }, shownBadge = '';
function drawBadge() {
  const { calls, turns } = badge, n = calls || turns;
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (!n) { link.href = 'icon.svg'; return; }
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.drawImage(icon, 0, 0, 64, 64);
  g.fillStyle = cssVar(calls ? '--call' : '--turn');
  g.beginPath(); g.arc(44, 20, 20, 0, Math.PI * 2); g.fill();
  g.fillStyle = calls ? '#fff' : '#1f2a2e'; // 小さな字なので、背景の色に対して読める白と墨に固定する
  g.font = '700 28px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(n > 9 ? '9+' : String(n), 44, 22);
  link.href = c.toDataURL('image/png');
}
export function setBadge(calls, turns) {
  badge = { calls, turns };
  const key = `${calls}|${turns}`;
  if (key === shownBadge) return;
  shownBadge = key;
  if (icon?.complete) return drawBadge();
  if (!icon) { icon = new Image(); icon.onload = drawBadge; icon.src = 'icon.svg'; }
}

function syncControls() {
  $('sound').setAttribute('aria-pressed', soundOn);
  $('sound').textContent = soundOn ? '音: オン' : '音を鳴らす';
  const n = 'Notification' in window ? Notification.permission : 'unsupported';
  $('notify').hidden = n === 'granted' || n === 'unsupported';
}

export function initAlerts() {
  $('sound').onclick = () => {
    soundOn = !soundOn; store.set('sound', soundOn); syncControls();
    if (soundOn) { audioCtx ||= new AudioContext(); audioCtx.resume(); chime(false); }
  };
  $('notify').onclick = async () => { await Notification.requestPermission(); syncControls(); };
  syncControls();
}
