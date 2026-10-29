// 라즈베리파이 상태 카드 (코인·주식 화면 공용): <section class="card" id="system"></section> 안을 채운다
// 온도·메모리·저장공간·전력은 15초마다, 맨 아래 코어별 CPU 이용률(최근 60초)은 2초마다 새로 고친다
(() => {
  const box = document.getElementById('system');
  if (!box) return;
  box.innerHTML = `
    <h2><span class="ico">🍓</span>라즈베리파이 <small id="sysSub"></small></h2>
    <div class="sys">
      <div class="tile"><div class="label">CPU 온도</div><div class="v num" id="sysTemp">-</div><div class="meter"><i id="sysTempBar"></i></div></div>
      <div class="tile"><div class="label">메모리</div><div class="v num" id="sysMem">-</div><div class="meter"><i id="sysMemBar"></i></div></div>
      <div class="tile"><div class="label">저장공간</div><div class="v num" id="sysDisk">-</div><div class="meter"><i id="sysDiskBar"></i></div></div>
      <div class="tile power" id="sysPowerTile" title="전력 센서가 없는 모델은 CPU 사용량으로 어림한 값이에요"><div class="label" id="sysPowerLabel">전력 (추정)</div>
        <div class="v num" id="sysPower">-</div><div class="sub" id="sysPowerSub"></div><div class="meter"><i id="sysPowerBar"></i></div></div>
    </div>
    <div class="desc" id="sysFoot"></div>
    <div class="cores">
      <div class="cores-head"><b>CPU</b><span class="muted" id="coresModel"></span><span class="muted cores-note">60초 간 이용률(%) · 위 끝 100%</span></div>
      <div class="cores-grid" id="coresGrid"><div class="muted">재는 중…</div></div>
    </div>`;
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';

  function meter(id, ratio, warnAt = .75, badAt = .9) {
    const bar = $(id);
    bar.style.width = Math.max(2, Math.min(100, ratio * 100)) + '%';
    bar.style.background = ratio >= badAt ? 'var(--bad)' : ratio >= warnAt ? 'var(--warn)' : 'var(--ok)';
  }

  function render(x) {
    if (x.temp_c != null) { $('sysTemp').textContent = x.temp_c.toFixed(1) + '°C'; meter('sysTempBar', x.temp_c / 85, 60 / 85, 75 / 85); }
    if (x.mem_total_mb) { $('sysMem').textContent = `${x.mem_used_mb} / ${x.mem_total_mb}MB`; meter('sysMemBar', x.mem_used_mb / x.mem_total_mb); }
    if (x.disk_total_gb) { $('sysDisk').textContent = `${x.disk_used_gb.toFixed(1)} / ${x.disk_total_gb.toFixed(0)}GB`; meter('sysDiskBar', x.disk_used_gb / x.disk_total_gb); }
    if (x.power_w != null) {  // 막대 끝 = 권장 어댑터. 색은 전압 상태 (W가 작아도 전압이 모자라면 빨강)
      const rec = x.power_w_recommended, amps = x.power_a_recommended || rec / 5;
      $('sysPowerLabel').textContent = x.power_measured ? '전력 (실측)' : '전력 (추정)';
      $('sysPowerTile').title = x.power_measured ? '전원 칩이 잰 보드 전력이에요 (USB에 꽂은 기기 몫은 빠져요)'
                                                 : '전력 센서가 없는 모델이라 CPU 사용량으로 어림한 값이에요';
      $('sysPower').textContent = `${x.power_measured ? '' : '약 '}${x.power_w.toFixed(1)}W`;
      $('sysPowerSub').textContent = `권장 어댑터 ${rec}W (5V ${amps}A)` + (x.undervoltage_now ? ' · 지금 전압 부족' : '');
      meter('sysPowerBar', x.power_w / rec);
      $('sysPowerBar').style.background = x.undervoltage_now ? 'var(--bad)' : x.undervoltage_ever ? 'var(--warn)' : 'var(--ok)';
    }
    const up = x.uptime_sec;
    $('sysSub').textContent = up != null ? `켜진 지 ${up >= 86400 ? Math.floor(up / 86400) + '일 ' : ''}${Math.floor(up % 86400 / 3600)}시간 ${Math.floor(up % 3600 / 60)}분` : '';
    const notes = [];
    if (x.undervoltage_now) notes.push('⚠️ 지금 전원 전압이 부족해요! 5V 2.5A 이상 어댑터와 짧고 굵은 케이블을 쓰세요' + (x.throttled_now ? ' (그래서 CPU 속도도 낮춰진 상태예요)' : ''));
    else if (x.undervoltage_ever) notes.push('⚡ 켜진 뒤로 전압 부족이 있었어요. 어댑터·케이블을 확인해 보세요');
    else if (x.undervoltage_now === false) notes.push('⚡ 전원 정상');
    if (x.temp_limit_now) notes.push('🔥 온도가 높아서 속도를 낮추는 중이에요. 통풍을 확인하세요');
    if (x.db_mb != null) notes.push(`💾 기록 DB ${x.db_mb.toFixed(1)}MB`);
    $('sysFoot').textContent = notes.join(' · ');
  }

  // ---- 코어별 CPU 이용률 (윈도 작업 관리자처럼 코어마다 작은 그래프, 오른쪽 끝이 지금) ----
  const W = 120, H = 50;
  function svg(tag, attrs) {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    return e;
  }
  function coreChart(values, seconds) {
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img' });
    for (let p = 1; p < 4; p++) s.append(svg('line', { x1: 0, x2: W, y1: H * p / 4, y2: H * p / 4, class: 'grid' }));
    for (let t = 1; t < 4; t++) s.append(svg('line', { x1: W * t / 4, x2: W * t / 4, y1: 0, y2: H, class: 'grid' }));
    if (values.length > 1) {
      const step = W / (seconds - 1), x0 = W - (values.length - 1) * step;
      const pts = values.map((v, i) => `${(x0 + i * step).toFixed(2)},${(H - Math.max(0, Math.min(100, v)) / 100 * H).toFixed(2)}`);
      s.append(svg('path', { d: `M${x0.toFixed(2)},${H} L${pts.join(' L')} L${W},${H} Z`, class: 'area' }));
      s.append(svg('polyline', { points: pts.join(' '), class: 'line' }));
    }
    return s;
  }
  function renderCores(c) {
    const grid = $('coresGrid');
    const usage = c.usage || [];
    const now = usage.map((u) => (u.length ? u[u.length - 1] : 0));
    const avg = now.length ? now.reduce((a, b) => a + b, 0) / now.length : null;
    $('coresModel').textContent = [c.model, c.cores ? `코어 ${c.cores}개` : '', avg != null ? `지금 평균 ${Math.round(avg)}%` : ''].filter(Boolean).join(' · ');
    if (!usage.length) {
      grid.replaceChildren(Object.assign(document.createElement('div'), { className: 'muted', textContent: '재는 중…' }));
      return;
    }
    grid.replaceChildren(...usage.map((u, i) => {
      const card = document.createElement('div');
      card.className = 'core';
      const top = document.createElement('div');
      top.className = 'core-top';
      top.append(Object.assign(document.createElement('span'), { textContent: `코어 ${i + 1}` }),
                 Object.assign(document.createElement('b'), { className: 'num', textContent: `${Math.round(now[i])}%` }));
      card.append(top, coreChart(u, c.seconds || 60));
      return card;
    }));
  }

  async function refresh() {
    try {
      const r = await fetch('/api/system', { cache: 'no-store' });
      if (r.ok) render(await r.json());  // 로그인이 풀린 건 화면 쪽 새로고침이 처리한다
    } catch (e) {}
  }
  async function refreshCores() {
    if (document.visibilityState !== 'visible') return;  // 안 보고 있으면 묻지 않는다 (파이는 5분 뒤 재기를 쉰다)
    try {
      const r = await fetch('/api/cpu', { cache: 'no-store' });
      if (r.ok) renderCores(await r.json());
    } catch (e) {}
  }
  refresh();
  refreshCores();
  setInterval(refresh, 15000);
  setInterval(refreshCores, 2000);
})();
