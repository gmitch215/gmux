/** the guest jobs of the idle-machine measurements, as one shell command each, and how a result is read back */
export const JOBS = ['none', 'silent', 'gzip', 'cpu'] as const;
export type Job = (typeof JOBS)[number];

/** starts the job in the background; the job writes its progress to /tmp/j/n and /tmp/j/done, never to the terminal */
export function start(job: Job, n = job === 'gzip' ? 100_000 : 20_000_000): string {
	switch (job) {
		case 'none':
			return '';
		case 'silent':
			return 'mkdir -p /tmp/j; (n=0; while :; do sleep 60; n=$((n+1)); echo $n > /tmp/j/n; done) &';
		case 'gzip':
			return (
				'mkdir -p /tmp/j; seq 1 20000 > /tmp/j/f; (ref=$(gzip -c /tmp/j/f | md5sum); n=0; bad=0; ' +
				`while [ $n -lt ${n} ]; do s=$(gzip -c /tmp/j/f | md5sum); [ "$s" = "$ref" ] || bad=$((bad+1)); ` +
				'n=$((n+1)); echo $n $bad > /tmp/j/n; sleep 0.01; done; echo FIN > /tmp/j/done) &'
			);
		case 'cpu':
			return (
				`mkdir -p /tmp/j; (n=0; s=0; while [ $n -lt ${n} ]; do n=$((n+1)); s=$((s+n)); ` +
				'[ $((n%1000)) = 0 ] && echo $n $s > /tmp/j/n; done; echo FIN > /tmp/j/done) &'
			);
	}
}

/** prints `R:<n file>:<done file>:<sleep processes + 1>` once the guest runs it */
export const READ = 'echo R:$(cat /tmp/j/n 2>/dev/null):$(cat /tmp/j/done 2>/dev/null):$(ps | grep -c sleep)\n';

/** the three fields of what READ printed, or null */
export function readback(output: string): [string, string, string] | null {
	const m = /R:([^:$\r\n]*):([^:$\r\n]*):(\d+)/.exec(output);
	return m ? [m[1]!, m[2]!, m[3]!] : null;
}

/** whether a job's progress is exactly what it should be: the gzip checksum never differed, the cpu sum is n(n+1)/2 */
export function exact(job: Job, progress: string): string {
	const [n, extra] = progress.trim().split(' ');
	if (!n) return 'no progress file';
	if (job === 'gzip') return extra === '0' ? 'exact (0 checksum mismatches)' : `WRONG (${extra} mismatches)`;
	if (job === 'cpu') return BigInt(extra ?? 0) === (BigInt(n) * (BigInt(n) + 1n)) / 2n ? 'exact (sum)' : 'WRONG sum';
	return 'n only';
}
