#!/usr/bin/env node
'use strict';
// EXAONE Code — 터미널에서 쓰는 K-EXAONE 에이전트. `exaone` 명령으로 실행한다.
// 데스크톱 앱과 같은 API 클라이언트(src/exaone.js)와 도구(src/tools.js)를 쓰며 추가 의존성이 없다 (Node 22+).

const fs = require('fs');
const path = require('path');

const store = require('./store');
const { Agent, MODES } = require('./agent');
const { History } = require('../src/history');
const tools = require('../src/tools');
const pkg = require('../package.json');

const EFFORTS = ['low', 'medium', 'high', 'max'];

const HELP = `EXAONE Code ${pkg.version} — 터미널용 K-EXAONE 에이전트

사용법
  exaone                        현재 폴더에서 대화형으로 시작
  exaone "할 일"                첫 지시를 주고 대화형으로 시작
  exaone -p "할 일"             한 번 실행하고 답만 출력 (파이프·스크립트용)
  exaone -c                     이 폴더의 가장 최근 세션을 이어서
  exaone -r [세션ID]            세션을 골라 이어서
  type 로그.txt | exaone -p "요약해줘"
  exaone doctor                 설치·연결 상태 점검

옵션
  -p, --print                       비대화형. 최종 답만 stdout 으로 출력
  -c, --continue                    가장 최근 세션 이어서 하기
  -r, --resume [id]                 세션 이어서 하기 (id 생략 시 목록에서 선택)
      --model <id>                  모델 ID (기본 k-exaone_v2.5 · EXAONE_MODEL)
      --effort <값>                 추론 강도: low | medium | high | max (기본 medium)
      --permission-mode <모드>      default | acceptEdits | plan | bypassPermissions
      --dangerously-skip-permissions  모든 권한 확인을 건너뜀 (격리된 환경에서만)
      --allowedTools <규칙…>        확인 없이 허용할 도구. 예: "Bash(git:*) Edit"
      --disallowedTools <이름…>     모델에게 주지 않을 도구. 예: "Bash WebFetch"
      --output-format <형식>        -p 출력: text | json | stream-json
      --max-turns <n>               한 지시에서 반복할 최대 요청 수 (기본 50)
      --system-prompt <글>          시스템 프롬프트 교체
      --append-system-prompt <글>   시스템 프롬프트 뒤에 덧붙임
  -C, --cwd <폴더>                  작업 폴더 (기본: 현재 폴더)
      --base-url <url>              API 주소 (기본 https://api.exaone.ai/v1 · EXAONE_BASE_URL)
      --verbose                     추론 내용과 도구 출력을 펼쳐서 표시
  -v, --version                     버전
  -h, --help                        도움말

대화형 화면
  /  명령 (/help 로 전체 목록)     @  파일 언급          !  셸 명령 바로 실행      #  메모리에 추가
  shift+tab 권한 모드 전환         esc 중단              ctrl+o 자세히 보기        \\⏎ 줄바꿈

파일
  토큰(API 키)  데스크톱 앱(설정 → 연결) 또는 /login 으로 등록한 것만 씁니다 (~/.exaone/key.txt, 앱과 함께 사용)
  메모리        EXAONE.md (프로젝트) · ~/.exaone/EXAONE.md (사용자) — system 메시지에 포함
  설정          ~/.exaone/settings.json · .exaone/settings.json · .exaone/settings.local.json
  사용자 명령   .exaone/commands/이름.md → /이름   ($ARGUMENTS 치환)
  세션 기록     ~/.exaone/projects/<폴더>/`;

