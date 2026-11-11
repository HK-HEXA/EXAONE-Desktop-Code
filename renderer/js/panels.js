'use strict';
/* 사이드바, 상단 바, 오른쪽 패널(매개변수·도구·미리보기), 설정, 테마 */

// ---------- 테마 ----------
function isDark() {
  const t = S.settings.theme;
  return t === 'dark' || (t !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function applyTheme() {
  const dark = isDark();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#hljs-light').disabled = dark;
  $('#hljs-dark').disabled = !dark;
  exa.setTheme(dark);
}

// ---------- 화면 전환 ----------
function setView(v) {
  S.view = v;
  for (const name of ['chat', 'tabular', 'logs']) $('#view-' + name).hidden = name !== v;
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  document.body.dataset.view = v;
  if (v === 'logs') renderLogs();
  if (v === 'tabular') renderTabular();
  renderChrome();
  renderConvList();
}

function renderChrome() {
  const conv = S.conv;
  const t = $('#conv-title');
  if (S.view === 'chat') {
    t.textContent = conv && conv.messages.length ? (conv.title || '새 대화') : (conv && conv.code ? '새 세션' : '새 대화');
    t.classList.toggle('editable', !!(conv && conv.messages.length && !conv.code));
  } else {
    t.textContent = S.view === 'tabular' ? 'EXAONE Tabular' : 'API 로그';
    t.classList.remove('editable');
  }
  const crumb = $('#proj-crumb');
  const proj = S.view === 'chat' ? projectOf(conv) : null;
  crumb.hidden = !proj;
  if (proj) { crumb.innerHTML = ''; crumb.append(icon('folder', 14), h('span', { text: proj.name }), h('i', { text: '/' })); }
  $('#model-chip').textContent = S.view === 'tabular' ? 'tabular' : S.settings.model;
  $('#model-chip').hidden = S.view === 'chat'; // 채팅 화면에서는 입력창 오른쪽에 모델이 표시된다
  $('#btn-export').hidden = S.view !== 'chat';
  renderChips();
  renderSendButton();
  const dot = $('#key-dot');
  dot.className = S.keyInfo.hasKey ? 'ok' : 'bad';
  dot.title = S.keyInfo.hasKey ? '토큰 등록됨' : '토큰이 등록되어 있지 않습니다';
}

function startRename(conv, anchorEl, onDone) {
  const input = h('input', { class: 'rename', value: conv.title || '', spellcheck: 'false' });
  const finish = async (save) => {
    if (input._done) return;
    input._done = true;
    const v = input.value.trim();
    if (save && v && v !== conv.title) {
      if (S.conv && S.conv.id === conv.id) { S.conv.title = v; persist(S.conv, true); }
      else { const full = await exa.loadConv(conv.id); if (full) { full.title = v; await exa.saveConv(full); S.convs = await exa.listConvs(); } }
    }
    onDone();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') finish(false); e.stopPropagation(); });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  anchorEl.innerHTML = '';
  anchorEl.append(input);
  input.focus();
  input.select();
}

// ---------- 프로젝트 ----------
// 프로젝트 = 이름 + 작업 폴더 + 지침. 대화는 projectId 로 프로젝트에 속한다.
function projectOf(conv) {
  return conv && conv.projectId ? (S.settings.projects || []).find((p) => p.id === conv.projectId) || null : null;
}

function saveProjects(list) {
  saveSettings({ projects: list });
  renderConvList();
  renderChrome();
  // 프로젝트 홈(또는 프로젝트가 지워진 빈 대화)은 바뀐 내용으로 다시 그린다.
  if (S.conv && !S.conv.messages.length && S.view === 'chat') renderConv();
}

function openProjectDialog(project) {
  const isNew = !project;
  const draft = project ? { ...project } : { id: uid('p'), name: '', description: '', path: '', instructions: '', memory: '', links: [], createdAt: Date.now() };
  const name = h('input', { class: 'txt', value: draft.name, placeholder: '예: 쇼핑몰 리뉴얼' });
  const pathLabel = h('span', { class: 'muted path' });
  const drawPath = () => { pathLabel.textContent = draft.path || '선택 안 함 (채팅 전용 프로젝트)'; pathLabel.title = draft.path || ''; };
  drawPath();
  const inst = h('textarea', { class: 'text-ta', rows: 6, value: draft.instructions || '', placeholder: '이 프로젝트의 모든 대화에 system 메시지로 들어갑니다. 예: 기술 스택, 코딩 규칙, 답변 언어…' });
  const descInput = h('input', { class: 'txt', value: draft.description || '', placeholder: '무엇을 하는 프로젝트인지 한 줄로' });
  const save = () => {
    draft.name = name.value.trim();
    draft.description = descInput.value.trim();
    if (!draft.name) { draft.name = draft.path ? baseName(draft.path) : ''; }
    if (!draft.name) { toast('프로젝트 이름을 입력하세요'); name.focus(); return; }
    draft.instructions = inst.value;
    const list = (S.settings.projects || []).filter((p) => p.id !== draft.id).concat(draft);
    list.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0));
    saveProjects(list);
    m.close();
    if (isNew) newConv(draft.id);
    else if (S.conv && S.conv.projectId === draft.id && !S.conv.messages.length) newConv(draft.id);
  };
  const m = openModal({
    title: isNew ? '새 프로젝트' : '프로젝트 설정',
    wide: true,
    body: h('div', { class: 'settings' },
      field('이름', name),
      field('설명', descInput, '선택'),
      field('작업 폴더', h('div', { class: 'inline' }, pathLabel, h('span', { class: 'grow' }),
        draft.path ? h('button', { class: 'btn ghost sm', onclick: () => { draft.path = ''; drawPath(); } }, '지우기') : null,
        h('button', { class: 'btn sm', onclick: async () => {
          const dir = await exa.pickFolder(draft.path || S.settings.lastWorkspace || '');
          if (!dir) return;
          draft.path = dir;
          if (!name.value.trim()) name.value = baseName(dir);
          drawPath();
        } }, icon('folder', 13), '폴더 선택')), '에이전트가 파일을 읽고 쓰는 곳'),
      field('프로젝트 지침', inst, '선택')),
    footer: [
      !isNew ? h('button', { class: 'btn danger-ghost', style: { marginRight: 'auto' }, onclick: async () => {
        if (!await confirmDialog(`"${project.name}" 프로젝트를 삭제할까요? 대화와 폴더의 파일은 그대로 남고, 대화는 프로젝트 밖으로 나옵니다.`, '삭제', true)) return;
        saveProjects((S.settings.projects || []).filter((p) => p.id !== project.id));
        m.close();
      } }, '프로젝트 삭제') : null,
      h('button', { class: 'btn', onclick: () => m.close() }, '취소'),
      h('button', { class: 'btn primary', onclick: save }, isNew ? '만들기' : '저장'),
    ],
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) save(); });
  setTimeout(() => name.focus(), 30);
}

async function moveConv(c, projectId) {
  const proj = (S.settings.projects || []).find((p) => p.id === projectId) || null;
  const apply = (conv) => {
    conv.projectId = proj ? proj.id : null;
    if (proj && proj.path && !conv.workspace) conv.workspace = proj.path;
  };
  if (S.conv && S.conv.id === c.id) { apply(S.conv); await persist(S.conv, true); renderChrome(); }
  else {
    await flushPersist(c.id); // 저장을 기다리던 변경이 이 이동을 덮어쓰지 않게 먼저 저장한다
    const full = await exa.loadConv(c.id);
    if (!full) return false;
    apply(full);
    await exa.saveConv(full);
    S.convs = await exa.listConvs();
    renderConvList();
  }
  return true;
}

// ---------- 대화를 끌어서 프로젝트에 넣기 / 빼기 ----------
// 사이드바의 대화를 프로젝트 줄(또는 그 안의 대화) 위에 놓으면 그 프로젝트로 들어가고,
// 아래쪽 일반 목록에 놓으면 프로젝트에서 빠진다.
const CONV_DRAG_TYPE = 'application/x-exaone-conv';
const convDrag = { conv: null, dirty: false };

function clearDropMarks() {
  for (const e of $$('#conv-list .drop-into, #conv-list .drop-out')) e.classList.remove('drop-into', 'drop-out');
}

function endConvDrag() {
  if (!convDrag.conv && !convDrag.dirty) return;
  convDrag.conv = null;
  clearDropMarks();
  for (const e of $$('#conv-list .dragging')) e.classList.remove('dragging');
  document.body.classList.remove('conv-dragging');
  // 끄는 동안 미뤄 둔 목록 갱신을 이제 한다.
  if (convDrag.dirty) { convDrag.dirty = false; renderConvList(); }
}

/** 끌고 있는 대화를 이 자리에 놓으면 어디로 가는지: { pid(없으면 프로젝트 밖), el(강조할 요소) }. 놓을 수 없는 자리면 null. */
function convDropTarget(e) {
  const c = convDrag.conv;
  if (!c || !e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes(CONV_DRAG_TYPE)) return null;
  const t = e.target instanceof Element ? e.target : (e.target && e.target.parentElement);
  if (!t) return null;
  const projects = S.settings.projects || [];
  const cur = c.projectId && projects.some((p) => p.id === c.projectId) ? c.projectId : null;
  const inProj = t.closest('[data-pid]');
  if (inProj) {
    const pid = inProj.dataset.pid;
    if (pid === cur || !projects.some((p) => p.id === pid)) return null; // 이미 그 프로젝트에 있다
    const row = $$('#conv-list .proj-row').find((r) => r.dataset.pid === pid);
    return row ? { pid, el: row } : null;
  }
  const zone = t.closest('.loose-zone');
  if (zone && cur) return { pid: null, el: zone };
  return null;
}

function initConvDrag() {
  const list = $('#conv-list');
  list.addEventListener('dragstart', (e) => {
    const item = e.target instanceof Element ? e.target.closest('.conv-item[data-conv]') : null;
    const conv = item ? S.convs.find((c) => c.id === item.dataset.conv) : null;
    // 이름을 바꾸는 중이거나 목록에 없는 대화는 끌지 않는다.
    if (!item || !conv || item.querySelector('input')) { e.preventDefault(); return; }
    endConvDrag();
    convDrag.conv = conv;
    e.dataTransfer.setData(CONV_DRAG_TYPE, conv.id);
    e.dataTransfer.effectAllowed = 'move';
    item.classList.add('dragging');
    document.body.classList.add('conv-dragging');
  });
  const onOver = (e) => {
    if (!convDrag.conv) return;
    const tgt = convDropTarget(e);
    const cls = tgt ? (tgt.pid ? 'drop-into' : 'drop-out') : '';
    // 강조할 곳이 바뀔 때만 다시 칠한다 (dragover 는 가만히 있어도 계속 온다).
    if (!tgt || !tgt.el.classList.contains(cls)) { clearDropMarks(); if (tgt) tgt.el.classList.add(cls); }
    if (!tgt) return; // preventDefault 를 하지 않으면 "놓을 수 없음" 커서가 된다
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  // dragenter 에서도 같은 처리를 해서, 올라가자마자 강조가 보이게 한다.
  list.addEventListener('dragenter', onOver);
  list.addEventListener('dragover', onOver);
  list.addEventListener('dragleave', (e) => {
    // 목록 안에서 요소 사이를 옮겨 갈 때도 dragleave 가 오므로, 포인터가 목록 밖으로 나갔을 때만 강조를 지운다.
    const r = list.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX >= r.right || e.clientY < r.top || e.clientY >= r.bottom) clearDropMarks();
  });
  list.addEventListener('drop', async (e) => {
    const tgt = convDropTarget(e);
    const conv = convDrag.conv;
    if (!tgt || !conv) { endConvDrag(); return; }
    e.preventDefault();
    e.stopPropagation();
    if (tgt.pid) {
      // 접혀 있던 프로젝트는 펼쳐서 옮겨진 것이 보이게 한다.
      const collapsed = new Set(S.settings.ui.collapsedProjects || []);
      if (collapsed.delete(tgt.pid)) saveSettings({ ui: { collapsedProjects: [...collapsed] } });
    }
    endConvDrag();
    const proj = tgt.pid ? (S.settings.projects || []).find((p) => p.id === tgt.pid) : null;
    const done = await moveConv(conv, tgt.pid);
    if (done) toast(proj ? `"${proj.name}" 프로젝트로 옮겼습니다` : '프로젝트에서 뺐습니다');
    else toast('대화를 옮기지 못했습니다', 'err');
  });
  list.addEventListener('dragend', () => endConvDrag());
  // 끌기가 끝났는데 dragend 를 받지 못한 경우의 안전망: 끄는 동안에는 mousemove 가 오지 않는다.
  window.addEventListener('mousemove', () => { if (convDrag.conv) endConvDrag(); }, true);
}

