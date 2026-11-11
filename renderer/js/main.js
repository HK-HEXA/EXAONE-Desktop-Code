'use strict';
/* 초기화와 이벤트 연결 */

(async function init() {
  const info = await exa.init();
  S.settings = info.settings;
  S.keyInfo = info.keyInfo;
  S.toolDefs = info.toolDefs;
  S.askUser = info.askUser || {};
  S.env = info.env;
  // 사용자 로고가 있으면 Desktop/Code 기본 앱 마크 대신 표시한다.
  S.logo = info.logo || null;
  if (S.logo) { const el = $('.brand .logo'); if (el) { el.textContent = ''; el.classList.add('has-img'); el.append(h('img', { src: S.logo, alt: '' })); } }
  document.body.dataset.platform = S.env.platform;

  for (const e of $$('[data-icon]')) e.prepend(icon(e.dataset.icon, e.classList.contains('icon-btn') ? 17 : 15));

  applyTheme();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  S.convs = await exa.listConvs();
  document.body.classList.toggle('sb-closed', !S.settings.ui.sidebar);

  // ----- IPC 이벤트 -----
  exa.onChatEvent((ev) => { const fn = chatHandlers.get(ev.reqId); if (fn) fn(ev); });
  exa.onToolOutput(({ callId, chunk }) => {
    const st = toolState.get(callId);
    if (!st) return;
    st.live = (st.live + chunk).slice(-20000);
    liveEmit('toolOutput', chunk);
    if (st.timer) return;
    st.timer = setTimeout(() => {
      st.timer = null;
      const conv = S.conv;
      if (!conv) return;
      for (let i = conv.messages.length - 1; i >= 0; i--) {
        const m = conv.messages[i];
        if (m.role === 'assistant' && (m.toolCalls || []).some((tc) => tc.id === callId)) { updateAssistant(m); stickBottom(); break; }
      }
    }, 80);
  });

  // ----- 사이드바 -----
  $('#btn-new').addEventListener('click', () => newConv());
  // 상단의 프로젝트 이름: 대화 중이면 프로젝트 홈으로, 이미 홈이면 프로젝트 설정을 연다.
  $('#proj-crumb').addEventListener('click', () => {
    const p = projectOf(S.conv);
    if (!p) return;
    if (S.conv.messages.length) newConv(p.id); else openProjectDialog(p);
  });
  $$('#nav button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  $('#search').addEventListener('input', (e) => { S.search = e.target.value; renderConvList(); });
  $('#btn-settings').addEventListener('click', () => openSettings());
  const toggleSidebar = () => {
    const closed = document.body.classList.toggle('sb-closed');
    saveSettings({ ui: { sidebar: !closed } });
  };
  $('#btn-sidebar-close').addEventListener('click', toggleSidebar);
  $('#btn-sidebar-open').addEventListener('click', toggleSidebar);

  // ----- 상단 바 -----
  $('#conv-title').addEventListener('click', () => {
    const t = $('#conv-title');
    if (S.view !== 'chat' || !S.conv || S.conv.code || !S.conv.messages.length || t.querySelector('input')) return;
    startRename(S.conv, t, () => { renderChrome(); renderConvList(); });
  });
  $('#btn-export').addEventListener('click', (e) => popupMenu(e.currentTarget, [
    { icon: 'file', label: 'Markdown 으로 내보내기', onClick: () => exportConv('md') },
    { icon: 'braces', label: 'JSON 으로 내보내기', desc: '추론·도구 호출·통계 포함', onClick: () => exportConv('json') },
    { icon: 'copy', label: '대화 전체 복사', onClick: () => { if (S.conv && S.conv.messages.length) copyText(convToMarkdown(S.conv)); } },
  ], { alignRight: true }));
  const togglePanel = () => { if ($('#rpanel').hidden) showPanel(); else hidePanel(); };
  $('#btn-panel').addEventListener('click', togglePanel);
  $('#btn-panel-close').addEventListener('click', hidePanel);
  $$('.rp-tabs button[data-tab]').forEach((b) => b.addEventListener('click', () => selectPanelTab(b.dataset.tab)));

  // ----- 입력창 -----
  const inp = $('#input');
  inp.addEventListener('input', () => { autosize(); slashIdx = 0; renderSlash(); });
  inp.addEventListener('blur', () => setTimeout(() => { $('#slash-menu').hidden = true; }, 120));
  inp.addEventListener('focus', renderSlash);
  inp.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // 한글 조합 중
    const slash = slashMatches();
    if (slash.length && !$('#slash-menu').hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        slashIdx = (slashIdx + (e.key === 'ArrowDown' ? 1 : -1) + slash.length) % slash.length;
        renderSlash();
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && slash[slashIdx].cmd !== inp.value.trim())) {
        e.preventDefault();
        pickSlash(slash[slashIdx]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  inp.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) { e.preventDefault(); addFiles(files); }
  });
  $('#btn-send').addEventListener('click', () => {
    if (S.busy) stopRun();
    else if (S.remote && S.conv && S.conv.code) exa.liveStop(S.conv.code.id); // 터미널이 실행 중인 작업을 멈춰 달라고 요청
    else send();
  });
  // [+] 메뉴: 대화에 무언가를 더하는 동작만 모은다.
  $('#btn-attach').addEventListener('click', (e) => {
    const agent = S.conv.mode === 'agent';
    popupMenu(e.currentTarget, [
      { icon: 'clip', label: '파일 첨부', desc: '텍스트 파일 · 끌어다 놓기나 붙여넣기도 가능', onClick: () => $('#file-input').click() },
      agent ? { icon: 'folder', label: S.conv.workspace ? '작업 폴더 바꾸기…' : '작업 폴더 선택…', desc: S.conv.workspace || '에이전트가 파일을 읽고 쓰는 곳', onClick: chooseWorkspace } : null,
      '-',
      { icon: 'edit', label: '시스템 프롬프트…', onClick: () => { openSettings('model'); const t = $('#p-system'); if (t) t.focus(); } },
      { icon: 'newchat', label: '새 프로젝트…', onClick: () => openProjectDialog(null) },
    ].filter(Boolean));
  });
  const toolsMenu = (anchor) => {
    const set = (mode) => { saveSettings({ structured: { mode } }); renderChips(); renderParamsPanel(); };
    const m = S.settings.structured.mode;
    const ct = !!S.settings.customTools.enabled;
    popupMenu(anchor, [
      { icon: 'chat', label: '일반 텍스트', desc: '출력 형식 지정 없음', active: m === 'off', onClick: () => set('off') },
      { icon: 'braces', label: 'JSON 객체', desc: 'response_format: json_object', active: m === 'json_object', onClick: () => set('json_object') },
      { icon: 'braces', label: 'JSON 스키마', desc: '지정한 스키마를 따르는 응답', active: m === 'json_schema', onClick: () => set('json_schema') },
      '-',
      { icon: 'code', label: '함수 호출 테스트', desc: '직접 정의한 함수를 tools 로 전달', active: ct, onClick: () => { saveSettings({ customTools: { enabled: !ct } }); renderChips(); renderToolsPanel(); } },
      '-',
      { icon: 'edit', label: 'JSON 스키마 편집…', onClick: () => openSettings('format') },
      S.conv.mode === 'agent' ? { icon: 'terminal', label: '에이전트 도구…', onClick: () => openSettings('agent') } : null,
    ].filter(Boolean), { title: '출력 형식 · 도구' });
  };
  $('#btn-tools').addEventListener('click', (e) => toolsMenu(e.currentTarget));
  $('#file-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $$('#mode-seg button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $$('#mode-pick button').forEach((b) => b.addEventListener('click', () => switchMode(b.dataset.mode)));
  $('#btn-terminal').addEventListener('click', () => openCliInTerminal());
  $('#btn-effort').addEventListener('click', (e) => popupMenu(e.currentTarget, Object.entries(EFFORTS).map(([k, v]) => ({
    label: `${v.label} (${k})`, desc: v.desc, active: effortOf(S.conv) === k,
    onClick: () => setEffort(k),
  })).concat(['-', { icon: 'sliders', label: '모델 설정…', desc: S.settings.model, onClick: () => openSettings('model') }]),
  { title: S.conv && S.conv.mode === 'agent' ? '추론 강도 — 에이전트 모드' : '추론 강도 — 채팅 모드', alignRight: true }));
  $('#btn-json').addEventListener('click', (e) => toolsMenu(e.currentTarget));
  $('#btn-workspace').addEventListener('click', (e) => {
    if (!S.conv.workspace) { chooseWorkspace(); return; }
    popupMenu(e.currentTarget, [
      { icon: 'folder', label: '다른 폴더 선택…', desc: S.conv.workspace, onClick: chooseWorkspace },
      { icon: 'ext', label: '탐색기에서 열기', onClick: () => exa.open(S.conv.workspace) },
    ], { title: '작업 폴더' });
  });
  $('#btn-approval').addEventListener('click', (e) => popupMenu(e.currentTarget, Object.entries(APPROVALS).map(([k, v]) => ({
    icon: v.icon, label: v.label, desc: v.desc, active: S.settings.agent.approval === k,
    onClick: () => { saveSettings({ agent: { approval: k } }); renderChips(); renderToolsPanel(); },
  })).concat(['-', { icon: 'sliders', label: '에이전트 설정…', onClick: () => openSettings('agent') }]), { title: '도구 실행 승인' }));

  // ----- 메시지 영역 -----
  $('#messages').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const code = btn.closest('.codeblock') && btn.closest('.codeblock').querySelector('pre code');
    if (!code) return;
    if (btn.dataset.act === 'copy-code') copyText(code.textContent, null);
    else if (btn.dataset.act === 'preview-code') openPreview(code.textContent, (btn.closest('.codeblock').querySelector('.cb-lang') || {}).textContent || '');
  });
  const sc = $('#scroll');
  sc.addEventListener('scroll', () => { stick = nearBottom(); $('#btn-bottom').hidden = stick; });
  $('#btn-bottom').addEventListener('click', scrollToBottom);
  // 내용이나 창 크기가 바뀌어도 맨 아래에 붙어 있도록
  const ro = new ResizeObserver(() => stickBottom());
  ro.observe($('#messages'));
  ro.observe(sc);

  // ----- 드래그 앤 드롭 -----
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e) || S.view !== 'chat') return; dragDepth++; $('#drop-overlay').hidden = false; });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $('#drop-overlay').hidden = true; });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    $('#drop-overlay').hidden = true;
    if (S.view === 'chat') addFiles(e.dataTransfer.files);
  });

  // ----- 단축키 -----
  window.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Escape') {
      if (openMenu) { closeMenu(); return; }
      if ($('#modal-root').children.length) return;
      if (S.busy) { stopRun(); e.preventDefault(); }
      else if (S.remote && S.conv && S.conv.code) { exa.liveStop(S.conv.code.id); e.preventDefault(); }
      return;
    }
    if (!mod) return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); newConv(e.shiftKey ? null : (S.conv && S.conv.projectId)); }
    else if (k === 'k') { e.preventDefault(); document.body.classList.remove('sb-closed'); $('#search').focus(); $('#search').select(); }
    else if (k === 'b') { e.preventDefault(); toggleSidebar(); }
    else if (k === '.') { e.preventDefault(); togglePanel(); }
    else if (k === ',') { e.preventDefault(); openSettings(); }
    else if (k === 'l') { e.preventDefault(); setView('chat'); $('#input').focus(); }
  });
  window.addEventListener('resize', autosize);

  initConvDrag(); // 사이드바의 대화를 끌어서 프로젝트에 넣기 / 빼기

  // ----- 터미널 세션 목록: 시작할 때와 창으로 돌아올 때 새로 읽는다 -----
  refreshCliSessions();
  window.addEventListener('focus', () => { refreshCliSessions(); refreshKeyInfo(); });
  // 터미널에서 세션에 글이 쌓이는 즉시 반영한다: 파일 변경 알림 + (알림을 못 받는 환경을 위한) 짧은 주기의 확인
  exa.onCliChanged(() => refreshCliSessions(true));
  exa.onLiveEvents(({ sid, events }) => onLiveEvents(sid, events));
  exa.onLiveStop(({ sid }) => { if (S.busy && S.run && S.run.conv.code && S.run.conv.code.id === sid) stopRun(); });
  setInterval(() => { if (S.conv && S.conv.code && !S.busy && S.view === 'chat') syncCodeConv(); }, 1500);
  exa.onTokenRequest(() => openTokenDialog());
  // 알림을 누르면 그 대화를 연다.
  exa.onNotifyClick(({ convId }) => {
    if (!convId || (S.conv && S.conv.id === convId)) { setView('chat'); return; }
    if (S.busy) return; // 다른 작업이 진행 중이면 화면을 바꾸지 않는다
    openConv(convId).catch(() => {});
  });
  refreshCliBin().then(() => { if (S.conv && S.conv.code && !S.conv.messages.length) renderConv(); }); // 터미널(EXAONE Code)이 토큰 등록을 요청했을 때

  // ----- 첫 화면 -----
  renderRate();
  renderLogBadge();
  newConv();
  if (S.settings.ui.panel) showPanel();
  // 토큰이 없으면(또는 터미널이 등록하라고 앱을 띄웠으면) 등록 창부터 보여 준다.
  if (!S.keyInfo.hasKey || info.registerToken) openTokenDialog();
})().catch((e) => {
  console.error(e);
  document.body.append(Object.assign(document.createElement('pre'), { textContent: '초기화 오류: ' + (e && e.stack || e), style: 'padding:24px;color:#b3261e;white-space:pre-wrap' }));
});
