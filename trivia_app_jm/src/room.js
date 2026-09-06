import { DurableObject } from "cloudflare:workers";
import { C2S, S2C, ROLE, PHASE } from "./messages.js";

/**
 * Room — one Durable Object per 4-letter room code. Owns ALL state for that
 * room and terminates every socket in it. Build-order step 2: socket plumbing
 * (connect, hello, join, disconnect, reconnect-with-snapshot). The phase machine
 * and scoring are steps 3–4; here `phase` just defaults to `lobby`.
 *
 * Hibernation (verified against live Cloudflare docs, 2026-08):
 *  - `ctx.acceptWebSocket(server, tags)` makes a socket hibernatable. Idle
 *    sockets evict from memory and stop accruing GB-s; the DO re-runs its
 *    constructor on the next event, so nothing in-memory is load-bearing —
 *    durable truth lives in SQLite, per-socket truth in the socket attachment.
 *  - Tags (≤10, ≤256 chars) are fixed at accept time. We tag `role:*` and
 *    `device:*` (both known at connect) for fan-out. `personId` is only known
 *    after JOIN, so it rides in the attachment instead.
 *  - `setWebSocketAutoResponse` answers an app-level "ping" with "pong" WITHOUT
 *    waking the DO, so 20 idle phones cost nothing between questions.
 */
