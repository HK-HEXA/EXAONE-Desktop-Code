'use strict';
// 터미널용 가벼운 구문 강조: 파일 미리보기(Write 결과)에서 줄마다 색을 입힌다.
// 정확한 파서가 아니라 줄 단위 정규식이라, 여러 줄에 걸친 주석·문자열은 첫 줄만 맞을 수 있다.

const { c } = require('./term');

const tok = {
  tag: (s) => c.colorize('38;5;197', s),      // 태그 · 키워드
  attr: (s) => c.colorize('38;5;148', s),     // 속성 이름 · 함수
  str: (s) => c.colorize('38;5;186', s),      // 문자열
  num: (s) => c.colorize('38;5;141', s),      // 숫자 · 상수
  com: (s) => c.colorize('38;5;242', s),      // 주석
  prop: (s) => c.colorize('38;5;81', s),      // 속성(CSS) · 타입
  punct: (s) => s,
};

const KEYWORDS = {
  js: 'async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield',
  py: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield',
  go: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
  rs: 'as async await break const continue crate else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while',
  java: 'abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static super switch synchronized this throw throws try void volatile while',
  sh: 'if then else elif fi for while do done case esac function in return local export echo exit set',
  php: 'abstract and array as break case catch class clone const continue declare default do echo else elseif empty endfor endforeach endif endwhile extends final finally fn for foreach function global if implements include instanceof interface isset list namespace new or print private protected public require require_once return static switch throw trait try unset use var while',
  sql: 'select from where insert into update delete set values create table drop alter index join left right inner outer on group by order having limit and or not null as distinct union primary key',
};
const CONST = new Set(['true', 'false', 'null', 'undefined', 'None', 'True', 'False', 'nil', 'NaN', 'Infinity']);

const LANG = {
  html: 'html', htm: 'html', xml: 'html', svg: 'html', vue: 'html', xhtml: 'html',
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', json: 'json', jsonc: 'json',
  css: 'css', scss: 'css', less: 'css',
  py: 'py', go: 'go', rs: 'rs', java: 'java', kt: 'java', cs: 'java', c: 'java', h: 'java', cpp: 'java', hpp: 'java', swift: 'java', dart: 'java',
  sh: 'sh', bash: 'sh', zsh: 'sh', ps1: 'sh', bat: 'sh', cmd: 'sh',
  php: 'php', sql: 'sql', md: 'md', markdown: 'md', yml: 'yaml', yaml: 'yaml', toml: 'yaml', ini: 'yaml',
};

function langOf(file) {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(file || ''));
  return m ? LANG[m[1].toLowerCase()] || null : null;
}

/** 정규식 규칙들로 한 줄을 훑어 맞은 조각에 색을 입힌다. */
function scan(line, rules) {
  let out = '', i = 0;
  while (i < line.length) {
    let hit = null;
    for (const [re, fn] of rules) {
      re.lastIndex = i;
      const m = re.exec(line);
      if (m && m.index === i && m[0]) { hit = [m, fn]; break; }
    }
    if (hit) { out += hit[1](hit[0][0], hit[0]); i += hit[0][0].length; }
    else { out += line[i]; i++; }
  }
  return out;
}

const STR = [/"(?:[^"\\]|\\.)*"?/y, /'(?:[^'\\]|\\.)*'?/y, /`(?:[^`\\]|\\.)*`?/y];

function codeRules(lang) {
  const kw = new Set((KEYWORDS[lang] || KEYWORDS.js).split(' '));
  const lineCom = lang === 'py' || lang === 'sh' || lang === 'yaml' ? /#.*/y : lang === 'sql' ? /--.*/y : /\/\/.*/y;
  const rules = [
    [/\/\*.*?(\*\/|$)/y, tok.com],
    [lineCom, tok.com],
    ...STR.map((re) => [re, tok.str]),
    [/\b(0x[0-9a-fA-F]+|\d+(\.\d+)?([eE][+-]?\d+)?)\b/y, tok.num],
    [/[A-Za-z_$][\w$]*(?=\s*\()/y, (s) => (kw.has(s) ? tok.tag(s) : tok.attr(s))],
    [/[A-Za-z_$][\w$]*/y, (s) => (kw.has(lang === 'sql' ? s.toLowerCase() : s) ? tok.tag(s) : CONST.has(s) ? tok.num(s) : /^[A-Z][a-z]/.test(s) && lang !== 'sql' ? tok.prop(s) : s)],
  ];
  if (lang === 'php' || lang === 'sh') rules.unshift([/\$[A-Za-z_][\w]*/y, tok.prop]);
  return rules;
}

function highlightLine(line, lang) {
  if (!lang || line.length > 400) return line;
  switch (lang) {
    case 'html': return scan(line, [
      [/<!--.*?(-->|$)/y, tok.com],
      [/<!DOCTYPE\s+[^>]*>?/iy, (s) => s.replace(/^(<!DOCTYPE\s+)([^>]*)(>?)$/i, (_, x, n, y) => tok.com(x) + tok.tag(n) + tok.com(y))],
      [/<\/?[A-Za-z][\w:-]*/y, (s) => s.replace(/^(<\/?)(.*)$/, (_, p, n) => p + tok.tag(n))],
      [/\/?>/y, tok.punct],
      [/[A-Za-z_:@][\w:.-]*(?==)/y, tok.attr],
      ...STR.slice(0, 2).map((re) => [re, tok.str]),
    ]);
    case 'css': return scan(line, [
      [/\/\*.*?(\*\/|$)/y, tok.com],
      ...STR.slice(0, 2).map((re) => [re, tok.str]),
      [/--[\w-]+/y, tok.prop],
      [/[a-z-]+(?=\s*:[^:])/y, tok.prop],
      [/#[0-9a-fA-F]{3,8}\b/y, tok.num],
      [/-?\d*\.?\d+(px|em|rem|%|vh|vw|s|ms|deg|fr)?\b/y, tok.num],
      [/@[\w-]+/y, tok.tag],
      [/[.#][A-Za-z_][\w-]*/y, tok.attr],
    ]);
    case 'json': return scan(line, [
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/y, tok.prop],
      [/"(?:[^"\\]|\\.)*"?/y, tok.str],
      [/-?\d+(\.\d+)?([eE][+-]?\d+)?/y, tok.num],
      [/\b(true|false|null)\b/y, tok.num],
    ]);
    case 'yaml': return scan(line, [
      [/#.*/y, tok.com],
      [/^\s*[\w.-]+(?=\s*[:=])/y, tok.prop],
      [/^\s*\[[^\]]*\]/y, tok.tag],
      ...STR.slice(0, 2).map((re) => [re, tok.str]),
      [/\b(\d+(\.\d+)?|true|false|null|yes|no)\b/y, tok.num],
    ]);
    case 'md': return /^\s*#/.test(line) ? c.bold(tok.tag(line)) : /^\s*([-*+]|\d+\.)\s/.test(line) ? line.replace(/^(\s*)([-*+]|\d+\.)/, (_, s, m) => s + tok.tag(m)) : line;
    default: return scan(line, codeRules(lang));
  }
}

module.exports = { langOf, highlightLine };
