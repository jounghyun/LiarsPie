// ⚙️ 설정 (코인·주식 화면 공용): 위쪽 톱니바퀴를 누르면 열린다
//   ✈️ 텔레그램 — 봇 하나를 코인·주식이 같이 쓴다 (로그인 코드·알림)
//   🪙 코인 계좌 / 📈 주식 계좌 — 모의투자 ↔ 실거래는 따로따로 바꾼다 (PIN)
//     🔑 키 넣기 — 업비트·토스증권 API 키. 연결해 보고 되면 파이에만 저장한다 (집 와이파이에서만, PIN)
//   🔒 PIN — 코인·주식 공통. 처음에는 기본 PIN 0000이라 바꾸라고 알려 준다 (톱니바퀴에도 빨간 점)
// 열려 있는 동안 5초마다 두 봇의 상태를 새로 받는다. 위쪽 로그아웃 버튼은 로그인 코드를 켰을 때만 보인다.
(() => {
  const gear = document.getElementById('gear');
  if (!gear) return;
  const ACCOUNTS = {
    coin: { title: '🪙 코인 계좌', name: '코인 계좌', status: '/api/status', control: '/api/control', broker: '업비트',
            hint: '실거래는 업비트 계좌 전체를 써요. 원화는 금고로 들어오고, 코인 계좌로 옮긴 만큼만 사고팔아요. 봇이 모르는 코인은 그 코인의 바이앤홀드 계좌로 모아요.',
            keyless: '🔑 키 없음 · 아래 🔑 키 넣기에서 넣어요',
            keys: { broker: 'upbit', fields: [['access', 'Access Key'], ['secret', 'Secret Key']],
                    steps: (b, ip) => [['PC에서 ', b('업비트 웹 → 마이페이지 → Open API 관리'), '로 들어가요.'],
                                       ['권한은 ', b('자산조회 · 주문조회 · 주문하기'), '만 체크해요. ', b('출금은 절대 체크하지 마세요.')],
                                       ['허용 IP에 집 공인 IP ', ip, '를 넣어요.'],
                                       ['받은 Access Key와 Secret Key를 붙여넣고 PIN을 넣은 뒤 ', b('연결해 보고 저장'), '을 눌러요. 키는 1년이 지나면 만료돼서 그때 새로 넣어요.']] },
            toLive: '⚠️ 업비트 계좌에 실제 주문이 나가요. 계좌 원화는 실거래 금고로 들어와요.',
            toPaper: '실거래 코인은 팔지 않고 그대로 둬요.' },
    stock: { title: '📈 주식 계좌', name: '주식 계좌', status: '/api/stock/status', control: '/api/stock/control', broker: '토스증권',
             hint: '실거래는 토스증권 계좌를 써요. 현금은 금고로 들어오고, 종목 계좌로 옮긴 만큼만 사고팔아요.',
             keyless: '🔑 키 없음 · 아래 🔑 키 넣기에서 넣어요',
             keys: { broker: 'toss', fields: [['client_id', 'Client ID'], ['secret', 'Client Secret']],
                     steps: (b, ip) => [['PC에서 ', b('토스증권 웹(WTS) → 설정 → Open API'), '에서 Client ID · Client Secret을 발급받아요.'],
                                        ['같은 화면 ', b('허용 IP 관리'), '에 집 공인 IP ', ip, '를 등록해요.'],
                                        ['토스증권 앱에서 ', b('투자자지시 거래소'), '를 ', b('통합'), '(SOR)으로 해 둬요. 아니면 주문이 거절돼요.'],
                                        ['두 값을 붙여넣고 PIN을 넣은 뒤 ', b('연결해 보고 저장'), '을 눌러요. 계좌가 여러 개면 고르는 칸이 나와요.']] },
             toLive: '⚠️ 토스증권 계좌에 실제 주문이 나가요. 계좌 현금은 실거래 금고로 들어와요.',
             toPaper: '실거래 주식은 팔지 않고 그대로 둬요.' },
  };
  const st = { data: {}, pick: {}, mine: {}, timer: null, linking: false, keyShown: {} };

  const node = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v; else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  const pinInput = () => node('input', { type: 'password', inputmode: 'numeric', placeholder: 'PIN', autocomplete: 'off', maxlength: '32', 'aria-label': 'PIN' });
  const say = (text, kind) => { if (window.toast) window.toast(text, kind); };
  async function post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (r.status === 401) { location.reload(); throw new Error('login'); }
    return r.json();
  }

  // ---- 틀 ----
  const back = node('div', { class: 'settings-back', hidden: '' });
  const panel = node('div', { class: 'settings-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'setTitle' });
  const closeBtn = node('button', { type: 'button', class: 'ghost small', text: '닫기 ✕' });
  panel.append(node('div', { class: 'settings-head' }, node('h2', { id: 'setTitle', text: '⚙️ 설정' }), closeBtn));
  back.append(panel);
  document.body.append(back);

  // ---- 텔레그램 ----
  const tg = {};
  tg.chip = node('span', { class: 'chip', text: '-' });
  tg.open = node('a', { class: 'tg-open', target: '_blank', rel: 'noopener', hidden: '' });
  tg.token = node('input', { type: 'password', placeholder: '봇 토큰 (123456789:ABC…)', autocomplete: 'off', style: 'flex:1 1 220px;width:auto' });
  tg.pinA = pinInput();
  tg.start = node('button', { type: 'button', class: 'primary', text: '연결 시작' });
  tg.off = node('div', {},
    node('ol', { class: 'steps' },
      node('li', {}, '텔레그램 앱에서 ', node('b', { text: '@BotFather' }), '를 찾아 ', node('code', { text: '/newbot' }), '을 보내요. 봇 이름과 아이디(끝이 ', node('code', { text: 'bot' }), ')를 정하면 ', node('b', { text: '봇 토큰' }), '을 줘요.'),
      node('li', {}, '그 토큰을 아래에 붙여넣고 PIN을 넣은 뒤 ', node('b', { text: '연결 시작' }), '을 눌러요.'),
      node('li', {}, '화면에 나오는 내 봇을 텔레그램에서 찾아 ', node('b', { text: '아무 메시지나' }), ' 보내면 자동으로 연결돼요.')),
    node('div', { class: 'field' }, tg.token, tg.pinA, tg.start),
    node('p', { class: 'desc', text: '연결하기 전에는 로그인 코드를 묻지 않고 바로 열려요. 같은 공유기 안에서만 쓰세요.' }));
  tg.notify = node('input', { type: 'checkbox' });
  tg.login = node('input', { type: 'checkbox' });
  tg.digits = node('select', { 'aria-label': '로그인 코드 자릿수' });
  for (let n = 2; n <= 8; n++) tg.digits.append(node('option', { value: String(n), text: `${n}자리` + (n === 2 ? ' (기본)' : '') }));
  tg.pinB = pinInput();
  tg.test = node('button', { type: 'button', text: '테스트 메시지' });
  tg.unlink = node('button', { type: 'button', class: 'ghost', text: '연결 끊기' });
  tg.on = node('div', { hidden: '' },
    node('div', { class: 'field', style: 'gap:8px 18px' },
      node('label', { class: 'toggle' }, tg.notify, ' 🔔 매매 체결·오류 알림 받기 (코인·주식)'),
      node('label', { class: 'toggle' }, tg.login, ' 🔐 웹페이지에 들어올 때 로그인 코드 요구'),
      node('label', { class: 'toggle' }, '🔢 로그인 코드 ', tg.digits)),
    node('div', { class: 'field', style: 'margin-top:10px' }, tg.pinB, tg.test, tg.unlink),
    node('p', { class: 'desc', text: '스위치·자릿수를 바꾸거나 버튼을 누르려면 PIN을 먼저 넣으세요. 로그인한 기기와 IP는 24시간 동안 다시 묻지 않아요. '
                                     + '로그인 코드는 자릿수가 많을수록 다른 사람이 찍어서 맞히기 어려워요.' }));
  tg.msg = node('p', { class: 'msg' });
  panel.append(node('section', { class: 'set-sec', id: 'setTelegram' },
    node('h3', {}, '✈️ 텔레그램 ', node('small', { text: '코인·주식이 같이 써요 · 로그인 코드 · 매매 알림' }), tg.chip),
    tg.open, tg.off, tg.on, tg.msg));

  const tgSay = (text, kind) => { tg.msg.textContent = text; tg.msg.className = 'msg ' + (kind || ''); };
  function renderTelegram() {
    const d = st.data.coin;
    const t = (d && d.telegram) || { connected: false };
    tg.off.hidden = !!t.connected;
    tg.on.hidden = !t.connected;
    tg.chip.textContent = t.connected ? `✅ @${t.bot || '내 봇'} 연결됨` : t.linking ? `⏳ @${t.linking} 에게 메시지 기다리는 중` : '연결 안 됨';
    if (t.linking && !st.linking) pollLink(Date.now());  // 새로고침해도 기다리던 연결을 이어서 확인
    tg.open.hidden = !t.linking || t.connected;  // 봇은 먼저 말을 걸 수 없어서, 내가 봇 대화창에서 [시작]을 한 번 눌러야 한다
    if (t.linking) { tg.open.href = `https://t.me/${t.linking}`; tg.open.textContent = `📲 텔레그램에서 @${t.linking} 열고 [시작] 누르기`; }
    if (t.connected && ![tg.notify, tg.login, tg.digits].includes(document.activeElement)) {
      tg.notify.checked = !!t.notify;
      tg.login.checked = !!t.login;
      tg.digits.value = String(t.digits || 2);
    }
    const logout = document.getElementById('logout');
    if (logout) logout.hidden = !(t.connected && t.login);
  }
  tg.start.onclick = async () => {
    const token = tg.token.value.trim(), pin = tg.pinA.value;
    if (!token || !pin) { tgSay('봇 토큰과 PIN을 넣어 주세요.', 'bad'); return; }
    tg.start.disabled = true;
    try {
      const r = await post('/api/telegram/start', { token, pin });
      tgSay(r.message, r.ok ? 'info' : 'bad');
      if (r.ok) { tg.token.value = ''; tg.pinA.value = ''; pollLink(Date.now()); }
    } catch (e) { tgSay('요청을 보내지 못했어요.', 'bad'); }
    finally { tg.start.disabled = false; }
  };
  async function pollLink(started) {
    st.linking = true;
    if (Date.now() - started > 900000) { st.linking = false; tgSay('시간이 지났어요. 다시 연결 시작을 눌러 주세요.', 'bad'); return; }
    try {
      const r = await post('/api/telegram/link', {});
      if (!r.ok) { st.linking = false; tgSay(r.message, 'bad'); return; }
      if (r.linked) { st.linking = false; tgSay('🎉 ' + r.message, 'ok'); say('✈️ 텔레그램 연결 완료!', 'info'); refresh(); return; }
      tgSay(r.message, 'info');
    } catch (e) { /* 다음에 다시 */ }
    setTimeout(() => pollLink(started), 3000);
  }
  async function tgAction(action, value) {
    if (tg.on.contains(document.activeElement)) document.activeElement.blur();  // 결과(또는 원래 값)를 다시 그리게
    const pin = tg.pinB.value;
    if (!pin) { tgSay('PIN을 먼저 넣어 주세요.', 'bad'); refresh(); return; }
    try {
      const r = await post('/api/telegram/action', { action, value, pin });
      tgSay(r.message, r.ok ? 'ok' : 'bad');
    } catch (e) { tgSay('요청을 보내지 못했어요.', 'bad'); }
    refresh();
  }
  tg.notify.onchange = () => tgAction('notify', tg.notify.checked);
  tg.digits.onchange = () => tgAction('digits', Number(tg.digits.value));
  tg.login.onchange = () => {
    if (!tg.login.checked && !confirm('로그인 코드를 끄면 같은 공유기에 있는 누구나 이 화면을 볼 수 있어요. 끌까요?')) { tg.login.checked = true; return; }
    tgAction('login', tg.login.checked);
  };
  tg.test.onclick = () => tgAction('test');
  tg.unlink.onclick = () => { if (confirm('텔레그램 연결을 끊을까요? 로그인 코드와 매매 알림이 멈춰요.')) tgAction('off'); };

  // ---- 코인 계좌 · 주식 계좌 (모의투자 ↔ 실거래) ----
  const ui = {};
  for (const [kind, a] of Object.entries(ACCOUNTS)) {
    const u = ui[kind] = {};
    u.chip = node('span', { class: 'chip', text: '-' });
    u.paper = node('button', { type: 'button', 'aria-pressed': 'false', text: '모의투자' });
    u.live = node('button', { type: 'button', 'aria-pressed': 'false', text: '실거래' });
    u.key = node('span', { class: 'hint' });
    u.confirm = node('input', { type: 'checkbox' });
    u.confirmRow = node('label', { class: 'check', hidden: '' }, u.confirm, ' 실제 돈으로 주문이 나간다는 걸 이해했어요');
    u.pin = pinInput();
    u.go = node('button', { type: 'button', class: 'primary', disabled: '', text: '계좌 바꾸기' });
    u.msg = node('p', { class: 'msg' });
    // 🔑 키 넣기 · 바꾸기: 넣은 키는 다시 화면에 보이지 않는다
    const k = a.keys, b = (text) => node('b', { text });
    u.ip = node('b', { text: '-' });
    u.keyInputs = k.fields.map(([name, label]) => node('input', { type: 'password', placeholder: label, autocomplete: 'off',
      spellcheck: 'false', 'aria-label': label, 'data-name': name, style: 'flex:1 1 200px;width:auto' }));
    u.account = node('select', { 'aria-label': '쓸 계좌', hidden: '' });
    u.keyPin = pinInput();
    u.keySave = node('button', { type: 'button', class: 'primary', text: '연결해 보고 저장' });
    u.keyMsg = node('p', { class: 'msg' });
    u.keyBox = node('details', { class: 'keys' }, node('summary', { text: `🔑 ${a.broker} 키 넣기 · 바꾸기` }),
      node('ol', { class: 'steps' }, ...k.steps(b, u.ip).map((kids) => node('li', {}, ...kids))),
      node('div', { class: 'field' }, ...u.keyInputs, u.account, u.keyPin, u.keySave),
      node('p', { class: 'hint', text: '키는 파이에만 저장되고 화면에 다시 보이지 않아요. 이 화면은 https가 아니라서 집 와이파이에서만 넣을 수 있어요. '
                                       + '넣으면 텔레그램으로 알려 줘요.' }),
      u.keyMsg);
    panel.append(node('section', { class: 'set-sec', id: kind === 'coin' ? 'setCoin' : 'setStock' },
      node('h3', {}, a.title + ' ', node('small', { text: '모의투자와 실거래는 금고·계좌를 따로 써요 · 바꿔도 아무것도 팔지 않아요' }), u.chip),
      node('div', { class: 'field' }, node('div', { class: 'seg big', role: 'group', 'aria-label': a.title }, u.paper, u.live), u.key),
      node('p', { class: 'hint', text: a.hint }), u.confirmRow, node('div', { class: 'actions' }, u.pin, u.go), u.msg, u.keyBox));
    const keySay = (text, cls) => { u.keyMsg.textContent = text; u.keyMsg.className = 'msg ' + (cls || ''); };
    u.keySave.onclick = async () => {
      const body = { broker: k.broker, pin: u.keyPin.value };
      for (const i of u.keyInputs) body[i.dataset.name] = i.value.trim();
      if (u.keyInputs.some((i) => !i.value.trim())) { keySay('두 칸을 다 넣어 주세요.', 'bad'); return; }
      if (!body.pin) { keySay('PIN을 넣어 주세요.', 'bad'); u.keyPin.focus(); return; }
      if (!u.account.hidden) body.account = u.account.value;
      u.keySave.disabled = true;
      keySay(`${a.broker}에 연결해 보는 중…`, 'info');
      try {
        const r = await post('/api/keys', body);
        if (r.choose) {  // 계좌가 여러 개: 고르고 다시 누른다
          u.account.replaceChildren(...r.choose.map((c) => node('option', { value: c.seq, text: c.label })));
          u.account.hidden = false;
        }
        keySay(r.message, r.ok ? 'ok' : r.choose ? 'info' : 'bad');
        if (r.ok) {
          for (const i of u.keyInputs) i.value = '';
          u.keyPin.value = '';
          u.account.hidden = true;
          say(`🔑 ${a.broker} 키를 저장했어요`, 'ok');
          refresh();
        }
      } catch (e) { keySay('요청을 보내지 못했어요.', 'bad'); }
      finally { u.keySave.disabled = false; }
    };
    u.paper.onclick = () => { st.pick[kind] = 'paper'; renderAccount(kind); };
    u.live.onclick = () => { st.pick[kind] = 'live'; renderAccount(kind); };
    u.go.onclick = async () => {
      const d = st.data[kind], now = d && d.status && d.status.mode, want = st.pick[kind];
      if (!now || !want || want === now) return;
      if (want === 'live' && !u.confirm.checked) { say("'실제 돈으로 주문이 나간다'에 체크해 주세요", 'bad'); return; }
      if (!u.pin.value) { say('PIN을 넣어 주세요', 'bad'); u.pin.focus(); return; }
      if (!confirm(`${a.name}를 ${want === 'live' ? '실거래' : '모의투자'}로 바꿀까요?\n\n${want === 'live' ? a.toLive : a.toPaper}`)) return;
      try {
        const r = await post(a.control, { action: 'mode', mode: want, confirm_live: u.confirm.checked, pin: u.pin.value });
        if (!r.ok) { say(r.message, 'bad'); return; }
        (st.mine[kind] = st.mine[kind] || {})[r.id] = true;
        say('⏳ ' + r.message, 'info');
        u.pin.value = ''; u.confirm.checked = false; st.pick[kind] = null;
        setTimeout(refresh, 1500);
      } catch (e) { say('요청을 보내지 못했어요. 파이 연결을 확인해 주세요.', 'bad'); }
    };
  }

  function renderAccount(kind) {
    const a = ACCOUNTS[kind], u = ui[kind], d = st.data[kind];
    const now = d && d.status && d.status.mode;
    const coin = st.data.coin, ip = ((coin && coin.status && coin.status.network) || {}).ip;
    u.ip.textContent = ip ? `(${ip})` : '(공유기 관리 화면의 외부 IP)';
    const hasKey = d && (kind === 'coin' ? d.live_ready : d.keys);
    if (d && !hasKey && !st.keyShown[kind]) { u.keyBox.open = true; st.keyShown[kind] = true; }  // 키가 없으면 처음 한 번 펼쳐 둔다
    if (!now) {
      u.chip.textContent = '봇이 아직 시작되지 않았어요';
      u.go.disabled = true;
      return;
    }
    const want = st.pick[kind] || now;
    u.chip.textContent = now === 'live' ? '🔴 지금 실거래' : '🧪 지금 모의투자';
    u.chip.className = 'chip ' + (now === 'live' ? 'live' : 'paper');
    u.paper.setAttribute('aria-pressed', String(want === 'paper'));
    u.live.setAttribute('aria-pressed', String(want === 'live'));
    const ready = kind === 'coin' ? d.live_ready : d.keys;
    u.live.disabled = !ready && now !== 'live';
    let keyText = ready ? `✅ ${a.broker} 키 연결됨` : a.keyless;
    if (kind === 'coin' && ready && d.key_info && d.key_info.expire_at) {
      const left = Math.floor((new Date(d.key_info.expire_at) - new Date(String(d.server_time).replace(' ', 'T') + '+09:00')) / 86400e3);
      keyText += ` · 만료 ${d.key_info.expire_at.slice(0, 10)} (${left <= 30 ? '⚠️ ' : ''}${left}일 남음)`;
    }
    u.key.textContent = keyText;
    u.confirmRow.hidden = !(want === 'live' && now !== 'live');
    u.go.disabled = want === now;
    u.msg.className = 'msg info';
    u.msg.textContent = d.pending ? '봇이 요청을 처리하는 중이에요…' : '';
    for (const r of d.results || []) {  // 여기서 보낸 요청의 결과만 알림으로
      if (!(st.mine[kind] || {})[r.id]) continue;
      delete st.mine[kind][r.id];
      say((r.ok ? '✅ ' : '⚠️ ') + r.message, r.ok ? 'ok' : 'bad');
    }
  }

  // ---- 🔒 PIN 바꾸기 (코인·주식 공통) ----
  const pinUi = {
    chip: node('span', { class: 'chip', text: '-' }),
    current: node('input', { type: 'password', inputmode: 'numeric', placeholder: '지금 PIN', autocomplete: 'current-password', maxlength: '32', 'aria-label': '지금 PIN' }),
    next: node('input', { type: 'password', inputmode: 'numeric', placeholder: '새 PIN (4자리 이상)', autocomplete: 'new-password', maxlength: '32', 'aria-label': '새 PIN' }),
    again: node('input', { type: 'password', inputmode: 'numeric', placeholder: '새 PIN 한 번 더', autocomplete: 'new-password', maxlength: '32', 'aria-label': '새 PIN 한 번 더' }),
    go: node('button', { type: 'button', class: 'primary', text: 'PIN 바꾸기' }),
    msg: node('p', { class: 'msg' }),
  };
  panel.append(node('section', { class: 'set-sec', id: 'setPin' },
    node('h3', {}, '🔒 PIN ', node('small', { text: '코인·주식 공통 · 계좌 만들기·이체·전략 바꾸기·계좌 바꾸기·텔레그램 설정에 써요' }), pinUi.chip),
    node('div', { class: 'field pin-fields' }, pinUi.current, pinUi.next, pinUi.again, pinUi.go),
    node('p', { class: 'hint', text: '처음 PIN은 0000이에요. 5번 틀리면 10분 동안 잠겨요. 잊어버렸으면 파이에서 python3 -m mypie.pin 으로 새로 정할 수 있어요.' }),
    pinUi.msg));
  const pinSay = (text, kind) => { pinUi.msg.textContent = text; pinUi.msg.className = 'msg ' + (kind || ''); };
  function renderPin() {
    const d = st.data.coin;
    const isDefault = !!(d && d.pin_default);
    pinUi.chip.textContent = isDefault ? '⚠️ 기본 PIN 0000 사용 중' : '✅ 내 PIN';
    pinUi.chip.className = 'chip ' + (isDefault ? 'live' : '');
    gear.classList.toggle('warn', isDefault);  // 기본 PIN이면 톱니바퀴에 빨간 점
    gear.title = isDefault ? '설정 · 기본 PIN(0000)을 바꿔 주세요' : '설정';
  }
  pinUi.go.onclick = async () => {
    const current = pinUi.current.value, next = pinUi.next.value, again = pinUi.again.value;
    if (!current || !next) { pinSay('지금 PIN과 새 PIN을 넣어 주세요.', 'bad'); return; }
    if (next !== again) { pinSay('새 PIN 두 번이 서로 달라요.', 'bad'); pinUi.again.focus(); return; }
    pinUi.go.disabled = true;
    try {
      const r = await post('/api/pin', { current, new: next, again });
      pinSay(r.message, r.ok ? 'ok' : 'bad');
      if (r.ok) {
        pinUi.current.value = pinUi.next.value = pinUi.again.value = '';
        say('🔐 PIN을 바꿨어요. 다음부터 새 PIN을 넣어 주세요.', 'ok');
        refresh();
      }
    } catch (e) { pinSay('요청을 보내지 못했어요.', 'bad'); }
    finally { pinUi.go.disabled = false; }
  };

  // ---- 불러오기 ----
  async function load(kind) {
    try {
      const r = await fetch(ACCOUNTS[kind].status, { cache: 'no-store' });
      if (r.status === 401) { location.reload(); return; }
      if (r.ok) st.data[kind] = await r.json();
    } catch (e) { /* 다음에 다시 */ }
  }
  async function refresh() {
    await Promise.all([load('coin'), back.hidden ? null : load('stock')]);
    renderTelegram();
    renderPin();
    if (!back.hidden) { renderAccount('coin'); renderAccount('stock'); }
  }
  function open() {
    back.hidden = false;
    document.body.classList.add('noscroll');
    refresh();
    clearInterval(st.timer);
    st.timer = setInterval(refresh, 5000);
    closeBtn.focus();
  }
  function close() {
    back.hidden = true;
    document.body.classList.remove('noscroll');
    clearInterval(st.timer);
    st.timer = null;
    gear.focus();
  }
  gear.onclick = open;
  closeBtn.onclick = close;
  back.addEventListener('click', (ev) => { if (ev.target === back) close(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !back.hidden) close(); });
  if (location.hash === '#settings') open();  // 예전 '설정' 주소로 들어와도 열어 준다
  refresh();  // 로그아웃 버튼·기본 PIN 표시를 정하려고 한 번
})();
