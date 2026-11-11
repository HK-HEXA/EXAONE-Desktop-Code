'use strict';
/* 대화 상태, API 요청 조립, 에이전트 루프, 메시지 렌더링, 입력창 */

const CTX_LIMIT = 524288;

const S = {
  settings: null,
  keyInfo: { hasKey: false },
  toolDefs: [],
  askUser: {},          // ask_user 도구의 안내문 (main 에서 받음)
  env: {},
  convs: [],
  conv: null,
  busy: false,
  run: null,
  view: 'chat',
  home: false,          // 프로젝트 홈(프로젝트에 속한 빈 대화)을 보여 주는 중인가
  attachments: [],
  logs: [],
  rate: null,
  search: '',
  sessionAllow: new Set(),
  cliSessions: [],      // EXAONE Code(터미널) 세션 목록
  remote: null,         // 열어 둔 Code 세션에서 터미널이 실행 중인 작업 { n, conv, asst, last, … }
};

const msgEls = new Map();      // message id -> element
const toolState = new Map();   // tool call id -> { status, live, resolve }
const chatHandlers = new Map(); // reqId -> handler

const EFFORTS = {
  low: { label: '낮음', desc: '빠른 응답' },
  medium: { label: '보통', desc: '공식 에이전트 가이드의 예시 값' },
  high: { label: '높음', desc: '수학·코딩' },
  max: { label: '최대', desc: '정확도 우선 (API 기본값, 느림)' },
};
const APPROVALS = {
  readonly: { label: '읽기 전용', desc: '파일 읽기·검색만 허용', icon: 'eye' },
  ask: { label: '승인 후 실행', desc: '쓰기·명령·웹 요청은 매번 확인', icon: 'shield' },
  auto: { label: '전체 자동', desc: '확인 없이 모두 실행', icon: 'bolt' },
};

// ---------- 설정 ----------
function mergeDeep(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? mergeDeep(base[k], v) : v;
  }
  return out;
}
let pendingPatch = null;
let pushTimer = null;
function saveSettings(patch) {
  S.settings = mergeDeep(S.settings, patch);
  pendingPatch = pendingPatch ? mergeDeep(pendingPatch, patch) : patch;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    const p = pendingPatch;
    pendingPatch = null;
    exa.setSettings(p).catch((e) => console.error(e));
  }, 250);
}

// 추론 강도는 모드별로 따로 둔다 (에이전트는 단계마다 다시 추론하므로 기본값이 더 낮다).
function effortOf(conv) {
  const v = conv && conv.mode === 'agent' ? S.settings.agent.reasoning_effort : S.settings.params.reasoning_effort;
  return EFFORTS[v] ? v : 'high';
}
function setEffort(v) {
  if (!EFFORTS[v]) return;
  if (S.conv && S.conv.mode === 'agent') saveSettings({ agent: { reasoning_effort: v } });
  else saveSettings({ params: { reasoning_effort: v } });
  renderChips();
  renderParamsPanel();
  renderToolsPanel();
}

// ---------- 대화 관리 ----------
/** 왼쪽 위 탭: 'chat' (대화 · 에이전트 작업) 또는 'code' (EXAONE Code 세션) */
function curTab() { return S.settings.ui && S.settings.ui.tab === 'code' ? 'code' : 'chat'; }
const codeSid = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);

function newConv(projectId) {
  if (S.busy) stopRun();
  if (curTab() === 'code') {
    // Code 탭의 대화는 터미널의 EXAONE Code 와 같은 세션 파일에 기록된다 (id 형식도 같다).
    const sid = codeSid();
    S.conv = {
      id: 'code:' + sid, code: { id: sid }, title: '', createdAt: Date.now(), updatedAt: Date.now(), projectId: null, mode: 'agent',
      workspace: S.settings.lastCodeDir || S.settings.lastWorkspace || '', messages: [],
    };
    loadCodeMemory(S.conv.workspace);
  } else {
    const proj = typeof projectId === 'string' ? (S.settings.projects || []).find((p) => p.id === projectId) : null;
    // 방식(채팅 / 에이전트)은 입력창의 버튼으로 고르고, 첫 메시지를 보내면 그 대화에 고정된다.
    const mode = S.settings.lastMode === 'agent' ? 'agent' : 'chat';
    S.conv = {
      id: uid('c'), title: '', createdAt: Date.now(), updatedAt: Date.now(), projectId: proj ? proj.id : null, mode,
      workspace: proj && proj.path ? proj.path : (mode === 'agent' ? (S.settings.lastWorkspace || '') : ''), messages: [],
    };
  }
  S.attachments = [];
  endRemote(false);
  setView('chat');
  renderConv();
  renderChrome();
  renderConvList();
  refreshChangesPanel();
  refreshFilesPanel();
  watchLive();
  $('#input').focus();
}

async function openConv(id) {
  if (S.conv && S.conv.id === id) { setView('chat'); return; }
  if (S.busy) stopRun();
  await flushPersist(id); // 방금 전의 변경이 아직 저장되지 않았다면 먼저 저장한다
  const c = await exa.loadConv(id);
  if (!c) { toast('대화를 불러오지 못했습니다', 'err'); return; }
  for (const m of c.messages) { if (m.streaming) m.streaming = false; }
  c.messages = c.messages.filter((m) => !(m.role === 'compact' && !m.summary));
  c.mode = c.mode === 'agent' ? 'agent' : 'chat';
  const tab = c.code ? 'code' : 'chat';
  if (curTab() !== tab) saveSettings({ ui: { tab } });
  if (c.code) loadCodeMemory(c.workspace);
  endRemote(false);
  S.conv = c;
  S.attachments = [];
  setView('chat');
  renderConv();
  renderChrome();
  renderConvList();
  refreshChangesPanel();
  refreshFilesPanel();
  watchLive();
}

// ----- Code 탭 -----
const codeMemory = new Map(); // 작업 폴더 -> EXAONE.md 메모리 글
function loadCodeMemory(cwd) {
  if (!cwd || codeMemory.has(cwd)) return;
  codeMemory.set(cwd, '');
  exa.codeMemory(cwd).then((t) => codeMemory.set(cwd, t || '')).catch(() => {});
}

/**
 * 터미널 쪽에서 이 세션에 글이 더 쌓였으면 다시 읽어 온다 (앱이 옛 내용으로 덮어쓰지 않게).
 * force 면 바뀌지 않았어도 기록 파일의 내용으로 맞춘다 (실시간으로 따라 그린 작업이 끝났을 때).
 */
async function syncCodeConv(force) {
  const conv = S.conv;
  if (!conv || !conv.code || S.busy || S.remote || (!conv._mtime && !force) || syncCodeConv.running) return false;
  syncCodeConv.running = true;
  try { return await syncCodeConvNow(conv, force); } finally { syncCodeConv.running = false; }
}
async function syncCodeConvNow(conv, force) {
  let st = null;
  try { st = await exa.codeStat(conv.code.id); } catch { return false; }
  if (!st || (!force && st.mtime === conv._mtime) || S.conv !== conv || S.busy || S.remote) return false;
  const fresh = await exa.loadConv(conv.id);
  if (!fresh || S.conv !== conv || S.busy || S.remote) return false;
  conv.messages = fresh.messages; conv.title = fresh.title; conv._mtime = fresh._mtime; conv.updatedAt = fresh.updatedAt;
  // 맨 아래를 보고 있었으면 새 글을 따라가고, 위쪽을 읽고 있었으면 그 자리를 지킨다.
  const follow = nearBottom(), top = scrollEl().scrollTop;
  renderConv(); renderChrome();
  if (!follow) requestAnimationFrame(() => { scrollEl().scrollTop = top; stick = false; $('#btn-bottom').hidden = false; });
  return true;
}

// ---------- 실시간 연동 (Code 탭 ↔ 터미널) ----------
// 앱이 실행하는 작업은 터미널이 그대로 따라 그릴 수 있게 알리고(liveEmit),
// 터미널이 실행하는 작업은 여기서 그대로 따라 그린다(applyLive).
const liveOut = { sid: null, q: [], timer: null };
function liveFlush() {
  clearTimeout(liveOut.timer);
  liveOut.timer = null;
  if (liveOut.sid && liveOut.q.length) exa.liveEmit(liveOut.sid, liveOut.q.splice(0));
}
function liveEmit(t, ...a) {
  if (!liveOut.sid) return;
  liveOut.q.push({ t, a });
  if (!liveOut.timer) liveOut.timer = setTimeout(liveFlush, 40);
}
async function liveStart(conv, display) {
  if (!conv.code || liveOut.sid) return;
  try { if (await exa.liveBegin({ sid: conv.code.id, cwd: conv.workspace, info: { display } })) liveOut.sid = conv.code.id; } catch { /* 알리지 못해도 작업은 한다 */ }
}
async function liveFinish(stats) {
  if (!liveOut.sid) return;
  liveEmit('turnEnd', stats || {});
  liveFlush();
  const sid = liveOut.sid;
  liveOut.sid = null;
  try { await exa.liveEnd(sid); } catch { /* 무시 */ }
}

/** 지금 보고 있는 대화가 Code 세션이면 그 세션의 실시간 통로를 지켜본다. */
function watchLive() {
  const conv = S.conv;
  try { exa.liveWatch(conv && conv.code && conv.workspace ? { sid: conv.code.id, cwd: conv.workspace } : null); } catch { /* 무시 */ }
}

function setRemoteBusy() {
  document.body.classList.toggle('busy', S.busy || !!S.remote);
  renderSendButton();
  renderHint();
}

function remoteStepEnd(r) {
  if (!r.asst) return;
  r.asst.streaming = false;
  for (const tc of r.asst.toolCalls) if (tc.pending) toolState.delete(tc.id);
  r.asst.toolCalls = r.asst.toolCalls.filter((tc) => !tc.pending);
  updateAssistant(r.asst);
  r.asst = null;
}

/** 터미널의 작업이 끝났다(또는 다른 대화로 넘어간다): 따라 그리던 상태를 정리하고, reload 면 기록 파일의 내용으로 맞춘다. */
function endRemote(reload) {
  const r = S.remote;
  if (!r) return;
  clearInterval(r.tick);
  remoteStepEnd(r);
  for (const m of r.conv.messages) if (m.live) for (const tc of m.toolCalls || []) toolState.delete(tc.id);
  S.remote = null;
  setRemoteBusy();
  refreshProgressPanel();
  if (reload && S.conv === r.conv) syncCodeConv(true);
}

let liveChain = Promise.resolve();
/** 터미널에서 온 사건들을 순서대로 화면에 반영한다. */
function onLiveEvents(sid, events) {
  liveChain = liveChain.then(async () => {
    for (const e of events) {
      if (!S.conv || !S.conv.code || S.conv.code.id !== sid) return;
      try { await applyLive(e); } catch (err) { console.error(err); }
    }
  });
}

async function applyLive(e) {
  const conv = S.conv;
  const a = Array.isArray(e.a) ? e.a : [];
  if (e.t === 'turnStart') {
    if (S.busy) return; // 우리가 실행 중이면 따라 그리지 않는다
    if (S.remote) endRemote(false);
    const info = a[0] || {};
    // 터미널이 이 지시를 시작하기 전까지의 기록과 맞춘다 (늦게 열었으면 이미 저장된 부분을 걷어 내고 처음부터 따라 그린다).
    if (typeof info.base === 'number' && info.base !== conv.messages.length) {
      if (info.base > conv.messages.length) await syncCodeConv(true);
      if (S.conv !== conv) return;
      if (conv.messages.length > info.base) { conv.messages.length = info.base; renderConv(); }
    }
    const r = S.remote = { n: e.n, conv, asst: null, last: Date.now(), tick: null, wait: null, runningId: null };
    const follow = nearBottom(); // 맨 아래를 보고 있었을 때만 따라 내려간다 (위쪽을 읽는 중이면 그 자리를 지킨다)
    const text = String(info.display || '');
    if (text) {
      const m = { id: uid('m'), role: 'user', content: text, attachments: [], ts: Date.now(), live: true };
      const first = !conv.messages.length;
      conv.messages.push(m);
      if (!conv.title) conv.title = makeTitle(text);
      if (first) { dockComposer(null); setProjectHome(false); $('#messages').innerHTML = ''; renderChrome(); }
      $('#messages').append(buildUser(m));
    }
    // 1초마다 경과 시간을 갱신하고, 터미널이 말없이 사라졌으면 기다리지 않는다.
    r.tick = setInterval(() => {
      if (r.asst && r.retry) r.asst.notice = Retry.label(r.retry.info, r.retry.until - Date.now());
      if (r.asst) updateAssistant(r.asst);
      if (Date.now() - r.last > 12000) endRemote(true);
    }, 500);
    setRemoteBusy();
    if (follow) scrollToBottom(); else $('#btn-bottom').hidden = false;
    return;
  }
  const r = S.remote;
  if (!r || e.n !== r.n || r.conv !== conv) return;
  r.last = Date.now();
  const cur = () => {
    if (!r.asst) {
      r.asst = { id: uid('m'), role: 'assistant', content: '', reasoning: '', toolCalls: [], ts: Date.now(), streaming: true, stats: { start: Date.now() }, live: true };
      conv.messages.push(r.asst);
    }
    return r.asst;
  };
  switch (e.t) {
    case 'hb': return;
    case 'liveEnd': endRemote(true); return;
    case 'turnEnd': return;
    case 'wait': r.wait = a[0] || 'approval'; renderHint(); return;
    case 'waitEnd': r.wait = null; renderHint(); return;
    case 'requestStart':
      if (r.retry && r.asst) { r.retry = null; r.asst.notice = null; r.asst.stats = { start: Date.now() }; break; } // 다시 시도: 같은 답변 자리에 이어서 받는다
      remoteStepEnd(r); cur(); break;
    case 'thinkingStart': cur().stats.thinkStart = performance.now(); break;
    case 'reasoning': { const m = cur(); if (!m.stats.thinkStart) m.stats.thinkStart = performance.now(); m.reasoning += a[0] || ''; break; }
    case 'thinkingEnd': { const m = cur(); m.stats.thinkMs = Number(a[0]) || 0; if (!m.reasoning && a[1]) m.reasoning = String(a[1]); break; }
    case 'contentStart': cur(); break;
    case 'content': cur().content += a[0] || ''; break;
    case 'contentEnd': break;
    case 'toolBuilding': {
      const id = 'live_' + uid('t');
      cur().toolCalls.push({ id, name: (a[0] || {}).name || '', arguments: '', pending: true });
      toolState.set(id, { status: 'pending', live: '' });
      break;
    }
    case 'toolStart': case 'toolEnd': {
      const tc = a[0] || {}, args = a[1] || {};
      const m = cur();
      let call = m.toolCalls.find((x) => x.id === tc.id) || m.toolCalls.find((x) => x.pending && x.name === tc.name);
      if (!call) { call = { id: tc.id, name: tc.name, arguments: '' }; m.toolCalls.push(call); }
      if (call.pending) { toolState.delete(call.id); call.pending = false; }
      call.id = tc.id; call.name = tc.name; call.arguments = JSON.stringify(args);
      if (e.t === 'toolStart') { toolState.set(tc.id, { status: 'running', live: '', startedAt: Date.now() }); r.runningId = tc.id; }
      else {
        toolState.delete(tc.id);
        r.runningId = null;
        const res = a[2] || {};
        conv.messages.push({ id: uid('m'), role: 'tool', toolCallId: tc.id, name: tc.name, content: String(res.content == null ? '' : res.content),
          status: res.ok ? 'ok' : res.rejected ? 'denied' : 'error', meta: res.meta || {}, ts: Date.now(), live: true });
        if (res.ok && (tc.name === 'write_file' || tc.name === 'edit_file')) {
          refreshChangesPanel(); refreshFilesPanel();
          if (res.meta && res.meta.path) autoPreview(r, conv, res.meta.path);
        }
        if (res.ok && tc.name === 'update_plan' && !r.planShown && S.settings.autoProgress !== false) { r.planShown = true; showPanel('progress'); }
        refreshProgressPanel();
      }
      break;
    }
    case 'toolOutput': { const st = r.runningId && toolState.get(r.runningId); if (st) st.live = (st.live + (a[0] || '')).slice(-20000); break; }
    case 'error': cur().error = String(a[0] || ''); break;
    case 'interrupted': cur().aborted = true; break;
    case 'retryWait': {
      // 터미널이 다시 시도를 기다리는 중: 받다 만 내용은 지우고, 남은 시간을 줄여 가며 보여 준다.
      const m = cur();
      m.content = ''; m.reasoning = '';
      for (const tc of m.toolCalls) toolState.delete(tc.id);
      m.toolCalls = [];
      r.retry = { until: Date.now() + (Number(a[0]) || 0), info: a[1] || { reason: '요청 한도 초과', attempt: 1, max: 1 } };
      m.notice = Retry.label(r.retry.info, r.retry.until - Date.now());
      break;
    }
    default: return;
  }
  if (r.asst) { updateAssistant(r.asst); stickBottom(); }
}

