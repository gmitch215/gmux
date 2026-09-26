/** the deepest recursion that returns, called directly and on a JSPI stack through WebAssembly.promising */
export async function depths(module: WebAssembly.Module): Promise<{ direct: number; jspi: number }> {
	const rec = (new WebAssembly.Instance(module).exports as { rec: (n: number) => number }).rec;
	const search = async (ok: (n: number) => Promise<boolean>) => {
		let lo = 1;
		let hi = 1 << 24;
		while (lo + 1 < hi) {
			const mid = (lo + hi) >>> 1;
			if (await ok(mid)) lo = mid;
			else hi = mid;
		}
		return lo;
	};
	const direct = await search(async (n) => {
		try {
			rec(n);
			return true;
		} catch {
			return false;
		}
	});
	const promised = (WebAssembly as any).promising(rec);
	const jspi = await search(async (n) => {
		try {
			await promised(n);
			return true;
		} catch {
			return false;
		}
	});
	return { direct, jspi };
}
