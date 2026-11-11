'use strict';
/* API 로그 화면, EXAONE Tabular 화면 */

// ---------- API 로그 ----------
let logSel = null;
let logTab = 'request';

function renderLogBadge() {
  const b = $('#log-count');
  b.textContent = S.logs.length ? String(S.logs.length) : '';
}

function statusClass(log) {
  if (log.error) return 'bad';
  if (log.status == null) return 'wait';
  return log.status >= 200 && log.status < 300 ? 'ok' : 'bad';
}

function curlOf(log) {
  const body = JSON.stringify(log.body, null, 2).replace(/'/g, `'\\''`);
  return `curl '${log.url}' \\\n  -H "Authorization: Bearer $EXAONE_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '${body}'`;
}

function renderLogs() {
  const box = $('#view-logs');
  if (box.hidden) return;
  box.innerHTML = '';
  if (!S.logs.length) {
    box.append(h('div', { class: 'empty big' }, icon('activity', 26), h('p', { text: '아직 요청이 없습니다. 메시지를 보내면 요청 본문·응답 헤더·원시 스트림이 여기에 기록됩니다.' })));
    return;
  }
  if (!logSel || !S.logs.includes(logSel)) logSel = S.logs[0];
  const list = h('div', { class: 'log-list' }, S.logs.map((l) => {
    const u = l.usage;
    return h('button', { class: 'log-row' + (l === logSel ? ' on' : ''), onclick: () => { logSel = l; renderLogs(); } },
      h('span', { class: 'st ' + statusClass(l), text: l.status == null ? (l.error ? 'ERR' : '…') : String(l.status) }),
      h('span', { class: 'log-main' },
        h('b', { text: l.kind === 'tabular' ? 'tabular' : `${(l.body.messages || []).length} 메시지` + (l.body.tools ? ` · 도구 ${l.body.tools.length}` : '') }),
        h('small', { text: `${fmtTime(l.ts)} · ${l.ms != null ? fmtDur(l.ms) : '진행 중'}` + (u ? ` · ${fmtNum(u.total_tokens)} 토큰` : '') })));
  }));

  const l = logSel;
  const tabs = [['request', '요청 본문'], ['response', '응답 요약'], ['raw', '원시 응답']];
  let text = '';
  if (logTab === 'request') text = JSON.stringify(l.body, null, 2);
  else if (logTab === 'response') {
    text = JSON.stringify({
      url: l.url, status: l.status, duration_ms: l.ms, finish_reason: l.finish || null,
      error: l.error || undefined, incomplete: l.incomplete || undefined, stream: l.stream || undefined,
      headers: l.headers, usage: l.usage || undefined, raw_total_chars: l.rawTotal,
    }, null, 2);
  } else text = l.raw || '(본문 없음)';

  const detail = h('div', { class: 'log-detail' },
    h('div', { class: 'log-tabs' },
      tabs.map(([k, label]) => h('button', { class: logTab === k ? 'on' : '', onclick: () => { logTab = k; renderLogs(); } }, label)),
      h('span', { class: 'grow' }),
      l.kind !== 'tabular' ? h('button', { class: 'btn ghost sm', title: '키 대신 $EXAONE_API_KEY 를 쓰는 curl 명령', onclick: (e) => copyText(curlOf(l), e.currentTarget) }, icon('terminal', 13), 'curl 복사') : null,
      h('button', { class: 'btn ghost sm', title: S.env.logDir, onclick: () => exa.open(S.env.logDir) }, icon('folder', 13), '로그 폴더'),
      h('button', { class: 'btn ghost sm', onclick: (e) => copyText(text, e.currentTarget) }, icon('copy', 13), '복사')),
    h('pre', { class: 'log-pre', text }));
  box.append(list, detail);
}

// ---------- Tabular ----------
const TB = { task: 'classification', outputType: 'class', train: null, test: null, target: '', running: false, result: null, reqId: null };

function parseCsv(text, maxRows = Infinity) {
  const rows = [];
  let row = [], cell = '', q = false;
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      if (rows.length >= maxRows) return rows;
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };

function sampleData(task) {
  let seed = task === 'regression' ? 20261110 : 20261109;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const mk = (n, withTarget) => {
    const rows = [];
    for (let i = 0; i < n; i++) {
      if (task === 'regression') {
        const area = Math.round(40 + rnd() * 100), rooms = 1 + Math.floor(area / 35), age = Math.round(rnd() * 30), dist = +(0.2 + rnd() * 9).toFixed(1);
        const price = Math.round(area * 950 + rooms * 2500 - age * 600 - dist * 2200 + (rnd() - 0.5) * 6000);
        rows.push(withTarget ? [area, rooms, age, dist, price] : [area, rooms, age, dist]);
      } else {
        const age = Math.round(20 + rnd() * 45), fee = Math.round(20 + rnd() * 90), tenure = Math.round(1 + rnd() * 60), calls = Math.floor(rnd() * 8);
        const score = fee / 45 + calls / 2.2 - tenure / 22 + (rnd() - 0.5) * 0.9;
        rows.push(withTarget ? [age, fee, tenure, calls, score > 1.2 ? 'yes' : 'no'] : [age, fee, tenure, calls]);
      }
    }
    return rows;
  };
  const head = task === 'regression' ? ['area_m2', 'rooms', 'age_years', 'distance_km'] : ['age', 'monthly_fee', 'tenure_months', 'support_calls'];
  const target = task === 'regression' ? 'price' : 'churn';
  const toCsv = (h2, rows) => [h2.join(',')].concat(rows.map((r) => r.join(','))).join('\n') + '\n';
  const enc = new TextEncoder();
  const file = (name, text) => ({ name, text, data: enc.encode(text), size: enc.encode(text).length });
  return { train: file(`${task}_train.csv`, toCsv(head.concat(target), mk(80, true))), test: file(`${task}_test.csv`, toCsv(head, mk(10, false))), target };
}

async function readCsvFile(f) {
  const data = new Uint8Array(await f.arrayBuffer());
  let text = new TextDecoder('utf-8').decode(data);
  if ((text.match(/�/g) || []).length > text.length / 200) { try { text = new TextDecoder('euc-kr').decode(data); } catch { /* 그대로 */ } }
  return { name: f.name, text, data, size: f.size };
}

function csvInfo(file) {
  if (!file) return null;
  const head = parseCsv(file.text, 1)[0] || [];
  let lines = 0;
  for (let i = 0; i < file.text.length; i++) if (file.text.charCodeAt(i) === 10) lines++;
  if (file.text.length && !file.text.endsWith('\n')) lines++;
  return { head, rows: Math.max(0, lines - 1) };
}

// 응답 배열에서 [행][타깃] 형태의 한 겹을 벗겨 낸다.
const unwrap1 = (v) => (Array.isArray(v) && v.length === 1 ? v[0] : v);

function tabularTable() {
  const r = TB.result;
  const d = r && r.json && r.json.data;
  if (!d) return null;
  const testRows = parseCsv(TB.test.text);
  const head = testRows[0] || [];
  const body = testRows.slice(1);
  let cols = [];
  let values = [];
  if (Array.isArray(d.labels) && d.labels.length) {
    cols = ['예측 (' + TB.target + ')'];
    values = d.labels.map((x) => [unwrap1(x)]);
  } else if (Array.isArray(d.probabilities) && d.probabilities.length) {
    let classes = d.classes || [];
    if (Array.isArray(classes[0])) classes = classes[0];
    const first = unwrap1(d.probabilities[0]) || [];
    cols = first.map((_, i) => 'P(' + (classes[i] != null ? classes[i] : i) + ')');
    values = d.probabilities.map((x) => (unwrap1(x) || []).map((p) => (typeof p === 'number' ? p.toFixed(4) : p)));
  } else if (Array.isArray(d.predictions) && d.predictions.length) {
    cols = ['예측 (' + TB.target + ')'];
    values = d.predictions.map((x) => { const v = unwrap1(x); return [typeof v === 'number' ? +v.toFixed(4) : v]; });
  } else if (Array.isArray(d.quantiles) && d.quantiles.length) {
    const levels = unwrap1(d.quantile_levels) || [];
    const pick = (q) => { let bi = 0, bd = Infinity; levels.forEach((l, i) => { const dd = Math.abs(l - q); if (dd < bd) { bd = dd; bi = i; } }); return bi; };
    const idx = [0.1, 0.5, 0.9].map(pick);
    cols = ['10%', '중앙값', '90%'];
    values = d.quantiles.map((x) => { const qs = unwrap1(x) || []; return idx.map((i) => (typeof qs[i] === 'number' ? +qs[i].toFixed(4) : qs[i])); });
  } else return null;

  const n = Math.min(body.length || values.length, values.length);
  const show = Math.min(n, 300);
  const table = h('table', { class: 'tb-table' },
    h('thead', null, h('tr', null, h('th', { text: '#' }), head.map((c) => h('th', { text: c })), cols.map((c) => h('th', { class: 'pred', text: c })))),
    h('tbody', null, Array.from({ length: show }, (_, i) => h('tr', null,
      h('td', { class: 'idx', text: i + 1 }), (body[i] || []).map((c) => h('td', { text: c })), (values[i] || []).map((c) => h('td', { class: 'pred', text: c == null ? '' : String(c) }))))));
  const csv = [head.concat(cols).map(csvCell).join(',')]
    .concat(Array.from({ length: n }, (_, i) => (body[i] || []).concat(values[i] || []).map(csvCell).join(','))).join('\n') + '\n';
  return { table, csv, rows: n, shown: show };
}

function renderTabular() {
  const box = $('#view-tabular');
  if (box.hidden) return;
  box.innerHTML = '';
  const ti = csvInfo(TB.train), si = csvInfo(TB.test);
  const outOpts = TB.task === 'classification'
    ? [['class', 'class — 예측 클래스'], ['probability', 'probability — 클래스별 확률']]
    : [['point', 'point — 예측값'], ['full', 'full — 분위수 분포 (999개)']];
  if (!outOpts.some(([k]) => k === TB.outputType)) TB.outputType = outOpts[0][0];
  if (ti && !ti.head.includes(TB.target)) TB.target = ti.head[ti.head.length - 1] || '';

  const filePick = (key, label, info) => {
    const input = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
    input.addEventListener('change', async () => { if (input.files[0]) { TB[key] = await readCsvFile(input.files[0]); TB.result = null; renderTabular(); } });
    return h('div', { class: 'tb-file' + (TB[key] ? ' has' : '') },
      h('div', { class: 'tb-file-head' }, h('b', { text: label }), h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => input.click() }, icon('clip', 13), TB[key] ? '바꾸기' : 'CSV 선택')),
      TB[key] ? h('div', { class: 'tb-file-info' }, icon('file', 14), h('span', { text: TB[key].name }), h('small', { text: `${fmtNum(info.rows)}행 × ${info.head.length}열 · ${fmtBytes(TB[key].size)}` }))
        : h('div', { class: 'tb-file-info muted', text: '선택된 파일 없음' }),
      input);
  };

  const canRun = TB.train && TB.test && TB.target && !TB.running;
  const form = h('div', { class: 'tb-form' },
    h('div', { class: 'tb-intro' },
      h('h2', { text: 'EXAONE Tabular' }),
      h('p', { text: '학습용 CSV 와 예측할 CSV 를 올리면 별도 학습 과정 없이 분류·회귀 예측을 돌려줍니다. (POST /v1/tabular/classification · /regression)' })),
    h('div', { class: 'seg' }, [['classification', '분류'], ['regression', '회귀']].map(([k, label]) => h('button', {
      class: TB.task === k ? 'on' : '', onclick: () => { TB.task = k; TB.result = null; renderTabular(); },
    }, label))),
    h('div', { class: 'tb-files' }, filePick('train', '학습 데이터 (train_file)', ti), filePick('test', '예측할 데이터 (test_file)', si)),
    h('div', { class: 'tb-opts' },
      field('타깃 열 (target_columns)', ti ? select(ti.head.map((c) => [c, c]), TB.target, (v) => { TB.target = v; }) : h('div', { class: 'muted', text: '학습 데이터를 먼저 고르세요' })),
      field('출력 형식 (output_type)', select(outOpts, TB.outputType, (v) => { TB.outputType = v; }))),
    h('div', { class: 'inline' },
      h('button', { class: 'btn primary', disabled: !canRun, onclick: runTabular }, TB.running ? h('span', { class: 'spin' }) : icon('bolt', 14), TB.running ? '예측 중…' : '예측 실행'),
      TB.running ? h('button', { class: 'btn', onclick: () => exa.chatAbort(TB.reqId) }, '중지') : null,
      h('button', { class: 'btn ghost', disabled: TB.running, onclick: () => { const s = sampleData(TB.task); TB.train = s.train; TB.test = s.test; TB.target = s.target; TB.result = null; renderTabular(); } }, '샘플 데이터 채우기')));
  box.append(form);

  const r = TB.result;
  if (r) {
    const res = h('div', { class: 'tb-result' });
    if (!r.ok) {
      res.append(h('div', { class: 'errbox' }, icon('info', 15), h('span', { text: r.aborted ? '중단했습니다.' : (r.status ? `HTTP ${r.status} · ` : '') + (r.error || '요청 실패') })));
    } else {
      const t = tabularTable();
      res.append(h('div', { class: 'tb-res-head' },
        h('b', { text: t ? `예측 결과 ${fmtNum(t.rows)}행` : '응답' }), h('span', { class: 'muted', text: fmtDur(r.ms) }), h('span', { class: 'grow' }),
        t ? h('button', { class: 'btn ghost sm', onclick: async () => { const p = await exa.exportSave(`tabular_${TB.task}_result.csv`, t.csv); if (p) toast('저장했습니다: ' + p); } }, icon('download', 13), 'CSV 저장') : null,
        h('button', { class: 'btn ghost sm', onclick: (e) => copyText(JSON.stringify(r.json, null, 2), e.currentTarget) }, icon('copy', 13), 'JSON 복사')));
      if (t) {
        res.append(h('div', { class: 'table-wrap tall' }, t.table));
        if (t.shown < t.rows) res.append(h('p', { class: 'muted small', text: `화면에는 처음 ${t.shown}행만 표시합니다. 전체는 CSV 로 저장하세요.` }));
      } else {
        res.append(h('pre', { class: 'log-pre', text: (r.json ? JSON.stringify(r.json, null, 2) : r.text || '').slice(0, 20000) }));
      }
    }
    box.append(res);
  }
}