const persistTimers = new Map();  // 대화 id -> 저장 예약 타이머
const persistPending = new Map(); // 대화 id -> 저장을 기다리는 대화 (아직 디스크에 없는 변경이 있다)
async function saveNow(conv) {
  // 터미널이 이 세션에서 작업 중이면 기록 파일은 터미널이 쓴다 (따라 그리던 내용으로 덮어쓰지 않는다).
  if (S.remote && S.remote.conv === conv) return;
  const copy = { ...conv, messages: conv.messages.map((m) => { const { streaming, notice, ...rest } = m; return rest; }) };
  try {
    const r = await exa.saveConv(copy);
    if (conv.code && r && r.mtime) conv._mtime = r.mtime;
    if (conv.code && r && r.error) toast('세션을 저장하지 못했습니다: ' + r.error, 'err');
  } catch (e) { console.error(e); }
  if (conv.code) { refreshCliSessions(true); return; }
  S.convs = await exa.listConvs();
  renderConvList();
}
function persist(conv, immediate) {
  if (!conv || !conv.messages.length) return;
  conv.updatedAt = Date.now();
  clearTimeout(persistTimers.get(conv.id));
  persistTimers.delete(conv.id);
  if (immediate) { persistPending.delete(conv.id); return saveNow(conv); }
  persistPending.set(conv.id, conv);
  persistTimers.set(conv.id, setTimeout(() => { persistTimers.delete(conv.id); persistPending.delete(conv.id); saveNow(conv); }, 400));
  return undefined;
}
/** 저장을 기다리는 변경이 있으면 지금 저장한다. 디스크의 대화를 직접 읽거나 고치기 전에 부른다. */
async function flushPersist(id) {
  const conv = persistPending.get(id);
  if (!conv) return;
  clearTimeout(persistTimers.get(id));
  persistTimers.delete(id);
  persistPending.delete(id);
  await saveNow(conv);
}

function makeTitle(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length > 42 ? t.slice(0, 42) + '…' : t || '새 대화';
}

// ---------- API 요청 조립 ----------
function userContent(m) {
  if (m.apiContent != null) return m.apiContent; // 터미널 세션에서 불러온 메시지: 모델에 보낼 원문이 따로 있다
  let s = '';
  for (const a of m.attachments || []) s += `<file name="${a.name}">\n${a.text}\n</file>\n\n`;
  return s + (m.content || '');
}

function agentPrompt(conv) {
  const a = S.settings.agent;
  const askOn = !!S.askUser.prompt && !(a.disabledTools || []).includes('ask_user');
  const lines = [
    'You are EXAONE working as a hands-on agent inside the EXAONE Desktop app on the user\'s computer.',
    '',
    'Environment',
    `- OS: ${S.env.osLabel || S.env.platform}; shell used by run_command: ${S.env.shell}`,
    `- Workspace (every tool path is relative to it, commands run in it): ${conv.workspace}`,
    `- Today: ${new Date().toISOString().slice(0, 10)}`,
    `- Permission mode: ${a.approval === 'readonly' ? 'read-only (no file changes, commands or network)' : a.approval === 'ask' ? 'the user approves each file change, command and web request' : 'full auto'}`,
    '',
    'How to work',
    '- Inspect before you answer: use list_dir / find_files / search_files / read_file instead of guessing what files contain.',
    askOn ? S.askUser.prompt : null,
    '- Keep your thinking short. Never draft whole files or long code in your reasoning: decide the approach in a few lines, then put the complete content directly into the write_file / edit_file call.',
    '- Act through tool calls. To create or change a file you must call write_file / edit_file; describing the file in your answer does not create it.',
    '- For work with several steps, call update_plan first and keep it current as steps finish.',
    '- Change existing files with edit_file (exact, unique old_string); use write_file only for new files or full rewrites.',
    '- Keep changes minimal and focused on the request. Do not touch files outside the workspace.',
    '- If a tool call fails or is denied, read the message, adjust, and do not repeat the same call unchanged.',
    '- When done, reply briefly in the user\'s language with what you did and anything they should check.',
  ];
  return lines.filter((l) => l != null).join('\n');
}

/** 프로젝트의 설명 · 지침 · 메모리 · 링크를 system 메시지에 넣을 글로 만든다. */
function projectPrompt(proj, conv) {
  if (!proj) return '';
  const desc = (proj.description || '').trim();
  const inst = (proj.instructions || '').trim();
  const mem = (proj.memory || '').trim();
  const links = (proj.links || []).filter((l) => l && l.url);
  if (!desc && !inst && !mem && !links.length) return '';
  let s = `# Project: ${proj.name}`;
  if (desc) s += `\n${desc}`;
  if (inst) s += `\n${inst}`;
  if (mem) s += `\n\n## Project memory\nNotes the user keeps for every task in this project:\n${mem}`;
  if (links.length) {
    s += `\n\n## Reference links${conv && conv.mode === 'agent' ? ' (read them with web_fetch when they are relevant)' : ''}\n`
      + links.map((l) => `- ${l.title ? l.title + ': ' : ''}${l.url}`).join('\n');
  }
  return s;
}

function systemPrompt(conv) {
  const parts = [];
  const sp = (S.settings.systemPrompt || '').trim();
  if (sp) parts.push(sp);
  const pp = projectPrompt(projectOf(conv), conv);
  if (pp) parts.push(pp);
  if (conv.mode === 'agent') parts.push(agentPrompt(conv));
  // Code 탭: 터미널의 EXAONE Code 처럼 그 폴더의 EXAONE.md 메모리를 함께 넣는다.
  if (conv.code && codeMemory.get(conv.workspace)) parts.push(codeMemory.get(conv.workspace));
  return parts.join('\n\n');
}

function parseCustomTools() {
  const j = tryJson(S.settings.customTools.json || '');
  if (!Array.isArray(j)) return [];
  const out = [];
  for (const t of j) {
    const f = t && t.function ? t.function : t;
    if (!f || typeof f.name !== 'string' || !f.name) continue;
    out.push({ type: 'function', function: { name: f.name, description: f.description || '', parameters: f.parameters || { type: 'object', properties: {} } } });
  }
  return out;
}

function activeTools(conv) {
  const list = [];
  if (conv.mode === 'agent') {
    const a = S.settings.agent;
    for (const t of S.toolDefs) {
      if ((a.disabledTools || []).includes(t.name)) continue;
      if (a.approval === 'readonly' && t.category !== 'read') continue;
      list.push(t.def);
    }
  }
  if (S.settings.customTools.enabled) {
    for (const d of parseCustomTools()) if (!list.some((x) => x.function.name === d.function.name)) list.push(d);
  }
  return list;
}

/** upto 번째 메시지 앞까지에서 마지막으로 끝난 압축 지점의 위치 (없으면 -1) */
function compactIndex(conv, upto = conv.messages.length) {
  for (let i = Math.min(upto, conv.messages.length) - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === 'compact' && m.summary) return i;
  }
  return -1;
}

function buildApiMessages(conv, upto = conv.messages.length) {
  const out = [];
  const sys = systemPrompt(conv);
  if (sys) out.push({ role: 'system', content: sys });
  // 압축된 대화: 압축 지점 앞의 메시지는 보내지 않고 요약으로 대신한다.
  const ci = compactIndex(conv, upto);
  const list = conv.messages.slice(ci + 1, upto);
  if (ci >= 0) {
    const next = list.find((m) => m.role === 'user' || (m.role === 'assistant' && (m.content || (m.toolCalls || []).length)));
    const resume = !next || next.role !== 'user'; // 작업 도중에 압축했다면 요약만 보고 바로 이어서 하게 한다
    out.push({ role: 'user', content: COMPACT_HEAD + conv.messages[ci].summary + (resume ? COMPACT_RESUME : '') });
    if (!resume) out.push({ role: 'assistant', content: '요약한 맥락을 확인했습니다. 이어서 진행하겠습니다.' });
  }
  for (const m of list) {
    if (m.role === 'user') out.push({ role: 'user', content: userContent(m) });
    else if (m.role === 'assistant') {
      const calls = m.toolCalls || [];
      if (!m.content && !calls.length) continue; // 오류·중단으로 비어 있는 응답
      const am = { role: 'assistant', content: m.content || '' };
      if (S.settings.sendReasoning && m.reasoning) am.reasoning_content = m.reasoning;
      if (calls.length) {
        am.tool_calls = calls.map((tc) => ({
          id: tc.id, type: 'function',
          function: { name: tc.name, arguments: tryJson(tc.arguments || '{}') === undefined ? '{}' : (tc.arguments || '{}') },
        }));
      }
      out.push(am);
      for (const tc of calls) {
        const tm = conv.messages.find((x) => x.role === 'tool' && x.toolCallId === tc.id);
        out.push({ role: 'tool', tool_call_id: tc.id, content: tm ? tm.content : '(실행되지 않음: 사용자가 중단함)' });
      }
    }
  }
  return out;
}

function buildBody(conv) {
  const p = S.settings.params;
  const body = { model: S.settings.model, messages: buildApiMessages(conv), stream: !!p.stream };
  if (p.stream) body.stream_options = { include_usage: true };
  body.reasoning_effort = effortOf(conv);
  body.temperature = Number(p.temperature);
  body.top_p = Number(p.top_p);
  if (p.top_k != null && Number(p.top_k) !== -1) body.top_k = Number(p.top_k);
  if (Number(p.presence_penalty)) body.presence_penalty = Number(p.presence_penalty);
  if (Number(p.max_tokens) > 0) body.max_tokens = Number(p.max_tokens);
  if (p.preserve_thinking || conv.mode === 'agent') body.chat_template_kwargs = { preserve_thinking: true };
  const tools = activeTools(conv);
  if (tools.length) {
    body.tools = tools;
    const tc = S.settings.agent.toolChoice;
    if (tc && tc !== 'auto') body.tool_choice = tc;
  }
  const st = S.settings.structured;
  if (st.mode === 'json_object') body.response_format = { type: 'json_object' };
  else if (st.mode === 'json_schema') {
    const schema = tryJson(st.schema);
    if (!schema || typeof schema !== 'object') throw new Error('구조화 출력의 JSON 스키마가 올바른 JSON 이 아닙니다. 설정 → 출력 형식에서 수정하세요.');
    body.response_format = { type: 'json_schema', json_schema: { name: st.name || 'response', strict: !!st.strict, schema } };
  }
  return body;
}

// ---------- 실행 루프 ----------
let busyTicker = null;
function setBusy(b) {
  S.busy = b;
  document.body.classList.toggle('busy', b);
  renderSendButton();
  // 작업 중에는 1초마다 경과 시간(생각·도구 실행)을 갱신한다.
  clearInterval(busyTicker);
  busyTicker = b ? setInterval(() => {
    const conv = S.run && S.run.conv;
    const last = conv && S.conv === conv ? lastAssistant(conv) : null;
    if (last) updateAssistant(last);
  }, 1000) : null;
}

async function runTurn(conv) {
  if (S.busy) return;
  const run = S.run = { conv, aborted: false, reqId: null, t0: Date.now() };
  setBusy(true);
  try {
    // Code 세션: 같은 세션을 보고 있는 터미널이 따라 그릴 수 있게 알린다 (send 에서 이미 시작했으면 그대로).
    if (conv.code && !liveOut.sid) {
      let lastUser = null;
      for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].role === 'user') { lastUser = conv.messages[i]; break; }
      await liveStart(conv, lastUser ? lastUser.content : '');
    }
    const maxSteps = conv.mode === 'agent' ? Math.max(1, Number(S.settings.agent.maxSteps) || 25) : 8;
    for (let step = 0; step < maxSteps && !run.aborted; step++) {
      // 대화가 길어져 컨텍스트 사용량이 기준을 넘으면 이전 내용을 요약으로 바꾸고 이어 간다.
      if (shouldAutoCompact(conv)) { await compactConv(run, conv, { auto: true }); if (run.aborted) break; }
      const asst = { id: uid('m'), role: 'assistant', content: '', reasoning: '', toolCalls: [], ts: Date.now(), streaming: true, stats: {} };
      conv.messages.push(asst);
      refreshFooters();
      updateAssistant(asst);
      scrollToBottom();
      const r = await streamAssistant(run, conv, asst);
      persist(conv);
      if (!r.ok || !asst.toolCalls.length) break;
      for (const tc of asst.toolCalls) {
        if (run.aborted) break;
        await execToolCall(run, conv, asst, tc);
      }
      updateAssistant(asst);
      persist(conv);
      if (step === maxSteps - 1 && !run.aborted) {
        asst.error = `최대 단계 수(${maxSteps})에 도달해 멈췄습니다. 계속하려면 "계속"이라고 보내세요.`;
        updateAssistant(asst);
      }
    }
  } catch (e) {
    console.error(e);
    toast(String(e && e.message || e), 'err');
  } finally {
    S.run = null;
    setBusy(false);
    refreshProgressPanel();
    if (conv.mode === 'agent') attachTurnChanges(conv);
    refreshChangesPanel();
    refreshFooters();
    renderChrome();
    if (liveOut.sid) {
      // 기록 파일을 먼저 저장한 뒤에 "끝났다" 고 알린다 (터미널이 곧바로 그 파일을 읽는다).
      let from = 0;
      for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].role === 'user') { from = i; break; }
      const steps = conv.messages.slice(from).filter((m) => m.role === 'assistant' && m.usage);
      const sum = (f) => steps.reduce((n, m) => n + (f(m.usage) || 0), 0);
      const stats = {
        ms: Date.now() - run.t0, turns: steps.length,
        prompt: steps.length ? steps[steps.length - 1].usage.prompt_tokens || 0 : 0,
        completion: sum((u) => u.completion_tokens),
        reasoning: sum((u) => (u.reasoning_tokens != null ? u.reasoning_tokens : (u.completion_tokens_details || {}).reasoning_tokens)),
      };
      try { await persist(conv, true); } catch (e) { console.error(e); }
      await liveFinish(stats);
    } else persist(conv);
  }
}

