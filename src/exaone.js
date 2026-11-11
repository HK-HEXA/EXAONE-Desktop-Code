'use strict';
// EXAONE API 클라이언트 (OpenAI 호환 /chat/completions + /tabular/*)
// fetch 구현체를 주입받으므로 Electron(net.fetch)과 Node(fetch) 양쪽에서 동작한다.

const RATE_HEADERS = [
  'x-second-rate-limit', 'x-second-rate-limit-remaining',
  'x-minute-rate-limit', 'x-minute-rate-limit-remaining',
  'x-day-rate-limit', 'x-day-rate-limit-remaining',
  'retry-after', 'retry-after-ms', 'x-request-id',
];
// 원시 응답은 앞부분과 끝부분을 남긴다. 스트림이 어떻게 끝났는지는 끝부분에 있다.
const RAW_HEAD = 80 * 1024;
const RAW_TAIL = 240 * 1024;

let lastStart = 0;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const t = setTimeout(done, ms);
    function done() { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }
    function onAbort() { clearTimeout(t); reject(abortError()); }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}
function abortError() { const e = new Error('aborted'); e.name = 'AbortError'; return e; }
function isAbort(e, signal) { return (signal && signal.aborted) || (e && e.name === 'AbortError'); }

// 계정 한도가 초당 1회이므로 요청 시작 간격을 벌린다.
async function throttle(minGapMs, signal) {
  const now = Date.now();
  const start = Math.max(now, lastStart + minGapMs);
  lastStart = start;
  if (start > now) await sleep(start - now, signal);
}

function pickHeaders(res) {
  const out = {};
  for (const k of RATE_HEADERS) {
    const v = res.headers.get(k);
    if (v != null) out[k] = v;
  }
  return out;
}

function retryAfterMs(headers) {
  if (headers['retry-after-ms']) return Math.ceil(Number(headers['retry-after-ms'])) || null;
  if (headers['retry-after']) return Math.ceil(Number(headers['retry-after']) * 1000) || null;
  return null;
}

