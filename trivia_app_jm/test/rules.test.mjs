import { test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../src/rules.js";

const fresh = (over = {}) => ({
	settings: { ...R.DEFAULT_SETTINGS },
	game: { phase: "lobby", cur: -1, before: null, open: true },
	questions: [],
	people: [],
	players: [],
	devices: {},
	teams: [],
	log: [],
	grants: [],
	rowSeq: 0,
	teamSeq: 0,
	...over,
});
const person = (S, name) => {
	const p = { personId: name.toLowerCase(), displayName: name, tags: [], gamesPlayed: 0 };
	S.people.push(p);
	S.players.push({ personId: p.personId, joinedAtQuestion: null });
	return p.personId;
};
const online = () => true;

test("normalizeQ fills from defaults and keeps explicit false", () => {
	const S = fresh();
	const q = R.normalizeQ({ id: "q1", answers: "Canberra", autograde: false }, S.settings);
	assert.deepEqual([q.kind, q.guesses, q.points, q.autograde, q.threshold, q.answers], ["single", 2, [8, 8], false, "auto", ["Canberra"]]);
	const l = R.normalizeQ({ id: "q2", kind: "list", grid: [[["a"]], [["b"]]] }, S.settings);
	assert.deepEqual([l.pointsPer, l.orderX, R.gridFilled(l)], [2, false, 2]);
});

test("points schedule: a later guess pays its own slot", () => {
	const S = fresh();
	const q = R.normalizeQ({ id: "q", answers: ["x"], guesses: 3, points: [8, 4] }, S.settings);
	assert.deepEqual(R.schedule(q, S.settings), [8, 4, 4]);
	assert.equal(R.pointsFor(q, 2, S.settings), 4);
});

test("the fold: earliest confirmed-correct guess wins a single; pending stays pending", () => {
	const S = fresh();
	const a = person(S, "Alice");
	const q = R.normalizeQ({ id: "q", answers: ["Canberra"], guesses: 2, points: [8, 4] }, S.settings);
	S.questions.push(q);
	S.log.push({ id: 1, questionId: "q", personId: a, unitId: a, guessNo: 1, payload: { text: "Sydney" }, verdict: R.grade(S, q, { text: "Sydney" }), superseded: false });
	assert.equal(R.outcome(S, "q", a).confirmed, false);
	assert.equal(R.pendingItems(S, "q").length, 1);
	S.log.push({ id: 2, questionId: "q", personId: a, unitId: a, guessNo: 2, payload: { text: "Canberra" }, verdict: R.grade(S, q, { text: "Canberra" }), superseded: false });
	const o = R.outcome(S, "q", a);
	assert.deepEqual([o.state, o.confirmed, o.winner.guessNo], ["correct", true, 2]);
	assert.equal(R.earned(S, q, a), 4);
	assert.equal(R.scores(S, online).get(a), 4);
});

test("lists: per-element marks with order flags, best confirmed guess pays", () => {
	const S = fresh();
	const a = person(S, "Alice");
	const q = R.normalizeQ({ id: "q", kind: "list", pointsPer: 2, orderX: true, orderY: false, grid: [[["France"], ["Paris"]], [["Japan"], ["Tokyo"]], [["Peru"], ["Lima"]]] }, S.settings);
	S.questions.push(q);
	// rows in any order, columns in order: 4 of 6 with one wrong capital and a swapped pair
	const v = R.grade(S, q, { items: ["Japan", "Tokio", "Paris", "France", "Peru", "Cusco"] });
	assert.deepEqual(v.marks, [true, true, false, false, true, false]);
	assert.equal(v.count, 3);
	assert.equal(v.confirmed, false); // partial credit waits for a human
	const full = R.grade(S, q, { items: ["Peru", "Lima", "France", "Paris", "Japan", "Tokyo"] });
	assert.deepEqual([full.count, full.confirmed], [6, true]);
	S.log.push({ id: 1, questionId: "q", personId: a, unitId: a, guessNo: 1, payload: { items: [] }, verdict: v, superseded: false });
	S.log.push({ id: 2, questionId: "q", personId: a, unitId: a, guessNo: 2, payload: { items: [] }, verdict: full, superseded: false });
	assert.equal(R.earned(S, q, a), 12);
});

test("standings: shared rank 1,2,2,4 and averaged 1,2.5,2.5,4", () => {
	const S = fresh();
	for (const n of ["A", "B", "C", "D"]) person(S, n);
	const q = R.normalizeQ({ id: "q", answers: ["x"], points: [8] }, S.settings);
	S.questions.push(q);
	const win = (pid, id) => S.log.push({ id, questionId: "q", personId: pid, unitId: pid, guessNo: 1, payload: { text: "x" }, verdict: R.grade(S, q, { text: "x" }), superseded: false });
	win("a", 1);
	win("b", 2);
	win("c", 3);
	S.log[0].verdict = { ...S.log[0].verdict, state: "correct", confirmed: true };
	// b and c tie below a, d has nothing
	S.log[1].verdict.overridden = true;
	const q2 = R.normalizeQ({ id: "q2", answers: ["y"], points: [4] }, S.settings);
	S.questions.push(q2);
	S.log.push({ id: 4, questionId: "q2", personId: "a", unitId: "a", guessNo: 1, payload: { text: "y" }, verdict: R.grade(S, q2, { text: "y" }), superseded: false });
	const ranks = R.standings(S, online).map((r) => `${r.displayName}${r.rank}`);
	assert.deepEqual(ranks, ["A1", "B2", "C2", "D4"]);
	S.settings.sharedRank = false;
	assert.deepEqual(R.standings(S, online).map((r) => r.rank), [1, 2.5, 2.5, 4]);
});

test("teams: units, captain, vote threshold, alternating mutinies, clean hand-over", () => {
	const S = fresh({ settings: { ...R.DEFAULT_SETTINGS, teamMode: "pick" } });
	const [a, b, c, d] = ["Alice", "Bob", "Carol", "Dave"].map((n) => person(S, n));
	const t = R.makeTeam(S, "Bazinga", a);
	for (const p of [b, c, d]) R.joinTeam(S, t.id, p);
	assert.equal(t.captain, a);
	assert.equal(R.unitOf(S, c), t.id);
	assert.equal(R.votesNeeded(t), 3);
	R.vote(S, t, b, online);
	R.vote(S, t, c, online);
	assert.equal(t.captain, a); // 2 of 3
	R.vote(S, t, d, online);
	assert.notEqual(t.captain, a);
	assert.ok([b, c, d].includes(t.captain)); // drawn from the voters
	assert.deepEqual([t.mutiny, t.mutinies, t.votes], [true, 1, []]);
	// a two-person team carries on one vote
	const u = R.makeTeam(S, "Duo", "x");
	R.joinTeam(S, u.id, "y");
	assert.equal(R.votesNeeded(u), 1);
	R.vote(S, u, "y", online);
	assert.deepEqual([u.captain, u.mutinies], ["y", 1]);
	R.vote(S, u, "x", online);
	assert.deepEqual([u.captain, u.mutinies], ["x", 2]); // and back, the other colour
	assert.ok(R.stepDown(S, u, online));
	assert.deepEqual([u.mutinies, u.crew, u.mutiny], [0, [], false]);
});

test("dealing: fill first, remainder small, lone player borrows; latecomers to the smallest", () => {
	assert.deepEqual(R.dealSizes(6, 4), [4, 2]);
	assert.deepEqual(R.dealSizes(9, 4), [3, 4, 2]);
	const S = fresh({ settings: { ...R.DEFAULT_SETTINGS, teamMode: "random", teamMax: 4 } });
	for (let i = 0; i < 7; i++) person(S, "P" + i);
	R.assignRandom(S);
	assert.deepEqual(S.teams.map((t) => t.members.length).sort(), [3, 4]);
	for (let i = 7; i < 12; i++) {
		person(S, "P" + i);
		R.placeLate(S, "p" + i);
	}
	assert.deepEqual(S.teams.map((t) => t.members.length).sort(), [4, 4, 4]);
	// a singleton at start is absorbed
	person(S, "Late");
	R.placeLate(S, "late");
	assert.equal(S.teams.length, 4);
	R.absorbSingletons(S);
	assert.equal(S.teams.length, 3);
	assert.equal(S.teams.reduce((n, t) => n + t.members.length, 0), 13);
});

test("birthday: the author sits out and is not eligible", () => {
	const S = fresh({ settings: { ...R.DEFAULT_SETTINGS, birthdayMode: true } });
	const c = person(S, "Carol");
	person(S, "Dave");
	const q = R.normalizeQ({ id: "q", author: "carol", answers: [] }, S.settings);
	assert.equal(R.isAuthor(S, q, c), true);
	assert.equal(R.eligible(S, q, online).length, 1);
	assert.equal(R.qLabel(S, q, 0), "carol");
	assert.equal(R.grade(S, q, { text: "anything" }).state, null);
});

test("Birthday Mode: the grader's hat moves to a teammate for their question, and comes back", () => {
	const S = fresh();
	S.settings.birthdayMode = true;
	S.settings.teamMode = "pick";
	const alice = person(S, "Alice"), bob = person(S, "Bob"), carol = person(S, "Carol");
	const t = R.makeTeam(S, "Crew");
	R.joinTeam(S, t.id, alice); // first in is captain
	R.joinTeam(S, t.id, bob);
	R.joinTeam(S, t.id, carol);
	S.questions = [R.normalizeQ({ id: "q1", authorId: alice }, S.settings), R.normalizeQ({ id: "q2", authorId: bob }, S.settings), R.normalizeQ({ id: "q3" }, S.settings)];
	assert.equal(t.captain, alice);
	// Alice's question: she grades, so Bob or Carol takes the hat
	S.game.cur = 0;
	S.game.phase = "collecting";
	R.standAside(S, S.questions[0], online);
	assert.notEqual(t.captain, alice);
	assert.equal(t.standIn.back, alice);
	assert.equal(R.evaluatorOf(S, S.questions[0]), alice);
	// a hand-over during her question never lands on her
	for (let i = 0; i < 20; i++) {
		R.stepDown(S, t, online);
		assert.notEqual(t.captain, alice);
	}
	// Bob's question: Alice's hat comes back first; then if Bob holds it, it moves again
	S.game.cur = 1;
	R.standAside(S, S.questions[1], online);
	assert.equal(t.captain, alice);
	assert.equal(t.standIn, null);
	// a question with no author: nothing moves
	S.game.cur = 2;
	R.standAside(S, S.questions[2], online);
	assert.equal(t.captain, alice);
	// the hat is only lent: a hand-over or a mutiny among the stand-ins during
	// her question decides who answers it, and the hat still goes back to her
	S.game.cur = 0;
	R.standAside(S, S.questions[0], online);
	R.stepDown(S, t, online); // the stand-in passes it on
	assert.notEqual(t.captain, alice);
	S.game.cur = 2;
	R.standAside(S, S.questions[2], online);
	assert.equal(t.captain, alice, "back to Alice after a hand-over");
	S.game.cur = 0;
	R.standAside(S, S.questions[0], online);
	const stand = t.captain;
	R.vote(S, t, [bob, carol].find((x) => x !== stand), online);
	R.vote(S, t, alice, online); // 2 of 3: the mutiny carries, never onto the grader
	assert.notEqual(t.captain, alice);
	S.game.cur = 2;
	R.standAside(S, S.questions[2], online);
	assert.equal(t.captain, alice, "back to Alice after a mutiny");
});

test("points shown on phones is per question, on unless switched off", () => {
	const S = fresh();
	assert.equal(R.normalizeQ({ id: "a" }, S.settings).showPoints, true);
	assert.equal(R.normalizeQ({ id: "b", showPoints: false }, S.settings).showPoints, false);
	assert.equal(R.normalizeQ({ id: "c", kind: "list", showPoints: false }, S.settings).showPoints, false);
});
