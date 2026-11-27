// 入口: サーバーからの配信を受けて各画面に渡し、画面の切り替えとクリックの受け付けをする。
//
// 画面ごとのモジュールは、次のうち必要なものを持つ。
//   init()     起動時に1回（イベントの登録など）
//   show()     その画面を開いたとき
//   hide()     その画面を離れたとき
//   update(d)  その画面を開いているあいだに新しい状態が届いたとき
// 呼び出し盤は、ほかの画面を開いていても見出しの件数やタブの題名を更新するため、常に描く。
import { $, toast } from './dom.js';
import { getData, setData } from './live.js';
import { initBoard, renderBoard, detectChanges, setArrange, ackTicket } from './board.js';
import { initAlerts, alertUser } from './alerts.js';
import { renderMeters, usageView } from './usage.js';
import { ledgerView } from './ledger.js';
import { historyView } from './history.js';
import { initDetail, openDetail } from './detail.js';
import { mapView } from './map.js';
import { reviewView } from './review.js';
import { ambient } from './orbit.js';

const views = { ledger: ledgerView, history: historyView, usage: usageView, map: mapView, review: reviewView };
const VIEWS = ['board', ...Object.keys(views)];
let currentView = null;

// 新しく呼ばれたセッションを知らせる。眺めている最中は閉じずに、宇宙の画面の中で知らせる
function announce(called) {
  if (!called.length) return;
  alertUser(called);
  ambient.notify(called);
}

// ---------- 画面切り替え ----------
function route() {
  let view = (location.hash.slice(1) || 'board').split('?')[0];
  if (!VIEWS.includes(view)) view = 'board';
  for (const v of VIEWS) {
    $('view-' + v).hidden = v !== view;
    const link = document.querySelector(`.views a[data-view="${v}"]`);
    if (v === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (currentView !== view) views[currentView]?.hide?.();
  currentView = view;
  views[view]?.show?.();
}

// ---------- 操作 ----------
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-detail],[data-ack],[data-copy],[data-arrange],.timeline li.reply');
  if (!el) return;
  if (el.dataset.arrange) { setArrange(el.dataset.arrange); return; }
  if (el.dataset.detail) { openDetail(el.dataset.detail, el.dataset.q); return; }
  if (el.dataset.ack) {
    ackTicket(el.dataset.ack);
    announce(detectChanges()); renderBoard(); toast('寝かせているに移しました');
  } else if (el.dataset.copy) {
    try { await navigator.clipboard.writeText(el.dataset.copy); toast(el.dataset.copied || 'コピーしました'); } catch { toast('コピーできませんでした'); }
  } else if (el.matches('.timeline li.reply')) {
    el.classList.toggle('open');
  }
});

// ---------- 接続 ----------
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { $('live').textContent = '更新中'; delete $('live').dataset.off; };
  es.onmessage = ev => {
    setData(JSON.parse(ev.data));
    announce(detectChanges()); renderBoard(); renderMeters();
    views[currentView]?.update?.(getData());
    ambient.update(getData());
  };
  es.onerror = () => { $('live').textContent = 'サーバーに接続できません'; $('live').dataset.off = ''; };
}

// 1つの画面の準備に失敗しても、盤面の表示と配信の受け取りは続ける
const safely = (name, fn) => { try { fn(); } catch (e) { console.error(`${name} の準備に失敗しました`, e); } };
initAlerts();
initBoard();
initDetail();
for (const [name, v] of Object.entries(views)) if (v.init) safely(name, () => v.init());
safely('ambient', () => ambient.init());
window.addEventListener('hashchange', route);
route();
connect();
setInterval(() => { renderBoard(); renderMeters(); }, 15000); // 待ち時間の表示を進める
