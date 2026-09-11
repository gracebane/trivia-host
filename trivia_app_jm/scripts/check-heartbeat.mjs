// M11 hardening, against a running Worker: a phone that stops pinging stops
// counting as connected, and the sweep closes its socket; one that keeps
// pinging stays. Takes about 80 s (45 s stale window + up to 30 s sweep).
//
//   node scripts/check-heartbeat.mjs http://127.0.0.1:8787 imwithstupid
const base = process.argv[2] || "http://127.0.0.1:8787";
const key = process.argv[3] || "imwithstupid";
const wsBase = base.replace(/^http/, "ws");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra = "") => {
	console.log(`${cond ? "  pass" : "  FAIL"}  ${label}${!cond && extra ? `\n         ${extra}` : ""}`);
	if (!cond) failures++;
};

function open(role, device, k, { beat }) {
	const q = new URLSearchParams({ role, device });
	if (k) q.set("key", k);
	const ws = new WebSocket(`${wsBase}/ws?${q}`);
	const c = { ws, last: null, closedAs: null };
	ws.onmessage = (e) => {
		if (e.data === "pong") return;
		const m = JSON.parse(e.data);
		if (m.t === "snapshot") c.last = m;
	};
	ws.onclose = (e) => (c.closedAs = e.code);
	c.ready = new Promise((res) => (ws.onopen = () => (ws.send(JSON.stringify({ t: "hello" })), res())));
	if (beat) setInterval(() => ws.readyState === 1 && ws.send("ping"), 15000);
	return c;
}

const host = open("host", "hb-host", key, { beat: true });
await host.ready;
await sleep(300);
host.ws.send(JSON.stringify({ t: "room.open" }));
const talker = open("player", "hb-talker", null, { beat: true });
const silent = open("player", "hb-silent", null, { beat: false });
await Promise.all([talker.ready, silent.ready]);
talker.ws.send(JSON.stringify({ t: "join", displayName: "HB Talker" }));
silent.ws.send(JSON.stringify({ t: "join", displayName: "HB Silent" }));
await sleep(800);
const row = (name) => host.last?.players.find((p) => p.displayName === name);
ok(row("HB Talker")?.connected && row("HB Silent")?.connected, "both phones start connected");

console.log("  … waiting 80 s with one phone silent");
await sleep(80_000);
ok(silent.closedAs !== null, "the silent phone's socket was closed by the sweep", `close code ${silent.closedAs}`);
ok(row("HB Silent") && row("HB Silent").connected === false, "the host sees the silent phone as disconnected");
ok(row("HB Talker")?.connected === true && talker.closedAs === null, "the phone that kept pinging is still connected");

console.log(failures ? `\n${failures} FAILED` : "\nall passed");
process.exit(failures ? 1 : 0);
