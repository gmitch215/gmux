export interface Snap {
	/** performance.now() in ms */
	t: number;
	/** the package counter in microjoules */
	uj: number;
	/** busy jiffies of every cpu */
	busy: number;
	/** jiffies of this rig's own processes */
	own: number;
}

/** microjoules from a to b, across at most one wraparound of a counter that wraps at `wrap` */
export const delta = (a: number, b: number, wrap: number) => (b >= a ? b - a : b + wrap - a);

/** a window's seconds, joules and the busy cores that are not the rig's own */
export function span(a: Snap, b: Snap, wrap: number, tick: number) {
	const s = (b.t - a.t) / 1000;
	return {
		s,
		j: delta(a.uj, b.uj, wrap) / 1e6,
		other: Math.max(0, (b.busy - a.busy - (b.own - a.own)) / tick / s)
	};
}

/** a window's joules above what the idle package would have drawn over it */
export const net = (grossJ: number, seconds: number, idleW: number) => grossJ - idleW * seconds;
