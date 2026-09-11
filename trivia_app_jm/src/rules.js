/**
 * The game's rules, ported from mockups/host.html and mockups/player.html.
 *
 * Everything here is a pure function over the room's state object `S`:
 *
 *   S.settings   the session settings (the mock's `settings`)
 *   S.game       { phase, cur, before, open }
 *   S.questions  the pack (the mock's `pack.questions`), each run through normalizeQ
 *   S.people     everyone ever seen: { personId, displayName, tags, gamesPlayed }
 *   S.players    the roster: { personId, joinedAtQuestion }
 *   S.teams      { id, name, members[], captain, votes[], mutiny, mutinies, crew[] }
 *   S.log        guess rows: { id, questionId, personId, unitId, guessNo, payload, submittedAt, verdict, superseded }
 *   S.grants     unitIds allowed to resubmit while the question is open
 *
 * `connected` is passed in where a rule needs it, because it is derived from
 * live sockets and never stored. Function names match the mockups so the two
 * can be read side by side.
 */
import { gradeSingle, elementMatches, normalise } from "./matcher.js";

export const MAX_GUESSES = 6;
export const KINDS = ["single", "list"];

export const DEFAULT_SETTINGS = Object.freeze({
	teamMode: "off",
	teamMax: 4,
	rotateEachRound: false,
	autoPassFuzzy: false,
	showVerdictsLive: false,
	showScores: true,
	showPointsOnPhones: false,
	sharedRank: true,
	birthdayMode: false,
	defaultGuesses: 2,
	defaultSchedule: [8, 8],
	defaultAutograde: true,
	defaultThreshold: "auto",
	defaultKind: "single",
	defaultPointsPer: 2,
	defaultOrderX: false,
	defaultOrderY: false,
	mutiny: true, // crews may vote their captain out (50 % + 1); off = the hat only moves by hand-over or the host
	egaFont: "scumm",
	egaStrict: false, // the strict EGA layer over the birthday skin: black ground, one text size, verbs not buttons
	reilly: { wordMs: 160, appearOnly: false, leadIn: 2, hold: 5 },
});

// ---- questions --------------------------------------------------------------

export function resize(arr, n) {
	const a = Array.isArray(arr) ? arr.map((v) => Math.max(0, Number(v) || 0)) : [Math.max(0, Number(arr) || 0)];
	while (a.length < n) a.push(a[a.length - 1] ?? 0);
	return a.slice(0, n);
}
export const allowedGuesses = (q, settings) => Math.min(MAX_GUESSES, q.guesses ?? settings.defaultGuesses);
export const schedule = (q, settings) => resize(q.points, allowedGuesses(q, settings));
export const pointsFor = (q, guessNo, settings) => schedule(q, settings)[Math.min(guessNo, allowedGuesses(q, settings)) - 1];

/** Fill a question's blanks from the session defaults. Explicit values, including false, win. */
export function normalizeQ(q, settings) {
	q.kind = KINDS.includes(q.kind) ? q.kind : settings.defaultKind;
	q.guesses = Math.min(MAX_GUESSES, Math.max(1, Number(q.guesses ?? settings.defaultGuesses) || 1));
	q.points = resize(q.points ?? settings.defaultSchedule, q.guesses);
	q.autograde = q.autograde ?? settings.defaultAutograde;
	q.threshold = q.threshold ?? settings.defaultThreshold;
	q.answers = Array.isArray(q.answers) ? q.answers.map(String) : q.answers != null ? [String(q.answers)] : [];
	q.author = q.author ?? "";
	q.authorId = q.authorId ?? null;
	q.flags = Array.isArray(q.flags) ? q.flags : [];
	q.showPoints = q.showPoints !== false; // per question: whether the phones say what it is worth
	if (q.kind === "list") {
		q.pointsPer = q.pointsPer ?? settings.defaultPointsPer;
		q.orderX = q.orderX ?? settings.defaultOrderX;
		q.orderY = q.orderY ?? settings.defaultOrderY;
		if (!Array.isArray(q.grid) || !q.grid.length) q.grid = [[[]]];
	}
	return q;
}