function errorMessage(status, text) {
  let msg = '';
  try {
    const j = JSON.parse(text);
    if (typeof j.description === 'string') msg = j.description;
    else if (j.error && typeof j.error === 'object') msg = j.error.message || JSON.stringify(j.error);
    else if (typeof j.error === 'string') msg = j.error;
    else if (typeof j.message === 'string') msg = j.message;
    else if (j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
  } catch { /* JSON 아님 */ }
  if (!msg) msg = (text || '').trim().slice(0, 500);
  const hint = {
    400: '요청 형식 오류 (컨텍스트 초과 포함)',
    401: 'API 키가 없거나 인증 실패',
    404: '경로 없음',
    422: '입력 형식 오류',
    429: '요청 한도 초과',
    500: '서비스 내부 오류',
  }[status];
  return [hint, msg].filter(Boolean).join(' — ') || `HTTP ${status}`;
}

/** fetch 가 던진 오류에서 실제 원인(ENOTFOUND, ECONNRESET …)을 꺼내 붙인다. */
function netMessage(e) {
  const msg = String(e && e.message || e);
  const cause = e && e.cause;
  const code = cause && (cause.code || cause.name);
  const detail = cause && cause.message && cause.message !== msg ? cause.message : '';
  return [msg, code && !msg.includes(code) ? code : '', detail && !detail.includes(String(code)) ? detail : ''].filter(Boolean).join(' · ');
}

function joinUrl(baseUrl, p) { return String(baseUrl || '').replace(/\/+$/, '') + p; }

/**
 * 채팅 요청. 결과는 onEvent 로 흘려보낸다.
 * 이벤트: request / response / reasoning / content / tool_call / usage / finish / error / aborted / done
 * done 에는 stream 진단 정보(청크 수, finish·[DONE] 수신 여부 등)와 incomplete 플래그가 붙는다.
 */
async function chat({ fetchImpl, baseUrl, apiKey, body, signal, onEvent, minGapMs = 1100 }) {
  const url = joinUrl(baseUrl, '/chat/completions');
  const st = { chunks: 0, sawFinish: false, sawDone: false, badLines: 0, unknown: [], errored: false, aborted: false, started: false };
  const emit = (ev) => {
    if (ev.type === 'error') st.errored = true;
    else if (ev.type === 'aborted') st.aborted = true;
    else if (ev.type === 'finish') st.sawFinish = true;
    try { onEvent(ev); } catch { /* 수신측 오류 무시 */ }
  };
  let rawHead = '', rawTail = '', rawTotal = 0;
  const addRaw = (s) => {
    rawTotal += s.length;
    if (rawHead.length < RAW_HEAD) { const take = RAW_HEAD - rawHead.length; rawHead += s.slice(0, take); s = s.slice(take); }
    if (s) rawTail = (rawTail + s).slice(-RAW_TAIL);
  };
  const rawOut = () => {
    const cut = rawTotal - rawHead.length - rawTail.length;
    return cut > 0 ? `${rawHead}\n\n… [가운데 ${cut}자 생략] …\n\n${rawTail}` : rawHead + rawTail;
  };
  const finish = () => emit({
    type: 'done', raw: rawOut(), rawTotal,
    stream: { chunks: st.chunks, sawFinish: st.sawFinish, sawDone: st.sawDone, badLines: st.badLines, unknown: st.unknown },
    // 본문을 받기 시작했는데 오류·중단 없이 finish_reason 도 없이 끝난 경우
    incomplete: st.started && !st.sawFinish && !st.errored && !st.aborted,
  });

  emit({ type: 'request', url, body });
  let res;
  let t0 = Date.now();
  try {
    await throttle(minGapMs, signal);
    t0 = Date.now();
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Accept': body.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (isAbort(e, signal)) emit({ type: 'aborted' });
    else emit({ type: 'error', status: 0, network: true, message: '네트워크 오류 — ' + netMessage(e) });
    return finish();
  }

  const headers = pickHeaders(res);
  emit({ type: 'response', status: res.status, headers, latencyMs: Date.now() - t0 });

  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch { /* 본문 없음 */ }
    addRaw(text);
    emit({ type: 'error', status: res.status, message: errorMessage(res.status, text), retryAfterMs: retryAfterMs(headers) });
    return finish();
  }

  st.started = true;
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  try {
    if (!body.stream || ctype.includes('application/json')) {
      const text = await res.text();
      addRaw(text);
      let j;
      try { j = JSON.parse(text); } catch { emit({ type: 'error', status: res.status, message: '응답 JSON 파싱 실패' }); return finish(); }
      st.chunks = 1;
      emitCompletion(j, emit);
      return finish();
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let pending = '';
    let eventName = '';
    const handleLine = (line) => {
      if (line === '') { eventName = ''; return; }
      if (line[0] === ':') return; // 주석·keepalive
      if (line.startsWith('event:')) { eventName = line.slice(6).trim(); return; }
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === '[DONE]') { st.sawDone = true; if (pending) { st.badLines++; pending = ''; } return; }
      let j;
      try { j = JSON.parse(pending + payload); pending = ''; }
      catch {
        if (pending) {
          // 앞줄이 깨진 줄이었을 수 있다. 이번 줄만으로 해석되면 앞줄은 버리고 계속 간다.
          try { j = JSON.parse(payload); st.badLines++; pending = ''; } catch { pending += payload; }
        } else pending = payload;
        if (j === undefined) {
          if (pending.length > 1e6) { pending = ''; st.badLines++; }
          return;
        }
      }
      st.chunks++;
      if (eventName === 'error') { emit({ type: 'error', status: Number(j.code || j.status || j.result_code) || 0, message: describeObject(j) }); return; }
      emitChunk(j, emit, st);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const s = dec.decode(value, { stream: true });
      addRaw(s);
      buf += s;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        handleLine(line);
      }
    }
    if (buf.trim()) handleLine(buf.trim());
    if (pending) st.badLines++;
  } catch (e) {
    if (isAbort(e, signal)) emit({ type: 'aborted' });
    else emit({ type: 'error', status: 0, network: true, message: '응답을 받는 중 연결이 끊겼습니다 — ' + netMessage(e) });
  }
  return finish();
}

function describeObject(j) {
  if (!j || typeof j !== 'object') return String(j);
  if (j.error) return typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
  for (const k of ['description', 'message', 'detail', 'msg']) {
    if (j[k]) return typeof j[k] === 'string' ? j[k] : JSON.stringify(j[k]);
  }
  return JSON.stringify(j).slice(0, 500);
}

function streamError(j) {
  if (!j || typeof j !== 'object') return null;
  if (j.error) return describeObject(j);
  if (j.object === 'error') return describeObject(j);
  if (typeof j.result_code === 'number' && j.result_code !== 200 && !j.choices) return j.description || ('result_code ' + j.result_code);
  return null;
}

