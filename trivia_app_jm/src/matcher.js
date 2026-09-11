/**
 * The answer matcher. Settled; see CLAUDE.md.
 *
 * Autograde by Damerau-Levenshtein distance within a radius. Anything the
 * matcher is not sure of goes to the host's review queue, and the host is
 * always the final word — so this only has to pre-sort, not be right.
 *
 * Pure functions, no imports. `test/matcher.test.mjs` pins them down.
 */

const SMALL = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty".split(" ");
const WORD_NUM = new Map(SMALL.map((w, i) => [w, String(i)]));

/**
 * Normalise both sides before comparing: fold accents, lowercase, `&` to
 * "and", drop punctuation, collapse spaces, drop a leading article, and read
 * number words up to twenty as digits.
 */
export function normalise(s) {
	let t = String(s ?? "")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "") // the combining marks NFKD split off
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
	t = t.replace(/^(the|a|an) /, "");
	return t
		.split(" ")
		.map((w) => WORD_NUM.get(w) ?? w)
		.join(" ");
}

/** Optimal string alignment distance: insert, delete, substitute, or swap two adjacent characters. */
export function distance(a, b) {
	if (a === b) return 0;
	const n = a.length;
	const m = b.length;
	if (!n) return m;
	if (!m) return n;
	const d = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = 0; i <= n; i++) d[i][0] = i;
	for (let j = 0; j <= m; j++) d[0][j] = j;
	for (let i = 1; i <= n; i++) {
		for (let j = 1; j <= m; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
		}
	}
	return d[n][m];
}

/** The radius for one accepted answer under a question's threshold setting. */
export function radius(threshold, matchedNormalised) {
	if (threshold === "exact") return 0;
	if (threshold === "auto" || threshold == null) return Math.floor(matchedNormalised.length / 3);
	return Math.max(0, Number(threshold) || 0);
}

/** The closest accepted answer to a guess: `{ matched, distance, within }`, or null with no answers. */
export function closest(guess, answers, threshold) {
	const g = normalise(guess);
	let best = null;
	for (const a of answers ?? []) {
		const an = normalise(a);
		if (!an) continue;
		const d = distance(g, an);
		if (!best || d < best.distance) best = { matched: a, distance: d, within: d <= radius(threshold, an) };
	}
	return best;
}

/**
 * Grade a single-answer guess into the mock's verdict shape:
 * `{ state, confirmed, matched, distance, method, overridden }`.
 *
 *   distance 0              → correct, confirmed
 *   within the radius       → correct, confirmed only if autoPassFuzzy
 *   outside                 → incorrect, pending
 *   autograde off / no key  → ungraded (state null), pending
 */
export function gradeSingle(text, q, settings) {
	const v = { state: null, confirmed: false, matched: null, distance: null, method: "manual", overridden: false };
	if (settings.birthdayMode || !q.answers?.length) return v;
	const c = closest(text, q.answers, q.threshold);
	if (!c) return v;
	v.matched = c.matched;
	v.distance = c.distance;
	if (c.distance === 0) Object.assign(v, { state: "correct", confirmed: true, method: "exact" });
	else if (c.within) Object.assign(v, { state: "correct", confirmed: !!settings.autoPassFuzzy, method: "fuzzy" });
	else Object.assign(v, { state: "incorrect", confirmed: false, method: "fuzzy" });
	if (!q.autograde) Object.assign(v, { confirmed: false, method: "manual" });
	if (v.state !== "correct") v.matched = null;
	return v;
}

/** Does one submitted element land on one grid cell (a list of accepted variants)? */
export function elementMatches(value, cell, threshold) {
	const c = closest(value, cell, threshold);
	return !!c && c.within;
}