function parseArgs(argv) {
  const o = {
    prompt: null, print: false, continue: false, resume: null, effort: null, mode: null, bypass: false, cwd: null, model: null, baseUrl: null,
    maxTurns: null, verbose: false, help: false, version: false, outputFormat: 'text', allowed: [], disallowed: [], systemPrompt: null, appendSystemPrompt: null, rest: [],
  };
  const need = (i, name) => { if (argv[i + 1] == null) { console.error(`${name} 뒤에 값이 필요합니다.`); process.exit(2); } return argv[i + 1]; };
  const list = (s) => String(s).split(/[,\s]+(?![^(]*\))/).map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-p' || a === '--print') o.print = true;
    else if (a === '-c' || a === '--continue') o.continue = true;
    else if (a === '-r' || a === '--resume') { o.resume = true; if (argv[i + 1] && /^\d{14}-[a-z0-9]{4}$/.test(argv[i + 1])) o.resume = argv[++i]; }
    else if (a === '--effort') o.effort = need(i++, a);
    else if (a === '--permission-mode') o.mode = need(i++, a);
    else if (a === '--dangerously-skip-permissions' || a === '-y' || a === '--yes') o.bypass = true;
    else if (a === '--readonly') o.disallowed.push('Bash', 'Edit', 'Write', 'WebFetch');
    else if (a === '--allowedTools' || a === '--allowed-tools') o.allowed.push(...list(need(i++, a)));
    else if (a === '--disallowedTools' || a === '--disallowed-tools') o.disallowed.push(...list(need(i++, a)));
    else if (a === '--output-format') o.outputFormat = need(i++, a);
    else if (a === '--max-turns' || a === '--max-steps') o.maxTurns = Math.max(1, parseInt(need(i++, a), 10) || 50);
    else if (a === '--system-prompt') o.systemPrompt = need(i++, a);
    else if (a === '--append-system-prompt') o.appendSystemPrompt = need(i++, a);
    else if (a === '--cwd' || a === '-C') o.cwd = need(i++, a);
    else if (a === '--model') o.model = need(i++, a);
    else if (a === '--base-url') o.baseUrl = need(i++, a);
    else if (a === '--verbose') o.verbose = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '-V' || a === '--version') o.version = true;
    else if (a.startsWith('-')) { console.error(`알 수 없는 옵션: ${a}  (exaone --help 참고)`); process.exit(2); }
    else o.rest.push(a);
  }
  if (o.rest.length) o.prompt = o.rest.join(' ');
  return o;
}

/** 파이프로 들어온 입력을 읽는다. 프롬프트가 이미 있는데 1초 안에 아무것도 오지 않으면 기다리지 않는다. */
function readStdin(hasPrompt) {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((res) => {
    const chunks = [];
    let timer = hasPrompt ? setTimeout(() => { process.stdin.pause(); res(''); }, 1000) : null;
    process.stdin.on('data', (ch) => { if (timer) { clearTimeout(timer); timer = null; } chunks.push(ch); });
    process.stdin.on('end', () => { if (timer) clearTimeout(timer); res(Buffer.concat(chunks).toString('utf8').trim()); });
    process.stdin.on('error', () => { if (timer) clearTimeout(timer); res(''); });
  });
}

