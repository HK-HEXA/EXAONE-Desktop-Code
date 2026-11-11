'use strict';
// EXAONE Code 의 에이전트 본체: 요청 루프, 도구 실행, 권한 판단. 화면 출력은 ui 콜백에 맡긴다.

const exaone = require('../src/exaone');
const retry = exaone.retry;
const tools = require('../src/tools');
const store = require('./store');

const CTX_LIMIT = 524288;
// 자동 압축 기준: Claude Code 와 같은 식을 EXAONE 의 컨텍스트 창에 적용한다.
//   쓸 수 있는 창 = 컨텍스트 창 − 요약 출력용으로 남겨 두는 토큰,  자동 압축 기준 = 쓸 수 있는 창 − 여유분
const COMPACT_RESERVE = 20000; // 요약 출력용 (EXAONE 의 max_tokens 는 추론 토큰까지 포함한다)
const COMPACT_BUFFER = 13000;  // 여유분
const COMPACT_MAX_FAILS = 3;   // 연달아 이만큼 실패하면 자동 압축을 더 시도하지 않는다
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
const MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
const TOOL_LABEL = {
  read_file: 'Read', write_file: 'Write', edit_file: 'Update', run_command: 'Bash', list_dir: 'List', find_files: 'Glob',
  search_files: 'Search', web_fetch: 'Fetch', update_plan: 'Update Todos', ask_user: 'Ask', exit_plan_mode: 'Plan',
};
// 설정·옵션에서 쓰는 도구 이름(Claude Code 식)을 내부 이름으로
const ALIAS = {
  Bash: ['run_command'], Edit: ['edit_file', 'write_file'], Write: ['write_file', 'edit_file'], Update: ['edit_file'], MultiEdit: ['edit_file'],
  Read: ['read_file'], Glob: ['find_files'], Grep: ['search_files'], Search: ['search_files'], LS: ['list_dir'], List: ['list_dir'],
  WebFetch: ['web_fetch'], Fetch: ['web_fetch'], TodoWrite: ['update_plan'],
};
const internalNames = (name) => ALIAS[name] || [name];
const tryJson = (s) => { try { return JSON.parse(s); } catch { return undefined; } };
const rid = () => 'call_' + Math.random().toString(36).slice(2, 10);

const EXTRA_TOOLS = {
  ask_user: { category: 'read', def: tools.askUser.def },
  exit_plan_mode: {
    category: 'read',
    def: { type: 'function', function: {
      name: 'exit_plan_mode',
      description: 'Plan mode only. Call this when your plan is ready, to show it to the user and ask for approval before making any change.',
      parameters: { type: 'object', properties: { plan: { type: 'string', description: 'The plan in concise Markdown: numbered steps, files to touch, how to verify.' } }, required: ['plan'] },
    } },
  },
};

function toolTitle(name, a) {
  a = a && typeof a === 'object' ? a : {};
  const arg = name === 'run_command' ? a.command : name === 'web_fetch' ? a.url
    : name === 'find_files' ? a.pattern : name === 'search_files' ? `pattern: "${a.pattern || ''}"` + (a.path ? `, path: "${a.path}"` : '') + (a.glob ? `, glob: "${a.glob}"` : '')
      : name === 'update_plan' || name === 'exit_plan_mode' ? '' : name === 'ask_user' ? (a.question || (Array.isArray(a.questions) && a.questions[0] && a.questions[0].question) || '') : (a.path || '.');
  return { label: TOOL_LABEL[name] || name, arg: String(arg == null ? '' : arg).replace(/\s+/g, ' ').trim() };
}

