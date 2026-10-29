// 긴 기간 전략 시뮬레이션: 파이가 따로 계산하는 동안 진행률·남은 시간·멈춤을 보여준다 (코인·주식 화면 공용)
// SimJob.show(상자, /api/simulate의 답, {kind, query, onDone}) · SimJob.hide(상자)
const SimJob = (() => {
  const AUTO_START_SEC = 60;  // 이보다 짧게 걸리면 묻지 않고 바로 계산한다
  let timer = null, cur = null;

  const node = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v; else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  const dur = (sec) => {
    sec = Math.max(1, Math.round(sec));
    return sec >= 3600 ? `${Math.floor(sec / 3600)}시간 ${Math.round(sec % 3600 / 60)}분`
      : sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60 ? (sec % 60) + '초' : ''}`.trim() : `${sec}초`;
  };
  const num = (n) => Math.round(n).toLocaleString('ko-KR');

  async function api(body) {
    const r = await fetch('/api/simjob', body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' });
    if (r.status === 401) { location.reload(); throw new Error('login'); }
    return r.json();
  }

  function left(job) {  // 남은 시간: 지금까지의 속도로. 처음 몇 %는 미리 잰 값으로
    const frac = job.total ? job.done / job.total : 0;
    if (job.phase === 'data') return (job.total - job.done) / 200 * 0.45;
    const spent = Date.now() / 1000 - (job.phase_started || job.started || Date.now() / 1000);
    return frac > 0.03 ? spent * (1 - frac) / frac : null;
  }

  function draw(job) {
    if (!cur) return;
    const { box, r } = cur;
    const mine = job && job.id === r.job_id;
    box.hidden = false;
    box.replaceChildren();
    if (job && job.state === 'running') {
      const frac = job.total ? Math.min(1, job.done / job.total) : 0;
      const what = !mine ? `다른 계산 중 · ${job.label}`
        : job.phase === 'data' ? '과거 봉을 받는 중' : job.phase === 'calc' ? '전략 계산 중' : '계산 준비 중';
      const rest = left(job);
      const detail = job.phase === 'data' ? `${num(job.done)} / ${num(job.total)}봉`
        : job.phase === 'calc' ? `${Math.floor(frac * 100)}%` : '';
      const stopBtn = node('button', { type: 'button', class: 'ghost small', text: '■ 멈춤' });
      stopBtn.onclick = stop;
      box.append(
        node('div', { class: 'simjob-head' }, node('b', { text: what }),
          node('span', { class: 'muted', text: [detail, rest != null ? `남은 시간 약 ${dur(rest)}` : ''].filter(Boolean).join(' · ') }),
          stopBtn),
        node('div', { class: 'simjob-bar' }, node('i', { style: `width:${Math.max(2, frac * 100)}%` })),
        node('div', { class: 'simjob-note muted', text: mine
          ? '파이가 매매를 먼저 하고 남는 힘으로 계산해요. 이 화면을 닫아도 계속 계산하고, 끝나면 결과를 하루 동안 저장해 둬요.'
          : '한 번에 하나씩 계산해요. 끝나거나 멈추면 이 기간을 계산할 수 있어요.' }));
      return;
    }
    const startBtn = node('button', { type: 'button', class: 'primary small', text: mine && job.state !== 'done' ? '다시 시작' : '계산 시작' });
    startBtn.onclick = start;
    const msg = mine && (job.state === 'stopped' || job.state === 'error') ? job.message
      : `이 기간은 파이가 따로 계산해요 · 약 ${dur(r.estimate_sec || 1)}` + (r.fetch_bars ? ` (과거 봉 ${num(r.fetch_bars)}개를 먼저 받아요)` : '');
    box.append(node('div', { class: 'simjob-head' }, node('span', { text: msg }), startBtn));
  }

  async function start() {
    if (!cur) return;
    try {
      const res = await api({ action: 'start', kind: cur.kind, query: cur.query });
      draw(res.job);
      if (res.job && res.job.state === 'running') poll();
    } catch (e) { /* 다음 새로고침 때 다시 */ }
  }
  async function stop() {
    try { draw((await api({ action: 'stop' })).job); poll(); } catch (e) { /* 그대로 */ }
  }
  function poll() {
    if (timer) return;
    timer = setInterval(async () => {
      let job;
      try { job = (await api()).job; } catch (e) { return; }
      draw(job);
      if (job.state !== 'running') {
        clearInterval(timer); timer = null;
        if (cur && job.state === 'done' && job.id === cur.r.job_id) cur.onDone();
      }
    }, 1500);
  }

  function show(box, r, opts) {
    const same = cur && cur.r.job_id === r.job_id && cur.box === box;
    cur = { box, r, ...opts };
    const job = r.job;
    draw(job);
    if (job && job.state === 'running') poll();
    else if (!same && !(job && job.id === r.job_id && job.state === 'stopped') && (r.estimate_sec || 0) <= AUTO_START_SEC) start();
  }
  function hide(box) {
    if (cur && cur.box === box) cur = null;
    box.hidden = true;
    box.replaceChildren();
    if (timer) { clearInterval(timer); timer = null; }
  }
  return { show, hide };
})();