// ---------- 대화 압축 ----------
// 기준은 Claude Code 의 자동 압축과 같은 식을 EXAONE 의 컨텍스트 창(524,288 토큰)에 적용한 것이다:
//   쓸 수 있는 창 = 컨텍스트 창 − 요약 출력용으로 남겨 두는 토큰
//   자동 압축 기준 = 쓸 수 있는 창 − 여유분
// 요청을 보내기 직전마다 (에이전트의 단계 사이에서도) 확인한다.
const COMPACT_RESERVE = 20000; // 요약 출력용 (EXAONE 의 max_tokens 는 추론 토큰까지 포함한다)
const COMPACT_BUFFER = 13000;  // 여유분
const COMPACT_MAX_FAILS = 3;   // 연달아 이만큼 실패하면 그 대화에서는 자동 압축을 더 시도하지 않는다
const compactFails = new Map(); // 대화 id -> 연속 실패 횟수
const COMPACT_ASK = '지금까지의 대화를 자세히 요약하세요. 이 요약이 대화의 앞부분을 대신해 이후 작업의 유일한 맥락이 됩니다. 도구는 호출하지 말고 글로만 답하세요.\n\n'
  + '먼저 <analysis> 태그 안에서 대화를 처음부터 차례로 훑으며 빠뜨린 것이 없는지 점검하고, 이어서 <summary> 태그 안에 아래 항목을 이 순서와 제목 그대로 작성하세요.\n\n'
  + '1. 주요 요청과 의도: 사용자가 명시적으로 요청한 것을 빠짐없이\n'
  + '2. 핵심 기술 개념: 다룬 기술 · 프레임워크 · 개념\n'
  + '3. 파일과 코드: 읽거나 만들거나 고친 파일, 왜 중요한지, 바뀐 내용과 중요한 코드 조각\n'
  + '4. 오류와 해결: 만난 오류와 고친 방법, 사용자가 지적한 점\n'
  + '5. 문제 해결: 해결한 문제와 진행 중인 문제 해결\n'
  + '6. 사용자 메시지 전체: 도구 결과를 뺀 사용자의 메시지를 모두 (의도가 어떻게 바뀌었는지 알 수 있게)\n'
  + '7. 남은 작업: 명시적으로 요청받았지만 아직 하지 않은 일\n'
  + '8. 현재 작업: 이 요약 직전에 하고 있던 일을 파일 이름 · 코드와 함께 구체적으로\n'
  + '9. 다음 단계: 현재 작업에 바로 이어지는 다음 한 걸음 (사용자의 최근 요청과 직접 관련된 것만)\n\n'
  + '도구는 호출하지 마세요. <analysis> 와 <summary> 두 블록만 출력하세요.';
const COMPACT_HEAD = '이 세션은 컨텍스트가 가득 차서 이전 대화에서 이어지는 것입니다. 아래 요약이 대화의 앞부분을 대신합니다.\n\n';
const COMPACT_RESUME = '\n\n사용자에게 더 묻지 말고 중단된 지점에서 바로 이어서 진행하세요. 요약을 받았다는 말이나 요약의 되풀이는 하지 마세요.';

function compactThreshold() {
  const c = S.settings.compact || {};
  if (c.auto === false) return Infinity;
  if (Number(c.threshold) > 0) return Number(c.threshold); // 시험용: 기준 토큰 수를 직접 지정
  return CTX_LIMIT - COMPACT_RESERVE - COMPACT_BUFFER;
}

/**
 * 다음 요청이 차지할 컨텍스트의 추정치: 마지막 응답이 알려 준 실제 사용량(입력 + 출력)에,
 * 그 뒤에 덧붙은 메시지(도구 결과 · 새 사용자 메시지)의 어림값을 더한다.
 * 한글은 한 글자가 한 토큰에 가까워 글자 수 ÷ 2 로 넉넉하게 잡는다.
 */
function ctxEstimate(conv) {
  let chars = 0;
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === 'compact' && m.summary) return (m.after || 0) + Math.ceil(chars / 2);
    if (m.usage) return (m.usage.prompt_tokens || 0) + (m.usage.completion_tokens || 0) + Math.ceil(chars / 2);
    if (m.role === 'user') chars += userContent(m).length;
    else if (m.role === 'tool') chars += String(m.content || '').length;
    else if (m.role === 'assistant') chars += (m.content || '').length + (m.toolCalls || []).reduce((n, tc) => n + (tc.arguments || '').length, 0);
  }
  return Math.ceil((chars + systemPrompt(conv).length) / 2); // 아직 응답을 한 번도 받지 않은 대화
}

function shouldAutoCompact(conv) {
  return (compactFails.get(conv.id) || 0) < COMPACT_MAX_FAILS && ctxEstimate(conv) >= compactThreshold();
}

/** 화면에 그리지 않는 한 번짜리 요청. 요약처럼 답만 필요할 때 쓴다. */
/** 본문만 받는 요청 (대화 압축용). 네트워크 문제 등으로 실패하면 채팅과 같은 규칙으로 다시 보낸다. */
async function requestText(run, body) {
  for (let attempt = 1; ; attempt++) {
    const res = await requestTextOnce(run, body);
    const wait = res.err && !res.aborted && !run.aborted ? Retry.delay(res.err, attempt, maxRetries()) : null;
    if (wait == null) return res;
    await new Promise((done) => {
      const end = () => { clearTimeout(t); run.cancelWait = null; done(); };
      const t = setTimeout(end, wait);
      run.cancelWait = end;
    });
    if (run.aborted) return { ...res, error: null, aborted: true };
  }
}
function requestTextOnce(run, body) {
  return new Promise((resolve) => {
    const reqId = uid('r');
    run.reqId = reqId;
    const log = newLog(reqId, body);
    const t0 = performance.now();
    const res = { content: '', reasoning: '', usage: null, error: null, aborted: false, finish: null };
    chatHandlers.set(reqId, (ev) => {
      switch (ev.type) {
        case 'request': log.url = ev.url; break;
        case 'response': log.status = ev.status; log.headers = ev.headers || {}; updateRate(ev.headers); break;
        case 'reasoning': res.reasoning += ev.text; break;
        case 'content': res.content += ev.text; break;
        case 'usage': res.usage = ev.usage; log.usage = ev.usage; break;
        case 'finish': res.finish = ev.finishReason; log.finish = ev.finishReason; break;
        case 'error': res.err = ev; res.error = (ev.status ? `HTTP ${ev.status} · ` : '') + ev.message; log.error = ev.message; if (ev.status && !log.status) log.status = ev.status; break;
        case 'aborted': res.aborted = true; log.error = '사용자 중단'; break;
        case 'done':
          chatHandlers.delete(reqId);
          log.raw = ev.raw || ''; log.rawTotal = ev.rawTotal; log.stream = ev.stream || null; log.incomplete = !!ev.incomplete;
          log.ms = Math.round(performance.now() - t0);
          if (ev.incomplete && !res.error && !res.aborted) res.error = '응답이 완료 신호 없이 끊겼습니다';
          saveLogFile(log);
          renderLogBadge();
          if (S.view === 'logs') renderLogs();
          res.ms = log.ms;
          resolve(res);
          break;
      }
    });
    exa.chatStart(reqId, body).catch((e) => {
      const hnd = chatHandlers.get(reqId);
      if (hnd) { hnd({ type: 'error', status: 0, message: String(e && e.message || e) }); hnd({ type: 'done', raw: '' }); }
    });
  });
}

/**
 * 이전 대화를 요약으로 바꾼다. 대화 기록에는 압축 지점(role: 'compact')이 남고,
 * 그 앞의 메시지는 화면에는 그대로 보이지만 더 이상 모델에 보내지 않는다.
 */
async function compactConv(run, conv, { auto = false, instructions = '' } = {}) {
  // 아직 답을 받지 못한 마지막 사용자 메시지는 요약에 넣지 않고 압축 지점 뒤에 둔다.
  let end = conv.messages.length;
  if (end && conv.messages[end - 1].role === 'user') end--;
  const from = compactIndex(conv, end) + 1;
  if (!conv.messages.slice(from, end).some((m) => m.role === 'assistant' && (m.content || (m.toolCalls || []).length))) return { skipped: true };

  const p = S.settings.params;
  const body = {
    model: S.settings.model,
    messages: buildApiMessages(conv, end).concat({ role: 'user', content: COMPACT_ASK + (instructions ? '\n\n추가 지시: ' + instructions : '') }),
    stream: true, stream_options: { include_usage: true },
    reasoning_effort: 'low', temperature: Number(p.temperature), top_p: Number(p.top_p),
    max_tokens: COMPACT_RESERVE,
  };
  const before = ctxUsed();
  liveEmit('compactStart');
  const marker = { id: uid('m'), role: 'compact', ts: Date.now(), auto, running: true, summary: '', before };
  conv.messages.splice(end, 0, marker);
  if (S.conv === conv) renderConv();
  const r = await requestText(run, body);
  // <analysis> 는 점검용 초안이라 버리고 <summary> 안의 내용만 쓴다.
  const raw = (r.content || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const sm = /<summary>([\s\S]*?)(<\/summary>|$)/.exec(raw);
  const text = (sm ? sm[1] : raw.replace(/<analysis>[\s\S]*?(<\/analysis>|$)/g, '')).trim();
  if (r.error || r.aborted || !text) {
    conv.messages.splice(conv.messages.indexOf(marker), 1);
    if (S.conv === conv) renderConv();
    if (!r.aborted) {
      const n = (compactFails.get(conv.id) || 0) + 1;
      compactFails.set(conv.id, n);
      toast('대화 압축 실패: ' + (r.error || '요약이 비어 있습니다') + (auto && n >= COMPACT_MAX_FAILS ? ` — ${n}번 연달아 실패해 이 대화에서는 자동 압축을 멈춥니다 (/compact 로 직접 실행 가능)` : ''), 'err');
    }
    liveEmit('compactEnd', { error: r.error || '중단됨' });
    return { error: r.error || 'aborted' };
  }
  liveEmit('compactEnd', { before: end });
  compactFails.delete(conv.id);
  marker.running = false;
  marker.summary = text;
  marker.ms = r.ms;
  marker.after = r.usage && r.usage.completion_tokens ? r.usage.completion_tokens - (r.usage.reasoning_tokens || 0) : Math.round(text.length / 2);
  if (S.conv === conv) { renderConv(); renderCtxMeter(); }
  persist(conv, true);
  return { ok: true };
}

/** 사용자가 직접 실행하는 압축 (/compact) */
async function compactNow(instructions) {
  const conv = S.conv;
  if (!conv || S.busy) return;
  const run = S.run = { conv, aborted: false, reqId: null };
  setBusy(true);
  try {
    const r = await compactConv(run, conv, { instructions });
    if (r.skipped) toast('압축할 대화가 없습니다');
    else if (r.ok) toast('이전 대화를 요약으로 압축했습니다');
  } finally {
    S.run = null;
    setBusy(false);
    renderChrome();
  }
}

function buildCompact(m) {
  const fmtTok = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n));
  if (m.running) {
    return h('div', { class: 'compact-mark live', dataset: { id: m.id } }, h('span', { class: 'cm-line' }),
      h('span', { class: 'cm-label' }, icon('spark', 13), m.auto ? '대화가 길어져 이전 내용을 요약으로 압축하는 중…' : '이전 대화를 요약으로 압축하는 중…'), h('span', { class: 'cm-line' }));
  }
  const size = m.before ? ` · ${fmtTok(m.before)} → 약 ${fmtTok(m.after || 0)} 토큰` : '';
  return h('details', { class: 'compact-mark', dataset: { id: m.id } },
    h('summary', null, h('span', { class: 'cm-line' }),
      h('span', { class: 'cm-label', title: '눌러서 요약 보기' }, icon('chevRight', 12), `여기까지의 대화를 요약으로 압축했습니다${m.auto ? ' (자동)' : ''}${size}`),
      h('span', { class: 'cm-line' })),
    h('div', { class: 'cm-body md', html: Md.render(m.summary) }));
}

function newLog(reqId, body) {
  const log = { id: reqId, ts: Date.now(), kind: 'chat', url: '', body, status: null, headers: {}, usage: null, ms: null, error: null, raw: '', finish: null };
  S.logs.unshift(log);
  if (S.logs.length > 60) S.logs.pop();
  renderLogBadge();
  return log;
}

/** 실패한 요청을 다시 보내는 횟수 (기본 10). 설정 파일의 maxRetries 로 바꿀 수 있다. */
function maxRetries() {
  const n = S.settings && S.settings.maxRetries;
  return Number.isFinite(n) && n >= 0 ? n : Retry.MAX_RETRIES;
}