// ---------- 프로젝트 홈 ----------
// 프로젝트를 고르면 Claude Cowork 의 프로젝트 화면처럼 가운데에 이름 · 입력창 · 작업 목록,
// 오른쪽에 지침 · 컨텍스트 · 메모리 카드를 보여 준다.

/** 입력창을 프로젝트 홈 안(slot)으로 옮기거나, null 이면 대화 화면 아래 제자리로 돌려놓는다. */
function dockComposer(slot) {
  const cw = $('#composer-wrap');
  if (slot) { if (cw.parentElement !== slot) slot.append(cw); return; }
  const view = $('#view-chat');
  if (cw.parentElement !== view) view.insertBefore(cw, $('#file-input'));
}

function setProjectHome(on) {
  if (on === S.home) return;
  S.home = on;
  document.body.classList.toggle('proj-home', on);
  // 홈에서는 오른쪽 패널을 접어 두고 (설정은 그대로), 대화로 돌아가면 원래 상태로 되돌린다.
  if (on) { $('#rpanel').hidden = true; document.body.classList.remove('panel-open'); }
  else if (S.settings.ui.panel) showPanel();
}

function updateProject(id, patch) {
  saveProjects((S.settings.projects || []).map((p) => (p.id === id ? { ...p, ...patch } : p)));
}

function relTime(ts) {
  if (!ts) return '';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return Math.floor(s / 60) + '분 전';
  if (s < 86400) return Math.floor(s / 3600) + '시간 전';
  if (s < 86400 * 7) return Math.floor(s / 86400) + '일 전';
  const d = new Date(ts);
  return (d.getFullYear() === new Date().getFullYear() ? '' : d.getFullYear() + '. ') + (d.getMonth() + 1) + '. ' + d.getDate() + '.';
}

const PROJECT_TEXT = {
  description: { title: '프로젝트 설명', rows: 3, hint: '무엇을 하는 프로젝트인지 한두 줄로 적어 두세요.', placeholder: '예: 사내 쇼핑몰 프론트엔드 리뉴얼' },
  instructions: { title: '지침', rows: 12, hint: '이 프로젝트의 모든 작업에 system 메시지로 들어갑니다.', placeholder: '예: 기술 스택, 코딩 규칙, 답변 언어, 하면 안 되는 일…' },
  memory: { title: '메모리', rows: 12, hint: '작업하면서 기억해 둘 사실 · 결정 사항. 모든 작업에 함께 전달됩니다. 대화 중에는 /remember 내용 으로 추가할 수 있습니다.', placeholder: '예:\n- 배포는 매주 목요일\n- 테스트는 npm test 로 실행' },
};

function editProjectText(proj, key) {
  const d = PROJECT_TEXT[key];
  const ta = h('textarea', { class: 'text-ta', rows: d.rows, value: proj[key] || '', placeholder: d.placeholder });
  const m = openModal({
    title: `${d.title} — ${proj.name}`,
    wide: true,
    body: h('div', { class: 'settings' }, h('p', { class: 'ph-modal-hint', text: d.hint }), ta),
    footer: [
      h('button', { class: 'btn', onclick: () => m.close() }, '취소'),
      h('button', { class: 'btn primary', onclick: () => { updateProject(proj.id, { [key]: ta.value.trim() }); m.close(); } }, '저장'),
    ],
  });
  setTimeout(() => ta.focus(), 30);
}

function addProjectLink(proj) {
  const url = h('input', { class: 'txt', placeholder: 'https://…' });
  const title = h('input', { class: 'txt', placeholder: '예: API 문서 (선택)' });
  const save = () => {
    let u = url.value.trim();
    if (u && !/^https?:\/\//i.test(u)) u = 'https://' + u;
    try { new URL(u); } catch { toast('주소를 확인하세요'); url.focus(); return; }
    const links = (proj.links || []).filter((l) => l.url !== u).concat({ url: u, title: title.value.trim() });
    updateProject(proj.id, { links });
    m.close();
  };
  const m = openModal({
    title: '링크 추가',
    body: h('div', { class: 'settings' }, field('주소', url), field('이름', title, '선택'),
      h('p', { class: 'ph-modal-hint', text: '에이전트 작업에서는 필요할 때 web_fetch 도구로 이 주소를 읽습니다.' })),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, '취소'), h('button', { class: 'btn primary', onclick: save }, '추가')],
  });
  for (const i of [url, title]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) save(); });
  setTimeout(() => url.focus(), 30);
}

/** 프로젝트의 폴더를 정한다. dir 을 주지 않으면 폴더 선택 창을 띄운다. */
async function connectProjectFolder(proj, dir) {
  if (!dir) dir = await exa.pickFolder(proj.path || (S.conv && S.conv.workspace) || S.settings.lastWorkspace || '');
  if (!dir) return;
  if (S.conv && S.conv.projectId === proj.id && !S.conv.messages.length) S.conv.workspace = dir;
  saveSettings({ lastWorkspace: dir });
  updateProject(proj.id, { path: dir });
  refreshFilesPanel();
}

const samePath = (a, b) => {
  const n = (p) => { p = String(p || '').replace(/[\\/]+$/, ''); return S.env.platform === 'win32' ? p.toLowerCase() : p; };
  return n(a) === n(b);
};

/**
 * 프로젝트 홈의 컨텍스트에 보일 폴더들.
 * 첫 번째가 새 작업이 쓸 폴더이고(프로젝트 폴더, 없으면 에이전트에 연결해 둔 작업 폴더),
 * 그 뒤로 이 프로젝트의 작업들이 써 온 다른 폴더가 이어진다.
 */
function projectFolders(proj) {
  const agent = S.conv && S.conv.mode === 'agent';
  const list = [];
  const add = (p, why) => { if (p && !list.some((x) => samePath(x.path, p))) list.push({ path: p, why }); };
  if (agent) add(S.conv.workspace, proj.path && samePath(proj.path, S.conv.workspace) ? 'project' : 'task');
  add(proj.path, 'project');
  for (const c of S.convs) if (c.projectId === proj.id) add(c.workspace, 'used');
  return list;
}

// 긴 경로는 앞쪽을 줄여 보여 주는데(direction: rtl), 구분 기호가 뒤집히지 않도록 방향 표시를 붙인다.
const ltr = (s) => '\u200e' + s + '\u200e';

function homeCard(title, actions, body) {
  return h('section', { class: 'ph-card' }, h('header', null, h('b', { text: title }), h('span', { class: 'grow' }), actions), body);
}

function homeTextCard(proj, key, empty) {
  const text = (proj[key] || '').trim();
  const edit = () => editProjectText(proj, key);
  return homeCard(PROJECT_TEXT[key].title,
    h('button', { class: 'icon-btn sm', title: PROJECT_TEXT[key].title + ' 편집', onclick: edit }, icon(text ? 'edit' : 'plus', 14)),
    text ? h('div', { class: 'ph-text', text, onclick: edit }) : h('button', { class: 'ph-add', onclick: edit }, empty));
}

function homeContextCard(proj) {
  const links = (proj.links || []).filter((l) => l && l.url);
  const folders = projectFolders(proj);
  const body = h('div', { class: 'ph-ctx' });
  folders.forEach((f, i) => {
    const main = i === 0;
    const pinned = !!proj.path && samePath(proj.path, f.path);
    body.append(h('div', { class: 'ph-row', title: f.path, onclick: () => exa.open(f.path) },
      icon('folder', 15),
      h('div', { class: 'ph-row-main' },
        h('b', null, baseName(f.path), main && !pinned ? h('em', { text: '작업 폴더' }) : !main ? h('em', { text: pinned ? '프로젝트 폴더' : '이전 작업' }) : null),
        h('small', { text: ltr(f.path) })),
      h('span', { class: 'ph-row-acts' },
        !pinned ? h('button', { class: 'icon-btn sm', title: '이 폴더를 프로젝트 폴더로 지정', onclick: (e) => { e.stopPropagation(); connectProjectFolder(proj, f.path); } }, icon('check', 13)) : null,
        main ? h('button', { class: 'icon-btn sm', title: '다른 폴더로 바꾸기', onclick: (e) => { e.stopPropagation(); connectProjectFolder(proj); } }, icon('edit', 13)) : null)));
    if (!main) return;
    const files = h('div', { class: 'ph-files' });
    body.append(files);
    exa.fileList({ workspace: f.path, path: '' }).then((r) => {
      if (!r.ok) { files.append(h('div', { class: 'ph-note', text: '폴더를 읽지 못했습니다: ' + r.error })); return; }
      const all = r.data.entries.filter((e) => !/^(node_modules|\.git)$/.test(e.name));
      if (!all.length) { files.append(h('div', { class: 'ph-note', text: '빈 폴더입니다. 작업을 시작하면 여기에 파일이 생깁니다.' })); return; }
      for (const e of all.slice(0, 7)) {
        files.append(h('button', {
          class: 'ph-file', title: e.dir ? '탐색기에서 열기' : '미리보기',
          onclick: () => { if (e.dir) exa.fileOpen({ workspace: f.path, path: e.name }); else openFilePreview(e.name, f.path); },
        }, icon(e.dir ? 'folder' : 'file', 13), h('span', { text: e.name }), e.dir ? null : h('small', { text: fmtBytes(e.size) })));
      }
      const rest = all.length - 7 + (r.data.more || 0);
      if (rest > 0) files.append(h('button', { class: 'ph-file more', onclick: () => showPanel('files') }, `외 ${rest}개 모두 보기`));
    }).catch(() => {});
  });
  if (!folders.length) {
    body.append(h('button', { class: 'ph-add', onclick: () => connectProjectFolder(proj) },
      '폴더를 연결하면 에이전트가 그 안에서 파일을 읽고 만들며, 모든 작업이 같은 폴더를 씁니다.'));
  }
  for (const l of links) {
    let host = l.url;
    try { host = new URL(l.url).host; } catch { /* 그대로 */ }
    body.append(h('div', { class: 'ph-row', title: l.url, onclick: () => exa.open(l.url) },
      icon('link', 15), h('div', { class: 'ph-row-main' }, h('b', { text: l.title || host }), h('small', { text: ltr(l.url) })),
      h('span', { class: 'ph-row-acts' },
        h('button', { class: 'icon-btn sm', title: '링크 빼기', onclick: (e) => { e.stopPropagation(); updateProject(proj.id, { links: links.filter((x) => x !== l) }); } }, icon('x', 13)))));
  }
  const hasFolder = folders.length > 0;
  return homeCard('컨텍스트',
    h('button', { class: 'icon-btn sm', title: '컨텍스트 추가', onclick: (e) => popupMenu(e.currentTarget, [
      { icon: 'folder', label: hasFolder ? '폴더 바꾸기…' : '폴더 연결…', desc: hasFolder ? folders[0].path : '에이전트가 파일을 읽고 쓰는 곳', onClick: () => connectProjectFolder(proj) },
      { icon: 'link', label: '링크 추가…', desc: '참고할 문서 · 페이지 주소', onClick: () => addProjectLink(proj) },
    ], { alignRight: true }) }, icon('plus', 14)),
    body);
}