function emitChunk(j, emit, st) {
  const err = streamError(j);
  if (err) return emit({ type: 'error', status: Number(j.result_code || j.code) || 0, message: err });
  if (!Array.isArray(j.choices) && !j.usage) {
    // 알 수 없는 모양의 청크: 오류로 보이면 오류로 올리고, 아니면 진단용으로 기록만 한다.
    if (j && typeof j === 'object' && (j.message || j.detail || j.description || j.code || j.status === 'error')) {
      return emit({ type: 'error', status: Number(j.code || j.status) || 0, message: describeObject(j) });
    }
    if (st && st.unknown.length < 3) st.unknown.push(JSON.stringify(j).slice(0, 300));
    return;
  }
  const choices = Array.isArray(j.choices) ? j.choices : [];
  for (const c of choices) {
    const d = c.delta || c.message || {};
    const r = d.reasoning_content != null ? d.reasoning_content : d.reasoning;
    if (typeof r === 'string' && r) emit({ type: 'reasoning', text: r });
    if (typeof d.content === 'string' && d.content) emit({ type: 'content', text: d.content });
    if (Array.isArray(d.tool_calls)) {
      d.tool_calls.forEach((tc, i) => emit({
        type: 'tool_call',
        index: typeof tc.index === 'number' ? tc.index : i,
        id: tc.id || null,
        name: tc.function && tc.function.name || null,
        args: tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments
          : (tc.function && tc.function.arguments != null ? JSON.stringify(tc.function.arguments) : ''),
      }));
    }
    if (c.finish_reason) emit({ type: 'finish', finishReason: c.finish_reason, matchedStop: c.matched_stop });
  }
  if (j.usage) emit({ type: 'usage', usage: j.usage });
}

function emitCompletion(j, emit) {
  const err = streamError(j);
  if (err) return emit({ type: 'error', status: Number(j.result_code || j.code) || 0, message: err });
  const c = (j.choices || [])[0] || {};
  const m = c.message || {};
  const r = m.reasoning_content != null ? m.reasoning_content : m.reasoning;
  if (typeof r === 'string' && r) emit({ type: 'reasoning', text: r });
  if (typeof m.content === 'string' && m.content) emit({ type: 'content', text: m.content });
  if (Array.isArray(m.tool_calls)) {
    m.tool_calls.forEach((tc, i) => emit({
      type: 'tool_call', index: i, id: tc.id || null,
      name: tc.function && tc.function.name || null,
      args: tc.function && typeof tc.function.arguments === 'string' ? tc.function.arguments
        : JSON.stringify(tc.function && tc.function.arguments || {}),
    }));
  }
  if (c.finish_reason) emit({ type: 'finish', finishReason: c.finish_reason, matchedStop: c.matched_stop });
  if (j.usage) emit({ type: 'usage', usage: j.usage });
}

/** EXAONE Tabular: multipart/form-data 로 학습·예측 CSV 전송 */
async function tabular({ fetchImpl, baseUrl, apiKey, task, train, test, mode, outputType, targetColumn, signal, minGapMs = 1100 }) {
  const url = joinUrl(baseUrl, task === 'regression' ? '/tabular/regression' : '/tabular/classification');
  const boundary = '----exaone' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const parts = [];
  const field = (name, value) => parts.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  const file = (name, f) => {
    const fname = String(f.name || name + '.csv').replace(/["\r\n]/g, '_');
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${fname}"\r\nContent-Type: text/csv\r\n\r\n`, 'utf8'));
    parts.push(Buffer.from(f.data));
    parts.push(Buffer.from('\r\n', 'utf8'));
  };
  file('train_file', train);
  file('test_file', test);
  field('mode', mode || 'default');
  field('output_type', outputType);
  field('target_columns', targetColumn);
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  const payload = Buffer.concat(parts);

  const t0 = Date.now();
  let res;
  try {
    await throttle(minGapMs, signal);
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'multipart/form-data; boundary=' + boundary },
      body: payload,
      signal,
    });
  } catch (e) {
    if (isAbort(e, signal)) return { ok: false, aborted: true, url };
    return { ok: false, status: 0, url, error: '네트워크 오류 — ' + (e && e.message || e) };
  }
  const headers = pickHeaders(res);
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* JSON 아님 */ }
  const ms = Date.now() - t0;
  const failed = !res.ok || (json && typeof json.result_code === 'number' && json.result_code !== 200);
  if (failed) return { ok: false, status: res.status, url, headers, ms, error: errorMessage(res.status, text), json };
  return { ok: true, status: res.status, url, headers, ms, json, text: json ? null : text.slice(0, 20000) };
}

module.exports = { chat, tabular, RATE_HEADERS, retry: require('../renderer/js/retry') };