function streamAssistant(run, conv, asst) {
  return new Promise((resolve) => {
    // asst 는 아직 비어 있으므로 buildApiMessages 에서 자동으로 제외된다.
    let body;
    try { body = buildBody(conv); }
    catch (e) {
      asst.streaming = false; asst.error = e.message; updateAssistant(asst);
      return resolve({ ok: false });
    }
    asst.jsonMode = !!body.response_format;
    let attempt = 0;
    let ticker = null;
    let raf = 0;
    const schedule = () => { if (!raf) raf = setTimeout(() => { raf = 0; updateAssistant(asst); stickBottom(); }, 60); };

    const start = () => {
      const reqId = uid('r');
      run.reqId = reqId;
      const log = newLog(reqId, body);
      const t0 = performance.now();
      let err = null;
      let aborted = false;
      asst.stats = { start: Date.now() };
      const first = () => { if (asst.stats.ttftMs == null) asst.stats.ttftMs = Math.round(performance.now() - t0); };
      // 같은 세션을 보는 터미널에 알릴 사건의 진행 상태
      const lv = { think: false, thinkDone: false, content: false, contentDone: false, tools: new Set() };
      const lvEndThink = () => { if (lv.think && !lv.thinkDone) { lv.thinkDone = true; liveEmit('thinkingEnd', asst.stats.thinkStart ? Math.round(performance.now() - asst.stats.thinkStart) : 0, asst.reasoning); } };
      const lvEndContent = () => { if (lv.content && !lv.contentDone) { lv.contentDone = true; liveEmit('contentEnd'); } };
      ticker = setInterval(() => { if (asst.streaming) updateAssistant(asst); }, 1000);

      chatHandlers.set(reqId, (ev) => {
        switch (ev.type) {
          case 'request': log.url = ev.url; liveEmit('requestStart'); break;
          case 'response':
            log.status = ev.status; log.headers = ev.headers || {};
            asst.stats.latencyMs = ev.latencyMs;
            updateRate(ev.headers);
            break;
          case 'reasoning':
            first();
            if (!asst.reasoning) asst.stats.thinkStart = performance.now();
            asst.reasoning += ev.text;
            if (!lv.think) { lv.think = true; liveEmit('thinkingStart'); }
            liveEmit('reasoning', ev.text);
            schedule();
            break;
          case 'content':
            first();
            if (!asst.content && asst.stats.thinkStart && !asst.stats.thinkEnd) asst.stats.thinkEnd = performance.now();
            asst.content += ev.text;
            if (!lv.content) { lvEndThink(); lv.content = true; liveEmit('contentStart'); }
            liveEmit('content', ev.text);
            schedule();
            break;
          case 'tool_call': {
            first();
            if (asst.stats.thinkStart && !asst.stats.thinkEnd) asst.stats.thinkEnd = performance.now();
            let tc = asst.toolCalls[ev.index];
            if (!tc) tc = asst.toolCalls[ev.index] = { id: ev.id || uid('call_'), name: '', arguments: '' };
            if (ev.name && !tc.name) tc.name = ev.name;
            if (ev.args) tc.arguments += ev.args;
            if (tc.name && !lv.tools.has(ev.index)) { lv.tools.add(ev.index); lvEndThink(); lvEndContent(); liveEmit('toolBuilding', { name: tc.name }); }
            schedule();
            break;
          }
          case 'usage': asst.usage = ev.usage; log.usage = ev.usage; break;
          case 'finish': asst.finish = ev.finishReason; log.finish = ev.finishReason; break;
          case 'error': err = ev; log.error = ev.message; if (ev.status && !log.status) log.status = ev.status; break;
          case 'aborted': aborted = true; log.error = '사용자 중단'; break;
          case 'done': {
            lvEndThink(); lvEndContent();
            chatHandlers.delete(reqId);
            clearInterval(ticker);
            clearTimeout(raf); raf = 0;
            log.raw = ev.raw || '';
            log.rawTotal = ev.rawTotal;
            log.stream = ev.stream || null;
            log.incomplete = !!ev.incomplete;
            log.ms = Math.round(performance.now() - t0);
            if (ev.incomplete) log.error = '완료 신호(finish_reason) 없이 스트림 종료';
            saveLogFile(log);
            renderLogBadge();
            if (S.view === 'logs') renderLogs();
            asst.stats.totalMs = log.ms;
            if (asst.stats.thinkStart && !asst.stats.thinkEnd) asst.stats.thinkEnd = performance.now();
            asst.stats.thinkMs = asst.stats.thinkStart ? Math.round(asst.stats.thinkEnd - asst.stats.thinkStart) : null;
            delete asst.stats.thinkStart; delete asst.stats.thinkEnd;

            // 네트워크 문제(연결 실패 · 응답 도중 끊김)나 요청 한도 · 서버 오류는 간격을 늘려 가며 자동으로 다시 보낸다 (규칙: retry.js).
            const wait = err && !aborted && !run.aborted ? Retry.delay(err, attempt + 1, maxRetries()) : null;
            if (wait != null) {
              attempt++;
              const info = { attempt, max: maxRetries(), reason: Retry.reason(err) };
              liveEmit('retryWait', wait, info);
              // 받다 만 내용은 버리고 처음부터 다시 받는다.
              asst.content = ''; asst.reasoning = ''; asst.toolCalls = []; asst.usage = null; asst.finish = null;
              const el = msgEls.get(asst.id);
              if (el) { for (const card of el._cards) card.remove(); el._cards = []; regroupSig = ''; }
              // 다시 시도할 때까지 남은 시간을 줄여 가며 보여 준다.
              const until = Date.now() + wait;
              const tickRetry = () => { asst.notice = Retry.label(info, until - Date.now()); updateAssistant(asst); };
              tickRetry();
              const retryTicker = setInterval(tickRetry, 250);
              const go = (stopped) => {
                clearInterval(retryTicker); clearTimeout(timer); run.cancelWait = null; asst.notice = null;
                if (stopped || run.aborted) finishUp({ aborted: true }); else start();
              };
              const timer = setTimeout(go, wait);
              run.cancelWait = () => go(true); // 기다리는 중에 중지를 누르면 바로 멈춘다
              return;
            }
            if (err && attempt > 0 && Retry.retryable(err)) err = { ...err, message: err.message + ` (${attempt}번 다시 시도했지만 실패했습니다)` };
            finishUp({ err, aborted: aborted || run.aborted, incomplete: !!ev.incomplete, stream: ev.stream, ms: log.ms });
            break;
          }
        }
      });
      exa.chatStart(reqId, body).catch((e) => {
        const hnd = chatHandlers.get(reqId);
        if (hnd) { hnd({ type: 'error', status: 0, message: String(e && e.message || e) }); hnd({ type: 'done', raw: '' }); }
      });
    };

    const finishUp = ({ err, aborted, incomplete, stream, ms }) => {
      asst.streaming = false;
      asst.notice = null;
      const cut = incomplete && !err && !aborted;
      // 호출 정리: 빈 칸 제거, ID 중복 방지
      const seen = new Set();
      asst.toolCalls = asst.toolCalls.filter(Boolean).filter((tc) => tc.name);
      for (const tc of asst.toolCalls) { if (!tc.id || seen.has(tc.id)) tc.id = uid('call_'); seen.add(tc.id); }
      // <think> 태그로 온 추론을 분리
      const v = viewOf(asst);
      asst.reasoning = v.reasoning;
      asst.content = v.content.replace(/^\s+/, '');
      if (err) asst.error = (err.status ? `HTTP ${err.status} · ` : '') + err.message;
      if (aborted || cut) asst.toolCalls = asst.toolCalls.filter((tc) => tryJson(tc.arguments || '{}') !== undefined);
      if (aborted) asst.aborted = true;
      if (!err && !aborted) extractTextToolCalls(asst, conv);
      if (cut) {
        asst.incomplete = true;
        asst.error = `응답이 완료 신호(finish_reason) 없이 ${fmtDur(ms)} 만에 끊겼습니다`
          + (stream ? ` (청크 ${fmtNum(stream.chunks)}개 수신${stream.badLines ? `, 해석 못 한 줄 ${stream.badLines}개` : ''}${stream.sawDone ? ', [DONE] 은 받음' : ''})` : '')
          + '. 서버나 중간 프록시의 시간 제한에 걸렸을 가능성이 큽니다. 추론 강도를 낮추고 다시 시도해 보세요. 스트림의 마지막 부분은 API 로그 → 원시 응답에 남아 있습니다.';
      } else if (!err && !aborted) {
        if (asst.finish === 'length') {
          asst.error = '길이 제한에 걸려 응답이 잘렸습니다 (finish_reason: length). max_tokens 를 늘리거나 비워 두고, 추론 강도를 낮춰 보세요. 추론 토큰도 max_tokens 에 포함됩니다.';
        } else if (!asst.content && !asst.toolCalls.length) {
          asst.error = '모델이 추론만 하고 답변이나 도구 호출 없이 끝났습니다' + (asst.finish ? ` (finish_reason: ${asst.finish})` : '') + '. 다시 생성하거나 추론 강도를 바꿔 보세요.';
        }
      }
      if (aborted) liveEmit('interrupted'); else if (asst.error) liveEmit('error', asst.error);
      const el = msgEls.get(asst.id);
      if (el) { for (const card of el._cards) card.remove(); el._cards = []; regroupSig = ''; }
      updateAssistant(asst);
      renderCtxMeter();
      resolve({ ok: !err && !aborted && !cut && asst.finish !== 'length' });
    };

    start();
  });
}

// 서버가 도구 호출을 tool_calls 로 바꿔 주지 않고 본문에 <tool_call>{…}</tool_call> 로 흘린 경우를 구제한다.
function extractTextToolCalls(asst, conv) {
  if (asst.toolCalls.length || !asst.content || asst.content.indexOf('<tool_call>') < 0) return;
  const names = new Set(activeTools(conv).map((t) => t.function.name));
  if (!names.size) return;
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const found = [];
  let m;
  while ((m = re.exec(asst.content))) {
    const j = tryJson(m[1]);
    if (!j || typeof j.name !== 'string' || !names.has(j.name)) continue;
    const args = j.arguments != null ? j.arguments : (j.parameters != null ? j.parameters : {});
    found.push({ id: uid('call_'), name: j.name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
  }
  if (!found.length) return;
  asst.toolCalls = found;
  asst.content = asst.content.replace(re, '').trim();
  asst.finish = 'tool_calls';
}

// 요청·응답을 파일로도 남긴다 (앱을 닫은 뒤에도 원인을 볼 수 있게).
function saveLogFile(log) {
  if (S.settings.saveLogs === false) return;
  exa.saveLog({
    id: log.id, time: new Date(log.ts).toISOString(), kind: log.kind, url: log.url, status: log.status, duration_ms: log.ms,
    finish_reason: log.finish || null, error: log.error || null, incomplete: !!log.incomplete, stream: log.stream || null,
    headers: log.headers, usage: log.usage || null, request: log.body, raw_total_chars: log.rawTotal, raw: log.raw,
  }).catch(() => {});
}

function needsApproval(def, conv) {
  if (def.category === 'read') return false;
  if (S.settings.agent.approval === 'auto') return false;
  return !S.sessionAllow.has(conv.id + ':' + def.category);
}

// ask_user 인자 정리와 답변 글 (src/tools.js 의 askUser 와 같은 규칙)
function askNormalize(args) {
  const a = args && typeof args === 'object' ? args : {};
  const list = Array.isArray(a.questions) ? a.questions : (a.question ? [a] : []);
  const out = [];
  for (const q of list.slice(0, 4)) {
    if (!q || typeof q !== 'object' || !String(q.question || '').trim()) continue;
    const options = (Array.isArray(q.options) ? q.options : []).slice(0, 6).map((o) => (o && typeof o === 'object'
      ? { label: String(o.label || o.title || o.value || '').trim(), description: String(o.description || '').trim() }
      : { label: String(o == null ? '' : o).trim(), description: '' })).filter((o) => o.label);
    out.push({ question: String(q.question).trim(), header: String(q.header || '').trim(), options, multi: !!(q.multi_select || q.multiSelect) });
  }
  return out;
}
function askFormat(questions, answers) {
  return 'The user answered:\n' + questions.map((q, i) => `- ${q.question} → ${String((answers || [])[i] || '').trim() || '(no answer)'}`).join('\n')
    + '\nProceed according to these answers.';
}

async function execToolCall(run, conv, asst, tc) {
  const args = tryJson(tc.arguments || '{}');
  const def = conv.mode === 'agent' ? S.toolDefs.find((t) => t.name === tc.name) : null;
  const custom = S.settings.customTools.enabled && parseCustomTools().some((t) => t.function.name === tc.name);
  const st = { status: 'pending', live: '' };
  toolState.set(tc.id, st);
  const wait = () => new Promise((res) => { st.resolve = res; updateAssistant(asst); stickBottom(); });
  let result;

  if (args === undefined || args === null || typeof args !== 'object') {
    result = { ok: false, content: '오류: 도구 인자가 올바른 JSON 객체가 아닙니다. 인자를 고쳐 다시 호출하세요.' };
  } else if (def && def.client && tc.name === 'ask_user') {
    // 사용자에게 질문하기: 질문 카드를 띄우고 답을 받을 때까지 기다린다.
    const qs = askNormalize(args);
    if (!qs.length) result = { ok: false, content: '오류: questions 가 비어 있습니다. question 과 options 를 넣어 다시 호출하세요.' };
    else {
      st.status = 'ask';
      st.questions = qs;
      liveEmit('wait', 'ask');
      const ans = await wait();
      liveEmit('waitEnd');
      if (ans == null) result = { ok: false, skipped: true, content: '(실행되지 않음: 사용자가 중단함)' };
      else if (ans === 'skip') result = { ok: true, content: S.askUser.skipped || 'The user skipped the questions. Proceed with reasonable defaults.', meta: { questions: qs, skippedAsk: true } };
      else result = { ok: true, content: askFormat(qs, ans), meta: { questions: qs, answers: ans, answer: ans.join(' · ') } };
    }
  } else if (def) {
    if (S.settings.agent.approval === 'readonly' && def.category !== 'read') {
      result = { ok: false, denied: true, content: '읽기 전용 모드라서 이 도구는 실행할 수 없습니다.' };
    } else {
      if (needsApproval(def, conv)) {
        st.status = 'approval';
        liveEmit('wait', 'approval');
        const decision = await wait();
        liveEmit('waitEnd');
        if (decision === 'always') S.sessionAllow.add(conv.id + ':' + def.category);
        if (decision === 'abort') result = { ok: false, skipped: true, content: '(실행되지 않음: 사용자가 중단함)' };
        else if (decision === 'deny') result = { ok: false, denied: true, content: '사용자가 이 작업을 거부했습니다. 같은 호출을 반복하지 말고, 다른 방법을 제안하거나 사용자에게 물어보세요.' };
      }
      if (!result) {
        st.status = 'running';
        st.startedAt = Date.now();
        updateAssistant(asst);
        liveEmit('toolStart', { id: tc.id, name: tc.name }, args);
        try { result = await exa.runTool({ callId: tc.id, name: tc.name, args, workspace: conv.workspace, convId: conv.id }); }
        catch (e) { result = { ok: false, content: '오류: ' + (e && e.message || e) }; }
      }
    }
  } else if (custom) {
    st.status = 'input';
    const text = await wait();
    result = text == null ? { ok: false, skipped: true, content: '(실행되지 않음: 사용자가 중단함)' } : { ok: true, content: String(text) };
  } else {
    result = { ok: false, content: `오류: "${tc.name}" 는 사용할 수 없는 도구입니다.` };
  }

  liveEmit('toolEnd', { id: tc.id, name: tc.name }, args && typeof args === 'object' ? args : {},
    { ok: !!result.ok, content: String(result.content == null ? '' : result.content), meta: result.meta || {}, rejected: !!result.denied, display: result.denied ? '거부함' : undefined });
  conv.messages.push({
    id: uid('m'), role: 'tool', toolCallId: tc.id, name: tc.name, content: String(result.content == null ? '' : result.content),
    status: result.skipped ? 'skipped' : result.denied ? 'denied' : result.ok ? 'ok' : 'error', meta: result.meta || {}, ts: Date.now(),
  });
  toolState.delete(tc.id);
  updateAssistant(asst);
  stickBottom();
  if (result.ok && (tc.name === 'write_file' || tc.name === 'edit_file')) {
    refreshChangesPanel();
    refreshFilesPanel();
    if (result.meta && result.meta.path) autoPreview(run, conv, result.meta.path);
  }
  // 계획(진행 상황)이 처음 세워지면 오른쪽 패널의 진행 탭을 자동으로 연다. 그 뒤로는 내용만 갱신한다.
  if (result.ok && tc.name === 'update_plan' && S.conv === conv && S.view === 'chat') {
    if (!run.planShown && S.settings.autoProgress !== false) { run.planShown = true; showPanel('progress'); }
  }
  refreshProgressPanel();
}

// 에이전트가 파일을 만들거나 고치면 미리보기를 띄운다.
// HTML 을 한 번 띄운 뒤에는 그 화면을 유지하고(옆의 CSS·JS 가 바뀌면 새로고침만), 그 전에는 가장 최근 파일을 보여 준다.
function autoPreview(run, conv, relPath) {
  if (S.settings.autoPreview === false || S.conv !== conv || S.view !== 'chat') return;
  if (/\.html?$/i.test(relPath)) { run.previewHtml = relPath; openFilePreview(relPath, conv.workspace); }
  else if (run.previewHtml) reloadPreview();
  else openFilePreview(relPath, conv.workspace);
}

// 이번 지시(마지막 사용자 메시지 이후)에서 에이전트가 바꾼 파일 요약.
// 줄 수는 단계별 합이 아니라 "이번 지시 직전 → 지금" 의 순 변화로 계산한다.
async function turnChanges(conv) {
  let start = 0;
  for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].role === 'user') { start = i; break; }
  const map = new Map();
  const ids = new Set();
  for (const m of conv.messages.slice(start)) {
    if (m.role !== 'tool' || m.status !== 'ok' || !['write_file', 'edit_file'].includes(m.name) || !m.meta || !m.meta.path) continue;
    const e = map.get(m.meta.path) || { path: m.meta.path, added: 0, removed: 0, created: false };
    e.added += m.meta.added || 0;
    e.removed += m.meta.removed || 0;
    if (m.meta.created) e.created = true;
    map.set(m.meta.path, e);
    ids.add(m.toolCallId);
  }
  const list = [...map.values()];
  if (!list.length) return list;
  try {
    const req = { convId: conv.id, workspace: conv.workspace };
    const r = await exa.historySummary(req);
    for (const e of r.ok ? list : []) {
      const f = r.data.files.find((x) => x.path === e.path);
      const first = f && f.versions.find((v) => ids.has(v.callId));
      if (!first || first.n < 1) continue;
      const d = await exa.historyDiff({ ...req, path: e.path, from: first.n - 1, to: 'disk' });
      if (!d.ok) continue;
      e.added = d.data.added;
      e.removed = d.data.removed;
      e.created = !f.versions[first.n - 1].existed;
    }
  } catch { /* 기록을 못 읽으면 단계별 합계를 그대로 쓴다 */ }
  return list;
}