function homePreview(c) {
  const p = String(c.preview || '').replace(/\s+/g, ' ').trim();
  const t = String(c.title || '').replace(/…$/, '').trim();
  return p && !(t && p.startsWith(t)) ? p : ''; // 제목이 첫 메시지 그대로면 되풀이하지 않는다
}

/** 프로젝트 홈의 작업(대화) 목록. 왼쪽 탭에서 고른 모드의 것만 보여 준다. */
function fillHomeTasks(box, proj) {
  const convs = S.convs.filter((c) => c.projectId === proj.id).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  box.innerHTML = '';
  box.append(h('div', { class: 'ph-sec' }, h('b', { text: '대화' }), convs.length ? h('small', { text: String(convs.length) }) : null));
  if (!convs.length) {
    box.append(h('div', { class: 'ph-empty', text: '아직 대화가 없습니다. 위에 할 일을 적으면 이 프로젝트의 폴더 · 지침 · 메모리를 가지고 시작합니다. 파일을 만들거나 고치게 하려면 입력창에서 에이전트를 고르세요.' }));
    return;
  }
  const list = h('div', { class: 'ph-list' });
  for (const c of convs) {
    const agent = c.mode === 'agent';
    list.append(h('div', { class: 'ph-task', title: c.title, onclick: () => openConv(c.id) },
      h('span', { class: 'ph-task-ic', title: agent ? '에이전트 작업' : '채팅' }, icon(agent ? 'bolt' : 'chat', 15)),
      h('div', { class: 'ph-task-main' }, h('b', { text: c.title || '새 대화' }), homePreview(c) ? h('small', { text: homePreview(c) }) : null),
      h('time', { text: relTime(c.updatedAt) }),
      h('button', { class: 'icon-btn sm danger', title: '삭제', onclick: async (e) => {
        e.stopPropagation();
        if (!await confirmDialog(`"${c.title || '새 대화'}" 대화를 삭제할까요?`, '삭제', true)) return;
        await exa.deleteConv(c.id);
        S.convs = await exa.listConvs();
        renderConvList();
      } }, icon('trash', 13))));
  }
  box.append(list);
}

function refreshProjectHome() {
  const box = $('#ph-tasks');
  const proj = S.home ? projectOf(S.conv) : null;
  if (box && proj) fillHomeTasks(box, proj);
}

function projectHomeEl(proj) {
  const agent = S.conv.mode === 'agent';
  const desc = (proj.description || '').trim();
  const slot = h('div', { class: 'ph-composer' });
  const tasks = h('div', { id: 'ph-tasks' });
  fillHomeTasks(tasks, proj);
  dockComposer(slot);
  return h('div', { class: 'phome' },
    h('div', { class: 'ph-main' },
      h('div', { class: 'ph-head' },
        h('span', { class: 'ph-ic' }, icon('folder', 21)),
        h('div', { class: 'ph-title' },
          h('h1', { text: proj.name }),
          h('button', { class: 'ph-desc' + (desc ? '' : ' none'), title: '설명 편집', text: desc || '설명 추가', onclick: () => editProjectText(proj, 'description') })),
        h('button', { class: 'icon-btn', title: '프로젝트 설정', onclick: () => openProjectDialog(proj) }, icon('sliders', 17))),
      !S.keyInfo.hasKey ? h('p', { class: 'ph-warn' }, '토큰이 등록되어 있지 않습니다. ', h('button', { class: 'link', onclick: () => openTokenDialog() }, '토큰 등록')) : null,
      slot,
      tasks),
    h('aside', { class: 'ph-side' },
      homeTextCard(proj, 'instructions', agent ? '이 프로젝트의 모든 작업에서 EXAONE이 따를 지침을 추가하세요.' : '이 프로젝트의 모든 대화에서 EXAONE이 따를 지침을 추가하세요.'),
      homeContextCard(proj),
      homeTextCard(proj, 'memory', '기억해 둘 사실과 결정을 적어 두면 모든 작업에 함께 전달됩니다.')));
}

// ---------- 대화 목록 ----------
function groupLabel(ts) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const today = d.getTime();
  const day = 86400000;
  if (ts >= today) return '오늘';
  if (ts >= today - day) return '어제';
  if (ts >= today - 7 * day) return '지난 7일';
  if (ts >= today - 30 * day) return '지난 30일';
  return '이전';
}

function convItem(c, nested) {
  const title = h('span', { class: 'conv-title', text: c.title || '새 대화' });
  const projects = S.settings.projects || [];
  const data = { conv: c.id };
  if (nested && c.projectId) data.pid = c.projectId;
  return h('div', {
    class: 'conv-item' + (nested ? ' nested' : '') + (S.view === 'chat' && S.conv && S.conv.id === c.id ? ' on' : ''),
    title: c.title,
    draggable: 'true', dataset: data, // 끌어서 프로젝트에 넣거나 뺄 수 있다
    onclick: () => openConv(c.id),
  },
  c.mode === 'agent' ? h('span', { class: 'conv-ic', title: '에이전트 작업' }, icon('bolt', 13)) : null,
  title,
  h('span', { class: 'conv-acts' },
    projects.length ? h('button', { class: 'icon-btn sm', title: '프로젝트로 이동', onclick: (e) => {
      e.stopPropagation();
      popupMenu(e.currentTarget, projects.map((p) => ({ icon: 'folder', label: p.name, active: c.projectId === p.id, onClick: () => moveConv(c, p.id) }))
        .concat(['-', { icon: 'x', label: '프로젝트에서 빼기', onClick: () => moveConv(c, null) }]), { title: '프로젝트로 이동' });
    } }, icon('folder', 13)) : null,
    h('button', { class: 'icon-btn sm', title: '이름 변경', onclick: (e) => { e.stopPropagation(); startRename(c, title, () => { renderConvList(); renderChrome(); }); } }, icon('edit', 13)),
    h('button', { class: 'icon-btn sm danger', title: '삭제', onclick: async (e) => {
      e.stopPropagation();
      if (!await confirmDialog(`"${c.title || '새 대화'}" 대화를 삭제할까요?`, '삭제', true)) return;
      await exa.deleteConv(c.id);
      S.convs = await exa.listConvs();
      if (S.conv && S.conv.id === c.id) newConv(c.projectId); else renderConvList();
    } }, icon('trash', 13))));
}

function renderConvList() {
  // 대화를 끄는 동안에는 목록을 다시 그리지 않는다 (끌던 요소가 사라지면 끌기가 꼬인다). 끝나면 한 번에 그린다.
  if (convDrag.conv) { convDrag.dirty = true; return; }
  const box = $('#conv-list');
  box.innerHTML = '';
  const q = S.search.trim().toLowerCase();
  // Code 탭은 EXAONE Code 세션을, 채팅 탭은 대화와 에이전트 작업을 한 목록으로 보여 준다.
  if (curTab() === 'code') { renderCodeList(box, q); refreshProjectHome(); return; }
  const match = (c) => !q || (c.title || '').toLowerCase().includes(q) || (c.preview || '').toLowerCase().includes(q);
  const projects = S.settings.projects || [];
  const ids = new Set(projects.map((p) => p.id));
  const collapsed = new Set(S.settings.ui.collapsedProjects || []);

  // 프로젝트
  box.append(h('div', { class: 'conv-group with-btn' }, h('span', { text: '프로젝트' }),
    h('button', { class: 'icon-btn sm', title: '새 프로젝트', onclick: () => openProjectDialog(null) }, icon('plus', 14))));
  if (!projects.length) box.append(h('button', { class: 'proj-empty', onclick: () => openProjectDialog(null) }, '폴더와 지침을 묶어 프로젝트로 관리하기'));
  for (const p of projects) {
    const convs = S.convs.filter((c) => c.projectId === p.id && match(c));
    if (q && !convs.length && !p.name.toLowerCase().includes(q)) continue;
    const isCurrent = S.view === 'chat' && S.conv && S.conv.projectId === p.id;
    const open = q ? true : !collapsed.has(p.id);
    box.append(h('div', {
      class: 'proj-row' + (open ? ' open' : '') + (isCurrent && !S.conv.messages.length ? ' on' : ''),
      title: p.path || p.name, dataset: { pid: p.id },
      // 이름을 누르면 프로젝트 홈으로, 화살표를 누르면 접고 펼친다.
      onclick: () => {
        if (collapsed.has(p.id)) { collapsed.delete(p.id); saveSettings({ ui: { collapsedProjects: [...collapsed] } }); }
        if (isCurrent && !S.conv.messages.length) renderConvList(); else newConv(p.id);
      },
    },
    h('span', { class: 'proj-chev', title: open ? '접기' : '펼치기', onclick: (e) => {
      e.stopPropagation();
      if (collapsed.has(p.id)) collapsed.delete(p.id); else collapsed.add(p.id);
      saveSettings({ ui: { collapsedProjects: [...collapsed] } });
      renderConvList();
    } }, icon('chevRight', 12)), icon('folder', 15),
    h('span', { class: 'conv-title', text: p.name }),
    h('span', { class: 'proj-count', text: convs.length ? String(convs.length) : '' }),
    h('span', { class: 'conv-acts' },
      h('button', { class: 'icon-btn sm', title: '이 프로젝트에서 새 대화', onclick: (e) => { e.stopPropagation(); newConv(p.id); } }, icon('newchat', 13)),
      h('button', { class: 'icon-btn sm', title: '프로젝트 설정', onclick: (e) => { e.stopPropagation(); openProjectDialog(p); } }, icon('sliders', 13)))));
    if (open) {
      if (!convs.length) box.append(h('div', { class: 'proj-none', dataset: { pid: p.id }, text: q ? '검색 결과 없음' : '대화 없음' }));
      for (const c of convs) box.append(convItem(c, true));
    }
  }

  // 프로젝트에 속하지 않은 대화
  const loose = S.convs.filter((c) => (!c.projectId || !ids.has(c.projectId)) && match(c));
  refreshProjectHome();
  // 프로젝트 밖의 대화는 한 구역으로 묶는다 (프로젝트 안의 대화를 여기에 끌어다 놓으면 프로젝트에서 빠진다).
  const zone = h('div', { class: 'loose-zone' });
  box.append(zone);
  if (!loose.length) {
    zone.append(h('div', { class: 'conv-group', text: '대화' }), h('div', { class: 'conv-empty', text: q ? '검색 결과가 없습니다' : '아직 대화가 없습니다' }));
    return;
  }
  let last = '';
  for (const c of loose) {
    const g = groupLabel(c.updatedAt || 0);
    if (g !== last) { zone.append(h('div', { class: 'conv-group', text: g })); last = g; }
    zone.append(convItem(c, false));
  }
}

