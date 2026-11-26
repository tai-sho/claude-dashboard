(() => {
  const $ = id => document.getElementById(id);
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  };
  const REST_AFTER_MS = 8 * 60 * 60 * 1000; // 8時間触っていない「あなたの番」は寝かせる扱い
  let acks = store.get('acks', {});
  let soundOn = store.get('sound', false);
  let arrange = store.get('arrange', 'project') === 'state' ? 'state' : 'project'; // 盤面の並べ方
  let data = null;
  let prevStates = null;
  const fresh = new Set();

  // ---------- 共通 ----------
  const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plain = t => String(t || '').replace(/```[\s\S]*?```/g, '［コード省略］').replace(/[*_`#>]/g, '').replace(/\n{2,}/g, '\n').trim();
  function elapsed(ms) {
    const m = Math.max(0, Math.floor(ms / 60000));
    if (m < 1) return { n: Math.max(0, Math.floor(ms / 1000)), u: '秒' };
    if (m < 60) return { n: m, u: '分' };
    const h = Math.floor(m / 60);
    if (h < 48) return { n: h, u: '時間' };
    return { n: Math.floor(h / 24), u: '日' };
  }
  const ago = t => { const e = elapsed(Date.now() - t); return `${e.n}${e.u}前`; };
  const hhmm = t => new Date(t).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  const dayKey = t => new Date(t).toLocaleDateString('sv-SE');
  function dayLabel(key) {
    const today = dayKey(Date.now()), yest = dayKey(Date.now() - 86400000);
    const d = new Date(key + 'T00:00');
    const base = d.toLocaleDateString('ja-JP', { month: 'long', day: 'numeric', weekday: 'short' });
    return key === today ? `今日　${base}` : key === yest ? `昨日　${base}` : base;
  }
  // noProject: プロジェクトの見出しの下ではプロジェクト名を繰り返さない
  function where(s, noProject) {
    const parts = noProject ? [] : [esc(s.project)];
    if (s.gitBranch && s.gitBranch !== 'HEAD') parts.push(`<span class="branch">${esc(s.gitBranch)}</span>`);
    else if (s.worktree) parts.push(esc(s.worktree));
    return parts.join(' / ');
  }
  const whereText = s => [s.project, s.gitBranch && s.gitBranch !== 'HEAD' ? s.gitBranch : s.worktree].filter(Boolean).join(' / ');
  function gitFlag(s) {
    if (!s.git) return '';
    if (s.git.changed > 0) return `<span class="flag dirty">未コミット ${s.git.changed}件</span>`;
    if (s.git.ahead > 0) return `<span class="flag dirty">未プッシュ ${s.git.ahead}件</span>`;
    return '';
  }
  // シェルに貼っても展開されないよう単一引用符で囲む
  const shQuote = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
  // Claude アプリで開くリンク（アプリのセッションでなければ再開コマンドのコピー）
  function openActions(s) {
    const out = [];
    if (s.hostSessionId) out.push(`<a class="act primary" href="claude://code/continue?session=${encodeURIComponent(s.hostSessionId)}&source=url_external">Claude で開く</a>`);
    else if (s.cwd) out.push(`<button class="act" data-copy="${esc(`cd ${shQuote(s.cwd)} && claude --resume ${shQuote(s.sessionId)}`)}" data-copied="再開コマンドをコピーしました">再開コマンドをコピー</button>`);
    if (s.cwd) out.push(`<button class="act" data-copy="${esc(s.cwd)}" data-copied="パスをコピーしました">パスをコピー</button>`);
    return out.join('');
  }
  function toast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 1600); }
  async function getJson(url) { const r = await fetch(url); if (!r.ok) throw new Error(r.status); return r.json(); }
  // 元の文字列を検索語で区切ってから、各部分をエスケープして一致部分だけを囲む（エスケープ後の文字列に当てると &amp; などを壊すため）
  function highlight(text, terms) {
    const words = terms.filter(Boolean).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return esc(text);
    const re = new RegExp(`(${words.join('|')})`, 'gi');
    return String(text ?? '').split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
  }

  // ---------- 呼び出し盤 ----------
  function laneOf(s) {
    const k = s.state.key;
    if (k === 'waiting' || k === 'stalled') return 'you';
    if (k === 'working') return 'work';
    if (k === 'yours') {
      if (acks[s.sessionId] && acks[s.sessionId] >= (s.lastReplyAt || 0)) return 'rest';
      if (Date.now() - s.lastActivityAt > REST_AFTER_MS) return 'rest';
      return 'you';
    }
    return 'rest';
  }
  const since = s => s.state.since || s.lastActivityAt;

  function ticket(s, big, inProject) {
    const e = elapsed(Date.now() - since(s));
    const place = where(s, inProject);
    const st = s.state;
    const stateText = st.key === 'working' ? `<span class="pulse" aria-hidden="true"></span>${esc(st.label)}` : esc(st.label);
    const prompt = plain(s.lastPrompt);
    const handoffFresh = s.handoff && s.handoff.at >= (s.lastPromptAt || 0);
    const reply = handoffFresh ? '' : plain(s.lastReply);
    const tools = st.key === 'working' && s.recentTools.length
      ? `<ul class="tools">${s.recentTools.slice(0, big ? 3 : 2).map(t => `<li><b>${esc(t.name)}</b>${esc(t.detail)}</li>`).join('')}</ul>` : '';
    const ack = st.key === 'yours' ? `<button class="act" data-ack="${esc(s.sessionId)}">確認した</button>` : '';
    return `
    <article class="ticket${big ? '' : ' compact'}${fresh.has(s.sessionId) ? ' fresh' : ''}" data-state="${esc(st.key)}">
      <div>
        <h3 class="t-name"><button data-detail="${esc(s.sessionId)}">${esc(s.name)}</button></h3>
        ${place ? `<p class="t-where">${place}</p>` : ''}
      </div>
      <div class="clock num" title="${esc(new Date(since(s)).toLocaleString('ja-JP'))}">
        <span class="elapsed">${e.n}<small>${e.u}</small></span>
        <span class="state">${stateText}</span>
      </div>
      ${st.key !== 'yours' && st.reason && !tools ? `<p class="reason">${esc(st.reason)}</p>` : ''}
      <dl class="exchange">
        ${prompt ? `<div class="say"><dt>依頼</dt><dd>${esc(prompt)}</dd></div>` : ''}
        ${handoffFresh && st.key !== 'working' ? `<div class="say handoff"><dt>引き継ぎ</dt><dd>${esc(s.handoff.text)}</dd></div>` : ''}
        ${reply && st.key !== 'working' ? `<div class="say"><dt>返答</dt><dd>${esc(reply)}</dd></div>` : ''}
        ${s.skills?.length ? `<div class="say skills"><dt>スキル</dt><dd>${esc(s.skills.join('、'))}</dd></div>` : ''}
      </dl>
      ${tools}
      <div class="foot">
        ${gitFlag(s)}${s.closable ? '<span class="flag clear">閉じてよい</span>' : ''}
        <span class="spacer"></span>
        ${openActions(s)}
        ${ack}
        <button class="act" data-detail="${esc(s.sessionId)}">詳細</button>
      </div>
    </article>`;
  }

  function closeFlag(s) {
    if (s.closable) return '<span class="flag clear">閉じてよい</span>';
    return gitFlag(s) || `<span class="flag">${esc(s.state?.label || '')}</span>`;
  }

  function restRow(s, inProject) {
    return `<li><button class="row-btn" data-detail="${esc(s.sessionId)}">
      <span class="r-name">${esc(s.name)}</span>
      <span class="r-where">${where(s, inProject)}</span>
      <span class="r-age num">${ago(s.lastActivityAt)}</span>
      <span class="r-flag">${closeFlag(s)}</span>
    </button></li>`;
  }

  // プロジェクト別: 呼ばれている度合いの高いプロジェクトを上に。中は 待っている → 作業中 → 寝かせている
  function renderProjects(lanes) {
    const groups = new Map();
    // 表示名（フォルダ名）が同じでも別のリポジトリは分ける。worktree は元のリポジトリにまとめる
    const rootOf = s => (s.cwd && s.project !== 'No folder' ? s.cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '') : '');
    const at = s => {
      const root = rootOf(s), key = root || s.project || '不明';
      if (!groups.has(key)) groups.set(key, { name: s.project || '不明', root, you: [], work: [], rest: [], calls: 0, last: 0 });
      return groups.get(key);
    };
    for (const lane of ['you', 'work', 'rest']) {
      for (const s of lanes[lane]) {
        const g = at(s);
        g[lane].push(s);
        if (lane === 'you' && s.state.key !== 'yours') g.calls++;
        g.last = Math.max(g.last, s.lastActivityAt || 0);
      }
    }
    const rank = g => (g.calls ? 0 : g.you.length ? 1 : g.work.length ? 2 : 3);
    const list = [...groups.values()].sort((a, b) => rank(a) - rank(b) || b.last - a.last);
    if (!list.length) return '<p class="lane-empty">稼働中のセッションはありません。</p>';
    const named = {};
    for (const g of list) named[g.name] = (named[g.name] || 0) + 1;
    return list.map((g, i) => {
      const parent = g.root.split('/').slice(-2, -1)[0];
      const label = named[g.name] > 1 && parent ? `${g.name}（${parent}）` : g.name;
      const tally = [
        g.you.length ? `<span class="pc" data-tone="${g.calls ? 'call' : 'turn'}">待っている <b class="num">${g.you.length}</b></span>` : '',
        g.work.length ? `<span class="pc" data-tone="work">作業中 <b class="num">${g.work.length}</b></span>` : '',
        g.rest.length ? `<span class="pc">寝かせている <b class="num">${g.rest.length}</b></span>` : '',
      ].join('');
      const cards = [...g.you.map(s => ticket(s, true, true)), ...g.work.map(s => ticket(s, false, true))].join('');
      return `<section class="proj" data-rank="${rank(g)}" aria-labelledby="p-${i}">
        <h2><span class="p-name" id="p-${i}"${g.root ? ` title="${esc(g.root)}"` : ''}>${esc(label)}</span><span class="p-tally">${tally}</span></h2>
        ${cards ? `<div class="grid-proj">${cards}</div>` : ''}
        ${g.rest.length ? `<ul class="rows">${g.rest.map(s => restRow(s, true)).join('')}</ul>` : ''}
      </section>`;
    }).join('');
  }

  // 並べ方の表示は、データが届く前（接続できないときも含む）から合わせておく
  function syncArrange() {
    for (const b of document.querySelectorAll('[data-arrange]')) b.setAttribute('aria-pressed', b.dataset.arrange === arrange);
    $('board-lanes').hidden = arrange !== 'state';
    $('board-projects').hidden = arrange !== 'project';
  }

  function renderBoard() {
    syncArrange();
    if (!data) return;
    const lanes = { you: [], work: [], rest: [] };
    for (const s of data.sessions) lanes[laneOf(s)].push(s);
    lanes.you.sort((a, b) => ((a.state.key === 'yours') - (b.state.key === 'yours')) || since(a) - since(b));
    lanes.rest.sort((a, b) => b.lastActivityAt - a.lastActivityAt);

    if (arrange === 'project') {
      $('board-projects').innerHTML = renderProjects(lanes);
    } else {
      $('lane-you').innerHTML = lanes.you.map(s => ticket(s, true)).join('') || '<p class="lane-empty">いま、あなたの返事を待っているセッションはありません。</p>';
      $('lane-work').innerHTML = lanes.work.map(s => ticket(s, false)).join('') || '<p class="lane-empty">作業中のセッションはありません。</p>';
      $('lane-rest').innerHTML = lanes.rest.map(s => restRow(s)).join('');
      $('c-you').textContent = lanes.you.length; $('c-work').textContent = lanes.work.length; $('c-rest').textContent = lanes.rest.length;
    }

    const calls = lanes.you.filter(s => s.state.key !== 'yours').length;
    const turns = lanes.you.length - calls;
    const v = $('verdict');
    if (calls) { v.textContent = `${calls}件が承認や確認を求めています`; v.dataset.tone = 'call'; }
    else if (turns) { v.textContent = `${turns}件があなたの返事を待っています`; v.dataset.tone = 'calm'; }
    else if (lanes.work.length) { v.textContent = 'すべて Claude が進めています'; v.dataset.tone = 'calm'; }
    else { v.textContent = '待っているセッションはありません'; v.dataset.tone = 'calm'; }
    $('tally').innerHTML = `稼働 <b class="num">${data.sessions.length}</b> セッション　作業中 <b class="num">${lanes.work.length}</b>　閉じてよい <b class="num">${data.sessions.filter(s => s.closable).length}</b>`;
    $('nav-calls').textContent = lanes.you.length || '';
    document.title = lanes.you.length ? `(${lanes.you.length}) Claude 呼び出し盤` : 'Claude 呼び出し盤';
    $('hint').innerHTML = data.hooksInstalled ? '' :
      `<p class="hint">「承認待ち」の検知には hooks の登録が必要です。登録するには <code>npm run hooks:install</code> を実行してください。</p>`;
  }

  // ---------- 状態変化の検知と通知 ----------
  function detectChanges() {
    const now = {};
    for (const s of data.sessions) now[s.sessionId] = laneOf(s) === 'you' ? s.state.key : 'other';
    if (prevStates) {
      const called = data.sessions.filter(s => now[s.sessionId] !== 'other' && prevStates[s.sessionId] !== now[s.sessionId]);
      for (const s of called) fresh.add(s.sessionId);
      if (called.length) alertUser(called);
    }
    prevStates = now;
  }
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
  function alertUser(list) {
    chime(list.some(s => s.state.key !== 'yours'));
    if ('Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      for (const s of list.slice(0, 3)) {
        const n = new Notification(`${s.state.label}: ${s.name}`, { body: s.state.key === 'yours' ? plain(s.handoff?.text || s.lastReply).slice(0, 120) : s.state.reason, tag: s.sessionId });
        if (s.hostSessionId) n.onclick = () => { location.href = `claude://code/continue?session=${encodeURIComponent(s.hostSessionId)}&source=url_external`; };
      }
    }
  }


  // ---------- 使用枠 ----------
  const WINDOWS = [
    { key: 'five_hour', label: '5時間枠', span: 5 * 3600000, color: 'var(--work)' },
    { key: 'seven_day', label: '週の枠', span: 7 * 86400000, color: 'var(--turn)' },
  ];
  const levelOf = p => (p >= 80 ? 'high' : p >= 50 ? 'mid' : 'low');
  function parseReset(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
    const t = Date.parse(v); return Number.isNaN(t) ? null : t;
  }
  function untilText(t) {
    const ms = t - Date.now();
    if (ms <= 0) return 'まもなくリセット';
    const m = Math.round(ms / 60000);
    if (m < 60) return `あと${m}分でリセット`;
    const h = Math.floor(m / 60);
    if (h < 48) return `あと${h}時間${m % 60 ? (m % 60) + '分' : ''}でリセット`;
    return `${new Date(t).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })} にリセット`;
  }
  // 今の窓の中での増え方から、リセット時点の見込みを出す
  function projection(w, cur, history) {
    const pct = cur?.used_percentage, reset = parseReset(cur?.resets_at);
    if (pct == null || !reset) return null;
    const start = reset - w.span;
    const pts = history.filter(r => r.at >= start && r.rate_limits?.[w.key]?.used_percentage != null)
      .map(r => ({ t: r.at, p: r.rate_limits[w.key].used_percentage }));
    if (pts.length < 2) return null;
    const first = pts[0], last = pts.at(-1);
    if (last.t - first.t < (w.key === 'five_hour' ? 20 : 120) * 60000) return null;
    const slope = (last.p - first.p) / (last.t - first.t);
    if (slope <= 0) return { text: 'この窓ではほとんど増えていません' };
    const atReset = pct + slope * Math.max(0, reset - Date.now());
    if (atReset >= 100) {
      const hit = Date.now() + (100 - pct) / slope;
      return { text: `このペースだと ${new Date(hit).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} ごろ上限に届きます`, over: true };
    }
    return { text: `このペースだとリセット時に約${Math.round(atReset)}%` };
  }
  function renderMeters() {
    const u = data?.usage, el = $('meters');
    if (!u?.rate_limits) { el.hidden = true; return; }
    const stale = Date.now() - u.at > 30 * 60000 ? `（${ago(u.at)}の値）` : '';
    el.innerHTML = WINDOWS.filter(w => u.rate_limits[w.key]).map(w => {
      const cur = u.rate_limits[w.key], p = Math.round(cur.used_percentage ?? 0), reset = parseReset(cur.resets_at);
      return `<div class="meter" data-level="${levelOf(p)}"><span>${w.label}</span>
        <span class="track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p}" aria-label="${w.label}"><span class="fill" style="display:block;width:${Math.min(100, p)}%"></span></span>
        <b class="num">${p}%</b>
        <span class="sub">${reset ? esc(untilText(reset)) : ''}${esc(stale)}</span></div>`;
    }).join('');
    el.hidden = false;
  }
  function chartSvg(history) {
    const W = 760, H = 220, L = 44, R = 10, T = 12, B = 26;
    const now = Date.now(), from = now - 7 * 86400000;
    const x = t => L + (W - L - R) * (t - from) / (now - from);
    const y = p => T + (H - T - B) * (1 - Math.min(100, p) / 100);
    const grid = [0, 50, 100].map(p => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(p)}" y2="${y(p)}"/><text x="${L - 6}" y="${y(p) + 4}" text-anchor="end">${p}%</text>`).join('');
    const days = [];
    for (let d = new Date(from); d <= now; d.setDate(d.getDate() + 1)) {
      const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
      if (t > now) break;
      days.push(`<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}" stroke-dasharray="2 4"/><text x="${x(t) + 4}" y="${H - 8}">${new Date(t).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' })}</text>`);
    }
    const lines = WINDOWS.map(w => {
      const pts = history.filter(r => r.at >= from && r.rate_limits?.[w.key]?.used_percentage != null);
      if (!pts.length) return '';
      // 値は次の記録まで続くので階段状に結ぶ
      let d = '';
      pts.forEach((r, i) => {
        const px = x(r.at), py = y(r.rate_limits[w.key].used_percentage);
        d += i ? ` H${px.toFixed(1)} V${py.toFixed(1)}` : `M${px.toFixed(1)} ${py.toFixed(1)}`;
      });
      d += ` H${x(now).toFixed(1)}`;
      return `<path d="${d}" fill="none" stroke="${w.color}" stroke-width="2" stroke-linejoin="round"/>`;
    }).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="この7日間の使用枠の推移">${grid}${days.join('')}${lines}</svg>`;
  }
  async function renderUsage() {
    const { installed, current, history } = await getJson('/api/usage?days=8');
    const body = $('usage-body');
    if (!current?.rate_limits) {
      body.innerHTML = `<p class="lane-empty">${installed
        ? 'まだ記録がありません。Claude Code の statusline が表示されると記録されます。デスクトップアプリのセッションでは statusline が動かないことがあるため、ターミナルで claude を一度動かすと確実です。'
        : '使用枠の記録が設定されていません。<code>npm run usage:install</code> を実行してください。'}</p>`;
      return;
    }
    const cards = WINDOWS.filter(w => current.rate_limits[w.key]).map(w => {
      const cur = current.rate_limits[w.key], p = Math.round(cur.used_percentage ?? 0), reset = parseReset(cur.resets_at);
      const pj = projection(w, cur, history);
      return `<div class="ucard" data-level="${levelOf(p)}"><h3>${w.label}</h3>
        <p class="big num">${p}<small>%</small></p>
        <p>${reset ? esc(untilText(reset)) : 'リセット時刻は不明'}</p>
        ${pj ? `<p class="proj">${esc(pj.text)}</p>` : '<p>見込みを出すには、もう少し記録が必要です</p>'}</div>`;
    }).join('');
    const keys = WINDOWS.map(w => `<span class="key"><i style="background:${w.color}"></i>${w.label}</span>`).join('');
    body.innerHTML = `<div class="usage-cards">${cards}</div>
      <div class="chart"><h3>この7日間の推移${keys}</h3>${chartSvg(history)}</div>
      <p class="usage-note">値は Claude Code の statusline に渡される使用率を、変化したときだけ記録したものです。最終記録は ${esc(new Date(current.at).toLocaleString('ja-JP'))}（${esc(ago(current.at))}）。</p>`;
  }

  // ---------- 引き継ぎ台帳 ----------
  async function renderLedger() {
    const { sessions } = await getJson('/api/ledger');
    $('c-ledger').textContent = sessions.length;
    $('ledger-list').innerHTML = sessions.map(s => {
      const st = s.live ? `<span class="st" data-state="${esc(s.state?.key)}">${esc(s.state?.label)}</span>` : `<span class="st">${s.archived ? 'アーカイブ済み' : '終了'}</span>`;
      const text = s.handoff ? `<p class="l-text">${esc(s.handoff.text)}</p>` : '<p class="l-text none">引き継ぎ文はまだありません。</p>';
      const note = s.handoffStale ? '<p class="l-note">引き継ぎ文のあとに新しい依頼があります</p>' : '';
      return `<li>
        <div class="l-head"><button class="l-name" data-detail="${esc(s.sessionId)}">${esc(s.name)}</button><span class="l-where">${where(s)}</span></div>
        ${text}${note}
        <div class="l-side">${st}<span class="num">${s.handoff ? ago(s.handoff.at) : ago(s.lastActivityAt)}</span>${s.live && s.closable ? '<span class="flag clear">閉じてよい</span>' : ''}</div>
      </li>`;
    }).join('') || '<li class="lane-empty">表示できるセッションがありません。</li>';
  }

  // ---------- 履歴と検索 ----------
  function histRow(s) {
    const range = `${hhmm(s.firstPromptAt || s.lastActivityAt)}–${hhmm(s.lastActivityAt)}`;
    const side = s.live ? `<span class="st" data-state="${esc(s.state?.key)}">${esc(s.state?.label || '稼働中')}</span>` : `<span class="flag">依頼 ${s.promptCount}　編集 ${s.fileCount}</span>`;
    return `<li><button class="row-btn" data-detail="${esc(s.sessionId)}">
      <span class="r-time num">${range}</span>
      <span class="r-name">${esc(s.name)}</span>
      <span class="r-where">${esc(whereText(s))}</span>
      <span class="r-flag">${side}</span>
    </button></li>`;
  }
  async function renderHistory() {
    const q = $('q').value.trim();
    if (q) return renderSearch(q);
    const { sessions, index } = await getJson('/api/history?days=14');
    $('hist-meta').textContent = index.ready ? `この2週間 ${sessions.length} セッション` : `索引を作成中 ${index.done}/${index.total}`;
    const groups = new Map();
    for (const s of sessions) { const k = dayKey(s.lastActivityAt); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s); }
    $('history-body').innerHTML = [...groups].map(([k, list]) => `
      <section class="day"><h3>${esc(dayLabel(k))}<span class="num">${list.length} セッション</span></h3>
      <ul class="rows hist">${list.map(histRow).join('')}</ul></section>`).join('') || '<p class="lane-empty">この2週間のセッションはありません。</p>';
  }
  async function renderSearch(q) {
    const { sessions, index } = await getJson('/api/search?q=' + encodeURIComponent(q));
    if ($('q').value.trim() !== q) return;
    const terms = q.split(/\s+/);
    $('hist-meta').textContent = `${sessions.length} セッションが見つかりました${sessions.length >= 60 ? '（新しい60件）' : ''}${index.ready ? '' : '　索引を作成中'}`;
    $('history-body').innerHTML = sessions.length ? `<ul class="rows hits" style="margin-top:20px">${sessions.map(s => `
      <li><button class="row-btn" data-detail="${esc(s.sessionId)}" data-q="${esc(q)}">
        <span class="r-name">${highlight(s.name, terms)}</span>
        <span class="r-where">${esc(whereText(s))}</span>
        <span class="r-age num">${new Date(s.lastActivityAt).toLocaleDateString('ja-JP')}</span>
      </button>
      <ul class="snips">${s.matches.map(m => `<li><span>${{ prompt: '依頼', reply: '返答', handoff: '引き継ぎ' }[m.kind] || ''}</span><div>${highlight(plain(m.snippet), terms)}</div></li>`).join('')}</ul></li>`).join('')}</ul>`
      : `<p class="lane-empty" style="margin-top:20px">「${esc(q)}」を含む会話は見つかりませんでした。語を減らすか、別の言い方で探してください。</p>`;
  }
  let qTimer;
  $('q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(renderHistory, 220); });

  // ---------- 詳細パネル ----------
  let detailSeq = 0;
  async function openDetail(id, q) {
    const seq = ++detailSeq; // 後から開いたものだけを描く
    const dlg = $('detail');
    $('d-title').textContent = '読み込み中';
    $('d-where').textContent = ''; $('d-actions').innerHTML = ''; $('d-body').innerHTML = '';
    if (!dlg.open) dlg.showModal();
    let s;
    try { s = await getJson('/api/session?id=' + encodeURIComponent(id)); }
    catch { if (seq === detailSeq) $('d-title').textContent = 'このセッションの記録が見つかりません'; return; }
    if (seq !== detailSeq) return;
    const live = data?.sessions.find(x => x.sessionId === id);
    $('d-title').textContent = s.name;
    $('d-where').innerHTML = `${where(s)}　${s.live ? esc(s.state?.label) : s.archived ? 'アーカイブ済み' : '終了'}　${esc(new Date(s.firstPromptAt || s.lastActivityAt).toLocaleString('ja-JP'))} 開始`;
    $('d-actions').innerHTML = openActions(s);

    const checks = (live?.closeChecks || s.closeChecks);
    const terms = q ? q.split(/\s+/) : [];
    const sections = [];
    if (checks) sections.push(`<section class="d-sec"><h3>${checks.every(c => c.ok) ? '閉じてよい状態です' : '閉じる前に'}</h3>
      <ul class="checks">${checks.map(c => `<li class="${c.ok ? '' : 'ng'}">${esc(c.label)}</li>`).join('')}</ul></section>`);
    if (s.handoff) sections.push(`<section class="d-sec"><h3>引き継ぎ文　<span class="num" style="color:var(--ink-3);font-weight:500;font-size:13px">${esc(ago(s.handoff.at))}</span></h3>
      <p class="handoff-box">${esc(s.handoff.text)}</p>${s.handoffStale ? '<p class="l-note" style="color:var(--turn);font-size:13px">このあとに新しい依頼があります</p>' : ''}</section>`);
    if (s.files.length) sections.push(`<section class="d-sec"><h3>触ったファイル <span class="num" style="color:var(--ink-3);font-weight:500">${s.files.length}</span></h3>
      <ul class="files">${s.files.slice(0, 40).map(f => `<li><span>${esc(s.cwd && f.path.startsWith(s.cwd + '/') ? f.path.slice(s.cwd.length + 1) : f.path)}</span><span class="num">${f.edits}回</span></li>`).join('')}</ul></section>`);
    sections.push(`<section class="d-sec"><h3>経緯</h3><ol class="timeline">${timelineHtml(s.timeline, terms)}</ol></section>`);
    $('d-body').innerHTML = sections.join('');
    if (q) $('d-body').querySelector('mark')?.scrollIntoView({ block: 'center' });
  }

  function timelineHtml(items, terms) {
    const out = [];
    let lastDay = null, tools = [];
    const flushTools = () => {
      if (!tools.length) return;
      const names = [...new Set(tools.map(t => t.text.split(' ')[0]))];
      out.push(`<li class="tools"><time class="num">${hhmm(tools[0].at)}</time><div class="tl-text">ツール ${tools.length}回（${esc(names.slice(0, 5).join('、'))}${names.length > 5 ? ' ほか' : ''}）</div></li>`);
      tools = [];
    };
    for (const t of items) {
      const d = t.at ? dayKey(t.at) : lastDay;
      if (d !== lastDay) { flushTools(); out.push(`<li class="day-sep">${esc(dayLabel(d))}</li>`); lastDay = d; }
      if (t.kind === 'tool') { tools.push(t); continue; }
      flushTools();
      const label = { prompt: '依頼', reply: '返答', handoff: '引き継ぎ' }[t.kind];
      const text = t.kind === 'reply' ? plain(t.text) : t.text;
      out.push(`<li class="${t.kind}"><time class="num" title="${esc(label)}">${t.at ? hhmm(t.at) : ''}</time><div class="tl-text">${terms.length ? highlight(text, terms) : esc(text)}</div></li>`);
    }
    flushTools();
    return out.join('');
  }
  $('d-close').onclick = () => $('detail').close();
  $('detail').addEventListener('click', e => { if (e.target === $('detail')) $('detail').close(); });

  // ---------- 操作 ----------
  document.addEventListener('click', async e => {
    const el = e.target.closest('[data-detail],[data-ack],[data-copy],[data-arrange],.timeline li.reply');
    if (!el) return;
    if (el.dataset.arrange) { arrange = el.dataset.arrange; store.set('arrange', arrange); renderBoard(); return; }
    if (el.dataset.detail) { openDetail(el.dataset.detail, el.dataset.q); return; }
    if (el.dataset.ack) {
      const s = data.sessions.find(x => x.sessionId === el.dataset.ack);
      acks[el.dataset.ack] = s?.lastReplyAt || Date.now(); store.set('acks', acks);
      detectChanges(); renderBoard(); toast('寝かせているに移しました');
    } else if (el.dataset.copy) {
      try { await navigator.clipboard.writeText(el.dataset.copy); toast(el.dataset.copied || 'コピーしました'); } catch { toast('コピーできませんでした'); }
    } else if (el.matches('.timeline li.reply')) {
      el.classList.toggle('open');
    }
  });

  function syncControls() {
    $('sound').setAttribute('aria-pressed', soundOn);
    $('sound').textContent = soundOn ? '音: オン' : '音を鳴らす';
    const n = 'Notification' in window ? Notification.permission : 'unsupported';
    $('notify').hidden = n === 'granted' || n === 'unsupported';
  }
  $('sound').onclick = () => { soundOn = !soundOn; store.set('sound', soundOn); syncControls(); if (soundOn) { audioCtx ||= new AudioContext(); audioCtx.resume(); chime(false); } };
  $('notify').onclick = async () => { await Notification.requestPermission(); syncControls(); };
  syncControls();
  syncArrange();

  // ---------- 画面切り替え ----------
  function route() {
    const view = (location.hash.slice(1) || 'board').split('?')[0];
    for (const v of ['board', 'ledger', 'history', 'usage']) {
      $('view-' + v).hidden = v !== view;
      const link = document.querySelector(`.views a[data-view="${v}"]`);
      if (v === view) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    if (view === 'ledger') renderLedger().catch(() => {});
    if (view === 'history') renderHistory().catch(() => {});
    if (view === 'usage') renderUsage().catch(() => {});
  }
  window.addEventListener('hashchange', route);
  route();

  // ---------- 接続 ----------
  function connect() {
    const es = new EventSource('/api/events');
    es.onopen = () => { $('live').textContent = '更新中'; delete $('live').dataset.off; };
    es.onmessage = ev => {
      data = JSON.parse(ev.data);
      detectChanges(); renderBoard(); renderMeters(); fresh.clear();
      if (!$('view-ledger').hidden) renderLedger().catch(() => {});
      if (!$('view-usage').hidden) renderUsage().catch(() => {});
    };
    es.onerror = () => { $('live').textContent = 'サーバーに接続できません'; $('live').dataset.off = ''; };
  }
  connect();
  setInterval(() => { renderBoard(); renderMeters(); }, 15000);
})();
