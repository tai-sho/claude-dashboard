// 画面に出す文字の整形。DOM に触らないので、node:test から直接読み込んで確かめられる。
// HTML を返す関数（where、gitFlag、openActions、highlight）は、中に入れる値をすべて esc() してから組み立てる。

export const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// 返答の Markdown を、一覧で読める素の文にする
export const plain = t => String(t || '').replace(/```[\s\S]*?```/g, '［コード省略］').replace(/[*_`#>]/g, '').replace(/\n{2,}/g, '\n').trim();
export const short = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
// worktree の作業フォルダを、元のリポジトリのフォルダにまとめる
export const rootOf = cwd => (cwd || '').replace(/\/\.claude\/worktrees\/[^/]+.*$/, '');

// ---------- 時刻 ----------
export function elapsed(ms) {
  const m = Math.max(0, Math.floor(ms / 60000));
  if (m < 1) return { n: Math.max(0, Math.floor(ms / 1000)), u: '秒' };
  if (m < 60) return { n: m, u: '分' };
  const h = Math.floor(m / 60);
  if (h < 48) return { n: h, u: '時間' };
  return { n: Math.floor(h / 24), u: '日' };
}
// 盤面の空の色を決める時間帯（朝 5〜9時、昼 10〜15時、夕 16〜18時、夜 それ以外）
export const daypart = hour => (hour >= 5 && hour < 10 ? 'morning' : hour >= 10 && hour < 16 ? 'day' : hour >= 16 && hour < 19 ? 'evening' : 'night');
export const ago = t =>{ const e = elapsed(Date.now() - t); return `${e.n}${e.u}前`; };
export const hhmm = t => new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
export const dayKey = t => new Date(t).toLocaleDateString('sv-SE');
export function dayLabel(key) {
  const today = dayKey(Date.now()), yest = dayKey(Date.now() - 86400000);
  const d = new Date(key + 'T00:00');
  const base = d.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
  return key === today ? `今日　${base}` : key === yest ? `昨日　${base}` : base;
}

// ---------- セッションの場所と操作 ----------
// noProject: プロジェクトの見出しの下ではプロジェクト名を繰り返さない
export function where(s, noProject) {
  const parts = noProject ? [] : [esc(s.project)];
  if (s.gitBranch && s.gitBranch !== 'HEAD') parts.push(`<span class="branch">${esc(s.gitBranch)}</span>`);
  else if (s.worktree) parts.push(esc(s.worktree));
  return parts.join(' / ');
}
export const whereText = s => [s.project, s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : s.worktree].filter(Boolean).join(' / ');
export function gitFlag(s) {
  if (!s.git) return '';
  if (s.git.changed > 0) return `<span class="flag dirty">未コミット ${esc(s.git.changed)}件</span>`;
  if (s.git.ahead > 0) return `<span class="flag dirty">未プッシュ ${esc(s.git.ahead)}件</span>`;
  return '';
}
// シェルに貼っても展開されないよう単一引用符で囲む
export const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Claude アプリでセッションを開くリンク
export const appUrl = hostSessionId => `claude://code/continue?session=${encodeURIComponent(hostSessionId)}&source=url_external`;
// アプリのセッションなら開くリンク、そうでなければ再開コマンドのコピー
export function openActions(s) {
  const out = [];
  if (s.hostSessionId) out.push(`<a class="act primary" href="${esc(appUrl(s.hostSessionId))}">Claude で開く</a>`);
  else if (s.cwd) out.push(`<button class="act" data-copy="${esc(`cd ${shQuote(s.cwd)} && claude --resume ${shQuote(s.sessionId)}`)}" data-copied="再開コマンドをコピーしました">再開コマンドをコピー</button>`);
  if (s.cwd) out.push(`<button class="act" data-copy="${esc(s.cwd)}" data-copied="パスをコピーしました">パスをコピー</button>`);
  return out.join('');
}

// 元の文字列を検索語で区切ってから、各部分をエスケープして一致部分だけを囲む（エスケープ後の文字列に当てると &amp; などを壊すため）
export function highlight(text, terms) {
  const words = terms.filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return esc(text);
  const re = new RegExp(`(${words.join('|')})`, 'gi');
  return String(text ?? '').split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}