// ---------- 토큰 등록 ----------
/** 토큰이 없을 때 뜨는 등록 창. 등록하면 앱과 터미널(EXAONE Code)이 함께 쓴다. */
function openTokenDialog() {
  if (openTokenDialog.open) return;
  openTokenDialog.open = true;
  const input = h('input', { type: 'password', class: 'txt', id: 'token-input', placeholder: 'EXAONE 토큰(API 키) 붙여넣기' });
  const save = async () => {
    const v = input.value.trim();
    if (!v) { input.focus(); return; }
    S.keyInfo = await exa.setKey(v);
    m.close();
    renderChrome();
    if (S.conv && !S.conv.messages.length) renderConv();
    toast(S.keyInfo.hasKey ? '토큰을 등록했습니다' : '토큰을 등록하지 못했습니다', S.keyInfo.hasKey ? undefined : 'err');
  };
  const m = openModal({
    title: 'EXAONE 토큰 등록',
    body: h('div', { class: 'settings' },
      h('p', { class: 'ph-modal-hint', text: S.keyInfo.hasKey ? `지금 등록된 토큰: ${S.keyInfo.masked}. 새 토큰을 넣으면 바꿉니다.` : 'EXAONE 을 쓰려면 토큰(API 키)을 먼저 등록해야 합니다. 한 번 등록하면 이 앱과 터미널의 EXAONE Code 가 함께 씁니다.' }),
      input),
    footer: [h('button', { class: 'btn', onclick: () => m.close() }, '나중에'), h('button', { class: 'btn primary', onclick: save }, '등록')],
    onClose: () => { openTokenDialog.open = false; },
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) save(); });
  setTimeout(() => input.focus(), 30);
}

/** 터미널에서 토큰을 등록했거나 지웠을 수 있으니 창으로 돌아올 때 다시 확인한다. */
async function refreshKeyInfo() {
  try {
    const k = await exa.keyInfo();
    if (k.hasKey === S.keyInfo.hasKey && k.masked === S.keyInfo.masked) return;
    S.keyInfo = k;
    renderChrome();
    if (S.conv && !S.conv.messages.length) renderConv();
  } catch { /* 무시 */ }
}

// ---------- Code 탭: EXAONE Code(터미널) 세션 ----------
// 세션 파일(~/.exaone/projects/…)을 터미널과 함께 쓴다. 목록은 시작할 때, 창으로 돌아올 때, 저장한 뒤에 새로 읽는다.
async function refreshCliSessions(force) {
  try {
    const r = await exa.cliList();
    if (!r || !r.ok) return;
    const sig = JSON.stringify(r.data.map((s) => [s.id, s.mtime]));
    if (!force && sig === refreshCliSessions.sig) return;
    const changed = sig !== refreshCliSessions.sig;
    refreshCliSessions.sig = sig;
    S.cliSessions = r.data;
    if (curTab() === 'code') renderConvList();
    if (changed) syncCodeConv(); // 열어 둔 세션이 터미널에서 바뀌었으면 다시 읽는다
  } catch { /* 목록은 없어도 된다 */ }
}

function codeItem(s) {
  const id = 'code:' + s.id;
  return h('div', {
    class: 'conv-item code-item' + (S.view === 'chat' && S.conv && S.conv.id === id ? ' on' : ''),
    title: `${s.title}\n${s.cwd || '(폴더를 알 수 없음)'}`,
    onclick: () => openConv(id),
  },
  h('span', { class: 'conv-ic' }, icon('terminal', 13)),
  h('span', { class: 'conv-title', text: s.title }),
  h('small', { class: 'cli-dir', text: s.cwd ? baseName(s.cwd) : '' }),
  h('span', { class: 'conv-acts' },
    h('button', { class: 'icon-btn sm', title: '터미널에서 열기 (exaone --resume)', onclick: (e) => { e.stopPropagation(); openCliInTerminal(s); } }, icon('ext', 13)),
    h('button', { class: 'icon-btn sm danger', title: '삭제', onclick: async (e) => {
      e.stopPropagation();
      if (!await confirmDialog(`"${s.title}" 세션을 삭제할까요? 터미널의 EXAONE Code 에서도 사라집니다.`, '삭제', true)) return;
      await exa.deleteConv(id);
      if (S.conv && S.conv.id === id) newConv();
      refreshCliSessions(true);
    } }, icon('trash', 13))));
}

function renderCodeList(box, q) {
  const all = (S.cliSessions || []).filter((s) => !q || s.title.toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));
  if (!all.length) {
    box.append(h('div', { class: 'conv-group', text: '세션' }), h('div', { class: 'conv-empty',
      text: q ? '검색 결과가 없습니다' : '아직 EXAONE Code 세션이 없습니다. 폴더를 고르고 여기서 시작하거나, 터미널에서 exaone 을 실행하면 이 목록에 나타납니다' }));
    return;
  }
  let last = '';
  for (const s of all) {
    const g = groupLabel(s.mtime || 0);
    if (g !== last) { box.append(h('div', { class: 'conv-group', text: g })); last = g; }
    box.append(codeItem(s));
  }
}

async function openCliInTerminal(s) {
  s = s || (S.conv && S.conv.code ? { id: S.conv.code.id, cwd: S.conv.workspace } : null);
  if (!s) return;
  if (!s.cwd) { toast('이 세션의 작업 폴더를 알 수 없어 터미널로 열 수 없습니다', 'err'); return; }
  const r = await exa.cliTerminal({ cwd: s.cwd, id: s.id });
  if (r.ok && r.data.opened) { toast('터미널을 열었습니다'); return; }
  const cmd = r.ok ? r.data.command : '';
  if (cmd) {
    try { await navigator.clipboard.writeText(cmd); } catch { /* 복사 실패해도 안내는 띄운다 */ }
    toast('터미널을 자동으로 열지 못해 명령을 복사했습니다. 터미널에 붙여 넣어 실행하세요', 'err');
  }
  else toast('터미널을 열지 못했습니다: ' + r.error, 'err');
}

// ---------- 요청 한도 ----------
function updateRate(headers) {
  if (!headers) return;
  const num = (k) => (headers[k] != null && headers[k] !== '' ? Number(headers[k]) : null);
  const r = {
    day: num('x-day-rate-limit'), dayLeft: num('x-day-rate-limit-remaining'),
    min: num('x-minute-rate-limit'), minLeft: num('x-minute-rate-limit-remaining'),
    ts: Date.now(),
  };
  if (r.day == null && r.min == null) return;
  S.rate = r;
  renderRate();
}

function renderRate() {
  const el = $('#rate');
  el.innerHTML = '';
  const r = S.rate;
  if (!r) { el.append(h('span', { class: 'muted', text: '요청 한도: 첫 응답 후 표시' })); return; }
  const row = (label, left, total) => {
    if (total == null || left == null) return null;
    const pct = total ? clamp(left / total * 100, 0, 100) : 0;
    return h('div', { class: 'rate-row' + (pct < 15 ? ' low' : '') },
      h('span', { text: label }), h('span', { class: 'rate-bar' }, h('i', { style: { width: pct + '%' } })),
      h('b', { text: `${fmtNum(left)} / ${fmtNum(total)}` }));
  };
  el.append(row('오늘', r.dayLeft, r.day), row('분당', r.minLeft, r.min));
}

