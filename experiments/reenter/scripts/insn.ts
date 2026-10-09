export type Arch = 'arm64' | 'x64';

export interface InsnCounts {
	instructions: number;
	loads: number;
	stores: number;
	frame: number;
	adds: number;
	leas: number;
}

/** the instruction lines of a printed code block: address, offset and encoding columns, then the text */
export const isInsnLine = (line: string) => /^0x[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+\S/.test(line);

const text = (line: string) => line.replace(/^0x[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+/, '').trim();

const frameBase = /\[(sp|fp|rsp|rbp)\b/;
const x64Move = /^(mov(zx|sx)?[bwlq]{1,2}|mov(ss|sd|d|dqu|ups|aps|upd|apd))$/;
const arm64Load = /^(ldr|ldur)(s?[bhw])?$|^ldp$/;
const arm64Store = /^(str|stur)[bh]?$|^stp$/;

/**
 * counts one function's instruction lines. x86-64: a store is a move into memory; a load is any other instruction (not
 * lea or nop) with a memory operand, a read-modify-write included. arm64: ldr/ldur/ldp and str/stur/stp. `frame` is the
 * loads and stores through sp, fp, rsp or rbp (spills, still counted in loads and stores). `adds` is add with no memory
 * operand; `leas` is the x86-64 lea, which is where V8 puts an address add.
 */
export function countInsns(lines: string[], arch: Arch): InsnCounts {
	const insn = lines.filter(isInsnLine);
	const out: InsnCounts = { instructions: insn.length, loads: 0, stores: 0, frame: 0, adds: 0, leas: 0 };
	for (const line of insn) {
		const t = text(line);
		if (arch === 'arm64') {
			const mnemonic = t.split(/\s+/)[0]!;
			if (mnemonic === 'add') out.adds++;
			const load = arm64Load.test(mnemonic);
			if (load) out.loads++;
			else if (arm64Store.test(mnemonic)) out.stores++;
			if ((load || arm64Store.test(mnemonic)) && frameBase.test(t)) out.frame++;
			continue;
		}
		const words = t.replace(/^REX\.W\s+/, '').split(/\s+/);
		const mnemonic = words[0]!;
		const ops = words.slice(1).join('').split(',');
		const memory = ops.findIndex((o) => o.includes('['));
		if (/^lea[lq]?$/.test(mnemonic)) out.leas++;
		else if (/^add[bwlq]?$/.test(mnemonic) && memory < 0) out.adds++;
		if (memory < 0 || /^(lea|nop)/.test(mnemonic)) continue;
		if (x64Move.test(mnemonic) && memory === 0) out.stores++;
		else out.loads++;
		if (frameBase.test(ops[memory]!)) out.frame++;
	}
	return out;
}
