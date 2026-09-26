import MarkdownIt from 'markdown-it';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** docs/index.html: the README as the documentation site's front page, linking both API references */
const root = new URL('..', import.meta.url).pathname;
const body = new MarkdownIt({ html: true, linkify: true }).render(
	readFileSync(join(root, 'README.md'), 'utf8')
);
writeFileSync(
	join(root, 'docs/index.html'),
	`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>gmux</title>
<link rel="icon" href="https://cdn.gmitch215.xyz/gmux.png">
<style>
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fff; --muted: #6e6e73; --code: #f2f2f5; }
@media (prefers-color-scheme: dark) { :root { --fg: #f2f2f5; --bg: #111114; --muted: #a1a1a6; --code: #1f1f24; } }
body { margin: 0 auto; max-width: 52rem; padding: 2rem 1rem; font: 16px/1.6 system-ui, sans-serif; color: var(--fg); background: var(--bg); }
nav { display: flex; gap: 1.5rem; margin-bottom: 2rem; }
a { color: inherit; }
code, pre { background: var(--code); border-radius: 6px; }
pre { padding: 1rem; overflow-x: auto; }
code { padding: 0.1rem 0.3rem; }
table { border-collapse: collapse; }
td, th { border: 1px solid var(--muted); padding: 0.3rem 0.6rem; }
img { max-width: 100%; }
</style>
</head>
<body>
<nav><a href="./typedoc/">TypeScript API</a><a href="./doxygen/">C Reference</a><a href="https://github.com/gmitch215/gmux">Source</a></nav>
${body}
</body>
</html>
`
);
console.log('docs/index.html written');