// Registered as `MyDurableObject` in wrangler.jsonc (the scaffold's name, kept
// to match what's already deployed — this class IS the per-room object).
export class MyDurableObject extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.ctx = ctx;

		// Schema init must finish before any request touches storage. SQLite is
		// synchronous here but blockConcurrencyWhile guarantees no request is
		// dispatched until this resolves, even across a hibernation wake.
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS person (
					personId    TEXT PRIMARY KEY,
					displayName TEXT NOT NULL,
					gamesPlayed INTEGER NOT NULL DEFAULT 0,
					v           INTEGER NOT NULL DEFAULT 1
				);
				CREATE TABLE IF NOT EXISTS device (
					deviceId TEXT PRIMARY KEY,
					personId TEXT NOT NULL
				);
				CREATE TABLE IF NOT EXISTS player (
					personId         TEXT PRIMARY KEY,
					displayName      TEXT NOT NULL,
					joinedAtQuestion INTEGER
				);
				CREATE TABLE IF NOT EXISTS meta (
					k TEXT PRIMARY KEY,
					val TEXT NOT NULL
				);
			`);
		});

		// Heartbeat that never wakes us. Clients send {"t":"ping"} as a raw
		// string "ping"; the runtime replies "pong". We read the last-seen
		// timestamp lazily via getWebSocketAutoResponseTimestamp for liveness.
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	// --- HTTP entry: the Worker forwards the WebSocket upgrade here ---------

	async fetch(request) {
		if (request.headers.get("Upgrade") !== "websocket") {
			return new Response("expected websocket", { status: 426 });
		}

		const url = new URL(request.url);
		const role = url.searchParams.get("role") === ROLE.HOST ? ROLE.HOST : ROLE.PLAYER;
		const deviceId = url.searchParams.get("device") || "";
		if (!deviceId) return new Response("missing device", { status: 400 });

		const { 0: client, 1: server } = new WebSocketPair();

		// Tags: role for per-role fan-out, device for targeting a browser.
		// personId is not known yet — it goes in the attachment on JOIN.
		this.ctx.acceptWebSocket(server, [`role:${role}`, `device:${deviceId}`]);

		// Seed connection state. Resolve the device→person HINT so a reconnecting
		// player is restored to `you` without a tap (JOIN can still override it).
		const hintedPerson = this._personForDevice(deviceId);
		server.serializeAttachment({ deviceId, role, personId: hintedPerson });

		return new Response(null, { status: 101, webSocket: client });
	}

	// --- WebSocket lifecycle (hibernation handlers) -------------------------

	async webSocketMessage(ws, raw) {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return this._send(ws, { t: S2C.ERROR, code: "bad_json", message: "not JSON" });
		}

		switch (msg.t) {
			case C2S.HELLO:
				return this._onHello(ws);
			case C2S.JOIN:
				return this._onJoin(ws, msg);
			case C2S.ANSWER:
				// Answer log / grading is step 3; ack the plumbing for now.
				return this._send(ws, {
					t: S2C.ANSWER_ACK,
					questionId: msg.questionId ?? null,
					accepted: false,
					submittedAt: null,
				});
			case C2S.START:
			case C2S.NEXT:
			case C2S.CLOSE:
			case C2S.REVEAL:
			case C2S.SET_VERDICT:
				// Host phase controls arrive in step 3.
				return this._send(ws, { t: S2C.ERROR, code: "not_impl", message: `${msg.t} lands in step 3` });
			default:
				return this._send(ws, { t: S2C.ERROR, code: "unknown_type", message: msg.t });
		}
	}

	async webSocketClose(ws, code, reason, wasClean) {
		// Nothing to persist: `connected` is derived from live sockets, not
		// stored. Just tell everyone the roster changed so the flag updates.
		try {
			ws.close(code, reason);
		} catch {
			/* already closing */
		}
		// The closing socket is still returned by getWebSockets() here, so exclude
		// it — otherwise the departing player would still read as `connected`.
		this._broadcastRoster(ws);
	}

	async webSocketError(ws, err) {
		this._broadcastRoster(ws);
	}

	// --- Frame handlers -----------------------------------------------------

	_onHello(ws) {
		// A snapshot fully replaces the client's view — reconnect is "push a
		// snapshot," never a merge (the derived-scores model makes it cheap).
		this._sendSnapshot(ws);
	}

	_onJoin(ws, msg) {
		const att = ws.deserializeAttachment();
		let personId;
		let displayName;

		if (msg.personId) {
			// Tapped an existing name. Verify it exists in this room's roster.
			const row = this._one(`SELECT personId, displayName FROM person WHERE personId = ?`, msg.personId);
			if (!row) return this._send(ws, { t: S2C.ERROR, code: "no_person", message: "unknown personId" });
			personId = row.personId;
			displayName = row.displayName;
		} else if (typeof msg.displayName === "string" && msg.displayName.trim()) {
			// `+ New player`: mint a personId server-side.
			personId = crypto.randomUUID();
			displayName = msg.displayName.trim().slice(0, 40);
			this.ctx.storage.sql.exec(
				`INSERT INTO person (personId, displayName) VALUES (?, ?)`,
				personId,
				displayName,
			);
		} else {
			return this._send(ws, { t: S2C.ERROR, code: "bad_join", message: "need personId or displayName" });
		}

		// The tap is authoritative: (re)point this device at the chosen person.
		// This is the whole borrowed-phone story — just an upsert, no conflict code.
		this.ctx.storage.sql.exec(
			`INSERT INTO device (deviceId, personId) VALUES (?, ?)
			 ON CONFLICT(deviceId) DO UPDATE SET personId = excluded.personId`,
			att.deviceId,
			personId,
		);

		// Ensure a roster entry. joinedAtQuestion is null until the phase machine
		// exists (step 3); mid-game-join stamping happens there.
		this.ctx.storage.sql.exec(
			`INSERT INTO player (personId, displayName, joinedAtQuestion) VALUES (?, ?, NULL)
			 ON CONFLICT(personId) DO UPDATE SET displayName = excluded.displayName`,
			personId,
			displayName,
		);

		// Bind this socket to the person for the rest of its life.
		ws.serializeAttachment({ ...att, personId });

		this._sendSnapshot(ws); // give the joiner their now-resolved view
		this._broadcastRoster(); // and tell everyone the roster changed
	}

	// --- Snapshot / roster --------------------------------------------------

	_sendSnapshot(ws) {
		const att = ws.deserializeAttachment();
		const roster = this._roster();
		const you = att.personId ? (roster.find((p) => p.personId === att.personId) ?? null) : null;

		const snap = {
			t: S2C.SNAPSHOT,
			serverTime: Date.now(), // client uses this to correct for clock drift
			phase: this._phase(),
			you, // resolved from the device→person hint, or set by a JOIN
			roster,
			hintPersonId: att.personId ?? null, // which name the picker pre-highlights
		};

		if (att.role === ROLE.HOST) {
			// Host-only additions (progress/review fill in at step 3).
			snap.progress = null;
			snap.review = null;
		}
		this._send(ws, snap);
	}

	/** Roster with `connected` DERIVED from live sockets, never stored.
	 *  `exclude` drops a socket that is mid-close (still listed by getWebSockets). */
	_roster(exclude = null) {
		const live = new Set();
		for (const s of this.ctx.getWebSockets()) {
			if (s === exclude) continue;
			const a = s.deserializeAttachment();
			if (a?.personId) live.add(a.personId);
		}
		const rows = this._all(`SELECT personId, displayName, joinedAtQuestion FROM player ORDER BY displayName`);
		return rows.map((r) => ({
			personId: r.personId,
			displayName: r.displayName,
			connected: live.has(r.personId),
			joinedAtQuestion: r.joinedAtQuestion,
		}));
	}

	_broadcastRoster(exclude = null) {
		const frame = { t: S2C.ROSTER, roster: this._roster(exclude) };
		for (const s of this.ctx.getWebSockets()) {
			if (s === exclude) continue;
			this._send(s, frame);
		}
	}

	// --- small helpers ------------------------------------------------------

	_personForDevice(deviceId) {
		const row = this._one(`SELECT personId FROM device WHERE deviceId = ?`, deviceId);
		return row ? row.personId : null;
	}

	_phase() {
		const row = this._one(`SELECT val FROM meta WHERE k = 'phase'`);
		return row ? row.val : PHASE.LOBBY;
	}

	_send(ws, obj) {
		try {
			ws.send(JSON.stringify(obj));
		} catch {
			/* socket gone; roster broadcast will reconcile */
		}
	}

	// SQLite cursor → plain rows. `.exec(...).toArray()` returns objects keyed
	// by column name (JS note: this is Cloudflare's SqlStorage API, not node).
	_all(sql, ...bind) {
		return this.ctx.storage.sql.exec(sql, ...bind).toArray();
	}
	_one(sql, ...bind) {
		return this._all(sql, ...bind)[0] ?? null;
	}
}
