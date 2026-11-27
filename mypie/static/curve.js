// 계좌 카드의 수익 그래프 (코인·주식 화면 공용): 첫 매매부터 이 계좌 전략(실선) vs 그냥 들고 있었다면(점선).
// 연구 탭 그래프처럼 ▲산 곳 ▼판 곳, 들고 있던 때 색칠, 날짜·% 눈금, 대면 그때 숫자가 나온다.
// 서버 /api/curve가 실제 매매 기록과 봉 종가로 다시 그린 값을 준다. 1분 동안은 받아 둔 걸 다시 쓴다.
// curveBox(kind, slotId)는 계좌마다 같은 칸을 돌려준다. 카드를 5초마다 다시 그려도 그래프와 말풍선이 그대로 남는다.
const CURVES = {};  // 'coin:s1' → { box, at, data, loading, drawn }

function curveBox(kind, slotId) {
  const key = `${kind}:${slotId}`;
  const c = CURVES[key] = CURVES[key] || {};
  if (!c.box) {
    c.box = document.createElement('div');
    c.box.className = 'curve';
    c.box.dataset.curve = key;
    c.box.classList.add('empty'); c.box.textContent = '그래프를 불러오는 중…';
    // 칸 너비에 맞춰 그린다 (카드에 처음 붙을 때, 화면을 돌리거나 넓힐 때)
    if ('ResizeObserver' in window) new ResizeObserver(() => redrawCurve(c)).observe(c.box);
  }
  requestAnimationFrame(() => redrawCurve(c));
  if (!c.loading && (!c.at || Date.now() - c.at > 60000)) loadCurve(kind, slotId);
  return c.box;
}

async function loadCurve(kind, slotId) {
  const c = CURVES[`${kind}:${slotId}`];
  c.loading = true;
  try {
    const r = await fetch(`/api/curve?kind=${kind}&slot=${encodeURIComponent(slotId)}`, { cache: 'no-store' });
    if (r.status === 401) { location.reload(); return; }
    c.data = await r.json();
  } catch (e) { /* 받아 둔 게 있으면 그걸로 */ }
  c.at = Date.now(); c.loading = false; c.drawn = null;
  redrawCurve(c);
}

function redrawCurve(c) {  // 값이 새로 왔거나 너비가 바뀌었을 때만 다시 그린다
  const w = c.box.clientWidth;
  if (!w || !c.at) return;
  const sig = `${w}|${c.at}`;
  if (c.drawn === sig) return;
  c.drawn = sig;
  drawCurve(c.box, c.data);
}