export const isList = (q) => q.kind === "list";
export const gridRows = (q) => (Array.isArray(q.grid) && q.grid.length ? q.grid : [[[]]]);
export const gridDims = (q) => ({ rows: gridRows(q).length, cols: gridRows(q)[0].length });
export const gridFilled = (q) => gridRows(q).flat().filter((c) => c.length).length;
export const listMax = (q) => (q.pointsPer ?? 0) * gridFilled(q);

// ---- Birthday Mode ------------------------------------------------------------

const normName = (t) => normalise(t).replace(/\s+/g, "");
export const personName = (S, pid) => S.people.find((p) => p.personId === pid)?.displayName ?? pid;
/** The author sits out their own question. An explicit pairing wins; else the deck's name is matched. */
export function isAuthor(S, q, pid) {
	if (!S.settings.birthdayMode) return false;
	if (q.authorId) return q.authorId !== "none" && q.authorId === pid;
	return !!q.author && normName(personName(S, pid)) === normName(q.author);
}
export const guessedAuthor = (S, q) => S.players.find((p) => q.author && normName(personName(S, p.personId)) === normName(q.author))?.personId ?? null;
/** Who grades a question: the paired author, else the deck's name matched to a player. Birthday Mode only. */
export function evaluatorOf(S, q) {
	if (!S.settings.birthdayMode || !q) return null;
	if (q.authorId) return q.authorId === "none" ? null : q.authorId;
	return guessedAuthor(S, q);
}
/** The evaluator of the question on the table never gets the hat: they are grading it, not answering it. */
export const gradingNow = (S) => (S.game.phase === "collecting" || S.game.phase === "closed" ? evaluatorOf(S, S.questions[S.game.cur]) : null);
export const qLabel = (S, q, i) => (S.settings.birthdayMode && q.author ? q.author : String(i + 1));

// ---- teams -------------------------------------------------------------------

