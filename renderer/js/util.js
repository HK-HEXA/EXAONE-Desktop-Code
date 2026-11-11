'use strict';
/* 공용 유틸: DOM 헬퍼, 아이콘, 포맷, 토스트, 팝업 메뉴, 모달 */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else if (['value', 'checked', 'disabled', 'hidden', 'selected', 'open', 'type', 'placeholder', 'title', 'id', 'min', 'max', 'step', 'rows'].includes(k)) e[k] = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    e.append(k.nodeType ? k : document.createTextNode(String(k)));
  }
  return e;
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor" stroke="none"/>',
  clip: '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  sliders: '<path d="M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2"/><circle cx="14" cy="6" r="2"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="18" r="2"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  chevRight: '<path d="m9 6 6 6-6 6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  terminal: '<path d="m4 17 6-6-6-6M12 19h8"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M15 4v16"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v16"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  spark: '<path d="M11 3l1.8 5.2L18 10l-5.2 1.8L11 17l-1.8-5.2L4 10l5.2-1.8Z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8Z"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  list: '<path d="M9 6h12M9 12h12M9 18h12"/><path d="m3 6 1.2 1.2L6.5 5M3 12l1.2 1.2L6.5 11M3 18l1.2 1.2L6.5 17"/>',
  key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.3-9.3M16 7l3 3"/>',
  code: '<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>',
  bolt: '<path d="M13 2 3 14h9l-1 8 10-12h-9z"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/>',
  braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v5a2 2 0 0 0 2 2 2 2 0 0 0-2 2v5a2 2 0 0 1-2 2h-1"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16.5h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.1.5l3-3a5 5 0 0 0-7.1-7.1l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.1-.5l-3 3a5 5 0 0 0 7.1 7.1l1.7-1.7"/>',
  note: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h14v15H6a2 2 0 0 0-2 2z"/><path d="M4 20a2 2 0 0 0 2 2h14v-4"/>',
  newchat: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M18.4 3.6a2 2 0 0 1 2.9 2.9L13 14.8l-3.8.9.9-3.8Z"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 10a6 6 0 0 1-8 7.6L7 23l-3-3 5.4-6A6 6 0 0 1 17 3l-2.3 2.3Z" transform="translate(-1 -2)"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
};

function icon(name, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size);
  s.setAttribute('height', size);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.8');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('class', 'ic ic-' + name);
  s.innerHTML = ICONS[name] || '';
  return s;
}

const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
const fmtNum = (n) => (n == null || isNaN(n) ? '–' : Number(n).toLocaleString('ko-KR'));
function fmtDur(ms) {
  if (ms == null) return '–';
  if (ms < 1000) return Math.round(ms) + 'ms';
  if (ms < 60000) return (ms / 1000).toFixed(1) + '초';
  return fmtElapsed(ms);
}
/** 경과 시간을 시·분·초로: 12초 / 4분 2초 / 1시간 2분 3초 */
function fmtElapsed(ms, done) {
  if (done && ms < 1000) return '1초 미만';
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}시간 ${mm}분 ${ss}초` : mm ? `${mm}분 ${ss}초` : `${ss}초`;
}
function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
function baseName(p) { return String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p || ''); }
function tryJson(s) { try { return JSON.parse(s); } catch { return undefined; } }
function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch {
    const ta = h('textarea', { value: text, style: { position: 'fixed', opacity: 0 } });
    document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove();
  }
  if (btn) {
    const old = btn.innerHTML;
    btn.innerHTML = '';
    btn.append(icon('check', 14));
    btn.classList.add('ok');
    setTimeout(() => { btn.innerHTML = old; btn.classList.remove('ok'); }, 1200);
  } else toast('복사했습니다');
}

function toast(msg, kind = '') {
  const t = h('div', { class: 'toast ' + kind, text: msg });
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 250); }, kind === 'err' ? 5000 : 2200);
}

/* 앵커 아래(공간이 없으면 위)에 뜨는 팝업 메뉴 */
let openMenu = null;
function closeMenu() { if (openMenu) { openMenu.remove(); openMenu = null; } }
function popupMenu(anchor, items, opts = {}) {
  closeMenu();
  const m = h('div', { class: 'menu' });
  if (opts.title) m.append(h('div', { class: 'menu-title', text: opts.title }));
  for (const it of items) {
    if (it === '-') { m.append(h('div', { class: 'menu-sep' })); continue; }
    m.append(h('button', {
      class: 'menu-item' + (it.active ? ' active' : '') + (it.danger ? ' danger' : ''),
      onclick: (e) => { e.stopPropagation(); closeMenu(); it.onClick && it.onClick(); },
    },
    it.icon ? icon(it.icon, 15) : null,
    h('span', { class: 'mi-main' }, h('span', { class: 'mi-label', text: it.label }), it.desc ? h('span', { class: 'mi-desc', text: it.desc }) : null),
    it.active ? icon('check', 14) : null));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = opts.alignRight ? r.right - mw : r.left;
  left = clamp(left, 8, window.innerWidth - mw - 8);
  let top = r.bottom + 6;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6);
  m.style.left = left + 'px';
  m.style.top = top + 'px';
  openMenu = m;
}
document.addEventListener('mousedown', (e) => { if (openMenu && !openMenu.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);

/* 모달 */
function openModal({ title, body, footer, wide, cls, onClose }) {
  const root = $('#modal-root');
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); onClose && onClose(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back) close(); } },
    h('div', { class: 'modal' + (wide ? ' wide' : '') + (cls ? ' ' + cls : '') },
      h('div', { class: 'modal-head' }, h('h2', { text: title }), h('button', { class: 'icon-btn', onclick: close, title: '닫기' }, icon('x'))),
      h('div', { class: 'modal-body' }, body),
      footer ? h('div', { class: 'modal-foot' }, footer) : null));
  root.append(back);
  document.addEventListener('keydown', onKey, true);
  return { close, el: back };
}

function confirmDialog(message, okLabel = '확인', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const m = openModal({
      title: '확인',
      body: h('p', { class: 'confirm-msg', text: message }),
      footer: [
        h('button', { class: 'btn', onclick: () => finish(false) }, '취소'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => finish(true) }, okLabel),
      ],
      onClose: () => { if (!done) { done = true; resolve(false); } },
    });
  });
}
