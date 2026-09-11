// Birthday Mode with teams, against a running Worker: the grader's hat moves
// to a teammate for their question and comes back; the team still answers;
// the star's name reaches the phones; mutinies can be switched off.
//
//   node scripts/check-birthday-teams.mjs http://127.0.0.1:8787 imwithstupid [--hold]
//
// --hold keeps the phones connected for 90 s after the checks, so a browser can
// open one of them (?device=chk-a / chk-b / chk-c) and look at the crew list.
// Needs a quiet room, like smoke.mjs.
const base = process.argv[2] || "http://127.0.0.1:8787";
const key = process.argv[3] || "imwithstupid";
const hold = process.argv.includes("--hold");
const wsBase = base.replace(/^http/, "ws");
let failures = 0;
const ok = (cond, label, extra = "") => {
	console.log(`${cond ? "  pass" : "  FAIL"}  ${label}${!cond && extra ? `\n         ${extra}` : ""}`);
	if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
	const opened = new Promise((res, rej) => {
		ws.onopen = () => res(true);
		ws.onerror = () => rej(new Error("socket error"));
		ws.onclose = (e) => rej(new Error(`closed ${e.code}`));
	});
	let lastSent = null;
	const c = {
		opened,
		close: () => ws.close(),
		send: (f) => ((lastSent = f.t), ws.send(JSON.stringify(f))),
		next: (pred = () => true, ms = 4000) =>
			new Promise((res, rej) => {
				const i = inbox.findIndex(pred);
				if (i >= 0) return res(inbox.splice(i, 1)[0]);
				const w = { pred, res };
				waiters.push(w);
				setTimeout(() => {
					if (!waiters.includes(w)) return;
					waiters.splice(waiters.indexOf(w), 1);
					rej(new Error(`${role} ${device}: timed out after ${lastSent}; last frames: ${inbox.slice(-3).map((m) => (m.t === "error" ? "error:" + m.code + " " + m.message : m.t)).join(" | ") || "none"}`));
				}, ms);
			}),
		do: async (frame, pred = () => true) => {
			await sleep(120);
			inbox.length = 0;
			c.send(frame);
			return c.next((m) => m.t === "error" || (m.t === "snapshot" && pred(m)));
		},
		err: async (frame) => {
			await sleep(120);
			for (let i = inbox.length - 1; i >= 0; i--) if (inbox[i].t === "error") inbox.splice(i, 1);
			c.send(frame);
			return c.next((m) => m.t === "error");
		},
		get state() {
			return last;
		},
		settle: async () => {
			await sleep(250);
			return last;
		},
	};
	return c;
}

const host = client("host", "chk-host", key);
await host.opened;
host.send({ t: "hello" });
await host.next((m) => m.t === "snapshot");
await host.do({ t: "game.reset" });
await host.do({ t: "settings.set", patch: { teamMode: "pick", birthdayMode: true, mutiny: true, rotateEachRound: false } });
await host.do({ t: "room.open" });

const phones = {};
for (const [d, name] of [["chk-a", "Alice"], ["chk-b", "Bob"], ["chk-c", "Carol"]]) {
	const c = client("player", d, undefined);
	await c.opened;
	c.send({ t: "hello" });
	await c.next((m) => m.t === "snapshot");
	await c.do({ t: "join", displayName: name }, (m) => m.you?.name === name);
	phones[name] = c;
}
await phones.Alice.do({ t: "team.create", name: "Crew" }, (m) => m.team);
const teamId = phones.Alice.state.team.id;
await phones.Bob.do({ t: "team.join", teamId }, (m) => m.team);
await phones.Carol.do({ t: "team.join", teamId }, (m) => m.team);
ok(phones.Alice.state.isCaptain, "first in is captain (Alice)");

const pid = (name) => host.state.people.find((p) => p.displayName === name).personId;
await host.do({ t: "questions.load", pack: { questions: [
	{ id: "q1", prompt: "Alice's", authorId: pid("Alice"), answers: ["x"] },
	{ id: "q2", prompt: "Bob's", authorId: pid("Bob"), answers: ["x"] },
	{ id: "q3", prompt: "nobody's", authorId: "none", answers: ["x"] },
] } });

console.log("\nAlice's question, Alice is captain");
await host.do({ t: "game.start" }, (m) => m.game.phase === "collecting");
await sleep(300);
const a = phones.Alice.state, b = phones.Bob.state, c = phones.Carol.state;
ok(!a.isCaptain, "the grader loses the hat for her own question");
ok(b.isCaptain || c.isCaptain, "a teammate holds it instead");
ok(a.question.evaluator === "Alice" && b.question.evaluator === "Alice", "every phone knows who wears the star");
ok(a.question.yours === true, "her phone still knows the question is hers");
const stand = b.isCaptain ? phones.Bob : phones.Carol;
const other = b.isCaptain ? phones.Carol : phones.Bob;
let r = await phones.Alice.err({ t: "answer", questionId: "q1", payload: { text: "x" } });
ok(r.code === "not_captain" || r.code === "author", "the grader cannot answer her own question (she holds no hat now)", r.message);
r = await stand.do({ t: "answer", questionId: "q1", payload: { text: "x" } }, (m) => m.guesses?.length === 1);
ok(r.t === "snapshot" && r.guesses.length === 1, "the stand-in captain answers for the team");
await stand.do({ t: "captain.stepDown" });
await sleep(300);
ok(other.state.isCaptain && !phones.Alice.state.isCaptain, "a hand-over during her question goes to the other teammate, never to Alice");

if (hold) {
	console.log("holding here for 90 s, Alice's question on the table — open /play?device=chk-a (Alice) or chk-b / chk-c");
	await sleep(90000);
}

console.log("\nmutiny switch");
await host.do({ t: "settings.set", patch: { mutiny: false } });
r = await other.err({ t: "captain.vote" });
ok(r.code === "no_mutiny", "with mutinies off a vote is refused", r.message);
ok((await other.settle()).settings.mutiny === false, "phones learn mutinies are off");
await host.do({ t: "settings.set", patch: { mutiny: true } });

console.log("\nnext question: Bob's");
await host.do({ t: "question.close" });
await host.do({ t: "question.next" }, (m) => m.game.cur === 1);
await sleep(300);
ok(phones.Alice.state.isCaptain, "Alice's hat comes back for the next question, even after the stand-in handed it on");
ok(phones.Alice.state.question.evaluator === "Bob", "Bob wears the star now");
ok(!phones.Bob.state.isCaptain, "Bob (not captain) simply sits it out from the box; Alice answers");
await host.do({ t: "question.close" });
await host.do({ t: "question.next" }, (m) => m.game.cur === 2);
await sleep(300);
ok(phones.Alice.state.question.evaluator === null, "no author, no star");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
