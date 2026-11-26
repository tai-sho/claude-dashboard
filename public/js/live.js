// サーバーから届いた最新の状態と、「確認した」の記録。どの画面もここを通して同じデータを見る。
import { store } from './dom.js';
import { laneFor } from './lanes.js';

let data = null;
const acks = store.get('acks', {});

export const getData = () => data;
export const setData = d => { data = d; };
export const laneOf = s => laneFor(s, acks, Date.now());

// 「確認した」: その時点の返答までを見たことにして、寝かせている列に移す
export function ack(id) {
  const s = data?.sessions.find(x => x.sessionId === id);
  acks[id] = s?.lastReplyAt || Date.now();
  store.set('acks', acks);
}
