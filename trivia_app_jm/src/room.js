import { DurableObject } from "cloudflare:workers";
import { C2S, S2C, ROLE, PHASE } from "./messages.js";
import * as R from "./rules.js";

/**
 * The room — one Durable Object that owns every socket and all the state.
 *
 * It is the mockups' game engine moved behind a socket. Each handler below is
 * the server side of one action a page can already take, and it ends the same
 * way every time: `save()` then `pushAll()`, which recomputes each socket's
 * role-scoped view and sends the whole thing. Clients never merge; a phone
 * waking from sleep says hello and receives the present.
 *
 * State lives in memory as `S` (the shape rules.js documents) and is written
 * through to storage after every change: the small arrays as JSON documents,
 * the guess log as a table because it is the one thing that can outgrow a
 * document. The constructor loads it all back, so hibernation is invisible.
 */
const DOCS = ["settings", "game", "questions", "people", "players", "devices", "teams", "grants", "say", "seq", "activity"];
// Hardening (M11). Phones ping every 15 s and the runtime answers without
// waking the room, stamping the time. A socket with no ping for STALE_MS is a
// phone that died without saying goodbye (battery, a lift, a lock screen iOS
// never woke): it stops counting as connected, and the sweep closes it so the
// phone's own reconnect starts fresh. IDLE_MS without a single action ends
// the night on its own.
const STALE_MS = 45_000;
const SWEEP_MS = 30_000;
const IDLE_MS = 12 * 60 * 60 * 1000;

const CAP = { name: 40, text: 200, items: 32 /* 8 rows × 4 columns, the largest grid a list can have */, item: 80, teamName: 24, say: 120, tags: 10 };
const clean = (s, n) => String(s ?? "").trim().slice(0, n);

