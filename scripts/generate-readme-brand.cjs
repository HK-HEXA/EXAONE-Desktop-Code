const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const asset = name => fs.readFileSync(path.join(root, 'assets', name), 'utf8');
const inner = svg => svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const wordmark = inner(asset('wordmark.svg'));
const outDir = path.join(root, 'docs', 'images');
fs.mkdirSync(outDir, { recursive: true });
for (const dark of [false, true]) {
  const ink = dark ? '#f4f4f5' : '#131415';
  const muted = dark ? '#afb1b5' : '#62646a';
  const bg = dark ? '#111113' : '#fafafa';
  const border = dark ? '#343539' : '#dfe0e1';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="240" viewBox="0 0 1040 240" role="img" aria-labelledby="title desc">
  <title id="title">EXAONE Desktop · EXAONE Code</title>
  <desc id="desc">Desktop client and terminal agent, with the EXAONE wordmark and each app's symbol.</desc>
  <rect x=".5" y=".5" width="1039" height="239" rx="20" fill="${bg}" stroke="${border}"/>
  <path d="M520 48v144" stroke="${border}"/>
  <g transform="translate(48 55)">${inner(asset('desktop.svg'))}</g>
  <g transform="translate(568 55)">${inner(asset('code.svg'))}</g>
  <g fill="${ink}" transform="translate(132 58) scale(1.72)">${wordmark}</g>
  <g fill="${ink}" transform="translate(652 58) scale(1.72)">${wordmark}</g>
  <g font-family="Segoe UI,Arial,sans-serif" fill="${ink}" font-size="25">
    <text x="132" y="129">Desktop</text><text x="652" y="129">Code</text>
  </g>
  <g font-family="Segoe UI,Arial,sans-serif" fill="${muted}" font-size="17">
    <text x="48" y="185">Chat, projects &amp; agent workspace</text>
    <text x="568" y="185">Your coding agent, in the terminal</text>
  </g>
</svg>\n`;
  fs.writeFileSync(path.join(outDir, `readme-brand-${dark ? 'dark' : 'light'}.svg`), svg);
  const mobile = `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="300" viewBox="0 0 520 300" role="img" aria-labelledby="title">
  <title id="title">EXAONE Desktop · EXAONE Code</title>
  <rect x=".5" y=".5" width="519" height="299" rx="20" fill="${bg}" stroke="${border}"/>
  <path d="M32 150h456" stroke="${border}"/>
  <g transform="translate(32 36) scale(.75)">${inner(asset('desktop.svg'))}</g>
  <g transform="translate(32 184) scale(.75)">${inner(asset('code.svg'))}</g>
  <g fill="${ink}" transform="translate(98 39) scale(1.5)">${wordmark}</g>
  <g fill="${ink}" transform="translate(98 187) scale(1.5)">${wordmark}</g>
  <g font-family="Segoe UI,Arial,sans-serif" fill="${ink}" font-size="26">
    <text x="250" y="70">Desktop</text><text x="250" y="218">Code</text>
  </g>
  <g font-family="Segoe UI,Arial,sans-serif" fill="${muted}" font-size="18">
    <text x="32" y="114">Chat, projects &amp; agent workspace</text>
    <text x="32" y="262">Your coding agent, in the terminal</text>
  </g></svg>\n`;
  fs.writeFileSync(path.join(outDir, `readme-brand-mobile-${dark ? 'dark' : 'light'}.svg`), mobile);
}
