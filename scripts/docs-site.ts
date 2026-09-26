import { Marked } from 'marked';
import { gfmHeadingId } from 'marked-gfm-heading-id';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHighlighter, type BundledLanguage } from 'shiki';

/**
 * docs/index.html: the README rendered into docs/template.html, the documentation site's front page.
 * The title block is dropped (the template carries it) but its badges are kept, relative links go to
 * the repository, and every fence is highlighted here, so the page needs no script.
 */
const root = new URL('..', import.meta.url).pathname;
const repo = 'https://github.com/gmitch215/gmux';
const ref = 'master';
const LANGUAGES: BundledLanguage[] = ['shellscript', 'typescript', 'c', 'json'];
const ALIASES: Record<string, BundledLanguage> = {
	sh: 'shellscript',
	bash: 'shellscript',
	ts: 'typescript',
	js: 'typescript'
};
const PLACEHOLDER = '<!-- readme -->';

const language = (lang: string | undefined): BundledLanguage | 'text' => {
	const named = lang?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
	const aliased = ALIASES[named] ?? (named as BundledLanguage);
	return LANGUAGES.includes(aliased) ? aliased : 'text';
};

/** a link into the working tree, as a repository URL: `tree` for a directory, `blob` for a file */
function repository(path: string): string {
	const relative = path.replace(/^\.\//, '').replace(/\/$/, '');
	const directory = statSync(join(root, relative), { throwIfNoEntry: false })?.isDirectory();
	return `${repo}/${directory ? 'tree' : 'blob'}/${ref}/${relative}`;
}

const readme = readFileSync(join(root, 'README.md'), 'utf8');
const title = readme.match(/^<div[\s\S]*?\n<\/div>\n+(---\n+)?/)?.[0] ?? '';
const badges = title.match(/<img src="https:\/\/img\.shields\.io[^"]*">/g) ?? [];

const highlighter = await createHighlighter({
	themes: ['github-light', 'github-dark'],
	langs: LANGUAGES
});
const renderer = new Marked({ async: true, gfm: true });
renderer.use(gfmHeadingId());
renderer.use({
	async: true,
	walkTokens(token) {
		if (token.type === 'link' && !/^[a-z][a-z0-9+.-]*:|^[#/]/i.test(token.href))
			token.href = repository(token.href);
		if (token.type === 'code') {
			token.text = highlighter.codeToHtml(token.text, {
				lang: language(token.lang),
				themes: { light: 'github-light', dark: 'github-dark' },
				defaultColor: false
			});
			token.escaped = true;
		}
	},
	renderer: { code: ({ text }) => text }
});
const body = (await renderer.parse(readme.slice(title.length)))
	.replaceAll('<table>', '<div class="table"><table>')
	.replaceAll('</table>', '</table></div>');
highlighter.dispose();

const template = readFileSync(join(root, 'docs/template.html'), 'utf8');
if (!template.includes(PLACEHOLDER))
	throw new Error(`docs/template.html has no ${PLACEHOLDER} line`);
const badgeRow = badges.length ? `<p class="badges">${badges.join(' ')}</p>\n` : '';
writeFileSync(
	join(root, 'docs/index.html'),
	template.replace(PLACEHOLDER, (badgeRow + body).trimEnd())
);
console.log('docs/index.html written');