async function doctor(cwd, cfg, keyInfo) {
  const ok = (b, t) => console.log((b ? '✔ ' : '✘ ') + t);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 22, `Node.js ${process.versions.node}` + (major >= 22 ? '' : ' — 22 이상이 필요합니다'));
  ok(!!keyInfo.key, keyInfo.key ? `토큰: ${keyInfo.source}` : '토큰이 등록되어 있지 않습니다 — 데스크톱 앱(설정 → 연결)에서 등록하거나 exaone 실행 후 /login');
  try {
    const r = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(8000) });
    ok(r.status < 500, `API 서버 응답: HTTP ${r.status} (${cfg.baseUrl}) — 키 없이 보낸 점검 요청이라 401 이 정상입니다`);
  } catch (e) { ok(false, `API 서버에 연결하지 못했습니다 (${cfg.baseUrl}): ${e.cause && e.cause.code || e.message}`); }
  ok(true, `셸: ${tools.shellFor('auto').name} · 설정 폴더: ${store.HOME}`);
  ok(true, `작업 폴더: ${cwd}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  const opt = parseArgs(sub === 'doctor' || sub === 'help' ? argv.slice(1) : argv);
  if (opt.help || sub === 'help') { console.log(HELP); return; }
  if (opt.version) { console.log(`${pkg.version} (EXAONE Code)`); return; }
  if (opt.effort && !EFFORTS.includes(opt.effort)) { console.error(`--effort 는 ${EFFORTS.join(' | ')} 중 하나여야 합니다.`); process.exit(2); }
  if (opt.mode && !MODES.includes(opt.mode)) { console.error(`--permission-mode 는 ${MODES.join(' | ')} 중 하나여야 합니다.`); process.exit(2); }
  if (!['text', 'json', 'stream-json'].includes(opt.outputFormat)) { console.error('--output-format 은 text | json | stream-json 중 하나여야 합니다.'); process.exit(2); }

  const cwd = path.resolve(opt.cwd || process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) { console.error('작업 폴더를 찾을 수 없습니다: ' + cwd); process.exit(2); }
  const settings = store.loadSettings(cwd);
  const keyInfo = store.findKey(cwd);
  const cfg = {
    baseUrl: opt.baseUrl || process.env.EXAONE_BASE_URL || settings.baseUrl || 'https://api.exaone.ai/v1',
    model: opt.model || process.env.EXAONE_MODEL || settings.model || 'k-exaone_v2.5',
    effort: opt.effort || (EFFORTS.includes(settings.effort) ? settings.effort : 'medium'),
    mode: opt.bypass ? 'bypassPermissions' : (opt.mode || (MODES.includes(settings.permissions.defaultMode) ? settings.permissions.defaultMode : 'default')),
    minGapMs: Number(process.env.EXAONE_MIN_GAP_MS || settings.minGapMs || 1100),
    maxTurns: opt.maxTurns || 50,
    autoCompact: settings.autoCompact !== false,
    maxRetries: process.env.EXAONE_MAX_RETRIES != null && process.env.EXAONE_MAX_RETRIES !== '' ? Math.max(0, Number(process.env.EXAONE_MAX_RETRIES) || 0) : (Number.isFinite(settings.maxRetries) ? settings.maxRetries : undefined), // 실패한 요청을 다시 보내는 횟수 (기본 10)
    compactThreshold: Number(process.env.EXAONE_AUTOCOMPACT_THRESHOLD || settings.autoCompactThreshold) || 0, // 시험용: 기준 토큰 수 직접 지정
    allowedTools: opt.allowed, disallowedTools: opt.disallowed,
    systemPrompt: opt.systemPrompt, appendSystemPrompt: opt.appendSystemPrompt,
  };
  if (sub === 'doctor') return doctor(cwd, cfg, keyInfo);

  // 세션: 새로 만들거나 이어서
  let session = new store.Session(cwd);
  let messages = [];
  const interactive = !opt.print && process.stdin.isTTY && process.stdout.isTTY;
  if (opt.continue || typeof opt.resume === 'string') {
    const list = store.Session.list(cwd);
    const id = typeof opt.resume === 'string' ? opt.resume : (list[0] && list[0].id);
    if (!id || !list.some((s) => s.id === id)) { console.error(id ? `세션을 찾을 수 없습니다: ${id}` : '이 폴더에 이어서 할 세션이 없습니다.'); process.exit(1); }
    ({ session, messages } = store.Session.load(cwd, id));
  }
  const history = new History(path.join(store.HOME, 'file-history'));

  if (interactive) {
    const { App } = require('./tui');
    const agent = new Agent({ cwd, key: keyInfo.key, cfg, settings, session, messages, history });
    const app = new App({ agent, cfg, cwd, keyInfo, history, settings, opt: { verbose: opt.verbose || !!settings.verbose, allowBypass: opt.bypass || cfg.mode === 'bypassPermissions' } });
    agent.ui = app.liveUi(); // 화면에 그리면서, 같은 세션을 보고 있는 데스크톱 앱에도 실시간으로 알린다
    if (opt.resume === true) app.queue.push('/resume');
    await app.start(opt.prompt);
    return;
  }

  // ----- 비대화형 (-p, 또는 파이프 입력) -----
  let text = opt.prompt || '';
  const piped = await readStdin(!!text);
  if (piped) text = text ? `${text}\n\n<stdin>\n${piped}\n</stdin>` : piped;
  if (!text) { console.error(opt.print ? '프롬프트가 없습니다. 예: exaone -p "이 폴더를 요약해줘"' : '대화형 화면은 터미널에서만 열 수 있습니다. 파이프나 스크립트에서는 -p 를 쓰세요.'); process.exit(2); }
  if (!keyInfo.key) { console.error('토큰이 등록되어 있지 않습니다. 데스크톱 앱(설정 → 연결)에서 토큰을 등록하거나, 터미널에서 exaone 을 실행해 /login 으로 등록하세요.'); process.exit(2); }

  const fmt = opt.outputFormat;
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const log = (s) => { if (opt.verbose) process.stderr.write(s + '\n'); };
  const ui = {
    thinkingEnd: (ms) => log(`∴ ${Math.round(ms / 1000)}초 동안 생각함`),
    toolEnd: (tc, a, res, title) => log(`⏺ ${title.label}(${title.arg}) → ${res.ok ? 'ok' : String(res.content).split('\n').slice(-1)[0]}`),
    error: (m) => process.stderr.write('오류: ' + m + '\n'),
    notice: (m) => log(m),
    // 네트워크 문제 등으로 다시 시도할 때 (stream-json 에서는 Claude Code 처럼 system/api_retry 로 알린다)
    retryWait: (ms, info) => {
      if (fmt === 'stream-json') emit({ type: 'system', subtype: 'api_retry', attempt: info.attempt, max_retries: info.max, retry_delay_ms: ms, error_status: info.status || null, error: info.error, session_id: session.id });
      else log(require('../renderer/js/retry').label(info, ms));
    },
    message: fmt === 'stream-json' ? (m) => {
      if (m.role === 'assistant') {
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.tool_calls || []) { let input = {}; try { input = JSON.parse(tc.function.arguments); } catch { /* 그대로 */ } content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input }); }
        emit({ type: 'assistant', message: { role: 'assistant', content }, session_id: session.id });
      } else if (m.role === 'tool') emit({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }] }, session_id: session.id });
    } : undefined,
  };
  // 같은 세션을 데스크톱 앱이 열어 두었으면 이 작업도 실시간으로 보이게 알린다.
  const live = require('../src/live');
  let liveOut = null;
  const agent = new Agent({ cwd, key: keyInfo.key, cfg, settings, session, messages, history, ui: live.tee(ui, () => liveOut) });
  liveOut = new live.LiveWriter(session.file, live.newSrc(), { onStop: () => agent.abort() });
  liveOut.begin({ display: text, base: messages.length });
  if (fmt === 'stream-json') emit({ type: 'system', subtype: 'init', session_id: session.id, cwd, model: cfg.model, permissionMode: cfg.mode, tools: agent.toolDefs().map((d) => d.function.name) });
  process.on('SIGINT', () => agent.abort());
  const r = await agent.turn(text);
  liveOut.end();
  const failed = !!r.error;
  if (fmt === 'text') { if (r.text) process.stdout.write(r.text + '\n'); }
  else emit({
    type: 'result', subtype: failed ? 'error' : 'success', is_error: failed, result: r.text || '', error: r.error || undefined, session_id: session.id,
    num_turns: r.turns, duration_ms: r.stats.ms, usage: { input_tokens: r.stats.prompt, output_tokens: r.stats.completion, reasoning_tokens: r.stats.reasoning },
  });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  try { process.stdout.write('\x1b[?2004l\x1b[?25h'); if (process.stdin.isTTY) process.stdin.setRawMode(false); } catch { /* 무시 */ }
  console.error(e && e.stack || e);
  process.exit(1);
});
