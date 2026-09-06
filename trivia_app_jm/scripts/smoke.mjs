// Step-2 smoke test: connect → hello → join → reconnect-with-snapshot.
// Not a permanent test suite — just proves the plumbing end to end.
import WebSocket from "ws";

// Defaults to local dev; override for prod: BASE=wss://trivia.johnhmcdonald.workers.dev/ws
const BASE = process.env.BASE || "ws://127.0.0.1:8787/ws";
// Fresh room per run so persisted local DO storage doesn't leak between runs.
const L = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // excludes I, O
const ROOM = Array.from({ length: 4 }, () => L[Math.floor(Math.random() * L.length)]).join("");
const results = [];
const ok = (name, cond, extra = "") => {
	results.push({ name, pass: !!cond, extra });
	console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
};

function open(role, device) {
	const ws = new WebSocket(`${BASE}?r=${ROOM}&role=${role}&device=${device}`);
	ws.frames = [];
	ws.waiters = [];
	ws.on("message", (d) => {
		const f = JSON.parse(d.toString());
		ws.frames.push(f);
		ws.waiters = ws.waiters.filter((w) => !w(f)); // resolve any satisfied waiter
	});
	return new Promise((res, rej) => {
		ws.on("open", () => res(ws));
		ws.on("error", rej);
	});
}
const send = (ws, obj) => ws.send(JSON.stringify(obj));
const last = (ws, t) => [...ws.frames].reverse().find((f) => f.t === t);

// Wait until a frame matching `pred` arrives (checking already-buffered frames
// first). Replaces fixed sleeps so prod latency can't race the assertions.
function waitFor(ws, pred, label = "frame", timeout = 8000) {
	const hit = ws.frames.find(pred);
	if (hit) return Promise.resolve(hit);
	return new Promise((res, rej) => {
		const timer = setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), timeout);
		ws.waiters.push((f) => {
			if (!pred(f)) return false;
			clearTimeout(timer);
			res(f);
			return true;
		});
	});
}
const nextSnapshot = (ws, after) =>
	waitFor(ws, (f) => f.t === "s2c.snapshot" && f !== after, "snapshot");
const rosterHas = (ws, pred) =>
	waitFor(ws, (f) => f.t === "s2c.roster" && (f.roster || []).some(pred), "roster");

const run = async () => {
	// A host connects and says hello → expects a snapshot with host extras.
	const host = await open("host", "dev-host");
	send(host, { t: "c2s.hello" });
	const hsnap = await waitFor(host, (f) => f.t === "s2c.snapshot", "host snapshot");
	ok("host HELLO → snapshot", !!hsnap);
	ok("snapshot carries serverTime", typeof hsnap.serverTime === "number");
	ok("host snapshot has host extras", "progress" in hsnap);
	ok("lobby phase by default", hsnap.phase === "lobby");

	// A brand-new player joins as "Alice".
	const p1 = await open("player", "phone-1");
	send(p1, { t: "c2s.hello" });
	const psnap = await waitFor(p1, (f) => f.t === "s2c.snapshot", "player snapshot");
	ok("player fresh device → you is null", psnap.you === null);

	send(p1, { t: "c2s.join", displayName: "Alice" });
	const joined = await nextSnapshot(p1, psnap);
	ok("join → you resolved", joined.you && joined.you.displayName === "Alice");
	const alicePid = joined.you.personId;
	const r1 = await rosterHas(host, (p) => p.displayName === "Alice");
	ok("host saw roster update with Alice", !!r1);
	ok("Alice shown connected", r1.roster.find((p) => p.personId === alicePid)?.connected === true);

	// Reconnect: same device, new socket, just HELLO → restored to Alice by hint.
	p1.close();
	const rGone = await rosterHas(host, (p) => p.personId === alicePid && p.connected === false);
	ok("after disconnect Alice not connected", !!rGone);

	const p1b = await open("player", "phone-1");
	send(p1b, { t: "c2s.hello" });
	const resnap = await waitFor(p1b, (f) => f.t === "s2c.snapshot", "reconnect snapshot");
	ok("reconnect HELLO restores you (device hint)", resnap.you && resnap.you.personId === alicePid);
	ok("reconnect marks connected again", resnap.you.connected === true);

	// Borrowed phone: same device taps a DIFFERENT (new) name → repoints, no conflict.
	send(p1b, { t: "c2s.join", displayName: "Bob" });
	const bob = await nextSnapshot(p1b, resnap);
	ok("borrowed phone repoints to Bob", bob.you && bob.you.displayName === "Bob");

	host.close();
	p1b.close();
	const failed = results.filter((r) => !r.pass);
	console.log(`\n${results.length - failed.length}/${results.length} passed`);
	process.exit(failed.length ? 1 : 0);
};

run().catch((e) => {
	console.error("smoke crashed:", e);
	process.exit(2);
});
