// Scripted phones against a running Worker, through everything the server
// does: the gate, packs, guesses and send-back, the review queue, lists,
// teams and mutinies, settings, Birthday Mode, Reilly, and drop-and-return.
//
//   node scripts/smoke.mjs http://127.0.0.1:8787 imwithstupid
//   node scripts/smoke.mjs https://trivia.<you>.workers.dev imwithstupid
//
// Every check states the rule it proves. A run starts with game.reset, so it
// leaves the room in a clean lobby, and uses a fresh name tag so it never
// collides with people from an earlier run.
//
// Run it against a QUIET room. Any real phone still connected stays in the
// roster through the reset (that is the rule) and gets dealt onto a team at
// Start, which changes the vote arithmetic the team checks rely on.
const base = process.argv[2] || "http://127.0.0.1:8787";
const key = process.argv[3] || "imwithstupid";
const wsBase = base.replace(/^http/, "ws");
let failures = 0;
const ok = (cond, label, extra = "") => {
	console.log(`${cond ? "  pass" : "  FAIL"}  ${label}${!cond && extra ? `\n         ${extra}` : ""}`);
	if (!cond) failures++;
};
const section = (s) => console.log(`\n${s}`);

function client(role, device, k) {
	const q = new URLSearchParams({ role, device });
	if (k !== undefined) q.set("key", k);
	const ws = new WebSocket(`${wsBase}/ws?${q}`);
	// ping like a real phone, or the room's 45 s heartbeat sweep drops us mid-run
	const beat = setInterval(() => ws.readyState === 1 && ws.send("ping"), 15000);
	ws.addEventListener("close", () => clearInterval(beat));
	const inbox = [];
	const waiters = [];
	let last = null;
	ws.onmessage = (e) => {
		const m = e.data === "pong" ? { t: "pong" } : JSON.parse(e.data);
		if (m.t === "snapshot") last = m;
		inbox.push(m);
		for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.res(m));
	};
	let closedAs = null;
	const opened = new Promise((res, rej) => {
		ws.onopen = () => res(true);
		ws.onerror = () => rej(new Error("socket error"));
		ws.onclose = (e) => {
			closedAs = `${e.code} ${e.reason || ""}`.trim();
			rej(new Error(`closed ${e.code}`));
		};
	});
	const c = {
		opened,
		send: (f) => ws.send(typeof f === "string" ? f : JSON.stringify(f)),
		next: (pred = () => true, ms = 4000) =>
			new Promise((res, rej) => {
				const i = inbox.findIndex(pred);
				if (i >= 0) return res(inbox.splice(i, 1)[0]);
				const w = { pred, res };
				waiters.push(w);
				setTimeout(() => {
					if (!waiters.includes(w)) return;
					waiters.splice(waiters.indexOf(w), 1);
					const seen = inbox.slice(-3).map((m) => (m.t === "error" ? `error:${m.code}` : m.t === "snapshot" ? `snapshot(phase=${m.phase ?? m.game?.phase},team=${m.team ? m.team.name : m.teams?.length})` : m.t));
					rej(new Error(`${role} ${device}: timed out; socket ${closedAs ? "CLOSED " + closedAs : "open"}; last frames: ${seen.join(" | ") || "none"}; last snapshot you=${last?.you?.name ?? "-"}`));
				}, ms);
			}),
		// send a frame, then wait for the snapshot that reflects it, or an error
		// Let anything still in flight from someone else's action land first, so
		// the frame we wait for is the answer to THIS one and not a late echo.
		do: async (frame, pred = () => true) => {
			await new Promise((r) => setTimeout(r, 120));
			inbox.length = 0;
			c.send(frame);
			return c.next((m) => m.t === "error" || (m.t === "snapshot" && pred(m)));
		},
		// For a frame that must be refused: wait for the error itself, ignoring
		// any snapshot that someone else's action pushes in the meantime.
		err: async (frame) => {
			await new Promise((r) => setTimeout(r, 120));
			for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].t === "error") inbox.splice(i, 1); // a stale refusal is never the one we want
			c.send(frame);
			return c.next((m) => m.t === "error");
		},
		get state() {
			return last;
		},
		close: () => ws.close(),
	};
	return c;
}
const snap = (pred = () => true) => (m) => m.t === "snapshot" && pred(m);
const tag = Date.now().toString(36).slice(-4);
const N = (n) => `${n}-${tag}`;