function parseRule(rule) {
  const m = /^\s*([A-Za-z_]+)\s*(?:\(([\s\S]*)\))?\s*$/.exec(String(rule));
  return m ? { tool: m[1], spec: m[2] == null ? null : m[2].trim() } : null;
}
const simpleCommand = (cmd) => !/[;&|`<>\n]|\$\(/.test(cmd);
function bashPrefix(cmd) {
  const t = String(cmd).trim().split(/\s+/);
  const two = ['git', 'npm', 'npx', 'yarn', 'pnpm', 'docker', 'cargo', 'go', 'pip', 'pip3', 'dotnet', 'gradle', 'mvn', 'kubectl', 'gh', 'node', 'python', 'python3'];
  return two.includes(t[0]) && t[1] && !t[1].startsWith('-') && !/[\\/.]/.test(t[1]) ? `${t[0]} ${t[1]}` : t[0];
}
function ruleMatches(rule, name, a) {
  const r = parseRule(rule);
  if (!r || !internalNames(r.tool).includes(name)) return false;
  if (r.spec == null || r.spec === '' || r.spec === '*') return true;
  if (name === 'run_command') {
    const cmd = String(a.command || '').trim();
    if (r.spec.endsWith(':*')) { const p = r.spec.slice(0, -2); return simpleCommand(cmd) && (cmd === p || cmd.startsWith(p + ' ')); }
    return cmd === r.spec;
  }
  if (name === 'web_fetch') {
    const host = (() => { try { return new URL(a.url).hostname; } catch { return ''; } })();
    const want = r.spec.replace(/^domain:/, '');
    return !!host && (host === want || host.endsWith('.' + want));
  }
  if (a.path) { try { return tools.globToRegex(r.spec).test(String(a.path).replace(/\\/g, '/')); } catch { return false; } }
  return false;
}

class Agent {
  constructor({ cwd, key, cfg, settings, session, messages, ui, history }) {
    this.cwd = cwd; this.key = key; this.cfg = cfg; this.session = session; this.ui = ui || {}; this.history = history;
    this.messages = messages || [];
    this.allow = [...(settings.permissions.allow || []), ...(cfg.allowedTools || [])];
    this.deny = [...(settings.permissions.deny || [])];
    this.disallowed = new Set((cfg.disallowedTools || []).flatMap(internalNames));
    this.shell = tools.shellFor('auto').name;
    this.todos = null;
    this.totals = { requests: 0, completion: 0, reasoning: 0, lastPrompt: 0, apiMs: 0, sinceChars: 0 };
    if (this.messages.length) this.resetUsage(); // 이어서 하는 세션
    this.rate = null;
    this.lastThinking = '';
    this.current = null;
    this.aborted = false;
    this.stop = false;
    this.turnDetails = []; // 마지막 지시의 추론·도구 출력 원문 (펼쳐 보기용)
  }

  get mode() { return this.cfg.mode; }
  setMode(m) { if (MODES.includes(m)) { this.cfg.mode = m; if (this.ui.modeChanged) this.ui.modeChanged(m); } }
  contextPct() { return this.totals.lastPrompt ? this.totals.lastPrompt / CTX_LIMIT * 100 : 0; }
  /** 대화를 바꿔 끼웠을 때(이어 하기 · 비우기): 실제 사용량이 아직 없으므로 불러온 메시지의 길이로 어림한다. */
  resetUsage() {
    this.totals.lastPrompt = 0;
    this.totals.sinceChars = this.messages.reduce((n, m) => n + String(m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0), 0);
    this.compactFails = 0;
  }
  /** 자동 압축 기준 (토큰). 꺼져 있으면 Infinity. */
  compactThreshold() {
    if (this.cfg.autoCompact === false) return Infinity;
    return Number(this.cfg.compactThreshold) > 0 ? Number(this.cfg.compactThreshold) : CTX_LIMIT - COMPACT_RESERVE - COMPACT_BUFFER;
  }
  /** 다음 요청이 차지할 컨텍스트 추정: 마지막 응답의 실제 사용량 + 그 뒤에 덧붙은 메시지 (글자 수 ÷ 2) */
  contextTokens() { return this.totals.lastPrompt + Math.ceil((this.totals.sinceChars || 0) / 2); }
  /** 자동 압축까지 남은 여유 (%). 꺼져 있으면 null. */
  compactLeftPct() {
    const th = this.compactThreshold();
    return isFinite(th) ? Math.max(0, (th - this.contextTokens()) / th * 100) : null;
  }

  // ---------- 프롬프트 ----------
  systemPrompt() {
    if (this.cfg.systemPrompt) return this.cfg.systemPrompt + (this.cfg.appendSystemPrompt ? '\n\n' + this.cfg.appendSystemPrompt : '');
    const m = this.mode;
    const lines = [
      'You are EXAONE Code, a hands-on coding agent running in the user\'s terminal.',
      '',
      'Environment',
      `- OS: ${{ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[process.platform] || process.platform}; shell used by run_command: ${this.shell}`,
      `- Working directory (every tool path is relative to it, commands run in it): ${this.cwd}`,
      `- Today: ${new Date().toISOString().slice(0, 10)}`,
      `- Permission mode: ${m === 'plan' ? 'plan (read-only until the user approves a plan)' : m === 'default' ? 'the user approves each file change, command and web request' : m === 'acceptEdits' ? 'file edits are auto-approved; commands and web requests need approval' : 'everything is auto-approved'}`,
      '',
      'How to work',
      '- Inspect before you answer: use list_dir / find_files / search_files / read_file instead of guessing what files contain.',
      '- Keep your thinking short. Never draft whole files or long code in your reasoning: decide the approach in a few lines, then put the complete content directly into the write_file / edit_file call.',
      '- Act through tool calls. To create or change a file you must call write_file / edit_file; describing the file in your answer does not create it.',
      '- For work with three or more steps, call update_plan first and keep it current as steps finish.',
      '- Change existing files with edit_file (exact, unique old_string); use write_file only for new files or full rewrites.',
      '- Keep changes minimal and focused on the request. Do not touch files outside the working directory.',
      '- If a tool call fails or is denied, read the message, adjust, and do not repeat the same call unchanged.',
      this.ui.askUser && !this.disallowed.has('ask_user') ? tools.askUser.prompt
        : '- You cannot ask the user questions in this run: when something is unclear, choose the most reasonable default and say what you assumed.',
      '- Output is shown in a terminal: be concise, use short Markdown, and reply in the user\'s language.',
    ];
    if (m === 'plan') lines.push('', 'PLAN MODE IS ACTIVE. Do not modify files or run commands. Research with the read-only tools, then call exit_plan_mode with a concise step-by-step plan and wait for approval.');
    for (const f of store.memoryFiles(this.cwd)) {
      if (f.exists) lines.push('', `# ${f.label} (${f.path})`, f.text.trim().slice(0, 20000));
    }
    if (this.cfg.appendSystemPrompt) lines.push('', this.cfg.appendSystemPrompt);
    return lines.join('\n');
  }

  toolDefs() {
    const plan = this.mode === 'plan';
    const list = tools.definitions().filter((t) => !this.disallowed.has(t.name) && (!plan || t.category === 'read')).map((t) => t.def);
    if (this.ui.askUser && !this.disallowed.has('ask_user')) list.push(EXTRA_TOOLS.ask_user.def);
    if (plan) list.push(EXTRA_TOOLS.exit_plan_mode.def);
    return list;
  }

  apiMessages(list) {
    // _display · _ui 처럼 _ 로 시작하는 것은 화면·기록용이라 모델에는 보내지 않는다.
    return (list || this.messages).map((m) => Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('_'))));
  }

  push(msg) {
    // 마지막 응답 뒤에 덧붙는 내용(도구 결과 · 새 지시)은 다음 요청의 입력이 되므로 어림해 둔다.
    if (msg.role === 'user' || msg.role === 'tool') this.totals.sinceChars = (this.totals.sinceChars || 0) + String(msg.content || '').length;
    this.messages.push(msg); if (this.session) this.session.append(msg); if (this.ui.message) this.ui.message(msg); }

  abort() { this.aborted = true; if (this.current) this.current.abort(); }

  // ---------- 요청 + 실패하면 다시 시도 ----------
  // 네트워크가 끊겼거나(연결 실패·응답 도중 끊김) 서버가 잠시 받지 못할 때(408·409·429·5xx)는
  // 간격을 늘려 가며 최대 10번까지 다시 보낸다 (규칙: renderer/js/retry.js).
  async requestRetry(opts = {}) {
    const ui = opts.quiet ? {} : this.ui;
    const max = this.cfg.maxRetries != null ? this.cfg.maxRetries : retry.MAX_RETRIES;
    for (let attempt = 1; ; attempt++) {
      const r = await this.request(opts);
      if (!r.error || r.aborted || this.aborted || this.stop) return r;
      const wait = retry.delay(r, attempt, max);
      if (wait == null) {
        if (attempt > 1 && retry.retryable(r)) r.error += ` (${attempt - 1}번 다시 시도했지만 실패했습니다)`;
        return r;
      }
      const info = { attempt, max, reason: retry.reason(r), error: r.error, status: r.status || 0 };
      if (this.ui.retryWait) this.ui.retryWait(wait, info);
      else if (ui.notice) ui.notice(retry.label(info, wait));
      // 기다리는 동안에도 중단(esc)은 바로 듣는다.
      await new Promise((res) => {
        const done = () => { clearTimeout(t); this.current = null; res(); };
        const t = setTimeout(done, wait);
        this.current = { abort: done };
      });
      if (this.aborted || this.stop) return { ...r, error: null, aborted: true, content: '', reasoning: '', toolCalls: [], usage: null };
    }
  }

  // ---------- 요청 한 번 ----------
  request({ extraMessages, noTools, quiet, effort, maxTokens, messages } = {}) {
    const ui = quiet ? {} : this.ui;
    return new Promise((resolve) => {
      const body = {
        model: this.cfg.model, stream: true, stream_options: { include_usage: true },
        messages: [{ role: 'system', content: this.systemPrompt() }, ...this.apiMessages(messages), ...(extraMessages || [])],
        reasoning_effort: effort || this.cfg.effort, temperature: 1.0, top_p: 0.95,
        chat_template_kwargs: { preserve_thinking: true },
      };
      if (maxTokens) body.max_tokens = maxTokens;
      const defs = noTools ? [] : this.toolDefs();
      if (defs.length) body.tools = defs;
      const ac = new AbortController();
      this.current = { abort: () => ac.abort() };
      const r = { content: '', reasoning: '', toolCalls: [], usage: null, finish: null, error: null, aborted: false, incomplete: false, stream: null, ms: 0 };
      const t0 = Date.now();
      let phase = 'wait';
      let thinkStart = 0;
      const endThinking = () => {
        if (!thinkStart) return;
        const ms = Date.now() - thinkStart;
        thinkStart = 0;
        this.lastThinking = r.reasoning;
        r.thinkMs = ms;
        if (ui.thinkingEnd) ui.thinkingEnd(ms, r.reasoning);
      };
      if (ui.requestStart) ui.requestStart();
      exaone.chat({
        fetchImpl: fetch, baseUrl: this.cfg.baseUrl, apiKey: this.key, body, signal: ac.signal, minGapMs: this.cfg.minGapMs,
        onEvent: (ev) => {
          switch (ev.type) {
            case 'response': if (ev.headers && Object.keys(ev.headers).length) { this.rate = ev.headers; store.saveRate(store.rateFromHeaders(ev.headers)); } break;
            case 'reasoning':
              if (!r.reasoning) { thinkStart = Date.now(); phase = 'think'; if (ui.thinkingStart) ui.thinkingStart(); }
              r.reasoning += ev.text;
              if (ui.reasoning) ui.reasoning(ev.text);
              break;
            case 'content':
              if (phase !== 'content') { endThinking(); phase = 'content'; if (ui.contentStart) ui.contentStart(); }
              r.content += ev.text;
              if (ui.content) ui.content(ev.text);
              break;
            case 'tool_call': {
              if (phase !== 'tool') { endThinking(); if (phase === 'content' && ui.contentEnd) ui.contentEnd(); phase = 'tool'; }
              let tc = r.toolCalls[ev.index];
              if (!tc) tc = r.toolCalls[ev.index] = { id: ev.id || rid(), name: '', arguments: '' };
              if (ev.name && !tc.name) tc.name = ev.name;
              if (ev.args) tc.arguments += ev.args;
              if (ui.toolBuilding) ui.toolBuilding(tc);
              break;
            }
            case 'usage': r.usage = ev.usage; break;
            case 'finish': r.finish = ev.finishReason; break;
            case 'error': r.error = (ev.status ? `HTTP ${ev.status} · ` : '') + ev.message; r.retryAfterMs = ev.retryAfterMs; r.status = ev.status; r.network = !!ev.network; break;
            case 'aborted': r.aborted = true; break;
            case 'done': {
              endThinking();
              if (phase === 'content' && ui.contentEnd) ui.contentEnd();
              r.incomplete = !!ev.incomplete; r.stream = ev.stream; r.ms = Date.now() - t0;
              this.current = null;
              this.totals.requests++; this.totals.apiMs += r.ms;
              if (r.usage) {
                this.totals.lastPrompt = (r.usage.prompt_tokens || 0) + (r.usage.completion_tokens || 0);
                this.totals.sinceChars = 0;
                this.totals.completion += r.usage.completion_tokens || 0;
                this.totals.reasoning += (r.usage.reasoning_tokens != null ? r.usage.reasoning_tokens : (r.usage.completion_tokens_details || {}).reasoning_tokens) || 0;
              }
              r.toolCalls = r.toolCalls.filter(Boolean).filter((t) => t.name);
              if (r.aborted || r.incomplete) r.toolCalls = r.toolCalls.filter((t) => tryJson(t.arguments || '{}') !== undefined);
              r.content = r.content.replace(/^\s+/, '');
              // 서버가 도구 호출을 본문에 <tool_call> 텍스트로 흘린 경우
              if (!r.toolCalls.length && r.content.includes('<tool_call>') && !r.error && !r.aborted) {
                const names = new Set(defs.map((d) => d.function.name));
                const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
                let m;
                while ((m = re.exec(r.content))) {
                  const j = tryJson(m[1]);
                  if (j && names.has(j.name)) r.toolCalls.push({ id: rid(), name: j.name, arguments: JSON.stringify(j.arguments != null ? j.arguments : (j.parameters || {})) });
                }
                if (r.toolCalls.length) r.content = r.content.replace(re, '').trim();
              }
              resolve(r);
              break;
            }
          }
        },
      });
    });
  }

  // ---------- 권한 ----------
  permissionFor(name, a, category) {
    if (this.deny.some((r) => ruleMatches(r, name, a))) return 'deny';
    if (category === 'read') return 'allow';
    const m = this.mode;
    if (m === 'bypassPermissions') return 'allow';
    if (m === 'plan') return 'deny';
    if (category === 'write' && m === 'acceptEdits') return 'allow';
    if (this.allow.some((r) => ruleMatches(r, name, a))) return 'allow';
    return 'ask';
  }

  // ---------- 도구 한 번 ----------
  async runTool(tc) {
    const ui = this.ui;
    const args = tryJson(tc.arguments || '{}');
    const a = args && typeof args === 'object' ? args : {};
    const title = toolTitle(tc.name, a);
    const done = (res) => { if (ui.toolEnd) ui.toolEnd(tc, a, res, title); this.turnDetails.push({ kind: 'tool', title, content: res.content || '', meta: res.meta || null }); return res; };
    if (args === undefined || args === null || typeof args !== 'object') return done({ ok: false, content: '오류: 도구 인자가 올바른 JSON 객체가 아닙니다. 인자를 고쳐 다시 호출하세요.' });

    if (tc.name === 'ask_user') {
      if (!ui.askUser) return done({ ok: false, content: '사용자에게 물어볼 수 없는 실행 방식입니다. 합리적인 기본값으로 진행하세요.' });
      const qs = tools.askUser.normalize(a);
      if (!qs.length) return done({ ok: false, content: '오류: questions 가 비어 있습니다. question 과 options 를 넣어 다시 호출하세요.' });
      const ans = await ui.askUser(qs); // 질문마다의 답(문자열) 배열, 닫으면 null
      if (ans == null) { this.stop = true; return done({ ok: false, content: '사용자가 답하지 않고 질문을 닫았습니다.', silent: true }); }
      return done({ ok: true, content: tools.askUser.format(qs, ans), meta: { answer: ans.join(' · '), questions: qs, answers: ans } });
    }
    if (tc.name === 'exit_plan_mode') {
      if (!ui.approvePlan) return done({ ok: false, content: '계획 승인을 받을 수 없는 실행 방식입니다.' });
      const d = await ui.approvePlan(String(a.plan || ''));
      if (d === 'keep') { this.stop = true; return done({ ok: false, content: '사용자가 계획을 승인하지 않았습니다. 계획 모드를 유지합니다. 사용자의 다음 지시를 기다리세요.', silent: true }); }
      this.setMode(d === 'accept' ? 'acceptEdits' : 'default');
      return done({ ok: true, content: '사용자가 계획을 승인했습니다. 계획 모드가 끝났으니 이제 계획대로 구현을 시작하세요.', silent: true });
    }

    const def = tools.definitions().find((t) => t.name === tc.name);
    if (!def || this.disallowed.has(tc.name)) return done({ ok: false, content: `오류: "${tc.name}" 는 사용할 수 없는 도구입니다.` });
    if (tc.name === 'update_plan' && Array.isArray(a.steps)) this.todos = a.steps;

    let verdict = this.permissionFor(tc.name, a, def.category);
    if (verdict === 'ask') {
      if (!ui.permission) verdict = 'deny-noninteractive';
      else {
        const d = await ui.permission({ tc, a, def, title, prefix: tc.name === 'run_command' ? bashPrefix(a.command || '') : null });
        if (d.decision === 'always') {
          if (def.category === 'write') this.setMode('acceptEdits');
          else {
            const rule = tc.name === 'run_command' ? `Bash(${bashPrefix(a.command || '')}:*)` : (() => { try { return `Fetch(domain:${new URL(a.url).hostname})`; } catch { return 'Fetch'; } })();
            this.allow.push(rule);
            try { store.addAllowRule(this.cwd, rule); } catch { /* 저장 실패는 무시 */ }
          }
          verdict = 'allow';
        } else if (d.decision === 'allow') verdict = 'allow';
        else if (d.feedback) return done({ ok: false, rejected: true, display: '거부함 — ' + d.feedback, content: '사용자가 이 작업을 거부하고 이렇게 말했습니다: ' + d.feedback });
        else { this.stop = true; return done({ ok: false, rejected: true, display: '거부함', content: '사용자가 이 작업을 거부했습니다. 같은 호출을 반복하지 말고 사용자의 다음 지시를 기다리세요.' }); }
      }
    }
    if (verdict === 'deny') return done({ ok: false, rejected: true, display: this.mode === 'plan' ? '계획 모드라 실행하지 않음' : '권한 규칙에 따라 거부됨', content: this.mode === 'plan' ? '계획 모드라서 실행할 수 없습니다. 계획이 준비되면 exit_plan_mode 를 호출하세요.' : '권한 설정(deny 규칙)에 따라 이 작업은 허용되지 않습니다.' });
    if (verdict === 'deny-noninteractive') return done({ ok: false, rejected: true, display: '승인할 수 없어 건너뜀', content: '비대화형 실행이라 사용자가 승인할 수 없습니다. 이 작업은 건너뛰고 필요한 내용을 답변으로 설명하세요. (--dangerously-skip-permissions 또는 --allowedTools 로 허용할 수 있습니다)' });

    if (ui.toolStart) ui.toolStart(tc, a, title);
    this.current = { abort: () => tools.cancel(tc.id) };
    const res = await tools.run(tc.name, a, {
      workspace: this.cwd, callId: tc.id, shell: 'auto', commandTimeout: 120, fetchImpl: fetch,
      onOutput: ui.toolOutput ? (chunk) => ui.toolOutput(chunk) : undefined,
      onChange: (ch) => { try { if (this.history) this.history.record(this.session ? this.session.id : 'session', { ...ch, callId: tc.id }); } catch { /* 무시 */ } },
    });
    this.current = null;
    return done(res);
  }

  // ---------- 지시 한 번 ----------
  async turn(text, { display } = {}) {
    const ui = this.ui;
    this.aborted = false; this.stop = false; this.turnDetails = [];
    const userMsg = { role: 'user', content: text };
    if (display) userMsg._display = display;
    this.push(userMsg);
    const t0 = Date.now();
    const use = { completion: 0, reasoning: 0, prompt: 0 };
    let turns = 0, finalText = '', error = null;
    const max = this.cfg.maxTurns || 50;
    while (turns < max && !this.aborted && !this.stop) {
      // 요청을 보내기 전마다: 컨텍스트가 기준을 넘었으면 이전 대화를 요약으로 압축하고 이어 간다.
      if ((this.compactFails || 0) < COMPACT_MAX_FAILS && this.contextTokens() >= this.compactThreshold()) {
        if (ui.compactStart) ui.compactStart();
        const cr = await this.compact('', { auto: true });
        if (cr && cr.error && !this.aborted) this.compactFails = (this.compactFails || 0) + 1;
        if (ui.compactEnd) ui.compactEnd(cr && cr.error && this.compactFails >= COMPACT_MAX_FAILS ? { ...cr, gaveUp: true } : cr);
        if (this.aborted) { error = 'interrupted'; if (ui.interrupted) ui.interrupted(); break; }
      }
      turns++;
      // 네트워크 문제나 요청 한도·서버 오류는 간격을 늘려 가며 자동으로 다시 시도한다.
      const r = await this.requestRetry();
      if (r.usage) {
        use.prompt = r.usage.prompt_tokens || 0; use.completion += r.usage.completion_tokens || 0;
        use.reasoning += (r.usage.reasoning_tokens != null ? r.usage.reasoning_tokens : (r.usage.completion_tokens_details || {}).reasoning_tokens) || 0;
      }
      if (r.reasoning) this.turnDetails.push({ kind: 'thinking', content: r.reasoning, ms: r.thinkMs });
      if (r.error) { error = r.error; if (ui.error) ui.error(r.error); break; }
      if (r.aborted) { error = 'interrupted'; if (ui.interrupted) ui.interrupted(); }
      else if (r.incomplete) { error = `응답이 완료 신호 없이 ${(r.ms / 1000).toFixed(0)}초 만에 끊겼습니다 (청크 ${r.stream ? r.stream.chunks : '?'}개). 서버나 프록시의 시간 제한일 수 있습니다. 추론 강도를 낮춰 다시 시도해 보세요.`; if (ui.error) ui.error(error); }
      else if (r.finish === 'length') { error = '길이 제한에 걸려 응답이 잘렸습니다 (finish_reason: length).'; if (ui.error) ui.error(error); }
      else if (!r.content && !r.toolCalls.length) { error = '모델이 추론만 하고 답변이나 도구 호출 없이 끝났습니다.'; if (ui.error) ui.error(error); }
      if (r.content || r.toolCalls.length) {
        const am = { role: 'assistant', content: r.content || '' };
        if (r.reasoning) am.reasoning_content = r.reasoning;
        if (r.toolCalls.length) am.tool_calls = r.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tryJson(tc.arguments || '{}') === undefined ? '{}' : (tc.arguments || '{}') } }));
        this.push(am);
        if (r.content) finalText = r.content;
      }
      if (r.aborted || r.incomplete || r.finish === 'length' || !r.toolCalls.length) {
        for (const tc of r.toolCalls) this.push({ role: 'tool', tool_call_id: tc.id, content: '(실행되지 않음: 중단됨)' });
        break;
      }
      for (const tc of r.toolCalls) {
        const res = (this.aborted || this.stop) ? { content: '(실행되지 않음: 사용자가 중단함)' } : await this.runTool(tc);
        this.push({ role: 'tool', tool_call_id: tc.id, content: String(res.content == null ? '' : res.content) });
      }
      if (this.aborted && ui.interrupted && !error) { error = 'interrupted'; ui.interrupted(); }
      if (turns >= max && !this.aborted && !this.stop && ui.notice) ui.notice(`최대 단계 수(${max})에 도달했습니다. "계속" 이라고 입력하면 이어서 합니다.`);
    }
    const stats = { ms: Date.now() - t0, turns, ...use };
    if (ui.turnEnd) ui.turnEnd(stats);
    return { text: finalText, error, turns, stats };
  }

  // ---------- 대화 압축 ----------
  /**
   * 대화를 요약으로 바꿔 컨텍스트를 비운다.
   * auto: 한 지시를 처리하는 도중에 자동으로 부른 경우 — 아직 답하지 않은 마지막 사용자 메시지는 요약 뒤에 그대로 두고,
   *       작업 도중이었다면 요약만 보고 바로 이어서 하도록 한다.
   */
  async compact(instructions, { auto = false } = {}) {
    const all = this.messages;
    const tail = auto && all.length && all[all.length - 1].role === 'user' ? [all[all.length - 1]] : [];
    const head = tail.length ? all.slice(0, -1) : all;
    if (!head.some((m) => m.role === 'assistant')) return null;
    const ask = COMPACT_ASK + (instructions ? '\n\n추가 지시: ' + instructions : '');
    // 요약할 범위(head)만 보낸다. 네트워크 문제로 다시 보낼 때도 같은 범위를 쓴다.
    const r = await this.requestRetry({ messages: head, extraMessages: [{ role: 'user', content: ask }], noTools: true, quiet: true, effort: 'low', maxTokens: COMPACT_RESERVE });
    // <analysis> 는 점검용 초안이라 버리고 <summary> 안의 내용만 쓴다.
    const raw = String(r.content || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    const sm = /<summary>([\s\S]*?)(<\/summary>|$)/.exec(raw);
    const summary = (sm ? sm[1] : raw.replace(/<analysis>[\s\S]*?(<\/analysis>|$)/g, '')).trim();
    if (r.error || r.aborted || !summary) return { error: r.aborted ? '중단됨' : (r.error || '요약을 만들지 못했습니다') };
    const resume = auto && !tail.length;
    this.messages = [
      { role: 'user', content: COMPACT_HEAD + summary + (resume ? COMPACT_RESUME : '') },
      ...(resume ? [] : [{ role: 'assistant', content: '요약한 맥락을 확인했습니다. 이어서 진행하겠습니다.' }]),
      ...tail,
    ];
    if (this.session) this.session.rewrite(this.messages);
    this.totals.lastPrompt = Math.ceil(summary.length / 2);
    this.totals.sinceChars = tail.reduce((n, m) => n + String(m.content || '').length, 0);
    this.compactFails = 0;
    return { summary, before: head.length, auto };
  }
}

module.exports = { Agent, MODES, CTX_LIMIT, COMPACT_RESERVE, COMPACT_BUFFER, TOOL_LABEL, toolTitle, bashPrefix, ruleMatches, internalNames };
