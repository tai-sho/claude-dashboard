// 画面の部品を扱う小さな道具。ブラウザでだけ読み込む。
export const $ = id => document.getElementById(id);

// 利用者ごとの小さな設定（並べ方、音、「確認した」）。保存できない環境でも画面は動かす
export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
// Canvas に描く色は CSS 変数から読む（ライトとダークの両方に合わせるため）
export const cssVar = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1600);
}
export async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(r.status);
  return r.json();
}
