// M0 smoke test: scripted phones against a running Worker.
//
//   node scripts/m0-smoke.mjs http://127.0.0.1:8787 imwithstupid
//   node scripts/m0-smoke.mjs https://trivia.<you>.workers.dev imwithstupid
//
// Exercises the whole one-question loop plus the two things M0 exists to prove:
// a wrong passphrase is refused, and a phone that drops and comes back with the
// same device id lands exactly where it was.
const base = process.argv[2] || "http://127.0.0.1:8787";
const key = process.argv[3] || "imwithstupid";
const wsBase = base.replace(/^http/, "ws");
let failures = 0;
const ok = (cond, label) => {
	console.log(`${cond ? "  pass" : "  FAIL"}  ${label}`);
	if (!cond) failures++;
};

function client(role, device, k) {
	const q = new URLSearchParams({ role, device });
	if (k !== undefined) q.set("key", k);
	const ws = new WebSocket(`${wsBase}/ws?${q}`);
	const inbox = [];
	const waiters = [];
	ws.onmessage = (e) => {
		const m = e.data === "pong" ? { t: "pong" } : JSON.parse(e.data);
		inbox.push(m);
		for (const w of [...waiters]) if (w.pred(m)) (waiters.splice(waiters.indexOf(w), 1), w.res(m));
	};
	const opened = new Promise((res, rej) => {
		ws.onopen = () => res(true);
		ws.onerror = () => rej(new Error("socket error"));
		ws.onclose = (e) => rej(new Error(`closed ${e.code}`));
	});
	return {
		ws,
		opened,
		send: (f) => ws.send(typeof f === "string" ? f : JSON.stringify(f)),
		next: (pred = () => true, ms = 4000) =>
			new Promise((res, rej) => {
				const hit = inbox.find(pred);
				if (hit) return (inbox.splice(inbox.indexOf(hit), 1), res(hit));
				const w = { pred, res };
				waiters.push(w);
				setTimeout(() => (waiters.includes(w) && waiters.splice(waiters.indexOf(w), 1), rej(new Error("timeout"))), ms);
			}),
		drain: () => (inbox.length = 0),
		close: () => ws.close(),
	};
}
const snap = (pred = () => true) => (m) => m.t === "snapshot" && pred(m);
const tag = Date.now().toString(36);

console.log(`M0 smoke test against ${base}\n`);

// 1. assets
const page = await fetch(`${base}/m0/play.html`);
ok(page.status === 200 && (await page.text()).includes("M0 player"), "player page is served as a static asset");

// 2. the passphrase gate
const bad = client("host", `h-bad-${tag}`, "nope");
ok(await bad.opened.then(() => false, () => true), "host socket with the wrong passphrase is refused");

// 3. connect everyone
const host = client("host", `h-${tag}`, key);
await host.opened;
host.send({ t: "hello" });
let h = await host.next(snap());
ok(h.role === "host", "host connects and receives a host snapshot");

const alice = client("player", `a-${tag}`);
const bob = client("player", `b-${tag}`);
await Promise.all([alice.opened, bob.opened]);
alice.send({ t: "hello" });
bob.send({ t: "hello" });
const a0 = await alice.next(snap());
ok(a0.role === "player" && a0.you === null, "a new phone is not anyone yet");
ok(!("answers" in a0) && !JSON.stringify(a0).includes("Canberra"), "a player snapshot never carries the answer key");

// 4. join
alice.send({ t: "join", displayName: `Alice-${tag}` });
bob.send({ t: "join", displayName: `Bob-${tag}` });
const a1 = await alice.next(snap((m) => m.you?.displayName === `Alice-${tag}`));
ok(!!a1.you, "Alice joins and is recognised");
await bob.next(snap((m) => m.you?.displayName === `Bob-${tag}`));

// 5. open, answer, see it on the host
host.send({ t: "question.next" });
await alice.next(snap((m) => m.phase === "collecting"));
await bob.next(snap((m) => m.phase === "collecting"));
alice.send({ t: "answer", text: "Canberra" });
bob.send({ t: "answer", text: "Sydney" });
h = await host.next(snap((m) => m.answers?.filter((x) => x.name.endsWith(tag)).length === 2));
ok(true, "the host sees both answers arrive");
const aliceId = h.answers.find((x) => x.name === `Alice-${tag}`).personId;
const bobId = h.answers.find((x) => x.name === `Bob-${tag}`).personId;

// 6. mark them; verdicts stay hidden from players until close
host.send({ t: "verdict.set", personId: aliceId, state: "correct" });
host.send({ t: "verdict.set", personId: bobId, state: "incorrect" });
const a2 = await alice.next(snap((m) => m.mine?.text === "Canberra"));
ok(a2.mine.verdict === null, "a verdict is hidden from the player while the question is open");

// 7. close and reveal
host.send({ t: "question.close" });
const a3 = await alice.next(snap((m) => m.phase === "closed"));
const b3 = await bob.next(snap((m) => m.phase === "closed"));
ok(a3.mine.verdict === "correct" && b3.mine.verdict === "incorrect", "after close each phone sees its own verdict");
bob.send({ t: "answer", text: "Canberra" });
const e = await bob.next((m) => m.t === "error");
ok(e.code === "closed", "an answer after close is refused with a reason");

// 8. heartbeat
alice.send("ping");
ok((await alice.next((m) => m.t === "pong")).t === "pong", "heartbeat ping is answered with pong");

// 9. the reconnect story: Alice's phone drops, comes back on the same device id
alice.close();
h = await host.next(snap((m) => m.roster.find((p) => p.displayName === `Alice-${tag}`)?.connected === false));
ok(true, "the host sees Alice go away");
const alice2 = client("player", `a-${tag}`);
await alice2.opened;
alice2.send({ t: "hello" });
const a4 = await alice2.next(snap());
ok(a4.you?.displayName === `Alice-${tag}`, "Alice's phone comes back as Alice with no tap");
ok(a4.phase === "closed" && a4.mine?.text === "Canberra" && a4.mine?.verdict === "correct", "and lands exactly where it was: her answer and her verdict");
h = await host.next(snap((m) => m.roster.find((p) => p.displayName === `Alice-${tag}`)?.connected === true));
ok(true, "the host sees Alice come back");

for (const c of [host, bob, alice2]) c.close();
console.log(`\n${failures ? `${failures} FAILED` : "all passed"}`);
process.exit(failures ? 1 : 0);
