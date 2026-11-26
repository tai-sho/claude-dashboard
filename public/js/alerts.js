// 呼ばれたときの音とデスクトップ通知、そのオンとオフ。
import { $, store } from './dom.js';
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