// ---------- 오른쪽 패널 ----------
function showPanel(tab) {
  $('#rpanel').hidden = false;
  document.body.classList.add('panel-open');
  selectPanelTab(tab || S.panelTab || 'files');
  if (!S.settings.ui.panel && !S.home) saveSettings({ ui: { panel: true } });
}
function hidePanel() {
  $('#rpanel').hidden = true;
  document.body.classList.remove('panel-open');
  if (S.settings.ui.panel && !S.home) saveSettings({ ui: { panel: false } });
}
const PANEL_TABS = ['progress', 'files', 'changes', 'preview'];
function selectPanelTab(tab) {
  if (!PANEL_TABS.includes(tab)) tab = 'files';
  S.panelTab = tab;
  $$('.rp-tabs button[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab));
  for (const name of PANEL_TABS) $('#rp-' + name).hidden = name !== tab;
  $('#rpanel').classList.toggle('wide', tab === 'preview' || tab === 'changes');
  if (tab === 'progress') renderProgressPanel();
  if (tab === 'files') renderFilesPanel();
  if (tab === 'changes') renderChangesPanel();
  if (tab === 'preview') renderPreviewPanel();
  renderProgressStrip();
}

// ---------- 진행 상황 ----------
function refreshProgressPanel() {
  if (!$('#rpanel').hidden && S.panelTab === 'progress') renderProgressPanel();
  renderProgressStrip();
}

/** 다른 탭(파일 · 변경 사항 · 미리보기)을 보고 있을 때도 맨 위에 한 줄로 진행 상황을 보여 준다. */
function renderProgressStrip() {
  const strip = $('#rp-strip');
  const plan = latestPlan(S.conv);
  const show = !!plan && plan.live && S.panelTab !== 'progress';
  strip.hidden = !show;
  if (!show) return;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const cur = plan.steps.find((s) => s.status === 'in_progress');
  strip.innerHTML = '';
  strip.append(h('span', { class: 'ps-bar' }, h('i', { style: { width: (done / plan.steps.length * 100) + '%' } })),
    h('b', { text: `진행 ${done}/${plan.steps.length}` }),
    h('span', { class: 'ps-cur', text: cur ? cur.title : done === plan.steps.length ? '모두 완료' : '' }), icon('chevRight', 12));
  strip.onclick = () => selectPanelTab('progress');
}

function renderProgressPanel() {
  const box = $('#rp-progress');
  if (box.hidden) return;
  const conv = S.conv;
  const plan = latestPlan(conv);
  box.innerHTML = '';
  if (!plan) {
    box.append(h('div', { class: 'empty' }, icon('list', 22), h('p', { text: '에이전트가 작업 계획을 세우면 단계별 진행 상황이 여기에 나타납니다. 계획이 세워지면 이 탭이 자동으로 열립니다.' })));
    return;
  }
  const running = S.busy && S.run && S.run.conv === conv && plan.live;
  const done = plan.steps.filter((s) => s.status === 'done').length;
  const all = plan.steps.length;
  box.append(
    h('div', { class: 'pg-head' },
      h('b', { text: '진행 상황' }),
      h('span', { class: 'pg-state' + (running ? ' live' : ''), text: running ? '작업 중' : done === all ? '완료' : plan.live ? '멈춤' : '이전 지시의 계획' }),
      h('span', { class: 'grow' }), h('span', { class: 'pg-count', text: `${done} / ${all}` })),
    h('div', { class: 'pg-bar' }, h('i', { style: { width: (done / all * 100) + '%' } })),
    h('ol', { class: 'pg-steps' }, plan.steps.map((s) => h('li', { class: 'st-' + (s.status || 'pending') + (running && s.status === 'in_progress' ? ' live' : '') },
      h('span', { class: 'pg-mark' }, s.status === 'done' ? icon('check', 12) : null),
      h('span', { class: 'pg-title', text: s.title })))));
  // 이번 지시에서 만들거나 고친 파일
  let start = 0;
  for (let i = conv.messages.length - 1; i >= 0; i--) if (conv.messages[i].role === 'user') { start = i; break; }
  const files = [];
  for (const m of conv.messages.slice(start)) {
    if (m.role === 'tool' && m.status === 'ok' && (m.name === 'write_file' || m.name === 'edit_file') && m.meta && m.meta.path && !files.includes(m.meta.path)) files.push(m.meta.path);
  }
  if (files.length) {
    box.append(h('h3', { text: '만들거나 고친 파일' }), h('div', { class: 'pg-files' }, files.map((p) => h('button', { class: 'ph-file', title: '미리보기', onclick: () => openFilePreview(p, conv.workspace) },
      icon('file', 13), h('span', { text: p })))));
  }
}

function field(label, control, hint) {
  return h('div', { class: 'field' }, h('div', { class: 'f-label' }, h('span', { text: label }), hint ? h('small', { text: hint }) : null), control);
}
function rowField(label, control, hint) {
  return h('div', { class: 'field row' }, h('div', { class: 'f-label' }, h('span', { text: label }), hint ? h('small', { text: hint }) : null), control);
}
function toggle(checked, onChange) {
  const i = h('input', { type: 'checkbox', checked: !!checked });
  i.addEventListener('change', () => onChange(i.checked));
  return h('label', { class: 'switch' }, i, h('i'));
}
function slider({ min, max, step, value, onChange }) {
  const range = h('input', { type: 'range', min, max, step, value });
  const num = h('input', { type: 'number', class: 'num', min, max, step, value });
  range.addEventListener('input', () => { num.value = range.value; onChange(Number(range.value)); });
  num.addEventListener('change', () => {
    let v = Number(num.value);
    if (isNaN(v)) v = value;
    v = clamp(v, Number(min), Number(max));
    num.value = v; range.value = v; onChange(v);
  });
  return h('div', { class: 'slider' }, range, num);
}
function select(options, value, onChange) {
  const s = h('select', { class: 'sel' }, options.map(([v, label]) => h('option', { value: v, selected: v === value }, label)));
  s.value = value;
  s.addEventListener('change', () => onChange(s.value));
  return s;
}
function jsonArea(value, onChange, validate, rows = 10) {
  const ta = h('textarea', { class: 'code-ta', rows, value, spellcheck: 'false' });
  const state = h('div', { class: 'json-state' });
  const check = () => {
    const msg = validate(ta.value);
    state.textContent = msg || '올바른 형식';
    state.classList.toggle('bad', !!msg);
  };
  ta.addEventListener('input', () => { check(); onChange(ta.value); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end'); }
  });
  check();
  return h('div', { class: 'json-area' }, ta, state);
}

// ---------- 파일 (작업 폴더 탐색) ----------
const FT = { open: new Set(), token: 0 };
function refreshFilesPanel() {
  if (!$('#rpanel').hidden && S.panelTab === 'files') renderFilesPanel();
}

async function renderFilesPanel() {
  const box = $('#rp-files');
  if (box.hidden) return;
  const token = ++FT.token;
  const conv = S.conv;
  const ws = conv && conv.workspace;
  if (!ws) {
    box.innerHTML = '';
    box.append(h('div', { class: 'empty' }, icon('folder', 22), h('p', { text: '작업 폴더를 고르면 파일 목록이 여기에 나타나고, 파일을 눌러 미리 볼 수 있습니다.' }),
      h('button', { class: 'btn', onclick: () => chooseWorkspace() }, icon('folder', 14), '폴더 선택')));
    return;
  }
  const tree = h('div', { class: 'ft-tree' });
  const fill = async (container, rel, depth) => {
    const r = await exa.fileList({ workspace: ws, path: rel });
    if (token !== FT.token) return;
    if (!r.ok) { container.append(h('div', { class: 'ft-note', style: { paddingLeft: 10 + depth * 14 + 'px' }, text: '읽지 못했습니다: ' + r.error })); return; }
    if (!r.data.entries.length) container.append(h('div', { class: 'ft-note', style: { paddingLeft: 10 + depth * 14 + 'px' }, text: '(비어 있음)' }));
    for (const e of r.data.entries) {
      const p = rel ? rel + '/' + e.name : e.name;
      const key = ws + '|' + p;
      const isOpen = e.dir && FT.open.has(key);
      const current = previewState && previewState.kind === 'file' && previewState.workspace === ws && previewState.path === p;
      container.append(h('div', {
        class: 'ft-row' + (isOpen ? ' open' : '') + (current ? ' on' : '') + (/^(node_modules|\.git)$/.test(e.name) ? ' dim' : ''),
        style: { paddingLeft: 6 + depth * 14 + 'px' }, title: p,
        onclick: () => {
          if (e.dir) { if (isOpen) FT.open.delete(key); else FT.open.add(key); renderFilesPanel(); }
          else openFilePreview(p, ws);
        },
      },
      h('span', { class: 'ft-chev' }, e.dir ? icon('chevRight', 12) : null),
      icon(e.dir ? 'folder' : 'file', 14),
      h('span', { class: 'ft-name', text: e.name }),
      e.dir ? null : h('small', { text: fmtBytes(e.size) })));
      if (isOpen) { const sub = h('div'); container.append(sub); await fill(sub, p, depth + 1); }
    }
    if (r.data.more) container.append(h('div', { class: 'ft-note', style: { paddingLeft: 10 + depth * 14 + 'px' }, text: `… 외 ${r.data.more}개` }));
  };
  await fill(tree, '', 0);
  if (token !== FT.token) return;
  box.innerHTML = '';
  box.append(
    h('div', { class: 'ch-head' }, icon('folder', 15), h('b', { class: 'ft-root', title: ws, text: baseName(ws) }), h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn sm', title: '새로고침', onclick: () => renderFilesPanel() }, icon('refresh', 14)),
      h('button', { class: 'icon-btn sm', title: '탐색기에서 열기', onclick: () => exa.open(ws) }, icon('ext', 14))),
    h('div', { class: 'ch-ws muted', title: ws, text: ws }),
    tree);
}

// ---------- 변경 사항 (버전 기록) ----------
const CH = { open: new Set(), view: {}, token: 0 };
const CH_STATUS = { added: '새 파일', modified: '수정', deleted: '삭제', unchanged: '원본과 같음' };

function versionLabel(v) {
  if (v.tool === 'write_file') return '작성';
  if (v.tool === 'edit_file') return '수정';
  if (v.tool === 'external') return '도구 밖 변경';
  if (v.tool.startsWith('restore:')) return v.tool.slice(8) + ' 로 복원';
  return v.tool;
}

function openChanges(path) {
  if (path) { CH.open.add(path); CH.view[path] = 'total'; }
  showPanel('changes');
}

function refreshChangesPanel() {
  if (!$('#rpanel').hidden && S.panelTab === 'changes') renderChangesPanel();
}

function statEl(added, removed) {
  return h('span', { class: 'ch-stat' }, h('i', { class: 'plus', text: '+' + added }), h('i', { class: 'minus', text: '−' + removed }));
}

async function renderChangesPanel() {
  const box = $('#rp-changes');
  if (box.hidden) return;
  const conv = S.conv;
  const token = ++CH.token;
  const emptyMsg = (text) => { box.innerHTML = ''; box.append(h('div', { class: 'empty' }, icon('file', 22), h('p', { text }))); };
  if (!conv || !conv.workspace) return emptyMsg('에이전트가 파일을 만들거나 고치면 여기에 버전 기록과 변경 내용이 표시됩니다.');
  const req = { convId: conv.id, workspace: conv.workspace };
  const r = await exa.historySummary(req);
  if (token !== CH.token) return;
  if (!r.ok) return emptyMsg('변경 기록을 읽지 못했습니다: ' + r.error);
  const files = r.data.files;
  if (!files.length) return emptyMsg('이 대화에서 에이전트가 바꾼 파일이 아직 없습니다. 파일을 만들거나 고치면 버전이 쌓이고, 무엇이 바뀌었는지 여기서 볼 수 있습니다.');

  const active = files.filter((f) => f.status !== 'unchanged');
  const add = active.reduce((n, f) => n + f.added, 0), del = active.reduce((n, f) => n + f.removed, 0);
  const restore = async (f, n, label) => {
    if (S.busy) { toast('에이전트가 작업 중일 때는 되돌릴 수 없습니다'); return; }
    if (!await confirmDialog(`${f.path} 을(를) ${label} 내용으로 되돌릴까요?` + (n === 0 && f.status === 'added' ? ' 에이전트가 새로 만든 파일이라 삭제됩니다.' : ''), '되돌리기', true)) return;
    const res = await exa.historyRestore({ ...req, path: f.path, n });
    if (!res.ok) toast('되돌리기 실패: ' + res.error, 'err'); else toast(res.data ? '되돌렸습니다' : '이미 같은 내용입니다');
    renderChangesPanel();
  };

  box.innerHTML = '';
  box.append(
    h('div', { class: 'ch-head' },
      h('b', { text: `변경된 파일 ${active.length}개` }), statEl(add, del), h('span', { class: 'grow' }),
      h('button', { class: 'btn ghost sm', title: '디스크 내용을 다시 읽기', onclick: () => renderChangesPanel() }, icon('refresh', 13), '새로고침'),
      h('button', { class: 'btn sm', disabled: !active.length || S.busy, title: '바뀐 파일을 모두 에이전트가 손대기 전 내용으로', onclick: async () => {
        if (!await confirmDialog(`파일 ${active.length}개를 모두 원본으로 되돌릴까요? 에이전트가 새로 만든 파일은 삭제됩니다.`, '모두 되돌리기', true)) return;
        const res = await exa.historyRestoreAll(req);
        if (!res.ok) toast('되돌리기 실패: ' + res.error, 'err'); else toast(`${res.data}개 파일을 되돌렸습니다`);
        renderChangesPanel();
      } }, '모두 되돌리기')),
    h('div', { class: 'ch-ws muted', title: conv.workspace, text: conv.workspace }));

  for (const f of files) {
    const isOpen = CH.open.has(f.path);
    const view = CH.view[f.path] != null ? CH.view[f.path] : 'total';
    const row = h('div', { class: 'ch-row', onclick: () => { if (isOpen) CH.open.delete(f.path); else CH.open.add(f.path); renderChangesPanel(); } },
      h('span', { class: 'ch-badge ' + f.status, text: CH_STATUS[f.status] }),
      h('span', { class: 'ch-path', title: f.path, text: f.path }),
      f.dirty ? h('span', { class: 'badge warn', title: '마지막 기록 이후 에이전트의 파일 도구 밖에서 내용이 바뀌었습니다', text: '도구 밖 변경' }) : null,
      f.status !== 'unchanged' ? statEl(f.added, f.removed) : null,
      f.status !== 'deleted' ? h('button', { class: 'icon-btn sm', title: '파일 미리보기', onclick: (e) => { e.stopPropagation(); openFilePreview(f.path, conv.workspace); } }, icon('eye', 14)) : null,
      f.status !== 'unchanged' ? h('button', { class: 'btn ghost sm', title: '에이전트가 손대기 전 내용으로', onclick: (e) => { e.stopPropagation(); restore(f, 0, '원본(v0)'); } }, '되돌리기') : null,
      h('span', { class: 'tool-chev' }, icon('chevRight', 13)));
    const el = h('div', { class: 'ch-file' + (isOpen ? ' open' : '') }, row);
    if (isOpen) {
      const steps = f.versions.filter((v) => v.n > 0);
      const chip = (key, label, title) => h('button', { class: 'ver' + (String(view) === String(key) ? ' on' : ''), title, onclick: () => { CH.view[f.path] = key; renderChangesPanel(); } }, label);
      const diffBox = h('div', { class: 'ch-diff' }, h('div', { class: 'muted small', style: { padding: '8px 13px' }, text: '불러오는 중…' }));
      const sel = view === 'total' ? null : f.versions[Number(view)];
      el.append(h('div', { class: 'ch-body' },
        h('div', { class: 'ch-vers' },
          chip('total', '전체 (원본 → 현재)', '에이전트가 손대기 전과 지금 디스크 내용 비교'),
          steps.map((v) => chip(v.n, `v${v.n} ${versionLabel(v)} · ${fmtTime(v.ts).slice(0, 5)}`, `이 단계에서 바뀐 내용 (+${v.added} −${v.removed})`))),
        sel ? h('div', { class: 'ch-veract' },
          h('span', { class: 'muted small', text: `v${sel.n - 1} → v${sel.n} 에서 바뀐 내용` }), statEl(sel.added, sel.removed), h('span', { class: 'grow' }),
          h('button', { class: 'btn ghost sm', onclick: () => restore(f, sel.n, `v${sel.n}`) }, `v${sel.n} 내용으로 복원`)) : null,
        diffBox));
      const dreq = sel ? { ...req, path: f.path, from: sel.n - 1, to: sel.n } : { ...req, path: f.path, from: 0, to: 'disk' };
      exa.historyDiff(dreq).then((d) => {
        if (token !== CH.token) return;
        diffBox.innerHTML = '';
        if (!d.ok) diffBox.append(h('div', { class: 'muted small', style: { padding: '8px 13px' }, text: '비교 실패: ' + d.error }));
        else if (d.data.same) diffBox.append(h('div', { class: 'muted small', style: { padding: '8px 13px' }, text: '차이가 없습니다.' }));
        else {
          if (d.data.toMissing) diffBox.append(h('div', { class: 'muted small', style: { padding: '8px 13px 0' }, text: '파일이 삭제된 상태입니다.' }));
          diffBox.append(diffEl(d.data.text, d.data.truncated));
        }
      });
    }
    box.append(el);
  }
  box.append(h('p', { class: 'muted small ch-note', text: '에이전트의 파일 도구(write_file · edit_file)로 바꾼 내용을 대화별로 버전 기록에 남깁니다. 명령 실행으로 바뀐 파일은 다음에 그 파일을 고칠 때 "도구 밖 변경"으로 잡힙니다.' }));
}

// ---------- 미리보기 ----------
// 두 종류: 답변 코드 블록(kind:'code')과 작업 폴더의 실제 파일(kind:'file')
let previewState = null;
let pvToken = 0;
const PV_IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif']);
const PV_AUDIO = new Set(['mp3', 'wav', 'ogg', 'm4a', 'flac']);
const PV_VIDEO = new Set(['mp4', 'webm', 'mov']);
const PV_RENDERED = new Set(['html', 'htm', 'md', 'markdown', 'csv', 'tsv', 'svg']);
const PV_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', java: 'java', kt: 'kotlin', go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp',
  cs: 'csharp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css', scss: 'scss', less: 'less', json: 'json',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', vue: 'xml', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', env: 'ini',
  sql: 'sql', swift: 'swift', lua: 'lua', r: 'r', pl: 'perl', md: 'markdown', markdown: 'markdown', diff: 'diff', patch: 'diff', makefile: 'makefile',
};
const extOf = (p) => { const b = baseName(p).toLowerCase(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1) : b; };