export class MyDurableObject extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.S = null;
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(`
				CREATE TABLE IF NOT EXISTS guess (
					id          INTEGER PRIMARY KEY,
					questionId  TEXT NOT NULL,
					personId    TEXT NOT NULL,
					unitId      TEXT NOT NULL,
					guessNo     INTEGER NOT NULL,
					payload     TEXT NOT NULL,
					verdict     TEXT NOT NULL,
					superseded  INTEGER NOT NULL DEFAULT 0,
					submittedAt INTEGER NOT NULL
				);
			`);
			await this._load();
		});
		ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
	}

	// ---- persistence ---------------------------------------------------------

	async _load() {
		const docs = await this.ctx.storage.get(DOCS);
		const seq = docs.get("seq") ?? { row: 0, team: 0 };
		const saved = docs.get("settings") ?? {};
		this.S = {
			settings: { ...R.DEFAULT_SETTINGS, ...saved, reilly: { ...R.DEFAULT_SETTINGS.reilly, ...(saved.reilly ?? {}) } },
			game: docs.get("game") ?? { phase: PHASE.LOBBY, cur: -1, before: null, open: false },
			questions: docs.get("questions") ?? [],
			people: docs.get("people") ?? [],
			players: docs.get("players") ?? [],
			devices: docs.get("devices") ?? {}, // deviceId → personId, the hint
			teams: docs.get("teams") ?? [],
			grants: docs.get("grants") ?? [],
			say: docs.get("say") ?? { text: "", at: 0 },
			lastActivity: docs.get("activity") ?? Date.now(),
			rowSeq: seq.row,
			teamSeq: seq.team,
			log: this.ctx.storage.sql
				.exec(`SELECT * FROM guess ORDER BY id`)
				.toArray()
				.map((r) => ({ ...r, payload: JSON.parse(r.payload), verdict: JSON.parse(r.verdict), superseded: !!r.superseded })),
		};
	}
	/** Write every document back. Cheap at this scale; called once per handled frame. */
	_save() {
		const S = this.S;
		const put = {};
		for (const k of DOCS) put[k] = k === "seq" ? { row: S.rowSeq, team: S.teamSeq } : k === "activity" ? S.lastActivity : S[k];
		this.ctx.storage.put(put);
	}
	_insertRow(r) {
		this.ctx.storage.sql.exec(
			`INSERT INTO guess (id, questionId, personId, unitId, guessNo, payload, verdict, superseded, submittedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			r.id, r.questionId, r.personId, r.unitId, r.guessNo, JSON.stringify(r.payload), JSON.stringify(r.verdict), r.superseded ? 1 : 0, r.submittedAt,
		);
	}
	_updateRow(r) {
		this.ctx.storage.sql.exec(`UPDATE guess SET verdict = ?, superseded = ? WHERE id = ?`, JSON.stringify(r.verdict), r.superseded ? 1 : 0, r.id);
	}
	_clearLog() {
		this.ctx.storage.sql.exec(`DELETE FROM guess`);
		this.S.log = [];
	}

	// ---- connection ------------------------------------------------------------

	async fetch(request) {
		if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
		const url = new URL(request.url);
		// The Worker has already refused a host socket with the wrong passphrase.
		const role = [ROLE.HOST, ROLE.BOARD].includes(url.searchParams.get("role")) ? url.searchParams.get("role") : ROLE.PLAYER;
		const deviceId = clean(url.searchParams.get("device"), 64);
		if (!deviceId) return new Response("missing device", { status: 400 });
		const { 0: client, 1: server } = new WebSocketPair();
		this.ctx.acceptWebSocket(server, [`role:${role}`]);
		server.serializeAttachment({ deviceId, role, personId: this.S.devices[deviceId] ?? null, at: Date.now() });
		await this._schedule();
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws, raw) {
		if (raw === "ping") return;
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return this._error(ws, "bad_json", "That wasn't a readable message.");
		}
		const att = ws.deserializeAttachment();
		att.seen = Date.now(); // any frame is as good as a ping
		ws.serializeAttachment(att);
		if (msg.t === C2S.HELLO) return this._send(ws, this._snapshot(ws));
		const ok = att.role === ROLE.HOST ? this._host(ws, att, msg) : att.role === ROLE.PLAYER ? this._player(ws, att, msg) : this._error(ws, "wrong_role", "The board only watches.");
		if (ok === false) return;
		this.S.lastActivity = Date.now();
		this._save();
		this._pushAll();
		await this._schedule();
	}
	async webSocketClose(ws, code, reason) {
		try {
			ws.close(code, reason);
		} catch {}
		this._pushAll(ws);
	}
	async webSocketError(ws) {
		this._pushAll(ws);
	}

	// ---- player frames ----------------------------------------------------------

	_player(ws, att, msg) {
		const S = this.S;
		const err = (code, message) => (this._error(ws, code, message), false);
		const pid = att.personId;
		const q = this._curQ();

		switch (msg.t) {
			case C2S.JOIN: {
				if (!S.game.open) return err("room_closed", S.game.phase === PHASE.LOBBY ? "The host hasn't opened the room yet." : "The host has closed the room for now.");
				if (S.game.phase === PHASE.ENDED) return err("ended", "The game is over.");
				let person;
				if (msg.personId) {
					person = S.people.find((p) => p.personId === msg.personId);
					if (!person) return err("no_person", "That name isn't in the list any more.");
				} else {
					const name = clean(msg.displayName, CAP.name);
					if (!name) return err("bad_join", "Type your name first.");
					person = S.people.find((p) => p.displayName.toLowerCase() === name.toLowerCase());
					if (!person) S.people.push((person = { personId: crypto.randomUUID(), displayName: name, tags: [], gamesPlayed: 0 }));
				}
				S.devices[att.deviceId] = person.personId; // the tap is authoritative
				ws.serializeAttachment({ ...att, personId: person.personId });
				this._addToLobby(person.personId);
				return true;
			}
			case C2S.TEAM_CREATE: {
				if (!pid) return err("not_joined", "Join first.");
				if (S.settings.teamMode !== "pick") return err("no_pick", "The host is dealing the teams.");
				if (R.teamOf(S, pid)) return err("on_team", "You're already on a team.");
				const name = clean(msg.name, CAP.teamName);
				if (!name) return err("bad_name", "Give the team a name first.");
				const same = S.teams.find((t) => t.name.toLowerCase() === name.toLowerCase());
				if (same) R.joinTeam(S, same.id, pid);
				else R.makeTeam(S, name, pid);
				return true;
			}
			case C2S.TEAM_JOIN: {
				if (!pid) return err("not_joined", "Join first.");
				if (S.settings.teamMode !== "pick") return err("no_pick", "The host is dealing the teams.");
				if (R.teamOf(S, pid)) return err("on_team", "You're already on a team.");
				if (!R.joinTeam(S, String(msg.teamId), pid)) return err("no_team", "That team isn't there any more.");
				return true;
			}
			case C2S.STEP_DOWN: {
				const t = R.teamOf(S, pid);
				if (!t || t.captain !== pid) return err("not_captain", "You're not the captain.");
				if (!R.stepDown(S, t, this._connected())) return err("alone", "You're captain until someone else joins.");
				return true;
			}
			case C2S.VOTE: {
				if (!S.settings.mutiny) return err("no_mutiny", "Mutinies are off tonight.");
				const t = R.teamOf(S, pid);
				if (!t) return err("no_team", "You're not on a team.");
				if (!R.vote(S, t, pid, this._connected())) return err("is_captain", "You can't vote against yourself.");
				return true;
			}
			case C2S.ANSWER: {
				if (!pid) return err("not_joined", "Join first.");
				if (!q) return err("no_question", "No open question");
				if (msg.questionId && msg.questionId !== q.id) return err("stale", "That question has moved on.");
				const uid = R.unitOf(S, pid);
				if (!uid) return err("no_team", "You're on no team.");
				if (R.teamsOn(S) && !R.isCaptain(S, pid)) return err("not_captain", `Only the captain answers for ${R.unitName(S, uid)}.`);
				if (R.isAuthor(S, q, pid)) return err("author", R.teamsOn(S) ? "This one's yours — the team answers without you." : "This one's yours — you sit it out.");
				const payload = this._payload(msg.payload, q);
				if (!payload) return err("empty", "Type an answer first.");
				const mine = R.guessesOf(S, q.id).get(uid) ?? [];
				let guessNo;
				if (S.grants.includes(uid)) {
					const last = mine[mine.length - 1];
					if (last) (last.superseded = true), this._updateRow(last);
					guessNo = last ? last.guessNo : 1;
					S.grants = S.grants.filter((x) => x !== uid);
				} else if (S.game.phase === PHASE.COLLECTING && mine.length < R.allowedGuesses(q, S.settings)) {
					guessNo = mine.length + 1;
				} else {
					const open = S.game.phase === PHASE.COLLECTING;
					return err(open ? "used" : "closed", open ? `All ${R.allowedGuesses(q, S.settings)} guesses used.` : "The question is closed.");
				}
				const row = { id: ++S.rowSeq, questionId: q.id, personId: pid, unitId: uid, guessNo, payload, submittedAt: Date.now(), verdict: R.grade(S, q, payload), superseded: false };
				S.log.push(row);
				this._insertRow(row);
				return true;
			}
			default:
				return err("unknown", `Unknown message: ${msg.t}`);
		}
	}

	_payload(p, q) {
		if (R.isList(q)) {
			const items = (Array.isArray(p?.items) ? p.items : String(p?.text ?? "").split(",")).map((t) => clean(t, CAP.item)).slice(0, CAP.items);
			return items.some(Boolean) ? { items } : null;
		}
		const text = clean(typeof p === "string" ? p : p?.text, CAP.text);
		return text ? { text } : null;
	}

	// ---- host frames ------------------------------------------------------------------

	_host(ws, att, msg) {
		const S = this.S;
		const err = (code, message) => (this._error(ws, code, message), false);
		const conn = this._connected();
		const q = this._curQ();
		const row = (id) => R.rowById(S, Number(id));

		switch (msg.t) {
			case C2S.ROOM_OPEN:
				S.game.open = true;
				return true;
			case C2S.ROOM_CLOSE:
				S.game.open = false;
				return true;

			case C2S.START:
			case C2S.NEXT: {
				if (S.game.phase === PHASE.COLLECTING) return err("open", "Close the question first.");
				if (S.game.phase === PHASE.ENDED) return err("ended", "The game is over.");
				if (S.game.cur + 1 >= S.questions.length) return err("no_more", "No more questions — End game when ready");
				if (R.teamsOn(S) && S.game.phase === PHASE.LOBBY && S.teams.length) {
					R.unassigned(S).forEach((p) => R.placeLate(S, p.personId));
					R.absorbSingletons(S);
				}
				if (R.teamsOn(S) && S.settings.rotateEachRound && S.game.cur >= 0) R.rotateCaptains(S, conn);
				if (R.teamsOn(S)) R.calmSeas(S);
				S.game.cur++;
				S.game.phase = PHASE.COLLECTING;
				S.grants = [];
				if (R.teamsOn(S)) R.standAside(S, S.questions[S.game.cur], conn); // Birthday Mode: the grader's hat moves for this question
				return true;
			}
			case C2S.CLOSE:
				if (S.game.phase !== PHASE.COLLECTING) return err("not_open", "There's no open question.");
				S.game.phase = PHASE.CLOSED;
				S.grants = [];
				return true;
			case C2S.END:
				if (S.game.phase === PHASE.ENDED) S.game.phase = S.game.before ?? PHASE.LOBBY;
				else {
					S.game.before = S.game.phase;
					S.game.phase = PHASE.ENDED;
					S.grants = [];
				}
				return true;

			case C2S.RESET: {
				// Not in the mockups, which end at "End game — room frozen". A party
				// wants a second game without redeploying, and tests need a clean
				// lobby. Everyone stays known; the roster stays; the game is fresh.
				this._clearLog();
				S.game = { phase: PHASE.LOBBY, cur: -1, before: null, open: S.game.open };
				S.teams = [];
				S.grants = [];
				S.say = { text: "", at: 0 };
				// Whoever still has a phone open is in the next game; whoever has
				// gone home is not. Otherwise Start would sweep the departed onto
				// teams as latecomers.
				S.players = S.players.filter((p) => conn(p.personId)).map((p) => ({ ...p, joinedAtQuestion: null }));
				return true;
			}
			case C2S.QUESTIONS_LOAD: {
				if (S.game.phase !== PHASE.LOBBY) return err("not_lobby", "Load packs in the lobby.");
				const pack = msg.pack;
				if (!Array.isArray(pack?.questions)) return err("bad_pack", "That pack has no questions.");
				if (pack.mode === "birthday") S.settings.birthdayMode = true;
				S.questions = pack.questions.slice(0, 200).map((x, i) =>
					R.normalizeQ(
						{
							id: String(x.id ?? `q${i + 1}`),
							author: x.author ?? "",
							authorId: x.authorId ?? null,
							slide: x.slide ?? i * 2 + 2,
							answerSlide: x.answerSlide ?? null,
							prompt: clean(x.prompt, 500),
							category: clean(x.category, 80),
							flags: x.flags ?? [],
							answers: x.answers,
							points: x.points,
							guesses: x.guesses,
							autograde: x.autograde,
							threshold: x.threshold,
							kind: x.kind,
							pointsPer: x.pointsPer,
							orderX: x.orderX,
							orderY: x.orderY,
							grid: x.grid,
							showPoints: x.showPoints,
						},
						S.settings,
					),
				);
				this._clearLog();
				S.game.cur = -1;
				return true;
			}
			case C2S.QUESTION_ADD: {
				const n = S.questions.length + 1;
				S.questions.push(R.normalizeQ({ id: "q" + Date.now(), slide: n * 2, prompt: "New question", answers: ["answer"] }, S.settings));
				return true;
			}
			case C2S.QUESTION_UPDATE: {
				const target = R.questionById(S, String(msg.questionId));
				if (!target) return err("no_question", "That question isn't there.");
				const p = msg.patch ?? {};
				for (const k of ["prompt", "category", "kind", "guesses", "points", "autograde", "threshold", "pointsPer", "orderX", "orderY", "grid", "answers", "slide", "answerSlide", "author", "showPoints"]) if (k in p) target[k] = p[k];
				R.normalizeQ(target, S.settings);
				return true;
			}
			case C2S.AUTHOR_SET: {
				const target = R.questionById(S, String(msg.questionId));
				if (!target) return err("no_question", "That question isn't there.");
				target.authorId = msg.personId ? String(msg.personId) : "none";
				return true;
			}

			case C2S.VERDICT_SET: {
				const r = row(msg.rowId);
				if (!r) return err("no_row", "That guess isn't there.");
				const state = msg.state === "correct" || msg.state === "incorrect" ? msg.state : null;
				if (!state) return err("bad_state", "A verdict is correct or incorrect.");
				const v = r.verdict;
				const matched = state === "correct" ? (msg.matched ?? v.matched ?? R.questionById(S, r.questionId)?.answers[0] ?? null) : null;
				const changed = state !== v.state || (state === "correct" && matched !== v.matched);
				const hadJudgment = v.state !== null;
				v.state = state;
				v.matched = matched;
				v.confirmed = true;
				if (changed && hadJudgment) v.overridden = true;
				this._updateRow(r);
				return true;
			}
			case C2S.VERDICT_CONFIRM: {
				const r = row(msg.rowId);
				if (!r) return err("no_row", "That guess isn't there.");
				const v = r.verdict;
				if (v.state === null) v.state = (v.count ?? 0) > 0 ? "correct" : "incorrect";
				v.confirmed = true;
				this._updateRow(r);
				return true;
			}
			case C2S.VERDICT_MARK: {
				const r = row(msg.rowId);
				if (!r) return err("no_row", "That guess isn't there.");
				const target = R.questionById(S, r.questionId);
				const n = R.itemsOf(r).length;
				const i = Number(msg.index);
				if (!(i >= 0 && i < n)) return err("bad_index", "No such element.");
				const v = r.verdict;
				const marks = (Array.isArray(v.marks) ? v.marks.slice() : []).concat(new Array(n).fill(false)).slice(0, n);
				marks[i] = !marks[i];
				v.marks = marks;
				v.count = R.markCount(target, v);
				v.state = v.count > 0 ? "correct" : "incorrect";
				v.overridden = true;
				this._updateRow(r);
				return true;
			}
			case C2S.SEND_BACK: {
				const qid = String(msg.questionId);
				const uid = String(msg.unitId);
				const r = R.liveRows(S, qid).get(uid);
				if (!r) return err("no_row", "Nothing to send back.");
				if (qid === q?.id && S.game.phase === PHASE.COLLECTING) {
					if (!S.grants.includes(uid)) S.grants.push(uid);
					// the phone that can act on it hears about it right now
					const t = R.teamsOn(S) ? R.teamById(S, uid) : null;
					const targetPid = t ? t.captain : uid;
					for (const s of this.ctx.getWebSockets("role:player")) if (s.deserializeAttachment()?.personId === targetPid) this._send(s, { t: S2C.GRANT, questionId: qid });
				}
				r.verdict.confirmed = false;
				this._updateRow(r);
				return true;
			}

			case C2S.SETTINGS_SET: {
				const p = msg.patch ?? {};
				const s = S.settings;
				const bools = ["rotateEachRound", "mutiny", "autoPassFuzzy", "showVerdictsLive", "showScores", "showPointsOnPhones", "sharedRank", "birthdayMode", "egaStrict", "defaultAutograde", "defaultOrderX", "defaultOrderY"];
				for (const k of bools) if (k in p) s[k] = !!p[k];
				if ("mutiny" in p && !s.mutiny) for (const t of S.teams) t.votes = []; // a vote in progress ends with the option
				if ("teamMode" in p && ["off", "pick", "random"].includes(p.teamMode)) {
					if (S.game.phase !== PHASE.LOBBY && p.teamMode !== s.teamMode) return err("locked", "Team mode is set once the game starts.");
					if (p.teamMode !== s.teamMode) S.teams = []; // changing the mode discards what the old one produced
					s.teamMode = p.teamMode;
				}
				if ("teamMax" in p) s.teamMax = Math.max(2, Math.min(10, Number(p.teamMax) || 4));
				if ("defaultGuesses" in p) {
					s.defaultGuesses = Math.max(1, Math.min(R.MAX_GUESSES, Number(p.defaultGuesses) || 1));
					s.defaultSchedule = R.resize(s.defaultSchedule, s.defaultGuesses);
				}
				if ("defaultSchedule" in p) s.defaultSchedule = R.resize(p.defaultSchedule, R.MAX_GUESSES);
				if ("defaultThreshold" in p) s.defaultThreshold = ["auto", "exact"].includes(p.defaultThreshold) ? p.defaultThreshold : String(Math.max(0, Number(p.defaultThreshold) || 0));
				if ("defaultKind" in p && R.KINDS.includes(p.defaultKind)) s.defaultKind = p.defaultKind;
				if ("defaultPointsPer" in p) s.defaultPointsPer = Math.max(0, Number(p.defaultPointsPer) || 0);
				if ("egaFont" in p) s.egaFont = p.egaFont === "mono" ? "mono" : "scumm";
				if (p.reilly && typeof p.reilly === "object") {
					const r = p.reilly;
					if ("wordMs" in r) s.reilly.wordMs = Math.max(40, Math.min(1000, Number(r.wordMs) || 160));
					if ("appearOnly" in r) s.reilly.appearOnly = !!r.appearOnly;
					if ("leadIn" in r) s.reilly.leadIn = Math.max(0, Math.min(30, Number(r.leadIn) || 0));
					if ("hold" in r) s.reilly.hold = Math.max(0, Math.min(60, Number(r.hold) || 0));
				}
				return true;
			}

			case C2S.TEAMS_DEAL:
				if (S.settings.teamMode !== "random") return err("no_deal", "Random mode only — in pick mode players choose.");
				if (S.game.phase !== PHASE.LOBBY) return err("not_lobby", "Deal in the lobby.");
				R.assignRandom(S);
				return true;
			case C2S.TEAMS_ROTATE:
				R.rotateCaptains(S, conn);
				return true;
			case C2S.TEAM_RENAME: {
				const t = R.teamById(S, String(msg.teamId));
				const name = clean(msg.name, CAP.teamName);
				if (!t) return err("no_team", "That team isn't there.");
				if (name) t.name = name;
				return true;
			}
			case C2S.TEAM_SET_CAPTAIN: {
				const t = R.teamById(S, String(msg.teamId));
				if (!t || !t.members.includes(msg.personId)) return err("no_member", "They're not on that team.");
				t.captain = msg.personId;
				t.votes = [];
				t.mutiny = false;
				t.mutinies = 0;
				t.crew = [];
				return true;
			}
			case C2S.TEAM_MOVE: {
				if (!S.players.some((p) => p.personId === msg.personId)) return err("no_player", "They're not in the game.");
				if (msg.teamId && !R.teamById(S, String(msg.teamId))) return err("no_team", "That team isn't there.");
				R.movePlayer(S, msg.personId, msg.teamId ? String(msg.teamId) : null);
				return true;
			}
			case C2S.TEAM_DISBAND:
				R.removeTeam(S, String(msg.teamId));
				return true;
			case C2S.TEAM_CLEAR_VOTES: {
				const t = R.teamById(S, String(msg.teamId));
				if (t) t.votes = [];
				return true;
			}
			case C2S.TEAM_CREATE: {
				const name = clean(msg.name, CAP.teamName) || `Team ${S.teams.length + 1}`;
				R.makeTeam(S, name);
				return true;
			}

			case C2S.PLAYERS_ADD:
				if (!S.people.some((p) => p.personId === msg.personId)) return err("no_person", "Nobody by that id.");
				this._addToLobby(msg.personId);
				return true;
			case C2S.PEOPLE_TAG: {
				const p = S.people.find((x) => x.personId === msg.personId);
				if (!p) return err("no_person", "Nobody by that id.");
				p.tags = (Array.isArray(msg.tags) ? msg.tags : []).map((t) => clean(t, 24)).filter(Boolean).slice(0, CAP.tags);
				return true;
			}
			case C2S.SAY: {
				S.say = { text: clean(msg.text, CAP.say), at: Date.now() };
				for (const s of this.ctx.getWebSockets("role:player")) this._send(s, { t: S2C.SAY, ...S.say });
				return true;
			}
			default:
				return err("unknown", `Unknown message: ${msg.t}`);
		}
	}

	_addToLobby(pid) {
		const S = this.S;
		if (S.players.some((p) => p.personId === pid)) return;
		S.players.push({ personId: pid, joinedAtQuestion: S.game.cur >= 0 ? S.game.cur : null });
		// a latecomer once the teams exist is placed by the same rule as everyone
		if (R.teamsOn(S) && S.settings.teamMode === "random" && S.teams.length) R.placeLate(S, pid);
	}

	// ---- snapshots ----------------------------------------------------------------------

	_curQ() {
		return this.S.game.cur >= 0 ? this.S.questions[this.S.game.cur] : null;
	}
	/** A socket is live while its heartbeat is fresh: the last ping the runtime answered, or any frame, or the connect itself. */
	_live(s, now = Date.now()) {
		const a = s.deserializeAttachment() ?? {};
		let ping = 0;
		try {
			ping = this.ctx.getWebSocketAutoResponseTimestamp(s)?.getTime() ?? 0;
		} catch {}
		return now - Math.max(ping, a.at ?? 0, a.seen ?? 0) < STALE_MS;
	}
	/** Which people have a live socket right now — derived, never stored. */
	_connected(exclude = null) {
		const live = new Set();
		const now = Date.now();
		for (const s of this.ctx.getWebSockets("role:player")) {
			if (s === exclude || !this._live(s, now)) continue;
			const a = s.deserializeAttachment();
			if (a?.personId) live.add(a.personId);
		}
		return (pid) => live.has(pid);
	}

	/** One alarm does both jobs: the heartbeat sweep while anyone is connected, and the 12-hour idle stop. */
	async _schedule() {
		const S = this.S;
		const now = Date.now();
		const times = [];
		if (this.ctx.getWebSockets().length) times.push(now + SWEEP_MS);
		if (this._active()) times.push((S.lastActivity ?? now) + IDLE_MS);
		if (!times.length) return;
		const at = Math.max(now + 1000, Math.min(...times));
		const cur = await this.ctx.storage.getAlarm();
		if (cur == null || cur > at || cur < now) await this.ctx.storage.setAlarm(at);
	}
	_active() {
		const g = this.S.game;
		return g.open || g.phase === PHASE.COLLECTING || g.phase === PHASE.CLOSED;
	}
	async alarm() {
		const S = this.S;
		const now = Date.now();
		let changed = false;
		// the sweep: a phone that stopped pinging is gone; closing it makes its reconnect start clean
		for (const s of this.ctx.getWebSockets()) {
			if (this._live(s, now)) continue;
			try {
				s.close(1001, "no heartbeat");
			} catch {}
			changed = true;
		}
		// twelve hours with nobody touching anything: close the room, and end a game left running
		if (this._active() && now - (S.lastActivity ?? now) >= IDLE_MS) {
			S.game.open = false;
			if (S.game.phase === PHASE.COLLECTING || S.game.phase === PHASE.CLOSED) {
				S.game.before = S.game.phase;
				S.game.phase = PHASE.ENDED;
				S.grants = [];
			}
			this._save();
			changed = true;
		}
		if (changed) this._pushAll();
		await this._schedule();
	}

	_pushAll(exclude = null) {
		for (const s of this.ctx.getWebSockets()) if (s !== exclude) this._send(s, this._snapshot(s, exclude));
	}

	_snapshot(ws, exclude = null) {
		const S = this.S;
		const att = ws.deserializeAttachment();
		const conn = this._connected(exclude);
		// The board role is also what the door and the TV join screen watch: they
		// need the room's style (to dress like the phones) and whether it is open.
		const board = {
			standings: R.standings(S, conn),
			showScores: S.settings.showScores,
			phase: S.game.phase,
			q: S.game.cur + 1,
			total: S.questions.length,
			open: !!S.game.open,
			settings: { birthdayMode: S.settings.birthdayMode, egaFont: S.settings.egaFont, egaStrict: S.settings.egaStrict },
		};
		if (att.role === ROLE.BOARD) return { t: S2C.SNAPSHOT, role: att.role, serverTime: Date.now(), ...board };
		if (att.role === ROLE.HOST) return this._hostSnapshot(att, conn, board.standings);
		return this._playerSnapshot(att, conn);
	}

	_hostSnapshot(att, conn, standings) {
		const S = this.S;
		return {
			t: S2C.SNAPSHOT,
			role: ROLE.HOST,
			serverTime: Date.now(),
			settings: S.settings,
			game: S.game,
			questions: S.questions,
			people: S.people,
			players: S.players.map((p) => ({ ...p, displayName: R.personName(S, p.personId), connected: conn(p.personId) })),
			teams: S.teams,
			log: S.log,
			grants: S.grants,
			say: S.say,
			standings,
			pending: Object.fromEntries(S.questions.map((q) => [q.id, R.pendingItems(S, q.id).map((r) => r.id)])),
			dealSizes: R.dealSizes(S.players.length, Math.max(2, Math.min(10, S.settings.teamMax || 4))),
		};
	}

	/** The player's `game` object from the mockup, minus everything a phone must not know. */
	_playerSnapshot(att, conn) {
		const S = this.S;
		const pid = att.personId;
		const you = pid ? { personId: pid, name: R.personName(S, pid) } : null;
		const inRoom = !!pid && S.players.some((p) => p.personId === pid);
		const base = {
			t: S2C.SNAPSHOT,
			role: ROLE.PLAYER,
			serverTime: Date.now(),
			open: S.game.open,
			phase: S.game.phase,
			you: inRoom ? you : null,
			hint: you, // whose name to pre-highlight on the door
			roster: S.people.map((p) => ({ personId: p.personId, displayName: p.displayName, live: S.players.some((x) => x.personId === p.personId) })),
			questionIndex: S.game.cur,
			questionCount: S.questions.length,
			settings: { birthdayMode: S.settings.birthdayMode, egaFont: S.settings.egaFont, egaStrict: S.settings.egaStrict, reilly: S.settings.reilly, teamMode: S.settings.teamMode, mutiny: S.settings.mutiny !== false, showPointsOnPhones: S.settings.showPointsOnPhones, showVerdictsLive: S.settings.showVerdictsLive },
			say: S.say,
		};
		if (!inRoom) return base;

		const t = R.teamOf(S, pid);
		const uid = R.unitOf(S, pid);
		const teamView = (x) => ({ id: x.id, name: x.name, members: x.members.map((m) => R.personName(S, m)), memberIds: x.members, captain: R.personName(S, x.captain), captainId: x.captain, votes: x.votes.map((m) => R.personName(S, m)), voteIds: x.votes, mutiny: x.mutiny, mutinies: x.mutinies, crew: (x.crew || []).map((m) => R.personName(S, m)) });
		Object.assign(base, {
			team: t ? teamView(t) : null,
			isCaptain: !!t && t.captain === pid,
			teams: S.teams.map(teamView),
			lobby: S.players.map((p) => R.personName(S, p.personId)),
		});

		const q = this._curQ();
		if (!q || S.game.phase === PHASE.LOBBY) return base;
		const closed = S.game.phase !== PHASE.COLLECTING;
		const showV = closed || S.settings.showVerdictsLive;
		const rows = uid ? (R.guessesOf(S, q.id).get(uid) ?? []) : [];
		const { rows: gr, cols: gc } = R.gridDims(q);
		base.question = {
			id: q.id,
			label: R.qLabel(S, q, S.game.cur),
			kind: q.kind,
			guesses: R.allowedGuesses(q, S.settings),
			points: R.isList(q) ? undefined : R.schedule(q, S.settings),
			pointsPer: R.isList(q) ? q.pointsPer : undefined,
			rows: R.isList(q) ? gr : undefined,
			cols: R.isList(q) ? gc : undefined,
			orderX: R.isList(q) ? !!q.orderX : undefined,
			orderY: R.isList(q) ? !!q.orderY : undefined,
			showPoints: q.showPoints !== false, // per question: whether the phone says what it is worth
			author: S.settings.birthdayMode ? q.author || null : null,
			yours: R.isAuthor(S, q, pid),
			evaluator: (() => {
				const ev = R.evaluatorOf(S, q);
				return ev ? R.personName(S, ev) : null;
			})(), // who wears the star: grading this one, so no hat and no answer
		};
		base.guesses = rows.map((r) => ({
			guessNo: r.guessNo,
			payload: r.payload,
			verdict: showV ? { state: r.verdict.state, confirmed: r.verdict.confirmed, count: r.verdict.count ?? null, marks: r.verdict.marks ?? null } : null,
		}));
		base.grant = !!uid && S.grants.includes(uid);
		if (closed && S.settings.showPointsOnPhones && uid) {
			base.earned = R.earned(S, q, uid);
			base.score = R.scores(S, conn).get(uid) ?? 0;
		}
		return base;
	}

	// ---- helpers ----------------------------------------------------------------------------

	_error(ws, code, message) {
		this._send(ws, { t: S2C.ERROR, code, message });
	}
	_send(ws, obj) {
		try {
			ws.send(JSON.stringify(obj));
		} catch {}
	}
}