const PACK = {
	title: "smoke",
	questions: [
		{ id: "q1", prompt: "Capital of Australia?", answers: ["Canberra"], points: [8, 4], guesses: 2, threshold: "auto" },
		{ id: "q2", prompt: "Countries and capitals", kind: "list", pointsPer: 2, orderX: true, orderY: false, grid: [[["France"], ["Paris"]], [["Japan"], ["Tokyo"]], [["Peru"], ["Lima"]]], guesses: 1 },
		{ id: "q3", prompt: "Chemical symbol for gold?", answers: ["Au"], points: [5], guesses: 1, threshold: "exact" },
		{ id: "q4", prompt: "Reilly question", author: N("Carol"), answers: [], points: [8], guesses: 1 },
	],
};

console.log(`Smoke test against ${base}  (tag ${tag})`);

// ---- connect --------------------------------------------------------------
section("Connecting");
const bad = client("host", `hb-${tag}`, "nope");
ok(await bad.opened.then(() => false, () => true), "a host socket with the wrong passphrase is refused");
const host = client("host", `h-${tag}`, key);
await host.opened;
host.send({ t: "hello" });
let h = await host.next(snap());
ok(h.role === "host" && Array.isArray(h.questions), "host connects and gets the host snapshot");

h = await host.do({ t: "game.reset" }, (m) => m.game.phase === "lobby");
ok(h.game.phase === "lobby" && h.log.length === 0, "game.reset gives a clean lobby, people kept");
await host.do({ t: "settings.set", patch: { teamMode: "off", birthdayMode: false, autoPassFuzzy: false, showVerdictsLive: false, showPointsOnPhones: false, sharedRank: true } });
h = await host.do({ t: "questions.load", pack: PACK });
ok(h.t === "snapshot" && h.questions.length === 4 && h.log.length === 0, "a pack loads in the lobby");
ok(h.questions[0].points.length === 2 && h.questions[1].kind === "list", "questions come back normalised");

// ---- the gate --------------------------------------------------------------
section("Room gate");
await host.do({ t: "room.close" });
const alice = client("player", `a-${tag}`);
await alice.opened;
alice.send({ t: "hello" });
let a = await alice.next(snap());
ok(a.you === null && a.open === false && !("questions" in a), "a new phone sees a closed room and nothing it shouldn't");
let e = await alice.err({ t: "join", displayName: N("Alice") });
ok(e.t === "error" && e.code === "room_closed", "join is refused while the room is closed", e.message);
await host.do({ t: "room.open" });
a = await alice.do({ t: "join", displayName: N("Alice") }, (m) => !!m.you);
ok(a.you?.name === N("Alice"), "once open, Alice joins");
const bob = client("player", `b-${tag}`);
const carol = client("player", `c-${tag}`);
await Promise.all([bob.opened, carol.opened]);
bob.send({ t: "hello" });
carol.send({ t: "hello" });
await bob.do({ t: "join", displayName: N("Bob") }, (m) => !!m.you);
await carol.do({ t: "join", displayName: N("Carol") }, (m) => !!m.you);
await host.next(snap((m) => m.players.filter((p) => p.displayName.endsWith(tag)).length === 3)).catch(() => {});
const ids = Object.fromEntries(host.state.players.map((p) => [p.displayName, p.personId]));
ok(host.state.players.filter((p) => p.displayName.endsWith(tag)).length === 3, "the host sees all three in the roster");
const mine = (name, qid) => host.state.log.find((r) => r.personId === ids[N(name)] && r.questionId === qid && !r.superseded);
const settle = () => new Promise((r) => setTimeout(r, 250));