async function openPreview(code, lang) {
  let html = code;
  if (lang === 'svg' || /^\s*(<\?xml[^>]*>\s*)?<svg/i.test(code)) {
    html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#fff">${code}</body></html>`;
  } else if (!/<meta[^>]+charset/i.test(code)) {
    html = '<meta charset="utf-8">' + code;
  }
  const url = await exa.setPreview(html);
  previewState = { kind: 'code', url, code, lang };
  showPanel('preview');
}

/** 작업 폴더의 파일을 미리보기 패널에 띄운다. */
function openFilePreview(path, workspace) {
  const ws = workspace || (S.conv && S.conv.workspace);
  if (!ws || !path) return;
  const same = previewState && previewState.kind === 'file' && previewState.path === path && previewState.workspace === ws;
  previewState = { kind: 'file', workspace: ws, path, source: same ? previewState.source : false };
  showPanel('preview');
}

function reloadPreview() {
  if (!$('#rpanel').hidden && S.panelTab === 'preview') renderPreviewPanel();
}

function codeView(text, ext, truncated) {
  const lang = PV_LANG[ext] || ext;
  const code = h('code');
  if (text.length < 300000 && window.hljs && hljs.getLanguage(lang)) {
    try { code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; code.className = 'hljs'; } catch { code.textContent = text; }
  } else code.textContent = text;
  const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  const gutter = h('div', { class: 'pv-gutter', text: Array.from({ length: Math.max(1, Math.min(lines, 20000)) }, (_, i) => i + 1).join('\n') });
  return h('div', { class: 'pv-codewrap' },
    h('div', { class: 'pv-code' }, gutter, h('pre', null, code)),
    truncated ? h('div', { class: 'muted small', style: { padding: '8px 14px' }, text: '파일이 커서 앞부분 1MB 만 표시했습니다.' }) : null);
}

function tableView(text, tab) {
  const rows = tab ? text.split(/\r?\n/).filter((l) => l !== '').slice(0, 501).map((l) => l.split('\t')) : parseCsv(text, 501);
  const head = rows[0] || [];
  const body = rows.slice(1, 501);
  return h('div', { class: 'pv-table' },
    h('div', { class: 'table-wrap' }, h('table', { class: 'tb-table left' },
      h('thead', null, h('tr', null, h('th', { text: '#' }), head.map((c) => h('th', { text: c })))),
      h('tbody', null, body.map((r, i) => h('tr', null, h('td', { class: 'idx', text: i + 1 }), r.map((c) => h('td', { text: c }))))))),
    rows.length > 500 ? h('p', { class: 'muted small', text: '처음 500행만 표시했습니다.' }) : null);
}

async function renderPreviewPanel() {
  const box = $('#rp-preview');
  if (box.hidden) return;
  const token = ++pvToken;
  const st = previewState;
  box.innerHTML = '';
  if (!st) {
    box.append(h('div', { class: 'empty' }, icon('eye', 22), h('p', { text: '에이전트가 파일을 만들거나 고치면 여기에 미리보기가 나타납니다. 답변의 HTML·SVG 코드 블록에서 "미리보기"를 눌러도 됩니다.' })));
    return;
  }
  const sandbox = 'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock';
  if (st.kind === 'code') {
    const frame = h('iframe', { class: 'preview-frame', sandbox, src: st.url });
    box.append(
      h('div', { class: 'preview-bar' },
        h('span', { class: 'muted', text: '답변의 코드 블록 · 격리된 샌드박스' }), h('span', { class: 'grow' }),
        h('button', { class: 'btn ghost sm', onclick: () => { frame.src = st.url; } }, icon('refresh', 13), '새로고침'),
        h('button', { class: 'btn ghost sm', onclick: (e) => copyText(st.code, e.currentTarget) }, icon('copy', 13), '코드 복사')),
      frame);
    return;
  }

  const req = { workspace: st.workspace, path: st.path };
  const ext = extOf(st.path);
  const body = h('div', { class: 'pv-body' });
  const setSource = (v) => { st.source = v; renderPreviewPanel(); };
  box.append(
    h('div', { class: 'preview-bar' },
      icon('file', 14), h('span', { class: 'pv-path', title: st.path, text: st.path }), h('span', { class: 'grow' }),
      PV_RENDERED.has(ext) ? h('div', { class: 'seg' },
        h('button', { class: st.source ? '' : 'on', onclick: () => setSource(false) }, '미리보기'),
        h('button', { class: st.source ? 'on' : '', onclick: () => setSource(true) }, '소스')) : null,
      h('button', { class: 'icon-btn sm', title: '새로고침', onclick: () => renderPreviewPanel() }, icon('refresh', 14)),
      h('button', { class: 'icon-btn sm', title: '기본 앱으로 열기', onclick: () => exa.fileOpen(req) }, icon('ext', 14)),
      h('button', { class: 'icon-btn sm', title: '폴더에서 보기', onclick: () => exa.fileOpen({ ...req, reveal: true }) }, icon('folder', 14))),
    body);
  const note = (text) => { body.innerHTML = ''; body.append(h('div', { class: 'empty' }, icon('file', 22), h('p', { text }))); };

  const rendered = !st.source;
  if ((rendered && (ext === 'html' || ext === 'htm')) || PV_IMAGE.has(ext) && rendered || PV_AUDIO.has(ext) || PV_VIDEO.has(ext)) {
    const r = await exa.fileUrl(req);
    if (token !== pvToken) return;
    if (!r.ok) return note('파일을 열지 못했습니다: ' + r.error);
    const url = r.data + '?v=' + Date.now();
    if (ext === 'html' || ext === 'htm') {
      // 작업 폴더 전용 출처(exa-file://…)에서 실행된다. 앱 화면과는 출처가 달라 서로 접근할 수 없다.
      body.classList.add('fill');
      body.append(h('iframe', { class: 'preview-frame', sandbox: sandbox + ' allow-same-origin', src: url }));
    } else if (PV_IMAGE.has(ext)) {
      body.classList.add('checker');
      const img = h('img', { class: 'pv-img', src: url, alt: st.path });
      img.addEventListener('error', () => note('이미지를 표시하지 못했습니다.'));
      body.append(img);
    } else if (PV_AUDIO.has(ext)) body.append(h('div', { class: 'pv-media' }, h('audio', { controls: true, src: url })));
    else body.append(h('div', { class: 'pv-media' }, h('video', { controls: true, src: url })));
    return;
  }
  if (ext === 'pdf') return note('PDF 는 앱 안에서 미리 볼 수 없습니다. 위의 "기본 앱으로 열기"를 눌러 주세요.');

  const r = await exa.fileRead(req);
  if (token !== pvToken) return;
  if (!r.ok) return note('파일을 읽지 못했습니다: ' + r.error);
  if (r.data.binary) return note(`텍스트가 아니라서 미리 볼 수 없습니다 (${fmtBytes(r.data.size)}). "기본 앱으로 열기"를 눌러 주세요.`);
  const text = r.data.text;
  if (rendered && (ext === 'md' || ext === 'markdown')) {
    const md = h('div', { class: 'md pv-md', html: Md.render(text) });
    Md.enhance(md);
    body.append(md);
  } else if (rendered && (ext === 'csv' || ext === 'tsv')) body.append(tableView(text, ext === 'tsv'));
  else body.append(codeView(text, ext, r.data.truncated));
}