async function attachTurnChanges(conv) {
  const changed = await turnChanges(conv);
  const last = lastAssistant(conv);
  if (!last || !changed.length) return;
  last.changes = changed;
  updateAssistant(last);
  stickBottom();
  persist(conv);
}

function stopRun() {
  const run = S.run;
  if (!run) return;
  run.aborted = true;
  if (run.cancelWait) run.cancelWait(); // 다시 시도를 기다리는 중이었으면 바로 끝낸다
  if (run.reqId) exa.chatAbort(run.reqId);
  for (const [id, st] of toolState) {
    if (st.status === 'running') exa.cancelTool(id);
    else if (st.resolve) { const r = st.resolve; st.resolve = null; r(st.status === 'input' || st.status === 'ask' ? null : 'abort'); }
  }
}

// ---------- 표시용 헬퍼 ----------
function viewOf(msg) {
  const c = msg.content || '';
  if (msg.reasoning || !/^\s*<think>/.test(c)) return { reasoning: msg.reasoning || '', content: c };
  const s = c.replace(/^\s*<think>/, '');
  const i = s.indexOf('</think>');
  return i < 0 ? { reasoning: s, content: '' } : { reasoning: s.slice(0, i).trim(), content: s.slice(i + 8) };
}

function thinkMsOf(msg) {
  const st = msg.stats || {};
  if (st.thinkMs != null) return st.thinkMs;
  if (st.thinkStart) return (st.thinkEnd || performance.now()) - st.thinkStart;
  return null;
}

function scrollEl() { return $('#scroll'); }
function nearBottom() { const s = scrollEl(); return s.scrollHeight - s.scrollTop - s.clientHeight < 120; }
let stick = true;
function scrollToBottom() { const s = scrollEl(); s.scrollTop = s.scrollHeight; stick = true; $('#btn-bottom').hidden = true; }
function stickBottom() { if (stick && !S.home) { const s = scrollEl(); s.scrollTop = s.scrollHeight; } }

// ---------- 메시지 렌더링 ----------
function renderConv() {
  dockComposer(null); // 입력창이 프로젝트 홈 안에 들어가 있었다면 #messages 를 비우기 전에 꺼낸다
  const box = $('#messages');
  box.innerHTML = '';
  msgEls.clear();
  groupEls.clear();
  regroupSig = '';
  const conv = S.conv;
  // 프로젝트에 속한 빈 대화는 환영 화면 대신 프로젝트 홈을 보여 준다.
  const proj = conv && !conv.messages.length ? projectOf(conv) : null;
  setProjectHome(!!proj);
  if (!conv) return;
  if (proj) {
    box.append(projectHomeEl(proj));
    autosize();
    renderCtxMeter();
    requestAnimationFrame(() => { scrollEl().scrollTop = 0; });
    return;
  }
  if (!conv.messages.length) {
    box.append(welcomeEl());
  } else {
    for (const m of conv.messages) {
      if (m.role === 'user') box.append(buildUser(m));
      else if (m.role === 'assistant') updateAssistant(m);
      else if (m.role === 'compact') box.append(buildCompact(m));
    }
  }
  renderCtxMeter();
  refreshProgressPanel();
  requestAnimationFrame(scrollToBottom);
}

function welcomeEl() {
  const agent = S.conv && S.conv.mode === 'agent';
  const sug = agent ? [
    { icon: 'folder', title: '폴더 파악', desc: '구조를 살펴보고 요약', text: '이 작업 폴더의 구조를 살펴보고 어떤 프로젝트인지 요약해줘.' },
    { icon: 'code', title: '웹 페이지 만들기', desc: 'HTML 파일을 만들고 미리보기', text: '테트리스를 할 수 있는 index.html 을 만들어줘. 파일 하나에 CSS 와 JS 를 모두 넣어줘.' },
    { icon: 'file', title: '문서 작성', desc: 'README.md 초안', text: '이 폴더의 내용을 바탕으로 README.md 를 작성해줘.' },
    { icon: 'search', title: '코드 점검', desc: '문제점을 찾아 정리', text: '이 폴더의 코드에서 버그나 개선할 점을 찾아 목록으로 정리해줘. 파일은 고치지 말고 알려만 줘.' },
  ] : [
    { icon: 'chat', title: '모델 알아보기', desc: 'K-EXAONE 2.5 의 강점과 한계', text: '너는 어떤 모델이야? 강점과 한계를 간단히 정리해줘.' },
    { icon: 'spark', title: '추론 테스트', desc: '논리 퍼즐로 사고 과정 확인', text: 'A, B, C 세 사람 중 정확히 한 명만 진실을 말한다.\nA: "B는 거짓말쟁이다."\nB: "C는 거짓말쟁이다."\nC: "A와 B는 둘 다 거짓말쟁이다."\n누가 진실을 말하고 있는지 단계별로 풀어줘.' },
    { icon: 'braces', title: '구조화 출력', desc: 'JSON 스키마에 맞춘 응답', text: '대한민국의 수도와 그 도시를 대표하는 키워드를 알려줘.', json: true },
    { icon: 'code', title: '코드 작성', desc: '짧은 함수와 설명', text: '파이썬으로 문자열에서 가장 긴 회문 부분 문자열을 찾는 함수를 작성하고, 시간 복잡도를 설명해줘.' },
  ];
  const proj = projectOf(S.conv);
  return h('div', { class: 'welcome' },
    S.logo ? h('div', { class: 'w-logo has-img' }, h('img', { src: S.logo, alt: '' })) : S.conv.code ? null : h('div', { class: 'w-logo', 'aria-hidden': 'true' }),
    h(S.conv.code && !proj ? 'h1' : 'div', { class: 'w-brand' + (S.conv.code ? ' code-brand' : '') }, S.conv.code && !S.logo ? h('span', { class: 'code-brand-mark', 'aria-hidden': 'true' }) : null, h('span', { class: 'brand-wordmark', role: 'img', 'aria-label': 'EXAONE' }), h('span', {}, S.conv.code ? 'Code' : 'Desktop')),
    S.conv.code && !proj ? null : h('h1', { text: proj ? proj.name : agent ? '무엇을 만들까요?' : '무엇을 도와드릴까요?' }),
    proj ? h('p', { class: 'w-proj' }, icon('folder', 14), proj.path || '폴더 없음', (proj.instructions || '').trim() ? ' · 프로젝트 지침 적용 중' : '') : null,
    h('p', { class: 'w-sub' }, !S.keyInfo.hasKey
      ? h('span', { class: 'warn' }, '토큰이 등록되어 있지 않습니다. ', h('button', { class: 'link', onclick: () => openTokenDialog() }, '토큰 등록'))
      : S.conv.code ? (S.conv.workspace ? '터미널의 exaone 과 같은 세션 기록을 씁니다. 여기서 한 작업은 터미널에서, 터미널에서 한 작업은 여기서 이어집니다' : '먼저 작업 폴더를 골라 주세요')
        : agent ? (S.conv.workspace ? '작업 폴더 안에서 파일을 만들고 고치며, 결과는 오른쪽 미리보기에 나타납니다' : '먼저 작업 폴더를 골라 주세요')
        : `${S.settings.model} · 텍스트 전용 · 컨텍스트 512K`),
    agent && !S.conv.workspace ? h('button', { class: 'btn primary w-pick', onclick: () => chooseWorkspace() }, icon('folder', 15), '작업 폴더 선택') : null,
    h('div', { class: 'w-grid' }, sug.map((s) => h('button', {
      class: 'w-card',
      onclick: () => {
        if (s.json && S.settings.structured.mode === 'off') { saveSettings({ structured: { mode: 'json_schema' } }); renderChips(); }
        const inp = $('#input');
        inp.value = s.text;
        autosize();
        inp.focus();
      },
    }, h('span', { class: 'w-ic' }, icon(s.icon, 18)), h('b', { text: s.title }), h('span', { text: s.desc })))));
}

function buildUser(m) {
  const el = h('div', { class: 'msg user', dataset: { id: m.id } });
  const fill = () => {
    el.innerHTML = '';
    el.append(
      h('div', { class: 'bubble' },
        (m.attachments || []).length ? h('div', { class: 'att-row' }, m.attachments.map((a) => h('span', { class: 'att', title: `${a.name} · ${fmtBytes(a.size)}` }, icon('file', 13), a.name))) : null,
        m.content ? h('div', { class: 'utext', text: m.content }) : null),
      h('div', { class: 'uacts' },
        h('button', { class: 'icon-btn sm', title: '복사', onclick: (e) => copyText(m.content, e.currentTarget) }, icon('copy', 14)),
        h('button', { class: 'icon-btn sm', title: '수정 후 다시 보내기', onclick: startEdit }, icon('edit', 14))));
  };
  const startEdit = () => {
    if (S.busy) { toast('응답이 끝난 뒤 수정할 수 있습니다'); return; }
    const ta = h('textarea', { class: 'edit-ta', value: m.content });
    el.innerHTML = '';
    el.append(h('div', { class: 'edit-box' }, ta, h('div', { class: 'edit-row' },
      h('span', { class: 'muted', text: '이 메시지 이후의 대화는 지워집니다' }),
      h('span', { class: 'grow' }),
      h('button', { class: 'btn', onclick: fill }, '취소'),
      h('button', { class: 'btn primary', onclick: () => {
        const text = ta.value.trim();
        if (!text && !(m.attachments || []).length) return;
        const conv = S.conv;
        const idx = conv.messages.indexOf(m);
        if (idx < 0) return;
        m.content = text;
        conv.messages.length = idx + 1;
        renderConv();
        runTurn(conv);
      } }, '보내기'))));
    ta.style.height = Math.min(360, ta.scrollHeight + 4) + 'px';
    ta.focus();
  };
  fill();
  return el;
}

function buildAsst(msg) {
  const el = h('div', { class: 'msg asst', dataset: { id: msg.id } });
  el._thinkLabel = h('span', { class: 'think-label' });
  el._thinkBody = h('div', { class: 'think-body' });
  const sum = h('summary', null, icon('spark', 14), el._thinkLabel, icon('chevRight', 12));
  sum.addEventListener('click', () => { el._userToggled = true; });
  el._think = h('details', { class: 'think' }, sum, el._thinkBody);
  el._md = h('div', { class: 'md' });
  el._tools = h('div', { class: 'tools' });
  el._cards = [];
  el._err = h('div', { class: 'errbox' });
  el._changes = h('div', { class: 'changes-card' });
  el._foot = h('div', { class: 'foot' });
  el.append(el._think, el._md, el._tools, el._err, el._changes, el._foot);
  return el;
}

