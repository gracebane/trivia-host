import { MyDurableObject } from "./room.js";

// The Durable Object class must be exported from the Worker entry so the
// runtime can find it (registered in wrangler.jsonc under new_sqlite_classes).
export { MyDurableObject };

// One room. There is no room code: the host's Open room switch is the gate.
const ROOM = "room";

export default {
	/**
	 * A thin router. Pages come from static assets (public/); only /ws reaches
	 * this code first, via `run_worker_first` in wrangler.jsonc.
	 *
	 * The host passphrase is checked HERE, before the room ever sees the socket,
	 * so a host socket inside the room is trusted by construction. It is a
	 * Worker secret (`wrangler secret put HOST_PASSPHRASE`), never in the code.
	 */
	async fetch(request, env) {
		const url = new URL(request.url);

		if (url.pathname === "/ws") {
			// Key first, upgrade second: a plain GET with a key is how the host page
			// asks "is this passphrase right?" before opening the socket (403 = no,
			// 426 = yes). A refused WebSocket looks the same as a dead wifi from the
			// browser, so the page has to ask this way to tell them apart.
			if (url.searchParams.get("role") === "host" && url.searchParams.get("key") !== env.HOST_PASSPHRASE) {
				return new Response("wrong passphrase", { status: 403 });
			}
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("expected websocket", { status: 426 });
			}
			return env.MY_DURABLE_OBJECT.getByName(ROOM).fetch(request);
		}

		// Friendly routes onto the mockup pages. The pages themselves live at
		// /mockups/… and reference ../assets/… relatively, which is why they are
		// served from the repo root rather than copied into a build folder.
		const ROUTES = { "/": "/mockups/index.html", "/join": "/mockups/index.html?tv=1", "/play": "/mockups/player.html", "/play/rbd": "/mockups/rbd_player.html", "/host": "/mockups/host.html", "/board": "/mockups/leaderboard.html", "/wall": "/mockups/devices.html" };
		const to = ROUTES[url.pathname.replace(/\/$/, "") || "/"];
		if (to) {
			// the page must see itself at /mockups/… so its relative links resolve
			const dest = new URL(to, url);
			for (const [k, v] of url.searchParams) dest.searchParams.set(k, v);
			return Response.redirect(dest.href, 302);
		}
		if (url.pathname.startsWith("/m0/")) return env.ASSETS.fetch(new Request(new URL("/mockups" + url.pathname + url.search, url), request));
		return env.ASSETS.fetch(request);
	},
};
