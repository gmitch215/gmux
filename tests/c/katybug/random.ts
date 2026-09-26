/**
 * CPython's random module, for the corpora: MT19937 seeded as random.seed(int) seeds it, and
 * getrandbits, choice and randrange drawing as CPython draws, so a corpus generated with a seed keeps
 * the cases it was first generated with.
 */
export class Random {
	private readonly mt = new Uint32Array(624);
	private index = 624;

	constructor(seed: number) {
		const key: number[] = [];
		for (let n = BigInt(Math.abs(seed)); n > 0n || !key.length; n >>= 32n)
			key.push(Number(n & 0xffffffffn));
		this.byArray(key);
	}

	private init(s: number) {
		const mt = this.mt;
		mt[0] = s >>> 0;
		for (let i = 1; i < 624; i++) {
			const x = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
			mt[i] = (Math.imul(1812433253, x) + i) >>> 0;
		}
	}

	private byArray(key: number[]) {
		const mt = this.mt;
		this.init(19650218);
		let i = 1;
		let j = 0;
		for (let k = Math.max(624, key.length); k; k--) {
			const x = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
			mt[i] = ((mt[i]! ^ Math.imul(x, 1664525)) + key[j]! + j) >>> 0;
			i++;
			j++;
			if (i >= 624) {
				mt[0] = mt[623]!;
				i = 1;
			}
			if (j >= key.length) j = 0;
		}
		for (let k = 623; k; k--) {
			const x = mt[i - 1]! ^ (mt[i - 1]! >>> 30);
			mt[i] = ((mt[i]! ^ Math.imul(x, 1566083941)) - i) >>> 0;
			i++;
			if (i >= 624) {
				mt[0] = mt[623]!;
				i = 1;
			}
		}
		mt[0] = 0x80000000;
	}

	private next(): number {
		const mt = this.mt;
		if (this.index >= 624) {
			for (let k = 0; k < 624; k++) {
				const y = (mt[k]! & 0x80000000) | (mt[(k + 1) % 624]! & 0x7fffffff);
				mt[k] = mt[(k + 397) % 624]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
			}
			this.index = 0;
		}
		let y = mt[this.index++]!;
		y ^= y >>> 11;
		y ^= (y << 7) & 0x9d2c5680;
		y ^= (y << 15) & 0xefc60000;
		y ^= y >>> 18;
		return y >>> 0;
	}

	/** k random bits; words fill from the least significant up, as CPython's do */
	getrandbits(k: number): bigint {
		if (k <= 32) return BigInt(this.next() >>> (32 - k));
		let value = 0n;
		for (let word = 0; k > 0; word++, k -= 32) {
			let r = this.next();
			if (k < 32) r >>>= 32 - k;
			value |= BigInt(r) << BigInt(32 * word);
		}
		return value;
	}

	randbelow(n: number): number {
		const k = n.toString(2).length;
		let r = this.getrandbits(k);
		while (r >= BigInt(n)) r = this.getrandbits(k);
		return Number(r);
	}

	choice<T>(seq: readonly T[]): T {
		return seq[this.randbelow(seq.length)]!;
	}

	randrange(start: number, stop?: number): number {
		return stop === undefined ? this.randbelow(start) : start + this.randbelow(stop - start);
	}
}
