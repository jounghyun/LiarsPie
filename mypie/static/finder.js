// 연구 탭의 ② 순위 카드 + 좋은 조합 찾기 (코인·주식 화면 공용)
// 연구 탭: ① 고르기(종목·주기·기간·손절선, 페이지) → ② 순위(여기) → ③ 자세히(페이지의 시뮬레이션)
// 순위는 고른 조건의 단일 전략 순위에, 같은 조건으로 찾아 둔 '좋은 조합'(그 기간 단일 전략 상위 6개를 살 때·팔 때에 섞은
// 1,296가지) 중 상위 5개를 같은 점수로 섞어 보여준다. 조합 찾기 결과에는 단일 전략도 같은 계산으로 들어 있어서 나란히 비교된다.
// 아직 안 찾았으면 [🔍 조합도 찾아보기]로 파이에게 맡긴다 (긴 시뮬레이션과 같은 자리라 한 번에 하나, 진행률·멈춤).
// 결과는 최근 5개가 저절로 남고 ⭐ 저장한 건 50개까지 남는다 ('지난 조합 찾기'에서 골라 다시 보기).
// Finder.init({ kind, sel: () => ({market, tf, days, stop}) | null, sim: () => 준비된 시뮬레이션 응답 | null,
//               current: () => 지금 자세히 보는 규칙, using: (rule) => 계좌가 쓰는 중인지, pick: (rule) => 줄을 눌렀을 때,
//               open: (item) => 지난 조합 찾기를 골랐을 때, title: () => 순위 카드 머리의 작은 글, message: () => 순위가 비었을 때 글 })
// Finder.render(): 고르기·시뮬레이션이 바뀔 때마다 페이지가 부른다.
const Finder = (() => {
  const COMBOS = 5, MEDALS = ['🥇', '🥈', '🥉'];
  const MODES = [['all', '전략 + 조합'], ['singles', '전략만'], ['combos', '조합만']];
  const PHASES = { data: '과거 봉을 받는 중', prep: '전략 계산 중', sides: '살 때·팔 때 판단 합치는 중', search: '조합 굴리는 중' };
  const ui = {};
  let opt = null, list = null, mode = 'all', timer = null, estTimer = null;
  const cache = {}, loading = {}, estimates = {};

  const node = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v; else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null && k !== false) e.append(k);
    return e;
  };
  const button = (text, cls, onclick) => { const b = node('button', { type: 'button', class: cls, text }); b.onclick = onclick; return b; };
  const pct = (v, d = 1) => (v == null ? '-' : (v > 0 ? '+' : '') + (v * 100).toLocaleString('ko-KR', { maximumFractionDigits: d, minimumFractionDigits: d }) + '%');
  const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const dur = (sec) => {
    sec = Math.max(1, Math.round(sec));
    return sec >= 3600 ? `${Math.floor(sec / 3600)}시간 ${Math.round(sec % 3600 / 60)}분`
      : sec >= 60 ? `${Math.floor(sec / 60)}분${sec % 60 ? ` ${sec % 60}초` : ''}` : `${sec}초`;
  };
  async function api(path, body) {
    const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' });
    if (r.status === 401) { location.reload(); throw new Error('login'); }
    return r.json();
  }
  const toast = (text, kind) => { if (window.toast && text) window.toast(text, kind); };

  // ---- 조합 찾기 결과 ----
  const simpleRule = (name) => ({ strategy: name, buy: [name], buy_op: 'and', sell: [name], sell_op: 'and' });
  const isSimple = (rule) => rule.buy.length === 1 && rule.sell.length === 1 && rule.buy[0] === rule.sell[0];
  const years = () => (list && list.years) || [1, 2, 3, 5, 8];
  function yearsOf(tf, days) {  // 이 기간이 조합 찾기 기간(1·2·3·5·8년)이면 그 해 수
    const y = days / 365, max = (list && list.max_years && list.max_years[tf]) || 8;
    return years().includes(y) && y <= max ? y : null;
  }
  const findItem = (market, tf, y) => ((list && list.history) || []).find((h) => h.market === market && h.tf === tf && h.years === y) || null;
  function result(item) {  // 결과 하나 (처음이면 받아 오고 다 받으면 다시 그린다)
    if (!item) return null;
    if (cache[item.id]) return cache[item.id];
    if (!loading[item.id]) {
      loading[item.id] = true;
      api(`/api/search?kind=${opt.kind}&id=${encodeURIComponent(item.id)}`)
        .then((d) => { if (d.result) cache[d.result.id] = d.result; })
        .catch(() => {})
        .finally(() => { loading[item.id] = false; render(); });
    }
    return null;
  }
  async function loadList() {
    try { list = await api(`/api/search?kind=${opt.kind}`); } catch (e) { return; }
    if (list.result) cache[list.result.id] = list.result;
    render();
    if (list.job && list.job.state === 'running') poll();
  }

  // ---- 순위 줄 ----
  const byScore = (a, b) => (b.score ?? b.total_return) - (a.score ?? a.total_return);
  function rows(res, sim) {
    if (res) {  // 조합 찾기 결과: 단일 전략 + 바이앤홀드 + 조합 (모두 같은 계산)
      const singles = (res.singles || []).map((s) => ({ ...s, rule: simpleRule(s.name) }));
      const hold = res.hold ? [{ ...res.hold, name: 'buy_and_hold', label: '바이앤홀드 (기준)', rule: simpleRule('buy_and_hold'), base: true }] : [];
      const combos = (res.results || []).filter((x) => !isSimple(x.rule)).map((x) => ({ ...x, combo: true })).sort(byScore);
      if (mode === 'singles') return [...singles, ...hold].sort(byScore);
      if (mode === 'combos') return combos;
      return [...singles, ...hold, ...combos.slice(0, COMBOS)].sort(byScore);
    }
    if (sim) {  // 시뮬레이션의 같은 기간 순위 (조합 줄은 '이 전략들 사이에 넣으면 몇 위')
      return sim.results.map((x) => ({ ...x, rule: x.combo ? opt.current() : simpleRule(x.name), base: x.name === 'buy_and_hold', simRank: x.rank }));
    }
    return [];
  }
  function drawRows(list_, res) {
    const current = normalizeRule(opt.current() || simpleRule('buy_and_hold')), hold = (res && res.hold) || {};
    ui.body.replaceChildren(...list_.map((x, i) => {
      // 조합 찾기 결과면 섞은 순서 그대로 1·2·3등, 시뮬레이션 순위면 전략 순위 (조합 줄은 '그 사이에 넣으면 몇 위')
      const rank = res ? i + 1 : x.simRank || i + 1, medal = res ? i < 3 : !x.combo && rank <= 3;
      const steady = res && x.first_half != null && hold.first_half != null && x.first_half > hold.first_half && x.second_half > hold.second_half;
      const name = node('td', { class: 'left' }, x.combo ? node('span', { class: 'tag combo', text: '조합' }) : null,
        ...(x.combo && x.buy_text ? [node('span', { class: 'muted', text: '살 때 ' }), x.buy_text, node('span', { class: 'muted', text: ' · 팔 때 ' }), x.sell_text]
                                  : [x.label]));
      if (steady) name.append(node('span', { class: 'tag ok', text: '👍 두 절반', title: '앞 절반·뒤 절반 모두 그냥 들고 있기보다 나음' }));
      if (opt.using(x.rule)) name.append(node('span', { class: 'tag', text: '사용 중' }));
      if (x.same) name.append(node('span', { class: 'muted', text: ` · 똑같은 조합 ${x.same}개 더` }));
      // 폰: 낙폭·매매·승률 칸 대신 이름 아래 한 줄
      name.append(node('small', { class: 'rank-mini', text: `낙폭 ${pct(x.mdd)} · ${x.trades}회` + (x.win_rate == null ? '' : ` · 승률 ${Math.round(x.win_rate * 100)}%`) }));
      const tr = node('tr', { class: (sameCombo(current, normalizeRule(x.rule)) ? 'active' : '') + (x.base ? ' base' : '') },
        node('td', { class: 'left' + (medal ? ' medal' : ''), text: medal ? MEDALS[rank - 1] : `${rank}위` }), name,
        node('td', { class: tone(x.total_return), text: pct(x.total_return) }),
        node('td', { class: x.mdd < 0 ? 'down' : '', text: pct(x.mdd) }),
        node('td', { text: `${x.trades}회` + (x.win_rate == null ? '' : ` · ${Math.round(x.win_rate * 100)}%`) }));
      tr.onclick = () => opt.pick(x.rule);
      return tr;
    }));
  }

  // ---- 카드 그리기 ----
  function render() {
    if (!opt || !ui.body) return;
    const q = opt.sel(), sim = opt.sim();
    if (!q) return;
    const y = yearsOf(q.tf, q.days), item = y && !q.stop ? findItem(q.market, q.tf, y) : null;
    const res = result(item);
    ui.sub.textContent = opt.title() + (res ? ` · 조합 포함 (${String(res.computed_at).slice(5, 16)} 계산)` : '');
    ui.seg.hidden = !res;
    ui.seg.replaceChildren(...MODES.map(([m, label]) => {
      const b = button(label, 'seg-btn', () => { mode = m; render(); });
      b.setAttribute('aria-pressed', String(mode === m));
      return b;
    }));
    const shown = rows(res, sim);
    drawRows(shown, res);
    ui.empty.hidden = shown.length > 0;
    ui.empty.textContent = (opt.message && opt.message()) || '계산하는 중이에요…';
    drawFoot(q, y, res);
  }

  function drawFoot(q, y, res) {
    const job = list && list.job, running = job && job.state === 'running';
    const mine = job && String(job.id || '').startsWith(`search-${opt.kind}-`);
    const parts = [];
    if (running) parts.push(jobBox(job, mine));
    else if (mine && (job.state === 'stopped' || job.state === 'error') && !res) parts.push(node('div', { class: 'muted', text: job.message || '멈췄어요' }));
    if (res) {
      const star = button(res.saved ? '★ 저장됨' : '☆ 저장', res.saved ? 'small' : 'ghost small', () => toggleSave(res));
      star.title = res.saved ? '눌러서 저장에서 빼기' : `저장해 두면 최근 ${(list && list.recent) || 5}개에서 밀려나도 남아요`;
      const again = button('🔁 다시 찾기', 'ghost small', () => start(q, y));
      again.disabled = !!running;
      parts.push(node('div', { class: 'rank-found' },
        node('span', { text: `조합 ${res.count.toLocaleString('ko-KR')}가지 중 ${mode === 'combos' ? '상위 ' + (res.results || []).length + '개' : `상위 ${COMBOS}개를 섞었어요`}`
          + ` · ${res.from} ~ ${res.to} · 섞은 전략: ${(res.singles || []).filter((s) => (res.top || []).includes(s.name)).map((s) => s.label).join(', ')} ` }),
        star, ' ', again));
      if (res.short) parts.push(node('div', { class: 'finder-short', text: `※ 상장한 지 얼마 안 돼서 ${res.years}년 대신 있는 만큼(${res.from}부터)만 계산했어요. 참고만 하세요.` }));
      const sim = opt.sim();  // 자세히 보기는 오늘 데이터로 계산해서, 예전에 찾은 조합이면 숫자가 조금 다를 수 있다
      if (sim && sim.to && String(sim.to).slice(0, 10) > res.to)
        parts.push(node('div', { class: 'muted', text: `※ 순위는 ${res.to}까지 데이터로 찾은 거라 아래 자세히 보기(오늘까지)와 숫자가 조금 달라요 · 🔁 다시 찾기로 맞출 수 있어요` }));
    } else if (!(running && mine)) {
      if (q.stop) parts.push(node('div', { class: 'muted', text: '손절선을 켜면 조합은 빼고 보여줘요 (조합 찾기는 손절선 없이 계산해요)' }));
      else if (!y) parts.push(node('div', { class: 'muted', text: `조합은 ${years().filter((v) => v <= ((list && list.max_years && list.max_years[q.tf]) || 8)).join('·')}년 기간에서 찾을 수 있어요` }));
      else {
        const key = `${q.market}|${q.tf}|${y}`, est = estimates[key];
        if (est === undefined) estimate(q, y, key);
        const go = button(`🔍 조합도 찾아보기${est ? ` · ${est}` : ''}`, 'small', () => start(q, y));
        go.disabled = !!running;
        parts.push(node('div', { class: 'rank-find' }, go,
          node('span', { class: 'muted', text: running ? ' 다른 계산이 끝나면 찾을 수 있어요' : ' 이 기간 단일 전략 상위 6개를 살 때·팔 때에 섞은 1,296가지 중 좋은 것만 순위에 넣어요' })));
      }
    }
    const items = (list && list.history) || [];
    if (items.length) {
      const label = (h) => `${h.saved ? '⭐ ' : ''}${h.name} ${h.tf_label} ${h.years}년 · ${String(h.computed_at || '').slice(5, 16)}`;
      const pick = node('select', { 'aria-label': '지난 조합 찾기', class: 'rank-history' },
        node('option', { value: '', text: `지난 조합 찾기 ${items.length}개 (최근 ${(list && list.recent) || 5}개 + ⭐ 저장)` }),
        ...items.map((h) => node('option', { value: h.id, text: label(h) })));
      pick.onchange = () => { const h = items.find((x) => x.id === pick.value); if (h) opt.open(h); };
      parts.push(pick);
    }
    ui.foot.replaceChildren(...parts);
  }

  function jobBox(job, mine) {
    if (!mine) return node('div', { class: 'simjob-head' }, node('span', { class: 'muted', text: `다른 계산 중 · ${job.label}` }));
    const frac = job.total ? Math.min(1, job.done / job.total) : 0;
    const spent = Date.now() / 1000 - (job.started || Date.now() / 1000);
    const rest = job.phase === 'search' && frac > 0.05
      ? (Date.now() / 1000 - job.phase_started) * (1 - frac) / frac : Math.max(0, (job.estimate_sec || 0) - spent);
    return node('div', { class: 'simjob' },
      node('div', { class: 'simjob-head' }, node('b', { text: `${job.label} · ${PHASES[job.phase] || '준비 중'}` }),
        node('span', { class: 'muted', text: [job.total ? `${job.done.toLocaleString('ko-KR')} / ${job.total.toLocaleString('ko-KR')}` : '',
          rest > 1 ? `남은 시간 약 ${dur(rest)}` : '마무리 중'].filter(Boolean).join(' · ') }), button('■ 멈춤', 'ghost small', stop)),
      node('div', { class: 'simjob-bar' }, node('i', { style: `width:${Math.max(2, frac * 100)}%` })),
      node('div', { class: 'simjob-note muted', text: '파이가 매매를 먼저 하고 남는 힘으로 계산해요. 화면을 닫아도 계속 계산하고, 끝나면 순위에 들어가요.' }));
  }

  // ---- 조합 찾기 맡기기 ----
  function estimate(q, y, key) {  // 걸리는 시간 (조금 기다렸다가 한 번)
    estimates[key] = null;
    clearTimeout(estTimer);
    estTimer = setTimeout(async () => {
      try {
        const r = await api(`/api/search?only=estimate&kind=${opt.kind}&market=${encodeURIComponent(q.market)}&tf=${q.tf}&years=${y}`);
        const e = r.estimate || {};
        estimates[key] = e.problem ? '' : `약 ${dur(e.sec)}`;
      } catch (err) { estimates[key] = ''; }
      render();
    }, 300);
  }
  async function start(q, y) {
    try {
      const r = await api('/api/search', { action: 'start', kind: opt.kind, market: q.market, tf: q.tf, years: y });
      if (!r.ok && !r.busy) toast(r.message, 'bad');
      if (r.busy) toast(r.message, 'info');
      if (list) list.job = r.job;
      render();
      poll();
    } catch (e) { /* 다음에 */ }
  }
  async function stop() {
    try { const r = await api('/api/search', { action: 'stop' }); if (list) list.job = r.job; render(); } catch (e) { /* 그대로 */ }
  }
  function poll() {  // 계산 중에는 가벼운 상태만 묻고, 끝나면 목록·결과를 다시 받는다
    if (timer) return;
    timer = setInterval(async () => {
      let job;
      try { job = (await api('/api/simjob')).job; } catch (e) { return; }
      if (list) list.job = job;
      if (job.state !== 'running') {
        clearInterval(timer); timer = null;
        await loadList();
        return;
      }
      render();
    }, 1500);
  }
  async function toggleSave(res) {
    try {
      const r = await api('/api/search', { action: res.saved ? 'unsave' : 'save', kind: opt.kind, id: res.id });
      toast(r.message, r.ok ? 'ok' : 'bad');
      if (r.ok) { res.saved = !res.saved; await loadList(); }
    } catch (e) { /* 그대로 */ }
  }

  function init(o) {
    opt = o;
    Object.assign(ui, { body: document.getElementById('ranks'), sub: document.getElementById('rankSub'), seg: document.getElementById('rankSeg'),
                        foot: document.getElementById('rankFoot'), empty: document.getElementById('ranksEmpty') });
    loadList();
  }
  return { init, render };
})();