// ---------- 설정 ----------
// Claude 설정 화면처럼 왼쪽에 분류, 오른쪽에 내용. 매개변수·도구 설정도 모두 여기에 모았다.
let settingsUi = null;
function renderParamsPanel() { if (settingsUi) settingsUi.refresh(); }
const renderToolsPanel = renderParamsPanel;

const SETTINGS_SECTIONS = [
  { id: 'general', label: '일반', icon: 'sliders' },
  { id: 'connection', label: '연결', icon: 'key' },
  { id: 'model', label: '모델', icon: 'spark' },
  { id: 'format', label: '출력 형식', icon: 'braces' },
  { id: 'agent', label: '에이전트', icon: 'terminal' },
  { id: 'cli', label: 'EXAONE Code', icon: 'terminal' },
  { id: 'functions', label: '함수 호출', icon: 'code' },
  { id: 'data', label: '데이터', icon: 'folder' },
  { id: 'about', label: '정보', icon: 'info' },
];

function settingsSection(id, refresh) {
  const p = S.settings.params;
  const a = S.settings.agent;
  const setP = (patch) => { saveSettings({ params: patch }); renderChips(); };
  const setA = (patch) => { saveSettings({ agent: patch }); renderChips(); };
  const numInput = (value, min, max, onChange, step) => {
    const i = h('input', { type: 'number', class: 'num wide', min, max, step: step || 1, value });
    i.addEventListener('change', () => { const v = clamp(parseInt(i.value, 10) || min, min, max); i.value = v; onChange(v); });
    return i;
  };
  const note = (text) => h('p', { class: 'muted small set-note', text });

  if (id === 'general') {
    return [
      rowField('테마', select([['system', '시스템 설정 따름'], ['light', '라이트'], ['dark', '다크']], S.settings.theme, (v) => { saveSettings({ theme: v }); setTimeout(applyTheme, 350); })),
      rowField('세부 내용 펼쳐 두기', toggle(!!S.settings.expandDetails, (v) => { saveSettings({ expandDetails: v }); renderConv(); }), '추론 과정과 도구 실행 내용을 기본으로 펼칩니다. 꺼 두면 접힌 채로 진행하고, 눌러서 열어 볼 수 있습니다'),
      rowField('진행 상황 자동 열기', toggle(S.settings.autoProgress !== false, (v) => saveSettings({ autoProgress: v })), '에이전트가 작업 계획을 세우면 오른쪽에 진행 탭을 바로 띄웁니다'),
      rowField('파일 미리보기 자동 열기', toggle(S.settings.autoPreview !== false, (v) => saveSettings({ autoPreview: v })), '에이전트가 파일을 만들거나 고치면 오른쪽에 바로 띄웁니다'),
      rowField('알림', select([['unfocused', '창이 뒤에 있을 때만'], ['always', '항상'], ['off', '끄기']], S.settings.notify || 'unfocused', (v) => saveSettings({ notify: v })), '작업이 끝났거나 질문 · 승인을 기다릴 때 시스템 알림으로 알려 줍니다. 알림을 누르면 그 대화가 열립니다'),
      rowField('긴 대화 자동 압축', toggle((S.settings.compact || {}).auto !== false, (v) => saveSettings({ compact: { auto: v } })), '컨텍스트가 한도에 가까워지면 이전 대화를 요약으로 바꿔 이어 갑니다. 기준은 약 491K 토큰 (컨텍스트 창 524K − 요약용 20K − 여유 13K) 이며, 요청을 보내기 전마다 확인합니다. 화면의 대화는 그대로 남고, /compact 로 직접 실행할 수도 있습니다'),
    ].filter(Boolean);
  }

  if (id === 'connection') {
    const info = h('div', { class: 'key-info' });
    const drawInfo = () => {
      const k = S.keyInfo;
      info.innerHTML = '';
      info.append(h('span', { class: 'dot ' + (k.hasKey ? 'ok' : 'bad') }),
        k.hasKey ? h('span', null, h('b', { text: k.masked }), ' — ', k.source) : h('span', { text: '등록된 토큰이 없습니다. 아래에 붙여 넣고 등록하세요.' }));
    };
    drawInfo();
    const keyInput = h('input', { type: 'password', class: 'txt', placeholder: '새 토큰 붙여넣기' });
    const saveKey = async (value) => {
      S.keyInfo = await exa.setKey(value);
      keyInput.value = '';
      drawInfo();
      renderChrome();
      if (!S.conv.messages.length) renderConv();
      toast(value ? '토큰을 등록했습니다' : '등록된 토큰을 지웠습니다');
    };
    const text = (key, placeholder) => {
      const i = h('input', { class: 'txt', value: S.settings[key], placeholder });
      i.addEventListener('change', () => { saveSettings({ [key]: i.value.trim() || placeholder }); i.value = S.settings[key]; renderChrome(); });
      return i;
    };
    return [
      h('h3', { text: '토큰 (API 키)' }),
      info,
      h('div', { class: 'inline' }, keyInput,
        h('button', { class: 'btn primary', onclick: () => { if (keyInput.value.trim()) saveKey(keyInput.value.trim()); } }, '등록'),
        h('button', { class: 'btn danger-ghost', title: '등록된 토큰을 지웁니다 (터미널의 EXAONE Code 에서도 쓸 수 없게 됩니다)', onclick: () => saveKey('') }, '지우기')),
      note('여기서 등록한 토큰을 데스크톱 앱과 터미널의 EXAONE Code 가 함께 씁니다. 등록한 토큰만 쓰며, 폴더의 key.txt 나 환경 변수는 읽지 않습니다. 토큰은 이 PC 의 사용자 폴더(~/.exaone/key.txt)에 저장됩니다.'),
      h('h3', { text: '서버' }),
      rowField('Base URL', text('baseUrl', 'https://api.exaone.ai/v1')),
      rowField('모델 ID', text('model', 'k-exaone_v2.5')),
      rowField('요청 최소 간격 (ms)', numInput(S.settings.minGapMs, 0, 10000, (v) => saveSettings({ minGapMs: v }), 100), '초당 1회 한도에 맞추기 위한 간격'),
    ];
  }

  if (id === 'model') {
    const sys = h('textarea', { id: 'p-system', class: 'text-ta', rows: 5, value: S.settings.systemPrompt, placeholder: '모든 대화의 맨 앞에 system 메시지로 들어갑니다. 비워 두면 보내지 않습니다.' });
    sys.addEventListener('input', () => saveSettings({ systemPrompt: sys.value }));
    const effort = h('div', { class: 'seg' }, Object.entries(EFFORTS).map(([k, v]) => h('button', {
      class: p.reasoning_effort === k ? 'on' : '', title: v.desc, onclick: () => { setP({ reasoning_effort: k }); refresh(); },
    }, v.label)));
    const maxTok = h('input', { type: 'number', class: 'num wide', min: 1, max: CTX_LIMIT, value: p.max_tokens || '', placeholder: '제한 없음' });
    maxTok.addEventListener('change', () => setP({ max_tokens: Number(maxTok.value) > 0 ? Math.floor(Number(maxTok.value)) : null }));
    const topK = h('input', { type: 'number', class: 'num wide', min: -1, step: 1, value: p.top_k });
    topK.addEventListener('change', () => { let v = parseInt(topK.value, 10); if (isNaN(v) || v === 0 || v < -1) v = -1; topK.value = v; setP({ top_k: v }); });
    return [
      h('h3', { text: '프롬프트' }),
      field('시스템 프롬프트', sys),
      h('h3', { text: '추론' }),
      rowField('추론 강도 (채팅)', effort, 'reasoning_effort · 추론은 끌 수 없습니다. 에이전트용은 에이전트 항목에 있습니다'),
      rowField('이전 추론 보존', toggle(p.preserve_thinking, (v) => setP({ preserve_thinking: v })), 'preserve_thinking · 에이전트 모드에서는 항상 켜집니다'),
      rowField('추론 내용 재전송', toggle(S.settings.sendReasoning, (v) => saveSettings({ sendReasoning: v })), '이전 답변의 reasoning_content 를 다음 요청에 포함'),
      h('h3', { text: '샘플링' }),
      rowField('temperature', slider({ min: 0, max: 2, step: 0.05, value: p.temperature, onChange: (v) => setP({ temperature: v }) }), '권장 1.0'),
      rowField('top_p', slider({ min: 0, max: 1, step: 0.01, value: p.top_p, onChange: (v) => setP({ top_p: v }) }), '권장 0.95'),
      rowField('presence_penalty', slider({ min: -2, max: 2, step: 0.1, value: p.presence_penalty, onChange: (v) => setP({ presence_penalty: v }) })),
      rowField('top_k', topK, '-1 이면 사용 안 함'),
      rowField('max_tokens', maxTok, '추론 토큰 포함. 비우면 제한 없음'),
      rowField('스트리밍', toggle(p.stream, (v) => setP({ stream: v })), 'stream + stream_options.include_usage'),
      h('div', { class: 'panel-foot' }, h('button', { class: 'btn ghost', onclick: async () => {
        if (!await confirmDialog('추론·샘플링 매개변수를 기본값으로 되돌릴까요?', '되돌리기')) return;
        saveSettings({ params: { reasoning_effort: 'high', temperature: 1, top_p: 0.95, top_k: -1, presence_penalty: 0, max_tokens: null, stream: true, preserve_thinking: false } });
        renderChips(); refresh();
      } }, '매개변수 기본값으로')),
    ];
  }

  if (id === 'format') {
    const st = S.settings.structured;
    const nameInput = h('input', { class: 'txt', value: st.name });
    nameInput.addEventListener('input', () => saveSettings({ structured: { name: nameInput.value } }));
    const schemaWrap = h('div', { hidden: st.mode !== 'json_schema' },
      rowField('스키마 이름', nameInput),
      rowField('strict', toggle(st.strict, (v) => saveSettings({ structured: { strict: v } })), '스키마를 엄격하게 강제'),
      field('JSON 스키마', jsonArea(st.schema, (v) => saveSettings({ structured: { schema: v } }),
        (v) => { const j = tryJson(v); return j && typeof j === 'object' && !Array.isArray(j) ? '' : 'JSON 객체가 아닙니다'; }, 14)));
    return [
      rowField('response_format', select([['off', '일반 텍스트'], ['json_object', 'JSON 객체 (json_object)'], ['json_schema', 'JSON 스키마 (json_schema)']], st.mode,
        (v) => { saveSettings({ structured: { mode: v } }); renderChips(); schemaWrap.hidden = v !== 'json_schema'; }), '입력창의 도구 버튼에서도 바꿀 수 있습니다'),
      schemaWrap,
    ];
  }

  if (id === 'agent') {
    const catLabel = { read: '읽기', write: '쓰기', exec: '실행', net: '네트워크' };
    return [
      rowField('추론 강도 (에이전트)', select(Object.entries(EFFORTS).map(([k, v]) => [k, `${v.label} (${k})`]), EFFORTS[a.reasoning_effort] ? a.reasoning_effort : 'medium', (v) => setA({ reasoning_effort: v })), '단계마다 다시 추론하므로 채팅보다 낮게 둡니다'),
      rowField('승인 방식', select(Object.entries(APPROVALS).map(([k, v]) => [k, v.label]), a.approval, async (v) => {
        if (v === 'auto' && !(await confirmAutoApproval())) return refresh();
        setA({ approval: v });
      }), '읽기 전용 · 쓰기/명령/웹은 매번 확인 · 확인 없이 실행'),
      rowField('tool_choice', select([['auto', 'auto — 모델이 결정'], ['required', 'required — 반드시 호출'], ['none', 'none — 호출 금지']], a.toolChoice || 'auto', (v) => setA({ toolChoice: v }))),
      rowField('최대 단계 수', numInput(a.maxSteps, 1, 200, (v) => setA({ maxSteps: v })), '한 번의 지시로 반복할 요청 수'),
      rowField('명령 제한 시간 (초)', numInput(a.commandTimeout, 5, 600, (v) => setA({ commandTimeout: v }))),
      S.env.platform === 'win32' ? rowField('셸', select([['auto', 'cmd.exe'], ['powershell', 'PowerShell']], a.shell === 'powershell' ? 'powershell' : 'auto', (v) => { setA({ shell: v }); S.env.shell = v === 'powershell' ? 'powershell' : 'cmd'; })) : null,
      h('h3', { text: '내장 도구' }),
      h('div', { class: 'tool-list' }, S.toolDefs.map((t) => h('div', { class: 'tool-row' },
        h('div', null, h('b', { text: t.name }), h('span', { class: 'cat cat-' + t.category, text: t.client ? '질문' : (catLabel[t.category] || t.category) }), h('p', { text: t.name === 'ask_user' ? '무엇을 만들지 불분명할 때 작업 전에 선택지 질문을 띄우고, 답을 받은 뒤 진행합니다.' : t.def.function.description })),
        toggle(!(a.disabledTools || []).includes(t.name), (on) => {
          const set = new Set(S.settings.agent.disabledTools || []);
          if (on) set.delete(t.name); else set.add(t.name);
          setA({ disabledTools: [...set] });
        })))),
    ];
  }

  if (id === 'functions') {
    const ct = S.settings.customTools;
    return [
      rowField('함수 호출 테스트', toggle(ct.enabled, (v) => { saveSettings({ customTools: { enabled: v } }); renderChips(); }), '아래 함수를 tools 로 모델에 전달합니다 (채팅 모드 포함)'),
      note('모델이 이 함수를 호출하면 실행 결과를 직접 입력해서 돌려줄 수 있습니다. function calling 동작을 확인할 때 쓰세요.'),
      field('함수 정의 (JSON 배열)', jsonArea(ct.json, (v) => { saveSettings({ customTools: { json: v } }); renderHint(); }, (v) => {
        const j = tryJson(v);
        if (!Array.isArray(j)) return 'JSON 배열이 아닙니다';
        const bad = j.findIndex((t) => !((t && t.function && t.function.name) || (t && t.name)));
        return bad >= 0 ? `${bad + 1}번째 항목에 function.name 이 없습니다` : '';
      }, 16)),
    ];
  }

  if (id === 'cli') {
    // 터미널 명령(exaone) 설치 · 제거
    const info = h('div', { class: 'key-info cli-info' });
    const actions = h('div', { class: 'inline cli-actions' });
    const detail = h('p', { class: 'muted small set-note cli-detail' });
    const draw = (st, busy) => {
      info.innerHTML = ''; actions.innerHTML = '';
      if (!st) { info.append(h('span', { class: 'dot' }), h('span', { text: '확인하는 중…' })); return; }
      const ready = st.installed && st.inPath;
      info.append(h('span', { class: 'dot ' + (ready ? 'ok' : 'bad') }),
        st.installed
          ? h('span', null, h('b', { text: ready ? '설치됨' : '설치됨 (PATH 등록 필요)' }), ' — 새 터미널에서 ', h('code', { text: 'exaone' }), ' 실행')
          : st.other ? h('span', null, h('b', { text: '다른 방법으로 설치되어 있음' }), ' — ', st.other)
            : h('span', { text: '설치되어 있지 않습니다. 설치하면 어느 폴더에서나 exaone 명령을 쓸 수 있습니다.' }));
      actions.append(
        h('button', { class: 'btn primary', disabled: !!busy, onclick: () => act('install') }, st.installed ? '다시 설치' : '설치'),
        st.installed ? h('button', { class: 'btn danger-ghost', disabled: !!busy, onclick: () => act('uninstall') }, '제거') : null);
      detail.textContent = st.installed
        ? `위치: ${st.launcher} · 실행 환경: ${st.runtime}` + (st.pathError ? ` · ${st.pathError}` : st.pathNote ? ` · ${st.pathNote}` : '')
        : `설치 위치: ${st.dir} · 실행 환경: ${st.runtime}`;
    };
    const act = async (what) => {
      draw(S.cliBin, true);
      const r = await (what === 'install' ? exa.cliBinInstall() : exa.cliBinUninstall());
      if (!r.ok) { toast((what === 'install' ? '설치' : '제거') + '하지 못했습니다: ' + r.error, 'err'); draw(S.cliBin); return; }
      S.cliBin = r.data;
      draw(S.cliBin);
      if (what === 'install') toast(r.data.pathError ? r.data.pathError : '설치했습니다. 새로 여는 터미널에서 exaone 을 실행하세요', r.data.pathError ? 'err' : undefined);
      else toast('exaone 명령을 제거했습니다');
      if (S.conv && !S.conv.messages.length) renderConv();
    };
    draw(S.cliBin);
    refreshCliBin().then(() => draw(S.cliBin));
    return [
      h('h3', { text: '터미널 명령 (exaone)' }),
      info,
      actions,
      detail,
      note('설치하면 사용자 폴더에 실행 파일(런처)을 만들고 그 폴더를 PATH 에 넣습니다. 관리자 권한은 필요 없고, 이미 열려 있는 터미널은 다시 열어야 합니다. 토큰과 세션 기록은 이 앱과 함께 씁니다.'),
      h('h3', { text: '쓰는 법' }),
      h('pre', { class: 'cli-usage', text: 'exaone                 대화형 화면\nexaone -c              마지막 세션 이어서\nexaone -p "지시"       한 번 실행하고 결과만 출력\nexaone --help          옵션 전체' }),
    ];
  }

  if (id === 'data') {
    const dirRow = (label, dir, hint) => rowField(label, h('button', { class: 'btn sm', onclick: () => exa.open(dir) }, icon('folder', 13), '열기'), hint);
    return [
      rowField('API 로그 파일 저장', toggle(S.settings.saveLogs !== false, (v) => saveSettings({ saveLogs: v })), '요청·응답 원문을 로그 폴더에 JSON 으로 남깁니다 (최근 40개, 키는 포함하지 않음)'),
      dirRow('로그 폴더', S.env.logDir, S.env.logDir),
      dirRow('데이터 폴더', S.env.dataDir, '대화 · 설정 · 파일 버전 기록 — ' + S.env.dataDir),
    ];
  }

  return [
    h('div', { class: 'about' },
      h('div', null, h('b', { text: 'EXAONE Desktop ' + S.env.appVersion })),
      h('div', { class: 'muted', text: `Electron ${S.env.electron} · Chromium ${S.env.chrome} · Node ${S.env.node}` }),
      updateRow(),
      h('div', { class: 'inline', style: { marginTop: '10px' } },
        h('button', { class: 'btn sm', onclick: () => exa.open('https://docs.exaone.ai') }, icon('ext', 13), 'EXAONE API 문서'))),
    note('터미널에서는 같은 폴더의 exaone-code 로 에이전트를 쓸 수 있습니다 (README 참고).'),
  ];
}