function updateAssistant(msg) {
  let el = msgEls.get(msg.id);
  if (!el) {
    if (!S.conv || !S.conv.messages.includes(msg)) return;
    el = buildAsst(msg);
    msgEls.set(msg.id, el);
    const w = $('#messages .welcome');
    if (w) w.remove();
    $('#messages').append(el);
  }
  const v = viewOf(msg);
  const content = v.content.replace(/^\s+/, '');
  const calls = (msg.toolCalls || []).filter(Boolean);

  // 추론
  const waiting = msg.streaming && !v.reasoning && !content && !calls.length;
  const thinking = msg.streaming && !!v.reasoning && !content && !calls.length;
  el._think.hidden = !(v.reasoning || waiting);
  el._think.classList.toggle('live', waiting || thinking);
  el._think.classList.toggle('empty', !v.reasoning);
  el._think.classList.toggle('retrying', waiting && !!msg.notice); // 다시 시도를 기다리는 중
  if (!el._think.hidden) {
    const ms = thinkMsOf(msg);
    const since = msg.stats && msg.stats.start ? Date.now() - msg.stats.start : 0;
    el._thinkLabel.textContent = waiting ? (msg.notice || `응답 기다리는 중… ${fmtElapsed(since)}`)
      : thinking ? `생각하는 중… ${fmtElapsed(ms || 0)}`
        : ms != null ? `${fmtElapsed(ms, true)} 동안 생각함` : '추론 과정';
    if (el._thinkText !== v.reasoning) {
      el._thinkText = v.reasoning;
      el._thinkBody.textContent = v.reasoning;
      if (thinking && el._think.open) el._thinkBody.scrollTop = el._thinkBody.scrollHeight;
    }
    if (!el._userToggled) el._think.open = !!S.settings.expandDetails && thinking; // 기본은 접힌 채로 진행
  }

  // 본문
  el._md.hidden = !content;
  el._md.classList.toggle('streaming', !!msg.streaming);
  if (el._mdText !== content) {
    el._mdText = content;
    let src = content;
    if (msg.jsonMode && content) {
      const j = tryJson(content);
      src = '```json\n' + (j !== undefined ? JSON.stringify(j, null, 2) : content) + '\n```';
    }
    el._md.innerHTML = Md.render(src);
    Md.enhance(el._md);
  }

  // 도구 호출
  el._tools.hidden = !calls.length;
  const cards = el._cards; // 카드는 묶음(그룹) 안으로 옮겨질 수 있어 배열로 따로 관리한다
  while (cards.length > calls.length) cards.pop().remove();
  calls.forEach((tc, i) => {
    let card = cards[i];
    if (!card) { card = buildToolCard(); cards.push(card); el._tools.append(card); }
    updateToolCard(card, tc, msg);
  });

  // 오류
  el._err.hidden = !msg.error;
  if (msg.error) {
    el._err.innerHTML = '';
    el._err.append(icon('info', 15), h('span', { text: msg.error }));
  }

  // 이번 지시에서 바뀐 파일 요약
  const ch = !msg.streaming && Array.isArray(msg.changes) ? msg.changes : [];
  el._changes.hidden = !ch.length;
  const chSig = JSON.stringify(ch);
  if (ch.length && el._chSig !== chSig) {
    el._chSig = chSig;
    const add = ch.reduce((n, c) => n + c.added, 0), del = ch.reduce((n, c) => n + c.removed, 0);
    el._changes.innerHTML = '';
    el._changes.append(
      h('div', { class: 'cc-head' }, icon('file', 15), h('b', { text: `파일 ${ch.length}개 변경` }),
        h('span', { class: 'ch-stat' }, h('i', { class: 'plus', text: '+' + add }), h('i', { class: 'minus', text: '−' + del })),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn sm', onclick: () => openChanges() }, '변경 사항 보기')),
      h('div', { class: 'cc-list' }, ch.map((c) => h('div', { class: 'cc-row', title: '변경 내용 보기', onclick: () => openChanges(c.path) },
        h('span', { class: 'ch-badge ' + (c.created ? 'added' : 'modified'), text: c.created ? '새 파일' : '수정' }),
        h('span', { class: 'cc-path', text: c.path }),
        h('span', { class: 'ch-stat' }, h('i', { class: 'plus', text: '+' + c.added }), h('i', { class: 'minus', text: '−' + c.removed })),
        h('button', { class: 'icon-btn sm', title: '파일 미리보기', onclick: (e) => { e.stopPropagation(); openFilePreview(c.path, S.conv && S.conv.workspace); } }, icon('eye', 14))))));
  }

  renderFoot(el, msg);
  regroup();
  return el;
}

// ---------- 같은 종류의 도구 단계 묶기 ----------
// 같은 도구(예: 명령 실행)가 연달아 나오면 한 묶음으로 접어 두고, 누르면 목록이 아래로 펼쳐진다.
const groupEls = new Map();   // 묶음의 첫 호출 id -> 요소
const groupOpen = new Map();  // 사용자가 직접 연/닫은 상태
let regroupSig = '';
const GROUP_LABEL = { run_command: '명령 실행', read_file: '파일 읽기', list_dir: '폴더 보기', find_files: '파일 찾기', search_files: '내용 검색', write_file: '파일 작성', edit_file: '파일 수정', web_fetch: '웹 가져오기' };

function groupEl(key, name) {
  let g = groupEls.get(key);
  if (g) return g;
  g = h('div', { class: 'tgroup' });
  g._key = key;
  g._count = h('span', { class: 'tg-count' });
  g._sub = h('span', { class: 'tool-sub' });
  g._status = h('span', { class: 'tool-status' });
  g._head = h('div', { class: 'tool-head tgroup-head', onclick: () => { const open = !g.classList.contains('open'); groupOpen.set(key, open); g.classList.toggle('open', open); } },
    h('span', { class: 'tool-ic' }, icon(describeTool({ name }, {}).icon, 15)),
    h('span', { class: 'tool-title', text: GROUP_LABEL[name] || name }), g._count, g._sub, g._status,
    h('span', { class: 'tool-chev' }, icon('chevRight', 13)));
  g._body = h('div', { class: 'tgroup-body' });
  g.append(g._head, g._body);
  groupEls.set(key, g);
  return g;
}

function regroup() {
  const conv = S.conv;
  if (!conv) return;
  const parts = [];
  for (const m of conv.messages) {
    if (m.role === 'user' || m.role === 'compact') parts.push('u');
    else if (m.role === 'assistant') parts.push(m.id + (viewOf(m).content.trim() ? 'c' : '') + ':' + (m.toolCalls || []).filter(Boolean).map((t) => t.name).join(','));
  }
  const sig = parts.join('|');
  if (sig !== regroupSig) {
    regroupSig = sig;
    // 1) 원래 자리로 되돌린다
    for (const el of msgEls.values()) {
      if (el._think.parentNode !== el) el.insertBefore(el._think, el.firstChild);
      for (const card of el._cards) el._tools.append(card);
    }
    for (const g of groupEls.values()) g.remove();
    // 2) 연달아 나온 같은 도구 단계를 묶는다 (본문이 있는 메시지는 흐름을 끊는다)
    let cur = null;
    const groups = [];
    for (const m of conv.messages) {
      if (m.role === 'user' || m.role === 'compact') { cur = null; continue; }
      if (m.role !== 'assistant') continue;
      const el = msgEls.get(m.id);
      if (!el) { cur = null; continue; }
      const hasText = !!viewOf(m).content.trim();
      (m.toolCalls || []).filter(Boolean).forEach((tc, i) => {
        const card = el._cards[i];
        if (!card || !GROUP_LABEL[tc.name]) { cur = null; return; }
        if (!cur || cur.name !== tc.name || (i === 0 && hasText)) { cur = { name: tc.name, key: tc.id, steps: [] }; groups.push(cur); }
        cur.steps.push({ el, card });
      });
      if (!(m.toolCalls || []).filter(Boolean).length) cur = null;
    }
    for (const gr of groups) {
      if (gr.steps.length < 2) continue;
      const g = groupEl(gr.key, gr.name);
      const first = gr.steps[0];
      first.el._tools.insertBefore(g, first.card);
      let prevEl = first.el;
      for (const st of gr.steps) {
        if (st.el !== prevEl) { g._body.append(st.el._think); prevEl = st.el; } // 그 단계 앞의 추론도 목록 안으로
        g._body.append(st.card);
      }
    }
  }
  refreshGroups();
}

function refreshGroups() {
  for (const g of groupEls.values()) {
    if (!g.isConnected) continue;
    const cards = Array.from(g._body.children).filter((x) => x.classList.contains('tool'));
    const count = (cls) => cards.filter((x) => x.classList.contains(cls)).length;
    const need = count('s-approval') + count('s-input');
    const working = count('s-running') + count('s-pending') + count('s-building');
    const failed = count('s-error');
    g._count.textContent = `${cards.length}개`;
    const last = cards[cards.length - 1];
    g._sub.textContent = last && last._sub ? last._sub.textContent : '';
    g._sub.className = 'tool-sub' + (last && last._sub && last._sub.classList.contains('mono') ? ' mono' : '');
    g._status.innerHTML = '';
    if (need) g._status.append(h('span', { class: 'badge warn', text: '승인 필요' }));
    else if (working) g._status.append(h('span', { class: 'spin' }));
    else if (failed) g._status.append(h('span', { class: 'badge err', text: `실패 ${failed}` }));
    else g._status.append(icon('check', 14));
    g.classList.toggle('s-ok', !need && !working && !failed);
    const user = groupOpen.get(g._key);
    // 사용자의 확인이 필요한 단계가 있으면 항상 펼친다.
    g.classList.toggle('open', need > 0 || (user != null ? user : !!S.settings.expandDetails));
  }
  // 내용이 모두 묶음으로 옮겨져 빈 껍데기만 남은 메시지는 숨긴다.
  for (const el of msgEls.values()) {
    const empty = !el._tools.children.length && el._think.parentNode !== el && el._md.hidden && el._err.hidden && el._changes.hidden && el._foot.hidden;
    el.classList.toggle('all-moved', empty);
  }
}

function lastAssistant(conv) {
  for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].role === 'assistant') return conv.messages[i];
  return null;
}

function renderFoot(el, msg) {
  const foot = el._foot;
  foot.innerHTML = '';
  const calls = msg.toolCalls || [];
  if (msg.streaming) { foot.hidden = true; return; }
  const isLast = S.conv && lastAssistant(S.conv) === msg;
  const interim = calls.length && !isLast;
  const bits = [];
  const u = msg.usage;
  const st = msg.stats || {};
  if (u) {
    const rt = u.reasoning_tokens != null ? u.reasoning_tokens : (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens);
    bits.push(`입력 ${fmtNum(u.prompt_tokens)}`);
    bits.push(`출력 ${fmtNum(u.completion_tokens)}` + (rt != null ? ` (추론 ${fmtNum(rt)})` : ''));
  }
  if (st.ttftMs != null) bits.push(`첫 토큰 ${fmtDur(st.ttftMs)}`);
  if (st.totalMs != null) bits.push(`총 ${fmtDur(st.totalMs)}`);
  if (u && u.completion_tokens && st.totalMs && st.ttftMs != null && st.totalMs > st.ttftMs) {
    bits.push(`${(u.completion_tokens / ((st.totalMs - st.ttftMs) / 1000)).toFixed(1)} tok/s`);
  }
  if (msg.finish && !['stop', 'tool_calls'].includes(msg.finish)) bits.push(`finish: ${msg.finish}`);
  if (msg.aborted) bits.push('중단됨');
  // 도구를 실행하는 중간 단계에는 통계 줄을 보이지 않는다.
  foot.hidden = (interim || (calls.length && S.busy)) && !msg.aborted && !msg.error;
  if (foot.hidden) return;
  const acts = h('span', { class: 'foot-acts' });
  if (msg.content) acts.append(h('button', { class: 'icon-btn sm', title: '답변 복사', onclick: (e) => copyText(msg.content, e.currentTarget) }, icon('copy', 14)));
  if (isLast && !S.busy) acts.append(h('button', { class: 'icon-btn sm', title: '다시 생성', onclick: regenerate }, icon('refresh', 14)));
  foot.append(acts, h('span', { class: 'foot-stats', text: bits.join(' · ') }));
}

function refreshFooters() {
  if (!S.conv) return;
  for (const m of S.conv.messages) {
    if (m.role !== 'assistant') continue;
    const el = msgEls.get(m.id);
    if (el) renderFoot(el, m);
  }
}

function regenerate() {
  const conv = S.conv;
  if (!conv || S.busy) return;
  let idx = -1;
  for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].role === 'user') { idx = i; break; }
  if (idx < 0) return;
  conv.messages.length = idx + 1;
  renderConv();
  runTurn(conv);
}

// ---------- 도구 카드 ----------
function describeTool(tc, a) {
  a = a && typeof a === 'object' ? a : {};
  switch (tc.name) {
    case 'run_command': return { icon: 'terminal', title: '명령 실행', sub: a.command || '', mono: true };
    case 'read_file': return { icon: 'file', title: '파일 읽기', sub: (a.path || '') + (a.offset ? ` · ${a.offset}행부터` : '') };
    case 'list_dir': return { icon: 'folder', title: '폴더 보기', sub: a.path || '.' };
    case 'find_files': return { icon: 'search', title: '파일 찾기', sub: a.pattern || '', mono: true };
    case 'search_files': return { icon: 'search', title: '내용 검색', sub: (a.pattern || '') + (a.glob ? `  (${a.glob})` : ''), mono: true };
    case 'write_file': return { icon: 'edit', title: '파일 작성', sub: a.path || '' };
    case 'edit_file': return { icon: 'edit', title: '파일 수정', sub: a.path || '' };
    case 'web_fetch': return { icon: 'globe', title: '웹 가져오기', sub: a.url || '' };
    case 'ask_user': { const qs = askNormalize(a); return { icon: 'chat', title: qs.length > 1 ? `질문 ${qs.length}개` : '질문', sub: qs.length ? qs[0].question : '' }; }
    case 'update_plan': return { icon: 'list', title: '계획', sub: Array.isArray(a.steps) ? `${a.steps.filter((s) => s && s.status === 'done').length}/${a.steps.length} 완료` : '' };
    default: return { icon: 'braces', title: tc.name || '함수 호출', sub: Object.keys(a).length ? JSON.stringify(a) : '', mono: true };
  }
}

function buildToolCard() {
  const card = h('div', { class: 'tool' });
  card._ic = h('span', { class: 'tool-ic' });
  card._title = h('span', { class: 'tool-title' });
  card._sub = h('span', { class: 'tool-sub' });
  card._meta = h('span', { class: 'tool-meta' });
  card._prev = h('button', { class: 'icon-btn sm', title: '파일 미리보기', hidden: true }, icon('eye', 14));
  card._prev.addEventListener('click', (e) => { e.stopPropagation(); if (card._prevPath) openFilePreview(card._prevPath, S.conv && S.conv.workspace); });
  card._status = h('span', { class: 'tool-status' });
  card._chev = h('span', { class: 'tool-chev' }, icon('chevRight', 13));
  card._head = h('div', { class: 'tool-head' }, card._ic, card._title, card._sub, card._meta, card._prev, card._status, card._chev);
  card._body = h('div', { class: 'tool-body' });
  card._actions = h('div', { class: 'tool-actions' });
  card._head.addEventListener('click', () => { card._open = !card.classList.contains('open'); card._userToggled = true; card.classList.toggle('open', card._open); });
  card.append(card._head, card._body, card._actions);
  return card;
}

function diffEl(text, truncated) {
  const box = h('div', { class: 'diff' });
  for (const line of String(text || '').split('\n')) {
    const c = line[0];
    box.append(h('div', { class: 'dl ' + (c === '+' ? 'add' : c === '-' ? 'del' : c === '@' ? 'hunk' : ''), text: line || ' ' }));
  }
  if (truncated) box.append(h('div', { class: 'dl hunk', text: '… (이하 생략)' }));
  return box;
}

/** 대화에서 가장 최근에 세운 계획: { steps, live(마지막 지시의 것인지) }. 없으면 null. */
function latestPlan(conv) {
  if (!conv) return null;
  let lastUser = -1;
  for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].role === 'user') { lastUser = i; break; }
  for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role !== 'assistant') continue;
    const calls = m.toolCalls || [];
    for (let k = calls.length - 1; k >= 0; k--) {
      if (!calls[k] || calls[k].name !== 'update_plan') continue;
      const a = tryJson(calls[k].arguments || '{}');
      if (a && Array.isArray(a.steps) && a.steps.length) return { steps: a.steps.filter((s) => s && s.title), live: i > lastUser };
    }
  }
  return null;
}

function planEl(steps) {
  return h('ul', { class: 'plan' }, (Array.isArray(steps) ? steps : []).map((s) => h('li', { class: 'st-' + (s && s.status || 'pending') },
    h('span', { class: 'plan-box' }, s && s.status === 'done' ? icon('check', 12) : null),
    h('span', { text: s && s.title || '' }))));
}

const preEl = (text, cls) => h('pre', { class: 'tool-pre ' + (cls || ''), text });
const clipShow = (s, n = 8000) => (s.length > n ? s.slice(0, n) + `\n… (${fmtNum(s.length - n)}자 더 있음)` : s);

