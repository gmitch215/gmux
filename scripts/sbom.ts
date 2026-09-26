import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from './payload.ts';

/**
 * an SPDX 2.3 bill of materials for a release: gmux itself, every upstream tree it builds from
 * (src/sources.json, with the patch sets applied to each) and the kernel artifacts it ships with their
 * hashes. `bun scripts/sbom.ts <dist/kernel or build/kernel> <out.spdx.json>`
 */
interface Source {
	repo?: string;
	url?: string;
	ref?: string;
	commit?: string;
	sha256?: string;
	license: string;
	patches?: string;
}

const root = new URL('..', import.meta.url).pathname;
const [kernelDir = join(root, 'build/kernel'), out = join(root, 'payload/gmux.spdx.json')] =
	process.argv.slice(2);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const sources: Record<string, Source> = JSON.parse(
	readFileSync(join(root, 'src/sources.json'), 'utf8')
);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
// SPDX requires SHA-1 for files and the package verification code
const sha1 = (bytes: Uint8Array | string) => createHash('sha1').update(bytes).digest('hex');
const id = (name: string) => `SPDXRef-${name.replace(/[^A-Za-z0-9.-]/g, '-')}`;

const upstream = Object.entries(sources).map(([name, s]) => ({
	SPDXID: id(`src-${name}`),
	name,
	versionInfo: s.commit ?? s.ref ?? s.url,
	downloadLocation: s.repo ? `git+${s.repo}@${s.commit}` : (s.url ?? 'NOASSERTION'),
	licenseConcluded: s.license,
	licenseDeclared: s.license,
	copyrightText: 'NOASSERTION',
	filesAnalyzed: false,
	...(s.sha256 ? { checksums: [{ algorithm: 'SHA256', checksumValue: s.sha256 }] } : {}),
	...(s.patches ? { comment: `built with the patches in ${s.patches}` } : {})
}));
const files = readdirSync(kernelDir)
	.filter((name) => !name.endsWith('.md'))
	.sort()
	.map((name) => ({
		SPDXID: id(`file-${name}`),
		fileName: `kernel/${name}`,
		checksums: [
			{ algorithm: 'SHA1', checksumValue: sha1(readFileSync(join(kernelDir, name))) },
			{ algorithm: 'SHA256', checksumValue: sha256(readFileSync(join(kernelDir, name))) }
		],
		licenseConcluded: 'NOASSERTION',
		copyrightText: 'NOASSERTION'
	}));
const document = {
	spdxVersion: 'SPDX-2.3',
	dataLicense: 'CC0-1.0',
	SPDXID: 'SPDXRef-DOCUMENT',
	name: `${pkg.name}@${pkg.version}`,
	documentNamespace: `https://github.com/gmitch215/gmux/spdx/${pkg.version}-${commit}`,
	creationInfo: {
		creators: ['Tool: gmux scripts/sbom.ts'],
		created: new Date(
			Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root })) * 1000
		)
			.toISOString()
			.replace(/\.\d+Z$/, 'Z')
	},
	packages: [
		{
			SPDXID: 'SPDXRef-gmux',
			name: pkg.name,
			versionInfo: pkg.version,
			downloadLocation: `git+https://github.com/gmitch215/gmux@${commit}`,
			licenseConcluded: pkg.license,
			licenseDeclared: pkg.license,
			copyrightText: 'NOASSERTION',
			filesAnalyzed: true,
			packageVerificationCode: {
				packageVerificationCodeValue: sha1(
					files
						.map((f) => f.checksums[0]!.checksumValue)
						.sort()
						.join('')
				)
			}
		},
		...upstream
	],
	files,
	relationships: [
		{
			spdxElementId: 'SPDXRef-DOCUMENT',
			relationshipType: 'DESCRIBES',
			relatedSpdxElement: 'SPDXRef-gmux'
		},
		...files.map((f) => ({
			spdxElementId: 'SPDXRef-gmux',
			relationshipType: 'CONTAINS',
			relatedSpdxElement: f.SPDXID
		})),
		...upstream.map((u) => ({
			spdxElementId: 'SPDXRef-gmux',
			relationshipType: 'GENERATED_FROM',
			relatedSpdxElement: u.SPDXID
		}))
	]
};
writeFileSync(out, `${JSON.stringify(document, null, '\t')}\n`);
console.log(`${out}: ${upstream.length} upstream trees, ${files.length} artifacts`);