// ---- single answer, two guesses, send-back, review queue ---------------------
section("Question 1: single answer, two guesses");
h = await host.do({ t: "game.start" }, (m) => m.game.phase === "collecting");
ok(h.game.cur === 0, "start opens question 1");
a = await alice.next(snap((m) => m.phase === "collecting"));
ok(a.question?.guesses === 2 && a.question.points?.length === 2 && !("prompt" in a.question), "the phone gets the FORMAT only: guesses, points, no text");
await alice.do({ t: "answer", payload: { text: "Sydney" } }, (m) => m.guesses?.length === 1);
ok(alice.state.guesses[0].verdict === null, "a verdict is hidden while the question is open");
await bob.do({ t: "answer", payload: { text: "canbera" } }, (m) => m.guesses?.length === 1);
await carol.do({ t: "answer", payload: { text: "Canberra!" } }, (m) => m.guesses?.length === 1);
await settle();
ok(mine("Carol", "q1").verdict.state === "correct" && mine("Carol", "q1").verdict.confirmed && mine("Carol", "q1").verdict.method === "exact", "an exact answer is correct and confirmed");
ok(mine("Bob", "q1").verdict.state === "correct" && !mine("Bob", "q1").verdict.confirmed && mine("Bob", "q1").verdict.distance === 1, "a fuzzy answer is correct but pending");
ok(mine("Alice", "q1").verdict.state === "incorrect" && !mine("Alice", "q1").verdict.confirmed, "a wrong answer is incorrect and pending");
ok(host.state.pending.q1.length === 2 && host.state.pending.q1[0] === mine("Bob", "q1").id, "the review queue holds the two pending, closest first");

a = await alice.do({ t: "answer", payload: { text: "Canberra" } }, (m) => m.guesses?.length === 2);
ok(a.guesses.length === 2, "a second guess is a second row");
host.send({ t: "verdict.sendBack", questionId: "q1", unitId: ids[N("Bob")] });
const g = await bob.next((m) => m.t === "grant");
ok(g.questionId === "q1", "a send-back reaches Bob's phone as a grant");
await bob.next(snap((m) => m.grant === true));
await bob.do({ t: "answer", payload: { text: "Canberra" } }, (m) => m.grant === false);
await settle();
ok(host.state.log.filter((r) => r.personId === ids[N("Bob")] && r.questionId === "q1").length === 2 && mine("Bob", "q1").guessNo === 1 && mine("Bob", "q1").verdict.confirmed, "the resubmission replaces guess 1 and keeps the old row superseded");
e = await alice.err({ t: "answer", payload: { text: "third" } });
ok(e.t === "error" && e.code === "used", "a third guess is refused: the allowance is two", `got ${e.code}: ${e.message}`);

await host.do({ t: "verdict.set", rowId: mine("Alice", "q1").id, state: "incorrect" });
h = await host.do({ t: "question.close" }, (m) => m.game.phase === "closed");
a = await alice.next(snap((m) => m.phase === "closed"));
ok(a.guesses[0].verdict.state === "incorrect" && a.guesses[1].verdict.state === "correct", "after close the phone sees every verdict");
ok(!("earned" in a), "points stay off phones unless the setting is on");
await host.do({ t: "settings.set", patch: { showPointsOnPhones: true } });
a = await alice.next(snap((m) => "earned" in m));
ok(a.earned === 4 && a.score === 4, "with the setting on, a second-guess win pays the second slot: 4");
let st = host.state.standings.filter((s) => s.displayName.endsWith(tag));
ok(st[0].score === 8 && st.filter((s) => s.score === 8).length === 2 && st[0].rank === 1 && st[2].rank === 3, "standings: two on 8 share rank 1, Alice on 4 is rank 3");

// ---- list question ------------------------------------------------------------
section("Question 2: list, order across, any row order");
await host.do({ t: "question.next" }, (m) => m.game.cur === 1);
a = await alice.next(snap((m) => m.question?.kind === "list"));
ok(a.question.rows === 3 && a.question.cols === 2 && a.question.orderX === true, "the phone gets the grid shape and the order flags");
await alice.do({ t: "answer", payload: { items: ["Japan", "Tokio", "Peru", "Lima", "France", "Cusco"] } }, (m) => m.guesses?.length === 1);
await settle();
let lr = mine("Alice", "q2");
ok(lr.verdict.count === 5 && !lr.verdict.confirmed, "five of six match, one of them fuzzy; partial credit waits for a human", JSON.stringify(lr.verdict));
await host.do({ t: "verdict.mark", rowId: lr.id, index: 5 });
lr = mine("Alice", "q2");
ok(lr.verdict.count === 6 && lr.verdict.overridden, "the host clicks the missed element: six of six, marked as an override");
await host.do({ t: "verdict.confirm", rowId: lr.id });
await host.do({ t: "question.close" }, (m) => m.game.phase === "closed");
a = await alice.next(snap((m) => m.phase === "closed" && m.earned === 12));
ok(a.earned === 12, "six elements at 2 each: 12");

