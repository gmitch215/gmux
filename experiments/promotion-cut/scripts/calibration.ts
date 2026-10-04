import { createHash } from 'node:crypto';
import type { Graph } from './plan.ts';

export interface Calibration {
	/** null when the rung was refused */
	tau_ns: number | null;
	rung: string;
	crossings: number;
	rounds: number;
	spread: number;
	host: string;
	node: string;
	/** sha256 of the guest module the rung was built from */
	module?: string;
	/** wall time the calibration took */
	seconds?: number;
	refused?: string;
}

export const FALLBACK_NS = 270;
export const MIN_CROSSINGS = 1000;
export const MAX_SPREAD = 0.2;

/** `deployed-<HOST_LABEL>` when that is set, else `local-<node major>.<minor>`; never a url or an account */
export function hostLabel(env: Record<string, string | undefined> = process.env, version = process.versions.node): string {
	if (env.HOST_LABEL) return `deployed-${env.HOST_LABEL}`;
	const [major, minor] = version.split('.');
	return `local-${major}.${minor}`;
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** why a fitted rung cannot stand for the guest, or undefined */
export function refusal(crossings: number, spread: number, tau: number): string | undefined {
	if (!Number.isFinite(tau) || tau <= 0) return `fitted tau ${tau} ns is not positive`;
	if (crossings < MIN_CROSSINGS) return `${crossings} crossings a unit, under ${MIN_CROSSINGS}`;
	if (spread > MAX_SPREAD) return `spread ${(100 * spread).toFixed(0)}% over ${100 * MAX_SPREAD}%`;
	return undefined;
}

export interface TauChoice {
	ns: number;
	source: 'argument' | 'calibrated' | 'fallback';
	/** why a calibration was not used */
	refused?: string;
}

/** a number is the explicit tau; `auto` is the calibration when it is whole, comes from this host and this module, else the fallback */
export function resolveTau(arg: string, cal?: Calibration, host = hostLabel(), module?: string): TauChoice {
	if (arg !== 'auto') {
		const ns = Number(arg);
		if (!Number.isFinite(ns) || ns <= 0) throw new Error(`tau must be a positive number of ns or auto, got ${arg}`);
		return { ns, source: 'argument' };
	}
	const fallback = (refused: string): TauChoice => ({ ns: FALLBACK_NS, source: 'fallback', refused });
	if (!cal) return fallback('no calibration');
	if (cal.host !== host) return fallback(`host ${cal.host} is not ${host}`);
	if (module && cal.module && cal.module !== module) return fallback('another module');
	const why = cal.tau_ns === null ? (cal.refused ?? 'refused') : refusal(cal.crossings, cal.spread, cal.tau_ns);
	if (why) return fallback(why);
	return { ns: cal.tau_ns!, source: 'calibrated' };
}

/** the executed function with no callee in the graph and an all-i32 signature that ran the most instructions */
export function hottestLeaf(g: Graph): string | undefined {
	const callers = new Set(g.edges.filter((e) => e.from !== e.to).map((e) => e.from));
	let best: { name: string; count: number } | undefined;
	g.nodes.forEach((n) => {
		if (n.wide || callers.has(n.name) || n.count <= 0) return;
		if (!best || n.count > best.count) best = { name: n.name, count: n.count };
	});
	return best?.name;
}

interface LadderRun {
	n: number;
	rows: { ms: number; crossings: number }[];
}

/**
 * One rung's residual per crossing (ns) from a ladder run of [interpreted, the rung, native]: the
 * rung's time less its instructions priced at the run's own ends, over the crossings it counted.
 */
export function residualPerCrossing(run: LadderRun, total: number, share: number): { ns: number; crossings: number } {
	const sI = run.rows[0]!.ms / run.n / 1e3 / total;
	const sN = run.rows.at(-1)!.ms / run.n / 1e3 / total;
	const nat = share * total;
	const row = run.rows[1]!;
	const resid = row.ms / run.n - (nat * sN + (total - nat) * sI) * 1e3;
	const crossings = row.crossings / run.n;
	return { ns: (resid * 1e6) / crossings, crossings };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** tau as the median of the repeats' residuals, with the repeats' spread, or the reason it is refused */
export function fitCalibration(runs: LadderRun[], total: number, share: number): Pick<Calibration, 'tau_ns' | 'crossings' | 'spread' | 'refused'> {
	const fits = runs.map((r) => residualPerCrossing(r, total, share));
	const taus = fits.map((f) => f.ns);
	const tau = median(taus);
	const crossings = median(fits.map((f) => f.crossings));
	const spread = (Math.max(...taus) - Math.min(...taus)) / tau;
	const refused = refusal(crossings, spread, tau);
	return { tau_ns: refused ? null : tau, crossings, spread, ...(refused ? { refused } : {}) };
}