async function runTabular() {
  if (TB.running || !TB.train || !TB.test) return;
  TB.running = true;
  TB.result = null;
  TB.reqId = uid('t');
  renderTabular();
  const log = {
    id: TB.reqId, ts: Date.now(), kind: 'tabular', url: '', status: null, headers: {}, usage: null, ms: null, error: null, raw: '',
    body: { task: TB.task, train_file: TB.train.name, test_file: TB.test.name, mode: 'default', output_type: TB.outputType, target_columns: TB.target },
  };
  S.logs.unshift(log);
  renderLogBadge();
  let r;
  try {
    r = await exa.runTabular({
      reqId: TB.reqId, task: TB.task, mode: 'default', outputType: TB.outputType, targetColumn: TB.target,
      train: { name: TB.train.name, data: TB.train.data }, test: { name: TB.test.name, data: TB.test.data },
    });
  } catch (e) { r = { ok: false, error: String(e && e.message || e) }; }
  log.url = r.url || ''; log.status = r.status == null ? null : r.status; log.headers = r.headers || {}; log.ms = r.ms;
  log.error = r.ok ? null : (r.aborted ? '사용자 중단' : r.error);
  log.raw = r.json ? JSON.stringify(r.json, null, 2).slice(0, 200000) : (r.text || '');
  updateRate(r.headers);
  TB.running = false;
  TB.result = r;
  renderTabular();
}