export const teamsOn = (S) => S.settings.teamMode !== "off";
export const teamOf = (S, pid) => S.teams.find((t) => t.members.includes(pid));
export const teamById = (S, id) => S.teams.find((t) => t.id === id);
export const unitOf = (S, pid) => (teamsOn(S) ? (teamOf(S, pid)?.id ?? null) : pid);
export const isCaptain = (S, pid) => teamOf(S, pid)?.captain === pid;
export const unassigned = (S) => S.players.filter((p) => !teamOf(S, p.personId));
const shuffle = (a) => a.map((v) => [Math.random(), v]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
const teamMax = (S) => Math.max(2, Math.min(10, S.settings.teamMax || 4));

/** Who takes part: teams, or players. Every fold walks this. */
export function units(S, connected) {
	if (!teamsOn(S)) return S.players.map((p) => ({ id: p.personId, label: personName(S, p.personId), connected: connected(p.personId) }));
	return S.teams.map((t) => ({ id: t.id, label: t.name, connected: t.members.some(connected), team: t }));
}
export const unitName = (S, id) => (teamsOn(S) ? (teamById(S, id)?.name ?? id) : personName(S, id));
export const eligible = (S, q, connected) => units(S, connected).filter((u) => !isAuthor(S, q, u.id));

export function makeTeam(S, name, pid) {
	const t = { id: "t" + ++S.teamSeq, name, members: [], captain: null, votes: [], mutiny: false, mutinies: 0, crew: [], standIn: null };
	S.teams.push(t);
	if (pid) joinTeam(S, t.id, pid);
	return t;
}
/** First in is captain. */
export function joinTeam(S, teamId, pid) {
	const t = teamById(S, teamId);
	if (!t) return null;
	const old = teamOf(S, pid);
	if (old) old.members = old.members.filter((x) => x !== pid);
	t.members.push(pid);
	if (!t.captain) t.captain = pid;
	return t;
}
/** A new captain at random, excluding the holder, preferring phones that are online. */
export function pickCaptain(t, exclude, connected, from) {
	const ex = [].concat(exclude ?? []); // the holder, and in Birthday Mode whoever is grading
	const src = (from ?? t.members).filter((pid) => !ex.includes(pid));
	const live = src.filter(connected);
	const c = live.length ? live : src;
	return c.length ? c[Math.floor(Math.random() * c.length)] : t.captain;
}
/** 50 % + 1 of the team, capped at the number who can vote: the captain cannot vote against themselves. */
export const votesNeeded = (t) => Math.min(Math.floor(t.members.length / 2) + 1, Math.max(1, t.members.length - 1));
/** A clean hand-over: the hat moves, no pirates. */
export function stepDown(S, t, connected) {
	if (!t || t.members.length < 2) return false;
	const next = pickCaptain(t, [t.captain, gradingNow(S)], connected);
	if (next === t.captain) return false; // nobody else who could take it
	t.captain = next;
	t.votes = [];
	t.mutiny = false;
	t.mutinies = 0;
	t.crew = [];
	return true;
}
/** Toggle a vote; at the threshold the mutiny carries and the count goes up. */
export function vote(S, t, pid, connected) {
	if (!t || pid === t.captain) return false;
	t.votes = t.votes.includes(pid) ? t.votes.filter((x) => x !== pid) : t.votes.concat(pid);
	if (t.votes.length >= votesNeeded(t)) {
		const crew = t.votes.slice();
		t.captain = pickCaptain(t, [t.captain, gradingNow(S)], connected, crew);
		t.votes = [];
		t.mutiny = true;
		t.mutinies = (t.mutinies || 0) + 1;
		t.crew = crew;
	}
	return true;
}
export function smallestTeam(S) {
	if (!S.teams.length) return null;
	const min = Math.min(...S.teams.map((t) => t.members.length));
	const c = S.teams.filter((t) => t.members.length === min);
	return c[Math.floor(Math.random() * c.length)];
}
/** A latecomer: the smallest team, at parity a random one; a new team when every team is full. */
export function placeLate(S, pid) {
	let t = smallestTeam(S);
	if (!t || t.members.length >= teamMax(S)) t = makeTeam(S, `Team ${S.teams.length + 1}`);
	joinTeam(S, t.id, pid);
	return t;
}
/** A team of one is not a team: fold a lone player into the smallest other team. */
export function absorbSingletons(S) {
	for (const t of S.teams.slice()) {
		if (t.members.length !== 1 || S.teams.length < 2) continue;
		const pid = t.members[0];
		S.teams.splice(S.teams.indexOf(t), 1);
		joinTeam(S, smallestTeam(S).id, pid);
	}
}
export function movePlayer(S, pid, teamId) {
	const old = teamOf(S, pid);
	if (old) {
		old.members = old.members.filter((x) => x !== pid);
		old.votes = old.votes.filter((x) => x !== pid);
		old.crew = (old.crew || []).filter((x) => x !== pid);
		if (old.captain === pid) old.captain = old.members[0] ?? null;
		if (!old.members.length) S.teams.splice(S.teams.indexOf(old), 1);
	}
	if (teamId) joinTeam(S, teamId, pid);
}
export function removeTeam(S, teamId) {
	const t = teamById(S, teamId);
	if (!t) return;
	t.members.slice().forEach((pid) => movePlayer(S, pid, null));
	const i = S.teams.indexOf(t);
	if (i >= 0) S.teams.splice(i, 1);
}
export const rotateCaptains = (S, connected) => S.teams.forEach((t) => stepDown(S, t, connected));
/** Fill teams to the max; the remainder is the small team; a remainder of one borrows a player. */
export function dealSizes(n, max) {
	const g = [];
	for (let i = 0; i < n; i += max) g.push(Math.min(max, n - i));
	if (g.length > 1 && g[g.length - 1] === 1) (g[g.length - 1]++, g[0]--);
	return g;
}
export function assignRandom(S) {
	S.teams.length = 0;
	const max = teamMax(S);
	const order = shuffle(S.players);
	const groups = [];
	for (let i = 0; i < order.length; i += max) groups.push(order.slice(i, i + max));
	if (groups.length > 1 && groups[groups.length - 1].length === 1) groups[groups.length - 1].push(groups[0].pop());
	groups.forEach((g, i) => {
		const t = makeTeam(S, `Team ${i + 1}`);
		g.forEach((p) => joinTeam(S, t.id, p.personId));
	});
}
/** Every question starts the crew clean; captains keep the job. */
export function calmSeas(S) {
	for (const t of S.teams) {
		t.votes = [];
		t.crew = [];
		t.mutiny = false;
		t.mutinies = 0;
	}
}
/**
 * Birthday Mode: the author grades their own question, so their team plays it
 * without them. If the author holds the hat it is lent to a teammate for that
 * question only, and it goes back to them at the next question whatever the
 * crew did with it meanwhile (a hand-over or a mutiny among the stand-ins only
 * decides who answers this one). Called once per question, after calmSeas,
 * with the question just put on the table.
 */
export function standAside(S, q, connected) {
	for (const t of S.teams) {
		if (!t.standIn) continue;
		if (t.members.includes(t.standIn.back)) t.captain = t.standIn.back;
		t.standIn = null;
	}
	const ev = evaluatorOf(S, q);
	const t = ev ? teamOf(S, ev) : null;
	if (!t || t.captain !== ev || t.members.length < 2) return;
	const stand = pickCaptain(t, ev, connected);
	if (stand === ev) return;
	t.captain = stand;
	t.standIn = { captain: stand, back: ev };
}

// ---- grading -------------------------------------------------------------------

/** The elements a player submitted, in the order they wrote them. */
export const itemsOf = (r) => (Array.isArray(r.payload?.items) ? r.payload.items.map((t) => String(t ?? "").trim()) : String(r.payload?.text ?? "").split(",").map((t) => t.trim())).filter(Boolean);

/** Which elements of one row landed. `ordered`: column order counts. */
function matchRow(gridRow, vals, ordered, threshold) {
	const out = new Array(vals.length).fill(false);
	if (ordered) {
		for (let j = 0; j < Math.min(vals.length, gridRow.length); j++) if (elementMatches(vals[j], gridRow[j], threshold)) out[j] = true;
		return out;
	}
	const used = new Set();
	vals.forEach((v, j) => {
		const k = gridRow.findIndex((cell, idx) => !used.has(idx) && elementMatches(v, cell, threshold));
		if (k >= 0) {
			used.add(k);
			out[j] = true;
		}
	});
	return out;
}
/** One boolean per submitted element. The two order flags are independent. */
export function listMarks(q, items) {
	const grid = gridRows(q);
	const { rows, cols } = gridDims(q);
	const marks = new Array(items.length).fill(false);
	const acrossOrdered = !!q.orderX && cols > 1;
	const usedRow = new Set();
	for (let start = 0, ci = 0; start < items.length; start += cols, ci++) {
		const vals = items.slice(start, start + cols);
		let gr = -1;
		if (q.orderY && rows > 1) gr = ci < rows ? ci : -1;
		else {
			let bestScore = 0;
			for (let r = 0; r < rows; r++) {
				if (usedRow.has(r)) continue;
				const n = matchRow(grid[r], vals, acrossOrdered, q.threshold).filter(Boolean).length;
				if (n > bestScore) (bestScore = n), (gr = r);
			}
		}
		if (gr < 0 || usedRow.has(gr)) continue;
		usedRow.add(gr);
		matchRow(grid[gr], vals, acrossOrdered, q.threshold).forEach((ok, j) => ok && (marks[start + j] = true));
	}
	return marks;
}
export const markCount = (q, v) => Math.min(gridFilled(q), Array.isArray(v.marks) ? v.marks.filter(Boolean).length : (v.count ?? 0));

/** A fresh verdict for a submission. Lists: a clean sweep auto-confirms; partial credit gets a human look. */
export function grade(S, q, payload) {
	if (isList(q)) {
		const outOf = gridFilled(q);
		if (S.settings.birthdayMode || !outOf) return { state: null, confirmed: false, count: null, outOf, matched: null, distance: null, method: "manual", overridden: false, marks: [] };
		const marks = listMarks(q, itemsOf({ payload }));
		const count = Math.min(outOf, marks.filter(Boolean).length);
		return { state: count > 0 ? "correct" : "incorrect", confirmed: !!q.autograde && count === outOf, marks, count, outOf, matched: null, distance: null, method: q.autograde ? "list" : "manual", overridden: false };
	}
	return gradeSingle(payload?.text ?? "", q, S.settings);
}

// ---- the fold -------------------------------------------------------------------

export function guessesOf(S, qid) {
	const m = new Map();
	for (const r of S.log) {
		if (r.questionId !== qid || r.superseded) continue;
		if (!m.has(r.unitId)) m.set(r.unitId, []);
		m.get(r.unitId).push(r);
	}
	for (const rows of m.values()) rows.sort((a, b) => a.guessNo - b.guessNo);
	return m;
}
export function liveRows(S, qid) {
	const m = new Map();
	for (const [uid, rows] of guessesOf(S, qid)) m.set(uid, rows[rows.length - 1]);
	return m;
}
export const rowById = (S, id) => S.log.find((r) => r.id === id);
export const questionById = (S, id) => S.questions.find((q) => q.id === id);

/** One unit's outcome on one question: earliest confirmed-correct guess for a single, best confirmed guess for a list. */
export function outcome(S, qid, uid) {
	const rows = guessesOf(S, qid).get(uid) ?? [];
	if (!rows.length) return { state: null, confirmed: false, none: true, winner: null };
	const q = questionById(S, qid);
	if (q && isList(q)) {
		const done = rows.filter((r) => r.verdict.confirmed);
		if (!done.length) return { state: null, confirmed: false, winner: null };
		const best = done.reduce((x, y) => ((y.verdict.count ?? 0) > (x.verdict.count ?? 0) ? y : x));
		return { state: (best.verdict.count ?? 0) > 0 ? "correct" : "incorrect", confirmed: true, winner: best, count: best.verdict.count ?? 0 };
	}
	const winner = rows.find((r) => r.verdict.state === "correct" && r.verdict.confirmed);
	if (winner) return { state: "correct", confirmed: true, winner };
	const pending = rows.some((r) => !r.verdict.confirmed);
	const anyCorrect = rows.some((r) => r.verdict.state === "correct");
	const anyIncorrect = rows.some((r) => r.verdict.state === "incorrect");
	return { state: anyCorrect ? "correct" : anyIncorrect ? "incorrect" : null, confirmed: !pending, winner: null };
}
export const pendingItems = (S, qid) => S.log.filter((r) => r.questionId === qid && !r.superseded && !r.verdict.confirmed).sort((a, b) => (a.verdict.distance ?? 99) - (b.verdict.distance ?? 99));
export const pendingTotal = (S) => S.questions.reduce((n, q) => n + pendingItems(S, q.id).length, 0);

/** What one unit earned on one question. */
export function earned(S, q, uid) {
	const o = outcome(S, q.id, uid);
	if (!(o.state === "correct" && o.confirmed && o.winner)) return 0;
	return isList(q) ? (q.pointsPer ?? 0) * (o.winner.verdict.count ?? 0) : pointsFor(q, o.winner.guessNo, S.settings);
}
export function scores(S, connected) {
	const s = new Map(units(S, connected).map((u) => [u.id, 0]));
	for (const q of S.questions) for (const uid of guessesOf(S, q.id).keys()) if (s.has(uid)) s.set(uid, s.get(uid) + earned(S, q, uid));
	return s;
}
/** sharedRank on: 1, 2, 2, 4. Off: 1, 2.5, 2.5, 4. */
export function standings(S, connected) {
	const s = scores(S, connected);
	const rows = units(S, connected)
		.map((u) => ({ id: u.id, personId: u.id, displayName: u.label, connected: u.connected, score: s.get(u.id), members: u.team ? u.team.members.map((p) => personName(S, p)) : undefined, captain: u.team ? personName(S, u.team.captain) : undefined }))
		.sort((a, b) => b.score - a.score || a.displayName.localeCompare(b.displayName));
	let i = 0;
	while (i < rows.length) {
		let j = i;
		while (j + 1 < rows.length && rows[j + 1].score === rows[i].score) j++;
		const rank = S.settings.sharedRank ? i + 1 : (i + 1 + (j + 1)) / 2;
		for (let k = i; k <= j; k++) rows[k].rank = rank;
		i = j + 1;
	}
	return rows;
}
