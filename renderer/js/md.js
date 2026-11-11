'use strict';
/* 마크다운 렌더링: marked + DOMPurify + highlight.js + KaTeX */

const Md = (() => {
  marked.use({ gfm: true, breaks: true });
  if (window.markedKatex && window.katex) {
    try { marked.use(window.markedKatex({ throwOnError: false, nonStandard: true })); } catch (e) { console.warn('KaTeX 확장 로드 실패', e); }
  }

  // \( \) / \[ \] 표기를 $ / $$ 로 바꾼다 (코드 영역은 건드리지 않음)
  function normalizeMath(src) {
    if (src.indexOf('\\(') < 0 && src.indexOf('\\[') < 0) return src;
    return src.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g).map((seg, i) => (i % 2 ? seg : seg
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => '\n$$\n' + m.trim() + '\n$$\n')
      .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => '$' + m.trim() + '$'))).join('');
  }

  function render(src) {
    if (!src) return '';
    let html;
    try { html = marked.parse(normalizeMath(src)); }
    catch { html = '<pre>' + src.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</pre>'; }
    return DOMPurify.sanitize(html, { ADD_ATTR: ['target'], FORBID_TAGS: ['style', 'form', 'button', 'iframe', 'textarea', 'select'] });
  }

  const PREVIEWABLE = new Set(['html', 'svg', 'xml']);

  function enhance(root) {
    for (const a of root.querySelectorAll('a[href]')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    for (const t of root.querySelectorAll('table')) {
      if (t.parentElement.classList.contains('table-wrap')) continue;
      const w = document.createElement('div');
      w.className = 'table-wrap';
      t.replaceWith(w);
      w.append(t);
    }
    for (const code of root.querySelectorAll('pre > code')) {
      const pre = code.parentElement;
      if (pre.parentElement.classList.contains('codeblock')) continue;
      const lang = ((code.className.match(/language-([\w+#.-]+)/) || [])[1] || '').toLowerCase();
      const text = code.textContent;
      if (lang && window.hljs && hljs.getLanguage(lang)) {
        try { code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value; code.classList.add('hljs'); } catch { /* 하이라이트 실패는 무시 */ }
      }
      const canPreview = PREVIEWABLE.has(lang) && /<(html|svg|body|div|!doctype)/i.test(text);
      const head = h('div', { class: 'cb-head' },
        h('span', { class: 'cb-lang', text: lang || 'text' }),
        h('span', { class: 'grow' }),
        canPreview ? h('button', { class: 'cb-btn', dataset: { act: 'preview-code' }, title: '미리보기' }, icon('eye', 14), '미리보기') : null,
        h('button', { class: 'cb-btn', dataset: { act: 'copy-code' }, title: '코드 복사' }, icon('copy', 14), '복사'));
      const wrap = h('div', { class: 'codeblock' });
      pre.replaceWith(wrap);
      wrap.append(head, pre);
    }
  }

  return { render, enhance };
})();
