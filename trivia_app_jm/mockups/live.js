/**
 * The live connection, shared by every page that talks to the room.
 *
 *   const room = TriviaLive.connect({ role, key, onSnapshot, onFrame, onError, onStatus });
 *   room.send({ t: "answer", ... });
 *
 * Everything here is about staying connected on a real phone. Browsers,
 * iPhones especially, suspend a page's socket when the screen locks, and a
 * socket can come back from sleep LOOKING open while actually dead. So:
 *
 *  - heartbeat: "ping" every 15 s; the room answers "pong" without waking.
 *  - on wake (visibilitychange): if the last pong is stale, the old socket is
 *    abandoned outright and a fresh one opened, no waiting for it to time out.
 *  - on any close: reconnect with backoff (0.5 s doubling, capped at 5 s).
 *  - on every open: send hello; the room replies with the whole present.
 *
 * Nothing is merged. Each snapshot replaces the page's state, then it redraws.
 *
 * `deviceId` is minted once per browser and kept in localStorage; it is the
 * hint that lets a returning phone be recognised without a tap. A page can
 * override it with ?device=… (the device wall does, so seven frames in one
 * browser are seven different phones).
 */
window.TriviaLive = (() => {
	function connect({ role, key = "", device = null, onSnapshot, onFrame, onError, onStatus }) {
		let deviceId = device;
		if (!deviceId) {
			try {
				deviceId = localStorage.getItem("deviceId");
				if (!deviceId) {
					deviceId = crypto.randomUUID();
					localStorage.setItem("deviceId", deviceId);
				}
			} catch {
				deviceId = "d-" + Math.random().toString(36).slice(2);
			}
		}

		let ws = null;
		let retries = 0;
		let retryTimer = null;
		let lastPong = Date.now();
		let everOpened = false;
		let status = "connecting";
		const events = [];
		const log = (msg) => {
			const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
			events.unshift(`${t}  ${msg}`);
			events.length = Math.min(events.length, 8);
			onStatus?.(status, events);
		};
		const setStatus = (s) => {
			status = s;
			onStatus?.(status, events);
		};

		function open() {
			clearTimeout(retryTimer);
			const proto = location.protocol === "https:" ? "wss" : "ws";
			const q = new URLSearchParams({ role, device: deviceId });
			if (key) q.set("key", key);
			const sock = new WebSocket(`${proto}://${location.host}/ws?${q}`);
			ws = sock;
			setStatus(everOpened ? "reconnecting" : "connecting");

			sock.onopen = () => {
				if (sock !== ws) return;
				retries = 0;
				lastPong = Date.now();
				everOpened = true;
				setStatus("live");
				log("connected");
				sock.send(JSON.stringify({ t: "hello" }));
			};
			sock.onmessage = (e) => {
				if (sock !== ws) return;
				if (e.data === "pong") return void (lastPong = Date.now());
				let m;
				try {
					m = JSON.parse(e.data);
				} catch {
					return;
				}
				if (m.t === "snapshot") onSnapshot?.(m);
				else if (m.t === "error") onError?.(m);
				else onFrame?.(m);
			};
			sock.onclose = () => {
				if (sock !== ws) return; // an abandoned socket closing late is not news
				setStatus(everOpened ? "reconnecting" : "failed");
				log(everOpened ? "lost connection" : role === "host" ? "refused: check the passphrase" : "couldn't connect");
				retryTimer = setTimeout(open, Math.min(5000, 500 * 2 ** retries++));
			};
		}

		/** Drop the current socket without waiting for it and start a fresh one. */
		function reopen(reason) {
			log(reason);
			const old = ws;
			ws = null;
			if (old) {
				old.onopen = old.onmessage = old.onclose = old.onerror = null;
				try {
					old.close();
				} catch {}
			}
			open();
		}

		setInterval(() => {
			if (ws?.readyState === WebSocket.OPEN) ws.send("ping");
			if (ws?.readyState === WebSocket.OPEN && Date.now() - lastPong > 45000) reopen("no heartbeat for 45 s");
		}, 15000);

		document.addEventListener("visibilitychange", () => {
			if (document.visibilityState !== "visible") return log("screen off / hidden");
			const away = Math.round((Date.now() - lastPong) / 1000);
			if (!ws || ws.readyState !== WebSocket.OPEN || away > 20) reopen(`woke after ~${away}s, reconnecting`);
			else {
				log("woke, still connected");
				ws.send("ping");
			}
		});

		open();
		return {
			send: (frame) => {
				if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
				else log("not connected; that tap was lost");
			},
			deviceId,
			get status() {
				return status;
			},
		};
	}
	return { connect };
})();