// ---- end and undo, mode lock --------------------------------------------------------
section("End game, undo, locks");
e = await host.err({ t: "settings.set", patch: { teamMode: "pick" } });
ok(e.t === "error" && e.code === "locked", "team mode cannot change once the game has started", `got ${e.code}: ${e.message}`);
await host.do({ t: "game.end" }, (m) => m.game.phase === "ended");
e = await bob.err({ t: "answer", payload: { text: "x" } });
ok(e.t === "error", "no answers while the game is ended");
await host.do({ t: "game.end" }, (m) => m.game.phase !== "ended");
ok(host.state.game.phase === "closed", "undo puts the game back where it was");

// ---- teams: players pick ----------------------------------------------------------------
section("Teams: players pick");
await host.do({ t: "game.reset" }, (m) => m.game.phase === "lobby");
await host.do({ t: "settings.set", patch: { teamMode: "pick", showPointsOnPhones: true } });
a = await alice.do({ t: "team.create", name: "Bazinga" }, (m) => !!m.team);
ok(a.team.name === "Bazinga" && a.isCaptain === true, "Alice names a team and is its captain");
const teamId = a.team.id;
await bob.do({ t: "team.join", teamId }, (m) => !!m.team);
await carol.do({ t: "team.join", teamId }, (m) => m.team?.members.length === 3);
ok(carol.state.team.members.length === 3 && carol.state.isCaptain === false, "Bob and Carol join; Carol is not captain");
e = await carol.err({ t: "team.join", teamId });
ok(e.t === "error" && e.code === "on_team", "you cannot join twice", `got ${e.code}: ${e.message}`);
await host.do({ t: "game.start" }, (m) => m.game.phase === "collecting");
e = await bob.err({ t: "answer", payload: { text: "Canberra" } });
ok(e.t === "error" && e.code === "not_captain", "only the captain answers for the team", e.message);
a = await alice.do({ t: "answer", payload: { text: "Canberra" } }, (m) => m.guesses?.length === 1);
const b = await bob.next(snap((m) => m.guesses?.length === 1));
ok(b.guesses[0].payload.text === "Canberra", "the whole team sees the captain's guess");
await settle();
ok(host.state.log.at(-1).unitId === teamId && host.state.log.at(-1).personId === ids[N("Alice")], "the row is filed under the team, typed by Alice");

await bob.do({ t: "captain.vote" }, (m) => m.team.votes.length === 1);
ok(bob.state.team.captain === N("Alice"), "one vote of two needed: still Alice");
await carol.do({ t: "captain.vote" }, (m) => m.team.mutinies === 1);
const t1 = carol.state.team;
ok(t1.captain !== N("Alice") && [N("Bob"), N("Carol")].includes(t1.captain) && t1.mutiny && t1.crew.length === 2, "the mutiny carries: a voter is captain, the crew is marked");
e = await alice.err({ t: "captain.stepDown" });
ok(e.t === "error" && e.code === "not_captain", "the deposed captain cannot step down for someone else", `got ${e.code}: ${e.message}`);
const newCap = t1.captain === N("Bob") ? bob : carol;
await newCap.do({ t: "captain.stepDown" }, (m) => m.team.mutinies === 0);
ok(newCap.state.team.mutiny === false && newCap.state.team.crew.length === 0, "a step-down is a clean hand-over: no pirates");
await host.do({ t: "question.close" }, (m) => m.game.phase === "closed");
await bob.do({ t: "captain.vote" }, (m) => m.team.votes.length === 1 || m.team.mutinies === 1).catch(() => {});
await host.do({ t: "question.next" }, (m) => m.game.cur === 1);
ok(host.state.teams[0].votes.length === 0 && host.state.teams[0].mutinies === 0, "the next question starts the crew clean");

await host.do({ t: "team.rename", teamId, name: "Renamed" });
ok(host.state.teams[0].name === "Renamed", "the host renames a team");
await host.do({ t: "team.setCaptain", teamId, personId: ids[N("Carol")] });
ok(host.state.teams[0].captain === ids[N("Carol")], "the host picks a captain");
await host.do({ t: "team.create", name: "Empty" });
const t2 = host.state.teams.find((t) => t.name === "Empty");
await host.do({ t: "team.move", personId: ids[N("Bob")], teamId: t2.id });
ok(host.state.teams.find((t) => t.name === "Empty").members.length === 1 && host.state.teams[0].members.length === 2, "the host moves a player across");
await host.do({ t: "team.disband", teamId: t2.id });
ok(!host.state.teams.some((t) => t.name === "Empty") && !host.state.teams[0].members.includes(ids[N("Bob")]), "disband sends its members unassigned");

