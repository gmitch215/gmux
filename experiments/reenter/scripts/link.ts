import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createVm, type Loaded, type Vm } from './vm.ts';

export interface Rung {
	rung: number;
	imports: Record<string, string>;
	cold?: string[];
}

export interface Linked {
	guest: Loaded;
	native: Record<string, (...a: number[]) => number>;
	/** crossings in each direction since the last reset (the glued path counts them; the direct path leaves them 0) */
	counts: { down: number; up: number };
}

/**
 * A dispatcher for the interpreter's host_direct import: a br_table on the id, each arm calling one native function with
 * its first `arity` arguments. `viaTable` calls through an imported table (call_indirect on the id's slot), which breaks
 * the cycle when the native module needs the interpreter's memory and so cannot exist before it; otherwise each arm
 * calls an imported function directly.
 */
export function dispatchWat(entries: { arity: number; returns: boolean }[], viaTable: boolean) {
	const sig = (e: { arity: number; returns: boolean }) => `(param ${'i32 '.repeat(e.arity)}) ${e.returns ? '(result i32)' : ''}`;
	const types = entries.map((e, i) => `(type $s${i} (func ${sig(e)}))`);
	const imports = viaTable ? ['(import "env" "table" (table 64 funcref))'] : entries.map((e, i) => `(import "native" "f${i}" (func $f${i} ${sig(e)}))`);
	const args = (e: { arity: number }) => Array.from({ length: e.arity }, (_, k) => `(local.get $a${k})`).join(' ');
	const arms = entries.map((e, i) => {
		const call = viaTable ? `(call_indirect (type $s${i}) ${args(e)} (i32.const ${i}))` : `(call $f${i} ${args(e)})`;
		return e.returns ? `(return ${call})` : `${call} (return (i32.const 0))`;
	});
	// arm i sits right after block i closes, which is where br_table target i lands
	const opens = entries.map((_, i) => `(block $b${entries.length - 1 - i}`).join(' ');
	const body = `(block $d ${opens} (br_table ${entries.map((_, i) => `$b${i}`).join(' ')} $d (local.get $id)) ${arms.map((a) => `) ${a}`).join(' ')}) (unreachable)`;
	return `(module ${types.join(' ')} ${imports.join(' ')}
	(func (export "host_direct") (param $id i32) ${Array.from({ length: 8 }, (_, k) => `(param $a${k} i32)`).join(' ')} (result i32)
		${body}))`;
}

/** the entries a rung's thunks need dispatched, in link order */
export const entriesOf = (rung: Rung) => Object.entries(rung.imports).map(([name, signature]) => ({ name, arity: signature.length - 3, returns: signature[0] !== 'v' }));

/**
 * Loads a rung into a vm: the interpreter side with its thunks, the native side over the interpreter's memory, and, for an
 * open rung, the native side's way back into the interpreter. `direct` answers the thunks through host_direct and a
 * dispatcher over `table` (which this fills); otherwise through JavaScript.
 */
export function linkRung(vm: Vm, dir: string, rung: Rung, options: { direct?: { table: WebAssembly.Table }; jsUp?: boolean; beforeUp?: () => void } = {}): Linked {
	const counts = { down: 0, up: 0 };
	const native: Linked['native'] = {};
	const entries = entriesOf(rung);
	const interpBytes = new Uint8Array(readFileSync(join(dir, `rung${rung.rung}.interp.wasm`)));
	const guest = options.direct
		? vm.load(interpBytes, { direct: entries.map((e) => ({ module: 'native', field: e.name, signature: rung.imports[e.name]! })) })
		: vm.load(interpBytes, {
				glued: {
					native: Object.fromEntries(
						entries.map((e) => [
							e.name,
							{
								signature: rung.imports[e.name]!,
								fn: (...a: number[]) => {
									counts.down++;
									return native[`f_${e.name}`]!(...a);
								}
							}
						])
					)
				}
			});
	const memory = vm.shim.memory;
	const base = new WebAssembly.Global({ value: 'i32', mutable: false }, guest.memory().base);
	const callAt = options.jsUp
		? (...a: number[]) => {
				options.beforeUp?.();
				counts.up++;
				return (vm.shim.burrow_call_at as (...x: number[]) => number)(...a);
			}
		: (vm.shim.burrow_call_at as unknown as WebAssembly.ImportValue);
	const interp: Record<string, WebAssembly.ImportValue> = { call_at: callAt };
	for (const c of rung.cold ?? []) interp[`h_${c}`] = new WebAssembly.Global({ value: 'i32', mutable: false }, guest.handle(`ie_${c}`));
	const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(dir, `rung${rung.rung}.native.wasm`))), { env: { memory, base }, interp });
	Object.assign(native, instance.exports);
	if (options.direct) entries.forEach((e, i) => options.direct!.table.set(i, native[`f_${e.name}`] as unknown as Function));
	return { guest, native, counts };
}

/**
 * A vm and a rung linked into it. `glued` answers the thunks and the way back through JavaScript; `direct` answers the
 * thunks with `dispatcher` (dispatchWat over a table, assembled) and gives the native side the interpreter's burrow_call_at
 * export itself, so no JavaScript frame sits between the two.
 */
export async function openRung(wasm3: string, dir: string, rung: Rung, mode: 'glued' | 'direct', dispatcher?: Uint8Array): Promise<{ vm: Vm; linked: Linked }> {
	if (mode === 'glued') {
		const vm = await createVm(wasm3);
		return { vm, linked: linkRung(vm, dir, rung, { jsUp: true }) };
	}
	if (!dispatcher) throw new Error('direct needs the assembled dispatcher');
	const table = new WebAssembly.Table({ element: 'anyfunc', initial: 64 });
	const instance = new WebAssembly.Instance(new WebAssembly.Module(dispatcher as Uint8Array<ArrayBuffer>), { env: { table } });
	const vm = await createVm(wasm3, { hostDirect: instance.exports.host_direct as (...a: number[]) => number });
	return { vm, linked: linkRung(vm, dir, rung, { direct: { table } }) };
}
