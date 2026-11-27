// プロジェクトごとの惑星の種類と色。眺めるモードの惑星と、盤面のプロジェクトの印で同じものを使う。
// DOM に触らないので、node:test から直接読み込んで確かめられる。

// 文字列から 0〜1 の値を決める（同じ文字列と k なら、いつも同じ値）。
// 末尾だけ違う文字列（project-1、project-2 など）でも散らばるよう、最後にビットをよく混ぜる
export const hash = (s, k = 0) => {
  let h = 2166136261 ^ k;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
};

export const TYPES = ['gas', 'terran', 'ice', 'rock'];
export const GAS_PALETTES = [
  [[0, '#7a4a2e'], [.25, '#c9935e'], [.45, '#ead3ae'], [.6, '#b37a4b'], [.8, '#e3c9a0'], [1, '#8a5634']],
  [[0, '#2f4a73'], [.3, '#7f9fc4'], [.5, '#d5e2ee'], [.7, '#5b7ba3'], [1, '#a9bfd8'], [1, '#a9bfd8']],
  [[0, '#4d5a3b'], [.3, '#a9a46a'], [.55, '#e2dcb4'], [.75, '#8c8550'], [1, '#c8c08a'], [1, '#c8c08a']],
];

// 盤面の小さな印に使う色（明るい面、地の色、影）。シェーダーの地表の色に合わせている
const GLYPH = {
  terran: ['#7fb2d6', '#1c5c87', '#0a2236'],
  ice: ['#ebf5f7', '#9cc2d9', '#5e8fad'],
  rock: ['#c9b49a', '#8a7560', '#3d3430'],
};
const LAND = ['#3f6b35', '#6f6a42']; // 地球型の陸（森と乾いた土地）

// プロジェクトの惑星。key は眺めるモードと盤面で同じもの（lanes.js の projectKey）を渡す
export function planetOf(key) {
  const type = TYPES[Math.floor(hash(key, 7) * TYPES.length)];
  const pal = GAS_PALETTES[Math.floor(hash(key, 13) * GAS_PALETTES.length)];
  const ring = type === 'gas' && hash(key, 8) > .35;
  const glyph = type === 'gas' ? [pal[2][1], pal[1][1], pal[0][1]] : GLYPH[type];
  return { type, pal, ring, glyph, land: type === 'terran' ? LAND : null };
}