// ---- teams: random deal + latecomer ---------------------------------------------------------
section("Teams: random deal");
await host.do({ t: "game.reset" }, (m) => m.game.phase === "lobby");
await host.do({ t: "settings.set", patch: { teamMode: "random", teamMax: 2 } });
ok(host.state.teams.length === 0, "changing mode discards the old teams");
e = await alice.err({ t: "team.create", name: "Nope" });
ok(e.t === "error" && e.code === "no_pick", "in random mode phones cannot make teams", `got ${e.code}: ${e.message}`);
await host.do({ t: "teams.deal" }, (m) => m.teams.length > 0);
ok(host.state.teams.length >= 2 && host.state.teams.every((t) => t.captain), "the deal makes teams with captains", host.state.teams.map((t) => t.members.length).join("+"));
const dave = client("player", `d-${tag}`);
await dave.opened;
dave.send({ t: "hello" });
const d = await dave.do({ t: "join", displayName: N("Dave") }, (m) => !!m.you);
ok(!!d.team, "a latecomer in random mode is placed without picking");

// ---- Birthday Mode -----------------------------------------------------------------------------
section("Birthday Mode");
await host.do({ t: "game.reset" }, (m) => m.game.phase === "lobby");
await host.do({ t: "settings.set", patch: { teamMode: "off", birthdayMode: true } });
for (let i = 0; i < 4; i++) {
	await host.do({ t: i ? "question.next" : "game.start" }, (m) => m.game.cur === i);
	if (i < 3) await host.do({ t: "question.close" }, (m) => m.game.phase === "closed");
}
ok(host.state.game.cur === 3, "reached Carol's question");
const c = await carol.next(snap((m) => m.question?.yours === true)).catch(() => carol.state);
ok(c.question?.yours === true && c.question.label === N("Carol"), "Carol's phone says this one is hers, labelled by author");
e = await carol.err({ t: "answer", payload: { text: "x" } });
ok(e.t === "error" && e.code === "author", "the author cannot answer her own question", `got ${e.code}: ${e.message}`);
await alice.do({ t: "answer", payload: { text: "anything" } }, (m) => m.guesses?.length === 1);
await settle();
ok(mine("Alice", "q4").verdict.state === null && !mine("Alice", "q4").verdict.confirmed, "in Birthday Mode nothing autogrades: ungraded, straight to the queue");
await host.do({ t: "verdict.set", rowId: mine("Alice", "q4").id, state: "correct" });
ok(mine("Alice", "q4").verdict.confirmed && !mine("Alice", "q4").verdict.overridden, "the first call on an ungraded row is not an override");

// ---- Reilly and settings ----------------------------------------------------------------------
section("Reilly");
await host.do({ t: "settings.set", patch: { egaFont: "mono", reilly: { wordMs: 220, appearOnly: true, leadIn: 1, hold: 2 } } });
a = await alice.next(snap((m) => m.settings.reilly.wordMs === 220));
ok(a.settings.egaFont === "mono" && a.settings.reilly.appearOnly === true, "type and delivery settings reach the phones");
host.send({ t: "say", text: "Look behind you, a three-headed monkey!" });
const said = await alice.next((m) => m.t === "say");
ok(said.text.includes("monkey") && said.at > 0, "a line arrives on the phone as its own frame, stamped");
a = await alice.next(snap((m) => m.say.text.includes("monkey")));
ok(a.say.text.includes("monkey"), "and rides in the snapshot for anyone who joins later");

// ---- drop and return ------------------------------------------------------------------------------
section("Drop and return");
alice.close();
await host.next(snap((m) => m.players.find((p) => p.personId === ids[N("Alice")])?.connected === false));
ok(true, "the host sees Alice go away");
const alice2 = client("player", `a-${tag}`);
await alice2.opened;
alice2.send({ t: "hello" });
const back = await alice2.next(snap());
ok(back.you?.name === N("Alice") && back.question?.id === "q4" && back.guesses?.length === 1 && back.say.text.includes("monkey"), "Alice's phone comes back as Alice, on the right question, with her guess and Reilly's line");

await host.do({ t: "game.reset" }, (m) => m.game.phase === "lobby");
for (const x of [host, bob, carol, dave, alice2]) x.close();
console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
