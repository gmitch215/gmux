import { MachineDO as Site } from '../../../src/site-do';
import type { Policy } from '../../../src/worker/keeper';

export { default } from '../../../src/site';

declare const KEEPER_POLICY: Partial<Policy>;

/** the site's machine with a keeper policy fixed at deploy time (`wrangler deploy --define KEEPER_POLICY:<json>`) */
export class MachineDO extends Site {
	protected override policy(): Partial<Policy> {
		return KEEPER_POLICY;
	}
}
