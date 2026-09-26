import rec from './rec.wasm';
import { depths } from './depth';

export default {
	async fetch(): Promise<Response> {
		return Response.json(await depths(rec));
	}
};
