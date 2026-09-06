import { MyDurableObject } from "./room.js";

// The Durable Object class must be exported from the Worker entry so the
// runtime can find it (it's registered in wrangler.jsonc under new_sqlite_classes).
export { MyDurableObject };

/**
 * @typedef {Object} Env
 * @property {DurableObjectNamespace} MY_DURABLE_OBJECT
 */

// 4 uppercase letters, excluding I and O (and digits entirely) so a room code
// is never misread aloud or mistyped. See spec MVP.
const ROOM_CODE = /^[A-HJ-NP-Z]{4}$/;

export default {
	/**
	 * The Worker is a thin router. It resolves the room code to a Durable Object
	 * and forwards the WebSocket upgrade to it — the DO owns all state and every
	 * socket for that room. (HTML/QR serving comes later via static assets.)
	 *
	 * @param {Request} request
	 * @param {Env} env
	 */
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/ws") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("expected websocket", { status: 426 });
			}
			const code = (url.searchParams.get("r") || "").toUpperCase();
			if (!ROOM_CODE.test(code)) {
				return new Response("bad room code", { status: 400 });
			}
			// getByName is the current one-step name→stub resolution (verified
			// against live docs). All sockets for `code` land on one instance.
			const stub = env.MY_DURABLE_OBJECT.getByName(code);
			return stub.fetch(request);
		}

		return new Response("trivia: try /ws?r=CODE&role=player&device=...", { status: 404 });
	},
};