function updateToolCard(card, tc, msg) {
  const args = tryJson(tc.arguments || '{}');
  const conv = S.conv;
  const result = conv ? conv.messages.find((m) => m.role === 'tool' && m.toolCallId === tc.id) : null;
  const st = toolState.get(tc.id);
  let status;
  if (result) status = result.status;
  else if (st) status = st.status;
  else if (msg.streaming) status = 'building';
  else status = 'skipped';

  const runSec = status === 'running' && st && st.startedAt ? Math.floor((Date.now() - st.startedAt) / 1000) : 0;
  const sig = [status, (tc.arguments || '').length, st ? st.live.length : 0, tc.name, runSec].join('|');
  if (card._sig === sig) return;
  card._sig = sig;

  const d = describeTool(tc, args);
  card.className = 'tool s-' + status + (card.classList.contains('open') ? ' open' : '');
  card._ic.innerHTML = ''; card._ic.append(icon(d.icon, 15));
  card._title.textContent = d.title;
  card._sub.textContent = d.sub;
  card._sub.classList.toggle('mono', !!d.mono);
  card._sub.title = d.sub;

  // 상태 표시
  card._status.innerHTML = '';
  const meta = result && result.meta || {};
  let metaText = '';
  if (status === 'ok' || status === 'error') {
    if (tc.name === 'run_command') metaText = (meta.exitCode != null ? `exit ${meta.exitCode}` : '') + (meta.ms != null ? ` · ${fmtDur(meta.ms)}` : '');
    else if (tc.name === 'write_file' || tc.name === 'edit_file') metaText = meta.added != null ? `+${meta.added} −${meta.removed}` : '';
    else if (tc.name === 'search_files' && meta.matches != null) metaText = `${meta.matches}건`;
    else if (tc.name === 'find_files' && meta.count != null) metaText = `${meta.count}개`;
    else if (tc.name === 'read_file' && meta.lines != null) metaText = `${meta.from}–${meta.to} / ${meta.lines}행`;
  }
  if (status === 'running' && st && st.startedAt) metaText = `실행 중 ${fmtElapsed(Date.now() - st.startedAt)}`;
  card._meta.textContent = metaText;
  if (status === 'ok') card._status.append(icon('check', 14));
  else if (status === 'error') card._status.append(icon('x', 14));
  else if (status === 'denied') card._status.append(h('span', { class: 'badge', text: '거부됨' }));
  else if (status === 'skipped') card._status.append(h('span', { class: 'badge', text: '중단됨' }));
  else if (status === 'approval') card._status.append(h('span', { class: 'badge warn', text: '승인 필요' }));
  else if (status === 'input') card._status.append(h('span', { class: 'badge warn', text: '결과 입력' }));
  else if (status === 'ask') card._status.append(h('span', { class: 'badge warn', text: '답변 필요' }));
  else card._status.append(h('span', { class: 'spin' }));

  // 본문
  const body = card._body;
  body.innerHTML = '';
  const acts = card._actions;
  acts.innerHTML = '';
  let autoOpen = false;
  const a = args && typeof args === 'object' ? args : {};
  card._prevPath = typeof a.path === 'string' ? a.path : '';
  card._prev.hidden = !(status === 'ok' && card._prevPath && ['write_file', 'edit_file', 'read_file'].includes(tc.name));

  if (status === 'building') {
    body.append(preEl(tc.arguments || '', 'dim'));
  } else if (status === 'approval' || status === 'pending' || status === 'running' || status === 'skipped') {
    if (tc.name === 'run_command') {
      body.append(preEl('$ ' + (a.command || '') + (st && st.live ? '\n' + clipShow(st.live.slice(-8000)) : ''), 'term'));
      const pre = body.lastChild; requestAnimationFrame(() => { pre.scrollTop = pre.scrollHeight; });
    } else if (tc.name === 'write_file') {
      body.append(preEl(clipShow(String(a.content || ''), 4000)));
    } else if (tc.name === 'edit_file') {
      const text = String(a.old_string || '').split('\n').map((l) => '-' + l).concat(String(a.new_string || '').split('\n').map((l) => '+' + l)).join('\n');
      body.append(diffEl(text));
    } else if (tc.name === 'update_plan') {
      body.append(planEl(a.steps));
    } else {
      body.append(preEl(JSON.stringify(a, null, 2)));
    }
    autoOpen = status !== 'skipped' && ['run_command', 'write_file', 'edit_file'].includes(tc.name);
    if (status === 'approval' && st && st.resolve) {
      autoOpen = true;
      const decide = (v) => { const r = st.resolve; st.resolve = null; if (r) r(v); };
      const def = S.toolDefs.find((t) => t.name === tc.name);
      const catLabel = { write: '파일 변경', exec: '명령 실행', net: '웹 요청' }[def && def.category] || '이 종류';
      acts.append(
        h('button', { class: 'btn primary', onclick: () => decide('allow') }, '승인'),
        h('button', { class: 'btn', onclick: () => decide('deny') }, '거부'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn ghost', title: '이 대화가 끝날 때까지 같은 종류는 묻지 않음', onclick: () => decide('always') }, `이 대화에서 ${catLabel} 항상 허용`));
    }
  } else if (status === 'ask' && st && st.resolve) {
    autoOpen = true;
    askForm(card, st, body, acts);
  } else if (tc.name === 'ask_user' && status === 'ok' && meta.questions) {
    // 답한 뒤: 질문과 답을 나란히 보여 준다.
    autoOpen = true;
    body.append(h('div', { class: 'ask-done' }, meta.questions.map((q, i) => h('div', { class: 'ask-qa' },
      h('span', { class: 'ask-q', text: q.question }),
      h('b', { class: meta.skippedAsk ? 'muted' : '', text: meta.skippedAsk ? '건너뜀' : ((meta.answers || [])[i] || '') })))));
  } else if (status === 'input') {
    autoOpen = true;
    body.append(h('div', { class: 'tool-note', text: '사용자 정의 함수입니다. 모델에게 돌려줄 결과를 직접 입력하세요.' }), preEl(JSON.stringify(a, null, 2)));
    const ta = h('textarea', { class: 'tool-input', placeholder: '함수 실행 결과 (예: {"temp": 12, "sky": "맑음"})', rows: 3 });
    if (card._draft) ta.value = card._draft;
    ta.addEventListener('input', () => { card._draft = ta.value; });
    const submit = () => { if (!st || !st.resolve) return; const r = st.resolve; st.resolve = null; r(ta.value || '{}'); };
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } });
    body.append(ta);
    acts.append(h('button', { class: 'btn primary', onclick: submit }, '결과 제출'), h('span', { class: 'muted', text: 'Ctrl+Enter' }));
    requestAnimationFrame(() => ta.focus());
  } else {
    // 완료(ok / error / denied)
    const content = result ? result.content : '';
    if (tc.name === 'update_plan' && status === 'ok') { body.append(planEl(a.steps)); autoOpen = true; }
    else if ((tc.name === 'write_file' || tc.name === 'edit_file') && status === 'ok' && meta.diff) { body.append(diffEl(meta.diff, meta.diffTruncated)); autoOpen = true; }
    else if (tc.name === 'run_command') { body.append(preEl('$ ' + (a.command || '') + '\n' + clipShow(content), 'term')); autoOpen = status === 'error'; }
    else {
      if (!S.toolDefs.some((t) => t.name === tc.name)) body.append(preEl(JSON.stringify(a, null, 2), 'dim'));
      body.append(preEl(clipShow(content), status === 'error' || status === 'denied' ? 'errtext' : ''));
      autoOpen = status === 'error';
    }
  }
  acts.hidden = !acts.children.length;
  // 기본은 접힌 상태. 사용자의 확인이 필요할 때(승인·결과 입력)와 계획 목록만 펼친다.
  const needsUser = status === 'approval' || status === 'input' || status === 'ask';
  const isPlan = (tc.name === 'update_plan' || tc.name === 'ask_user') && status === 'ok';
  if (needsUser) card.classList.add('open');
  else if (!card._userToggled) card.classList.toggle('open', isPlan || (!!S.settings.expandDetails && autoOpen));
}

/**
 * 질문 카드: 질문마다 선택지 버튼과 직접 입력 칸. 질문이 하나이고 하나만 고르는 것이면 누르는 즉시 보낸다.
 * 고른 내용은 card._ask 에 두어 카드가 다시 그려져도 남는다.
 */
function askForm(card, st, body, acts) {
  const qs = st.questions;
  const state = card._ask || (card._ask = qs.map(() => ({ picked: [], other: '' })));
  const answerOf = (i) => {
    const s = state[i];
    const parts = s.picked.map((k) => qs[i].options[k].label);
    if (s.other.trim()) parts.push(s.other.trim());
    return parts.join(', ');
  };
  const finish = (v) => { if (!st.resolve) return; const r = st.resolve; st.resolve = null; r(v); };
  const send = h('button', { class: 'btn primary', onclick: () => finish(qs.map((_q, i) => answerOf(i))) }, '답변 보내기');
  const sync = () => { send.disabled = !qs.every((_q, i) => answerOf(i)); };
  const quick = qs.length === 1 && !qs[0].multi;
  body.append(h('div', { class: 'ask' }, qs.map((q, i) => {
    const s = state[i];
    const btns = [];
    const other = h('input', { class: 'txt ask-other', placeholder: q.options.length ? '직접 입력…' : '답을 입력하세요', value: s.other });
    const paint = () => btns.forEach((b, k) => b.classList.toggle('on', s.picked.includes(k)));
    q.options.forEach((o, k) => btns.push(h('button', { class: 'ask-opt', onclick: () => {
      if (q.multi) s.picked = s.picked.includes(k) ? s.picked.filter((x) => x !== k) : s.picked.concat(k).sort();
      else { s.picked = [k]; s.other = ''; other.value = ''; }
      paint(); sync();
      if (quick) finish([answerOf(0)]);
    } }, h('span', { class: 'ask-mark' }, icon('check', 12)), h('span', { class: 'ask-text' }, h('b', { text: o.label }), o.description ? h('small', { text: o.description }) : null))));
    other.addEventListener('input', () => { s.other = other.value; if (!q.multi && other.value.trim()) s.picked = []; paint(); sync(); });
    other.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && !send.disabled) { e.preventDefault(); send.click(); } });
    paint();
    return h('div', { class: 'ask-item' + (q.multi ? ' multi' : '') },
      h('div', { class: 'ask-head' }, q.header ? h('span', { class: 'ask-tag', text: q.header }) : null, h('span', { class: 'ask-q', text: q.question }), q.multi ? h('small', { text: '여러 개 선택 가능' }) : null),
      h('div', { class: 'ask-opts' }, btns), other);
  })));
  sync();
  acts.append(send, h('button', { class: 'btn ghost', title: '답하지 않고 EXAONE 이 알아서 정하게 합니다', onclick: () => finish('skip') }, '건너뛰기'));
}

// ---------- 입력창 ----------
function autosize() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
}

function renderSendButton() {
  const b = $('#btn-send');
  b.innerHTML = '';
  const running = S.busy || !!S.remote; // 터미널이 이 세션에서 작업 중일 때도 중지 버튼이 된다
  b.append(icon(running ? 'stop' : 'arrowUp', 18));
  b.title = S.remote ? '터미널의 작업 중지 (Esc)' : S.busy ? '중지 (Esc)' : '보내기 (Enter)';
  b.classList.toggle('stop', running);
}

function renderAttachments() {
  const box = $('#attachments');
  box.innerHTML = '';
  box.hidden = !S.attachments.length;
  S.attachments.forEach((a, i) => box.append(h('span', { class: 'att', title: `${a.name} · ${fmtBytes(a.size)}` },
    icon('file', 13), a.name, h('small', { text: fmtBytes(a.size) }),
    h('button', { class: 'att-x', title: '제거', onclick: () => { S.attachments.splice(i, 1); renderAttachments(); } }, icon('x', 12)))));
}

async function addFiles(fileList) {
  for (const f of Array.from(fileList)) {
    if (f.size > 1024 * 1024) { toast(`${f.name}: 1MB 를 넘는 파일은 첨부할 수 없습니다`, 'err'); continue; }
    let buf;
    try { buf = new Uint8Array(await f.arrayBuffer()); } catch { toast(`${f.name}: 읽기 실패`, 'err'); continue; }
    if (buf.subarray(0, 8192).includes(0)) { toast(`${f.name}: 텍스트 파일만 첨부할 수 있습니다 (모델이 텍스트 전용)`, 'err'); continue; }
    let text = new TextDecoder('utf-8').decode(buf);
    if ((text.match(/�/g) || []).length > text.length / 200) { try { text = new TextDecoder('euc-kr').decode(buf); } catch { /* 그대로 */ } }
    S.attachments.push({ name: f.name, size: f.size, text });
  }
  renderAttachments();
  $('#input').focus();
}

// 채팅 ↔ 에이전트 전환. 이미 시작한 대화의 모드는 바꾸지 않고, 그 모드의 새 대화로 넘어간다.
/** 채팅 / 에이전트 고르기: 아직 비어 있는 대화는 그 자리에서 바꾸고, 진행 중인 대화에서는 그 방식의 새 대화를 연다. */
async function switchMode(mode) {
  mode = mode === 'agent' ? 'agent' : 'chat';
  if (S.settings.lastMode !== mode) saveSettings({ lastMode: mode });
  if (curTab() !== 'chat') saveSettings({ ui: { tab: 'chat' } });
  const conv = S.conv;
  if (conv && !conv.code && !conv.messages.length) {
    if (conv.mode !== mode) {
      const proj = projectOf(conv);
      conv.mode = mode;
      conv.workspace = proj && proj.path ? proj.path : (mode === 'agent' ? (S.settings.lastWorkspace || '') : '');
    }
    setView('chat');
    renderConv(); renderChrome(); renderConvList(); refreshFilesPanel(); refreshChangesPanel();
    $('#input').focus();
  } else newConv(conv && !conv.code ? conv.projectId : null);
}
const setMode = switchMode;

/** 왼쪽 위 탭 바꾸기 */
function switchTab(tab) {
  tab = tab === 'code' ? 'code' : 'chat';
  if (curTab() !== tab) saveSettings({ ui: { tab } });
  if (tab === 'code') refreshCliSessions(true);
  const belongs = S.conv && (!!S.conv.code) === (tab === 'code');
  if (belongs) { setView('chat'); renderChrome(); renderConvList(); } else newConv();
}

async function chooseWorkspace() {
  if (S.conv.code && S.conv.messages.length) { toast('이미 시작한 세션의 작업 폴더는 바꿀 수 없습니다. 새 세션을 만드세요'); return false; }
  const dir = await exa.pickFolder(S.conv.workspace || S.settings.lastWorkspace || '');
  if (!dir) return false;
  S.conv.workspace = dir;
  saveSettings(S.conv.code ? { lastCodeDir: dir } : { lastWorkspace: dir });
  if (S.conv.code) { loadCodeMemory(dir); watchLive(); }
  // 폴더가 없는 프로젝트의 작업에서 고른 폴더는 그 프로젝트의 폴더가 된다.
  const proj = projectOf(S.conv);
  if (proj && !proj.path) updateProject(proj.id, { path: dir });
  renderChips();
  refreshFilesPanel();
  refreshChangesPanel();
  if (S.conv.messages.length) persist(S.conv); else renderConv();
  return true;
}