function drawCurve(box, data) {
  box.replaceChildren();
  const pts = (data && data.points) || [], trades = (data && data.trades) || [];
  box.classList.toggle('empty', pts.length < 2);
  if (pts.length < 2) { box.textContent = '📈 첫 매매부터 수익 그래프를 그려요'; return; }
  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; return e; };
  const div = (cls, text) => { const d = document.createElement('div'); if (cls) d.className = cls; if (text != null) d.textContent = text; return d; };
  const span = (cls, text) => { const s = document.createElement('span'); s.className = cls; s.textContent = text; return s; };
  const pct = (v) => (v > 0 ? '+' : '') + v.toFixed(1) + '%';
  const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  const price = (v) => (v >= 100 ? Math.round(v).toLocaleString('ko-KR') : v.toLocaleString('ko-KR', { maximumSignificantDigits: 4 })) + '원';
  const time = (s) => new Date(s.replace(' ', 'T') + '+09:00').getTime();

  // 크기와 눈금: 칸 너비 그대로 (글자가 찌그러지지 않게)
  const W = Math.max(240, box.clientWidth - 24), H = W < 420 ? 150 : 170, padL = 6, padR = 46, padT = 8, xlab = 18;  // 왼쪽 끝 ▲가 잘리지 않게
  const plotW = W - padR, plotH = H - padT - xlab;
  const t0 = time(pts[0][0]), t1 = time(pts[pts.length - 1][0]);
  const x = (s) => padL + Math.max(0, Math.min(1, (time(s) - t0) / (t1 - t0 || 1))) * (plotW - padL);
  let lo = 0, hi = 0;
  for (const p of pts) { lo = Math.min(lo, p[1], p[2]); hi = Math.max(hi, p[1], p[2]); }
  const top = hi, bottom = lo, pad = (hi - lo) * 0.1 || 1;
  lo -= pad; hi += pad;
  const y = (v) => padT + (hi - v) / (hi - lo) * plotH;
  const last = pts[pts.length - 1];
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img',
                          'aria-label': `첫 매매부터 전략 ${last[1].toFixed(1)}%, 그냥 들고 있었다면 ${last[2].toFixed(1)}%` });
  const label = (text, xx, yy, attrs = {}) => svg.append(mk('text', { x: xx, y: yy, 'font-size': 11, fill: 'var(--muted)', ...attrs }, text));

  // 들고 있던 때 색칠 (산 때부터 판 때까지, 처음이 매도면 그 전부터 들고 있었다)
  let from = trades.length && trades[0][1] === 'sell' ? pts[0][0] : null;
  const spans = [];
  for (const [ts, side] of trades) { if (side === 'buy') from = ts; else if (from != null) { spans.push([from, ts]); from = null; } }
  if (from != null) spans.push([from, last[0]]);
  for (const [a, b] of spans) svg.append(mk('rect', { x: x(a), y: padT, width: Math.max(2, x(b) - x(a)), height: plotH, fill: 'var(--brand)', opacity: .1 }));

  // % 눈금: 0%(점선)와 가장 높을 때·낮을 때. 0%와 겹치는 글자는 뺀다
  for (const v of [0, top, bottom]) {
    if (v !== 0 && Math.abs(y(v) - y(0)) < 4) continue;  // 0% 줄과 거의 같은 줄은 안 긋는다
    svg.append(mk('line', { x1: 0, x2: plotW, y1: y(v), y2: y(v), stroke: 'var(--line)', 'stroke-dasharray': v === 0 ? '4 4' : '' }));
    if (v === 0 || Math.abs(y(v) - y(0)) >= 13) label(v === 0 ? '0%' : (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) < 10 ? 1 : 0) + '%', plotW + 6, y(v) + 4);
  }
  const line = (i) => pts.map((p) => `${x(p[0]).toFixed(1)},${y(p[i]).toFixed(1)}`).join(' ');
  svg.append(mk('polyline', { points: line(2), class: 'curve-hold' }));
  svg.append(mk('polyline', { points: line(1), class: 'curve-strat' }));

  // ▲산 곳 ▼판 곳: 전략 선 위에 (그 시각의 전략 값으로)
  const stratAt = (ts) => {
    const t = time(ts);
    let k = pts.findIndex((p) => time(p[0]) >= t);
    if (k <= 0) return k === 0 ? pts[0][1] : last[1];
    const [a, b] = [pts[k - 1], pts[k]], ta = time(a[0]), tb = time(b[0]);
    return a[1] + (b[1] - a[1]) * ((t - ta) / (tb - ta || 1));
  };
  const s = trades.length > 60 ? 3.5 : 5;  // 매매가 아주 많으면 작게
  for (const [ts, side] of trades) {
    const cx = x(ts), buy = side === 'buy', yy = y(stratAt(ts)) + (buy ? s + 4 : -(s + 4));
    const tri = buy ? `${cx},${yy - s} ${cx - s},${yy + s} ${cx + s},${yy + s}` : `${cx},${yy + s} ${cx - s},${yy - s} ${cx + s},${yy - s}`;
    svg.append(mk('polygon', { points: tri, fill: buy ? 'var(--up)' : 'var(--down)', stroke: 'var(--soft)', 'stroke-width': 1 }));
  }

  // 아래 날짜: 해가 바뀌면 연도까지, 이틀이 넘으면 시각은 빼고
  const years = pts[0][0].slice(0, 4) !== last[0].slice(0, 4), long = t1 - t0 > 2 * 86400e3;
  const dateText = (ms) => {
    const k = new Date(ms + 9 * 3600e3).toISOString();
    return long ? k.slice(years ? 0 : 5, 10) : `${k.slice(years ? 0 : 5, 10)} ${k.slice(11, 16)}`;
  };
  const ticks = W < 420 ? 2 : 4;
  for (let k = 0; k <= ticks; k++)
    label(dateText(t0 + (t1 - t0) * k / ticks), k === 0 ? 0 : padL + (plotW - padL) * k / ticks, H - 4, { 'text-anchor': k === 0 ? 'start' : k === ticks ? 'end' : 'middle' });

  // 대면 그때 값 (손가락으로 대고 밀어도)
  const cross = mk('line', { x1: 0, x2: 0, y1: padT, y2: padT + plotH, stroke: 'var(--muted)', 'stroke-dasharray': '3 3', opacity: 0 });
  svg.append(cross);
  const tip = div('tip'); tip.hidden = true;
  const show = (ev) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const mx = (ev.clientX - rect.left) * W / rect.width;
    let i = 0;
    for (let k = 1; k < pts.length; k++) if (Math.abs(x(pts[k][0]) - mx) < Math.abs(x(pts[i][0]) - mx)) i = k;
    const p = pts[i], prev = i ? pts[i - 1][0] : '';
    cross.setAttribute('x1', x(p[0])); cross.setAttribute('x2', x(p[0])); cross.setAttribute('opacity', .7);
    const when = document.createElement('b'); when.textContent = p[0].slice(0, 16);
    tip.replaceChildren(when, div('', `가격 ${price(p[3])}`), div('', `이 전략 ${pct(p[1])}`), div('', `그냥 들고 있기 ${pct(p[2])}`));
    const here = trades.filter(([ts]) => ts > prev && ts <= p[0]);  // 앞 점과 이 점 사이에 한 매매
    for (const [ts, side, at] of here.slice(0, 4)) tip.append(div(side === 'buy' ? 'up' : 'down', `${side === 'buy' ? '▲ 삼' : '▼ 팜'} ${price(at)} · ${ts.slice(5, 16)}`));
    if (here.length > 4) tip.append(div('', `… 외 ${here.length - 4}번`));
    tip.hidden = false;
    const px = x(p[0]) * rect.width / W;
    tip.style.top = '4px';
    tip.style.left = Math.max(0, Math.min(px + 12, rect.width - tip.offsetWidth)) + 'px';
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('opacity', 0); });

  // 머리: 언제부터 + 지금 숫자, 아래: 그림 읽는 법
  const head = div('curve-head'), legend = span('curve-legend', '');
  const strat = span('c-strat', '━ 전략 '), hold = span('c-hold', '┅ 들고만 있었다면 ');
  strat.append(span('num ' + tone(last[1]), pct(last[1])));
  hold.append(span('num ' + tone(last[2]), pct(last[2])));
  legend.append(strat, hold);
  head.append(span('', `📈 첫 매매(${pts[0][0].slice(0, 10)})부터`), legend);
  const chart = div('curve-chart'); chart.append(svg, tip);
  box.append(head, chart, div('curve-foot', `▲ 산 곳 ▼ 판 곳 · 색칠한 곳은 들고 있던 때 · ${trades.length}번 매매`));
}
