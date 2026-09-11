import { test } from "node:test";
import assert from "node:assert/strict";
import { normalise, distance, radius, closest, gradeSingle, elementMatches } from "../src/matcher.js";

test("normalise folds accents, case, punctuation, articles and small numbers", () => {
	assert.equal(normalise("  The Beatles! "), "beatles");
	assert.equal(normalise("Pelé"), "pele");
	assert.equal(normalise("Rock & Roll"), "rock and roll");
	assert.equal(normalise("Four"), "4");
	assert.equal(normalise("Twenty-One"), "20 1"); // each word under twenty-one maps on its own
	assert.equal(normalise("An Apple"), "apple");
	assert.equal(normalise("Ant"), "ant"); // an article needs a following space
});

test("distance is Damerau-Levenshtein with adjacent swaps costing one", () => {
	assert.equal(distance("canberra", "canberra"), 0);
	assert.equal(distance("canberra", "canbera"), 1);
	assert.equal(distance("canberra", "cnaberra"), 1); // a swap
	assert.equal(distance("michelangelo", "michaelangelo"), 1);
	assert.equal(distance("", "abc"), 3);
});

test("radius follows the threshold setting", () => {
	assert.equal(radius("exact", "canberra"), 0);
	assert.equal(radius("auto", "canberra"), 2); // floor(8/3)
	assert.equal(radius("auto", "au"), 0);
	assert.equal(radius("3", "x"), 3);
	assert.equal(radius(2, "x"), 2);
});

test("closest picks the nearest accepted answer and reports whether it is within radius", () => {
	const c = closest("Lincon", ["Abraham Lincoln", "Lincoln"], "auto");
	assert.equal(c.matched, "Lincoln");
	assert.equal(c.distance, 1);
	assert.equal(c.within, true);
	assert.equal(closest("Sydney", ["Canberra"], "auto").within, false);
	assert.equal(closest("x", [], "auto"), null);
});

const q = (over = {}) => ({ answers: ["Canberra"], threshold: "auto", autograde: true, ...over });
const S = (over = {}) => ({ autoPassFuzzy: false, birthdayMode: false, ...over });

test("gradeSingle: exact is correct and confirmed", () => {
	const v = gradeSingle("canberra.", q(), S());
	assert.deepEqual([v.state, v.confirmed, v.method, v.distance, v.matched], ["correct", true, "exact", 0, "Canberra"]);
});
test("gradeSingle: within radius is correct, confirmed only with auto-pass", () => {
	assert.equal(gradeSingle("Canbera", q(), S()).confirmed, false);
	assert.equal(gradeSingle("Canbera", q(), S()).state, "correct");
	assert.equal(gradeSingle("Canbera", q(), S({ autoPassFuzzy: true })).confirmed, true);
});
test("gradeSingle: outside the radius is incorrect and pending, matched cleared", () => {
	const v = gradeSingle("Sydney", q(), S());
	assert.deepEqual([v.state, v.confirmed, v.matched], ["incorrect", false, null]);
	assert.equal(v.distance >= 6, true);
});
test("gradeSingle: autograde off or birthday mode leaves it ungraded", () => {
	assert.equal(gradeSingle("Canberra", q({ autograde: false }), S()).confirmed, false);
	assert.equal(gradeSingle("Canberra", q({ autograde: false }), S()).method, "manual");
	assert.equal(gradeSingle("Canberra", q(), S({ birthdayMode: true })).state, null);
	assert.equal(gradeSingle("Canberra", q({ answers: [] }), S()).state, null);
});
test("elementMatches uses the same radius per element", () => {
	assert.equal(elementMatches("Tokio", ["Tokyo"], "auto"), true);
	assert.equal(elementMatches("Kyoto", ["Tokyo"], "auto"), false);
	assert.equal(elementMatches("Tokio", ["Tokyo"], "exact"), false);
});