/** 설정 > 정보의 업데이트 줄. 상태가 바뀌면 renderUpdate() 가 다시 그린다. */
function updateRow() {
  const row = h('div', { class: 'update-row', id: 'update-row' });
  drawUpdateRow(row);
  return row;
}

function drawUpdateRow(row) {
  const u = S.update || {};
  row.innerHTML = '';
  if (!u.supported) {
    row.append(h('span', { class: 'muted small', text: S.env.platform === 'win32' ? '자동 업데이트는 설치판에서만 동작합니다 (개발 실행 중).' : '자동 업데이트는 Windows 설치판에서만 동작합니다.' }));
    return;
  }
  const label = {
    idle: '', checking: '업데이트 확인 중…', latest: '최신 버전입니다.',
    downloading: `새 버전 v${u.version || ''} 받는 중… ${u.percent || 0}%`,
    ready: `새 버전 v${u.version} 준비됨 — 재시작하면 설치됩니다.`,
    error: '업데이트 확인 실패: ' + (u.error || ''),
  }[u.status] || '';
  row.append(h('span', { class: 'dot ' + (u.status === 'error' ? 'bad' : u.status === 'latest' || u.status === 'ready' ? 'ok' : '') }), h('span', { text: label || '자동 업데이트 사용 중' }));
  if (u.status === 'ready') row.append(h('button', { class: 'btn sm primary', onclick: () => exa.updateInstall() }, '재시작하여 업데이트'));
  else row.append(h('button', { class: 'btn sm', disabled: u.status === 'checking' || u.status === 'downloading', onclick: () => { exa.updateCheck(); } }, icon('refresh', 13), '업데이트 확인'));
}

/** 업데이트 상태를 사이드바 버튼과 설정 화면에 반영한다. */
function renderUpdate() {
  const u = S.update || {};
  const btn = $('#btn-update');
  if (btn) {
    btn.hidden = u.status !== 'ready';
    if (u.status === 'ready') btn.title = `v${u.version} 을 설치하고 다시 실행합니다`;
  }
  const row = $('#update-row');
  if (row) drawUpdateRow(row);
}

/** 터미널 명령(exaone)의 설치 상태를 다시 읽는다. */
async function refreshCliBin() {
  try { const r = await exa.cliBinStatus(); if (r && r.ok) S.cliBin = r.data; } catch { /* 다음에 다시 */ }
  return S.cliBin;
}

function openSettings(section) {
  if (settingsUi) { if (section) settingsUi.select(section); return; }
  const nav = h('div', { class: 'set-nav' });
  const pane = h('div', { class: 'set-pane' });
  const ui = {
    section: SETTINGS_SECTIONS.some((x) => x.id === section) ? section : 'general',
    select(id) { ui.section = id; ui.refresh(true); },
    refresh(top) {
      const keep = top ? 0 : pane.scrollTop;
      const sec = SETTINGS_SECTIONS.find((x) => x.id === ui.section) || SETTINGS_SECTIONS[0];
      $$('button', nav).forEach((b) => b.classList.toggle('on', b.dataset.id === sec.id));
      pane.innerHTML = '';
      pane.append(h('h2', { text: sec.label }), h('div', { class: 'settings' }, settingsSection(sec.id, () => ui.refresh())));
      pane.scrollTop = keep;
    },
  };
  for (const sec of SETTINGS_SECTIONS) nav.append(h('button', { dataset: { id: sec.id }, onclick: () => ui.select(sec.id) }, icon(sec.icon, 15), h('span', { text: sec.label })));
  settingsUi = ui;
  openModal({ title: '설정', cls: 'settings-modal', body: h('div', { class: 'set-wrap' }, nav, pane), onClose: () => { settingsUi = null; } });
  ui.refresh(true);
}