function chipContent(btn, iconName, label, on) {
  btn.innerHTML = '';
  btn.append(icon(iconName, 14), h('span', { text: label }), icon('chevDown', 12));
  btn.classList.toggle('on', !!on);
}

function renderChips() {
  const conv = S.conv;
  if (!conv) return;
  const agent = conv.mode === 'agent';
  const tab = curTab();
  $$('#mode-seg button').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  document.body.classList.toggle('mode-agent', agent);
  document.body.dataset.tab = tab;
  $('.brand-name em').textContent = tab === 'code' ? 'Code' : 'Desktop';
  $('#btn-new span').textContent = tab === 'code' ? '새 세션' : '새 대화';
  // 채팅 / 에이전트 고르기는 아직 시작하지 않은 대화에서만 보인다 (Code 세션은 늘 에이전트).
  const pick = $('#mode-pick');
  pick.hidden = !!conv.code || conv.messages.length > 0;
  $$('#mode-pick button').forEach((b) => b.classList.toggle('on', b.dataset.mode === (agent ? 'agent' : 'chat')));
  $('#btn-terminal').hidden = S.view !== 'chat' || !conv.code || !conv.messages.length;

  // 입력창에는 꼭 필요한 것만: [+] [도구] (켜진 출력 형식) (에이전트: 승인 방식) … [모델·추론] [보내기]
  const eb = $('#btn-effort');
  eb.innerHTML = '';
  eb.append(h('span', { class: 'mb-model', text: S.settings.model }), h('span', { class: 'mb-effort', text: EFFORTS[effortOf(conv)].label }), icon('chevDown', 12));
  eb.title = `모델 · 추론 강도 (${agent ? '에이전트' : '채팅'} 모드): ${EFFORTS[effortOf(conv)].label}`;
  const sm = S.settings.structured.mode;
  const jb = $('#btn-json');
  jb.hidden = sm === 'off';
  if (sm !== 'off') chipContent(jb, 'braces', sm === 'json_schema' ? 'JSON 스키마' : 'JSON 객체', true);
  $('#btn-tools').classList.toggle('active', !!S.settings.customTools.enabled);
  const ap = APPROVALS[S.settings.agent.approval] || APPROVALS.ask;
  chipContent($('#btn-approval'), ap.icon, ap.label, S.settings.agent.approval === 'auto');

  // 작업 폴더는 상단 바에 둔다 (프로젝트 폴더와 같으면 프로젝트 이름만 보인다).
  const wb = $('#btn-workspace');
  const proj = projectOf(conv);
  // 프로젝트 홈에서는 컨텍스트 카드가 폴더를 보여 주므로 숨긴다.
  wb.hidden = S.view !== 'chat' || !agent || S.home || !!(proj && proj.path && proj.path === conv.workspace);
  wb.disabled = !!(conv.code && conv.messages.length);
  wb.innerHTML = '';
  wb.append(icon('folder', 14), h('span', { text: conv.workspace ? baseName(conv.workspace) : '폴더 선택' }), h('i', { text: '/' }));
  wb.title = conv.workspace ? '작업 폴더: ' + conv.workspace : '에이전트 작업 폴더 선택';
  wb.classList.toggle('need', agent && !conv.workspace);

  $('#input').placeholder = conv.code ? 'EXAONE Code 에 시킬 일을 입력하세요' : agent ? '무엇을 만들거나 고칠까요?' : 'EXAONE에게 메시지 보내기';
  renderHint();
}

function ctxUsed() {
  const conv = S.conv;
  if (conv) for (let i = conv.messages.length - 1; i >= 0; i--) {
    const m = conv.messages[i];
    if (m.role === 'compact' && m.summary) return m.after || 0; // 압축 뒤에는 요약 크기부터 다시 센다
    const u = m.usage;
    if (u) return (u.prompt_tokens || 0) + (u.completion_tokens || 0);
  }
  return 0;
}

// 입력창 아래 한 줄: 평소에는 비워 두고, 알릴 것이 있을 때만 보인다.
function renderHint() {
  const el = $('#composer-hint');
  const bits = [];
  if (S.remote) bits.push(S.remote.wait === 'ask' ? '터미널에서 질문에 답하기를 기다리는 중' : S.remote.wait ? '터미널에서 승인을 기다리는 중' : '터미널에서 작업 중 — 실시간으로 보여 주는 중');
  if (S.settings.customTools.enabled) bits.push(`함수 호출 테스트 켜짐 (${parseCustomTools().length}개)`);
  const used = ctxUsed();
  if (used) {
    const pct = used / CTX_LIMIT * 100;
    const th = compactThreshold();
    const left = isFinite(th) ? Math.max(0, (th - used) / th * 100) : null;
    // 자동 압축 기준에 가까워지면 남은 여유를 알려 준다.
    bits.push(left != null && left <= 20
      ? `자동 압축까지 컨텍스트 ${left.toFixed(0)}% 남음`
      : `컨텍스트 ${used >= 1000 ? (used / 1000).toFixed(1) + 'K' : used} / 512K${pct >= 1 ? ` (${pct.toFixed(0)}%)` : ''}`);
    el.classList.toggle('hot', left != null ? left <= 20 : pct > 80);
  }
  el.textContent = bits.join('  ·  ');
  el.title = used ? `컨텍스트 사용량: ${fmtNum(used)} / ${fmtNum(CTX_LIMIT)} 토큰` : '';
}
const renderCtxMeter = renderHint;

const SLASH = [
  { cmd: '/new', desc: '새 대화 시작', run: () => newConv(S.conv && S.conv.projectId) },
  { cmd: '/chat', desc: '채팅 방식으로 (진행 중이면 새 대화)', run: () => switchMode('chat') },
  { cmd: '/agent', desc: '에이전트 방식으로 (진행 중이면 새 대화)', run: () => switchMode('agent') },
  { cmd: '/code', desc: 'Code 탭으로 — EXAONE Code 세션', run: () => switchTab('code') },
  { cmd: '/effort', hint: '[low|medium|high|max]', arg: true, desc: '추론 강도', run: (arg) => {
    if (!EFFORTS[arg]) { toast('사용법: /effort low | medium | high | max'); return; }
    setEffort(arg);
  } },
  { cmd: '/json', desc: '구조화 출력(JSON 스키마) 켜기/끄기', run: () => {
    saveSettings({ structured: { mode: S.settings.structured.mode === 'off' ? 'json_schema' : 'off' } }); renderChips(); renderParamsPanel();
  } },
  { cmd: '/compact', hint: '[추가 지시]', desc: '이전 대화를 요약으로 압축해 컨텍스트 확보', run: (_a, raw) => compactNow(raw) },
  { cmd: '/remember', hint: '<기억해 둘 내용>', arg: true, desc: '프로젝트 메모리에 추가', run: (_a, raw) => {
    const proj = projectOf(S.conv);
    if (!proj) { toast('프로젝트 안의 대화에서만 쓸 수 있습니다'); return; }
    if (!raw) { toast('사용법: /remember 기억해 둘 내용'); return; }
    updateProject(proj.id, { memory: ((proj.memory || '').trim() ? proj.memory.trim() + '\n' : '') + '- ' + raw });
    toast('프로젝트 메모리에 추가했습니다');
  } },
  { cmd: '/workspace', desc: '에이전트 작업 폴더 선택', run: () => chooseWorkspace() },
  { cmd: '/system', desc: '시스템 프롬프트 편집', run: () => { openSettings('model'); const t = $('#p-system'); if (t) t.focus(); } },
  { cmd: '/tools', desc: '에이전트 도구 설정', run: () => openSettings('agent') },
  { cmd: '/files', desc: '작업 폴더 파일 보기', run: () => showPanel('files') },
  { cmd: '/export', desc: '대화를 Markdown 으로 내보내기', run: () => exportConv('md') },
  { cmd: '/clear', desc: '현재 대화의 메시지 모두 지우기', run: async () => {
    if (!S.conv.messages.length) return;
    if (!await confirmDialog('현재 대화의 메시지를 모두 지울까요?', '지우기', true)) return;
    if (S.busy) stopRun();
    const pid = S.conv.projectId;
    await exa.deleteConv(S.conv.id);
    S.convs = await exa.listConvs();
    newConv(pid);
  } },
  { cmd: '/logs', desc: 'API 요청·응답 로그 보기', run: () => setView('logs') },
  { cmd: '/settings', desc: '설정 열기', run: () => openSettings() },
];
let slashIdx = 0;

function slashMatches() {
  const v = $('#input').value;
  if (!v.startsWith('/')) return [];
  // 명령만 입력하고 띄어 쓴 상태("/effort ")면 그 명령의 인자 예시를 계속 보여 준다.
  if (/\s/.test(v)) {
    const m = /^(\/\S+)[ \t]+$/.exec(v);
    const c = m && SLASH.find((x) => x.cmd === m[1].toLowerCase());
    return c && c.hint ? [c] : [];
  }
  return SLASH.filter((c) => c.cmd.startsWith(v.toLowerCase()));
}

function renderSlash() {
  const box = $('#slash-menu');
  const list = slashMatches();
  box.hidden = !list.length;
  box.innerHTML = '';
  if (!list.length) return;
  slashIdx = clamp(slashIdx, 0, list.length - 1);
  list.forEach((c, i) => box.append(h('button', {
    class: 'slash-item' + (i === slashIdx ? ' on' : ''),
    onmousedown: (e) => { e.preventDefault(); pickSlash(c); },
  }, h('b', null, c.cmd, c.hint ? h('i', { text: ' ' + c.hint }) : null), h('span', { text: c.desc }))));
}

function pickSlash(c) {
  const inp = $('#input');
  if (c.arg) { inp.value = c.cmd + ' '; renderSlash(); inp.focus(); return; }
  inp.value = '';
  autosize();
  renderSlash();
  c.run('');
}

function runSlash(text) {
  const [cmd, ...rest] = text.trim().split(/\s+/);
  const c = SLASH.find((x) => x.cmd === cmd.toLowerCase());
  if (!c) return false;
  c.run(rest.join(' ').toLowerCase(), text.trim().slice(cmd.length).trim());
  return true;
}

async function send() {
  if (S.busy) return;
  if (S.remote) { toast('터미널에서 작업 중입니다. 끝난 뒤에 보낼 수 있습니다'); return; }
  const inp = $('#input');
  const text = inp.value.trim();
  if (!text && !S.attachments.length) return;
  if (text.startsWith('/') && !text.includes('\n') && runSlash(text)) {
    inp.value = ''; autosize(); renderSlash();
    return;
  }
  // 토큰을 등록해야 쓸 수 있다 (터미널에서 방금 등록했을 수도 있으니 한 번 더 확인한다).
  if (!S.keyInfo.hasKey) {
    S.keyInfo = await exa.keyInfo();
    if (!S.keyInfo.hasKey) { openTokenDialog(); return; }
    renderChrome();
  }
  const conv = S.conv;
  if (conv.mode === 'agent' && !conv.workspace) {
    toast(conv.code ? 'EXAONE Code 는 작업 폴더를 먼저 골라야 합니다' : '에이전트 방식에서는 작업 폴더를 먼저 골라야 합니다');
    if (!await chooseWorkspace()) return;
  }
  // Code 세션: 터미널에서 그 사이에 이어 쓴 내용이 있으면 먼저 불러온다.
  if (conv.code && await syncCodeConv()) toast('터미널에서 이어 쓴 내용을 불러왔습니다');
  const m = { id: uid('m'), role: 'user', content: text, attachments: S.attachments.splice(0), ts: Date.now() };
  // Code 세션: 같은 세션을 보는 터미널에 입력한 지시가 바로 보이게, 기록하기 전에 먼저 알린다.
  if (conv.code) await liveStart(conv, text || (m.attachments[0] && m.attachments[0].name) || '');
  const first = !conv.messages.length;
  conv.messages.push(m);
  // 폴더가 없는 프로젝트에서 시작한 첫 에이전트 작업의 폴더를 프로젝트 폴더로 삼는다.
  if (first && conv.mode === 'agent' && conv.workspace) {
    const proj = projectOf(conv);
    if (proj && !proj.path) updateProject(proj.id, { path: conv.workspace });
  }
  if (!conv.title) conv.title = makeTitle(text || (m.attachments[0] && m.attachments[0].name) || '');
  inp.value = '';
  autosize();
  renderSlash();
  renderAttachments();
  if (first) {
    // 프로젝트 홈에서 보낸 첫 메시지: 입력창을 제자리로 돌려놓고 대화 화면으로 바꾼다.
    dockComposer(null);
    setProjectHome(false);
    $('#messages').innerHTML = '';
    renderChrome();
    inp.focus();
  }
  $('#messages').append(buildUser(m));
  scrollToBottom();
  persist(conv, true);
  await runTurn(conv);
}

// ---------- 내보내기 ----------
function convToMarkdown(conv) {
  const out = [`# ${conv.title || '대화'}`, '', `- 모델: ${S.settings.model}`, `- 모드: ${conv.mode === 'agent' ? '에이전트' : '채팅'}${conv.workspace && conv.mode === 'agent' ? ` (${conv.workspace})` : ''}`, `- 날짜: ${new Date(conv.createdAt).toLocaleString('ko-KR')}`, ''];
  for (const m of conv.messages) {
    if (m.role === 'user') {
      out.push('## 사용자', '');
      for (const a of m.attachments || []) out.push(`> 첨부: ${a.name} (${fmtBytes(a.size)})`);
      out.push(m.content || '', '');
    } else if (m.role === 'assistant') {
      out.push('## EXAONE', '');
      if (m.reasoning) out.push('<details><summary>추론 과정</summary>', '', m.reasoning, '', '</details>', '');
      if (m.content) out.push(m.content, '');
      for (const tc of m.toolCalls || []) {
        const r = conv.messages.find((x) => x.role === 'tool' && x.toolCallId === tc.id);
        out.push(`**도구 호출: \`${tc.name}\`**`, '', '```json', tc.arguments || '{}', '```', '');
        if (r) out.push('```text', r.content, '```', '');
      }
      if (m.error) out.push(`> 오류: ${m.error}`, '');
    } else if (m.role === 'compact' && m.summary) {
      out.push('---', '', '> 여기까지의 대화는 아래 요약으로 압축되어 이후 요청에는 요약만 전달되었습니다.', '', m.summary, '', '---', '');
    }
  }
  return out.join('\n');
}

async function exportConv(kind) {
  const conv = S.conv;
  if (!conv || !conv.messages.length) { toast('내보낼 대화가 없습니다'); return; }
  const name = (conv.title || 'exaone-chat').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  const content = kind === 'json' ? JSON.stringify(conv, null, 2) : convToMarkdown(conv);
  const p = await exa.exportSave(`${name}.${kind === 'json' ? 'json' : 'md'}`, content);
  if (p) toast('저장했습니다: ' + p);
}
