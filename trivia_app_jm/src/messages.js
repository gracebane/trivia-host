/**
 * Message set — the wire contract for every WebSocket frame.
 *
 * This is build-order step 1 (see CLAUDE.md): the contract the whole app hangs
 * off, defined before any socket or Durable Object code. It is deliberately
 * platform-independent — nothing here imports from `cloudflare:workers` — so it
 * survives a platform change and can be shared verbatim by the browser clients.
 *
 * Conventions
 * -----------
 * - Every frame is JSON: `{ t: <type>, ...fields }`. `t` is the discriminator.
 * - `t` values are namespaced by direction/role so a mistyped frame is obvious:
 *     c2s  = client → server        s2c = server → client
 * - Timestamps are epoch milliseconds (`Date.now()` shape). The server is the
 *   only clock of record; see `serverTime` on SNAPSHOT for drift correction.
 * - The server NEVER sends one blob to all roles. Player frames and host frames
 *   are composed separately so the answer key never reaches a player socket.
 *
 * (JS note: these are plain frozen string maps used as enums. `Object.freeze`
 *  just makes accidental reassignment throw in strict mode — no runtime types in
 *  JS, so the JSDoc @typedefs below are the only "schema" the editor sees.)
 */

/** Frames a client sends to the server. */
export const C2S = Object.freeze({
	// --- both roles ---
	/** First frame after the socket opens, before anything else. Carries the
	 *  browser's deviceId (from localStorage) and which role this socket is.
	 *  Server replies with a SNAPSHOT. */
	HELLO: "c2s.hello",

	// --- player ---
	/** Player picked a name from the roster, or `+ New player`.
	 *  Existing person: `{ personId }`. New person: `{ displayName }`.
	 *  This tap is authoritative — it (re)points device:<deviceId> at the person.
	 *  See spec: the device→person map is a hint, overwritten by whatever is tapped. */
	JOIN: "c2s.join",
	/** Submit an answer to the currently-collecting question.
	 *  `payload` is JSON (not a bare string) so question kinds can vary. */
	ANSWER: "c2s.answer",

	// --- host ---
	/** Begin the game (leave the lobby). */
	START: "c2s.start",
	/** Advance to the next question and open collecting. */
	NEXT: "c2s.next",
	/** Move current question collecting → grading (stop accepting answers).
	 *  Server also enforces this independently at the deadline. */
	CLOSE: "c2s.close",
	/** Publish the reveal for the current question (grading → revealing). */
	REVEAL: "c2s.reveal",
	/** Flip one verdict in the review queue. `{ questionId, personId, matched }`.
	 *  Recomputes the leaderboard fold. */
	SET_VERDICT: "c2s.setVerdict",
});

/** Frames the server sends to a client. */
export const S2C = Object.freeze({
	/** Full state for this socket's role, sent on connect and on any reconnect.
	 *  Reconnect is "push a whole snapshot," never a merge — the client replaces
	 *  its view wholesale. Because scores are a fold over the answer log, the
	 *  snapshot is cheap to recompute and always correct.
	 *  Common fields: `{ serverTime, phase, you, roster }`.
	 *  Host snapshots additionally carry live progress + the review queue. */
	SNAPSHOT: "s2c.snapshot",
	/** Roster changed (someone joined, reconnected, or was renamed).
	 *  `{ roster: Player[] }`. */
	ROSTER: "s2c.roster",
	/** Phase transition, so clients can switch screens.
	 *  `{ phase, questionId }`. phase ∈ collecting | grading | revealing | lobby. */
	PHASE: "s2c.phase",
	/** The current question, role-scoped.
	 *  Player: `{ questionId, kind, prompt, media?, deadline }` — NO answer key.
	 *  Host:   the above PLUS `{ acceptedAnswers, matcherOverride? }`. */
	QUESTION: "s2c.question",
	/** Server accepted a player's submission (or rejected it, e.g. after cutoff).
	 *  Player-facing: `{ questionId, accepted, submittedAt }`. */
	ANSWER_ACK: "s2c.answerAck",
	/** Host-only live progress during collecting.
	 *  `{ questionId, answered: personId[], total }`. */
	PROGRESS: "s2c.progress",
	/** Host-only review queue for the current question: every NON-exact verdict,
	 *  accepted and rejected alike, sorted by distance. Exact matches are omitted.
	 *  `{ questionId, items: ReviewItem[] }`. */
	REVIEW: "s2c.review",
	/** Reveal payload, role-scoped.
	 *  Player: `{ questionId, correct, yourVerdict, leaderboard? }`.
	 *  Host:   full per-person verdicts + answers. */
	RESULTS: "s2c.results",
	/** Leaderboard fold. Host/display always; players only post-MVP.
	 *  `{ standings: { personId, displayName, score }[] }`. */
	LEADERBOARD: "s2c.leaderboard",
	/** Something went wrong with the last frame. `{ code, message }`.
	 *  Non-fatal; the socket stays open. */
	ERROR: "s2c.error",
});

/** Roles a socket can declare in HELLO. Display is post-MVP (see spec). */
export const ROLE = Object.freeze({
	PLAYER: "player",
	HOST: "host",
	DISPLAY: "display",
});

/** Phase machine (spec: collecting → grading → revealing). `lobby` is the
 *  pre-START state before the first question. */
export const PHASE = Object.freeze({
	LOBBY: "lobby",
	COLLECTING: "collecting",
	GRADING: "grading",
	REVEALING: "revealing",
});

/**
 * ---- Shapes referenced above, as JSDoc typedefs ----
 * These are documentation only (JS has no runtime types), but they make the
 * editor autocomplete fields and flag typos.
 *
 * @typedef {Object} Player
 * @property {string} personId
 * @property {string} displayName
 * @property {boolean} connected
 * @property {number|null} joinedAtQuestion  index of the question when they joined
 *
 * @typedef {Object} AnswerLogEntry   // append-only; the leaderboard is a fold over these
 * @property {string} questionId
 * @property {string} personId
 * @property {string} deviceId        // recorded for diagnostics only
 * @property {any}    payload         // JSON, not a bare string
 * @property {number} submittedAt
 * @property {Verdict} verdict
 *
 * @typedef {Object} Verdict
 * @property {boolean} matched
 * @property {number}  distance       // Damerau-Levenshtein distance; 0 = exact
 * @property {string}  method         // e.g. "exact" | "fuzzy" | "override"
 * @property {boolean} overridden     // true once a host flips it
 *
 * @typedef {Object} ReviewItem
 * @property {string} personId
 * @property {string} displayName
 * @property {any}    payload
 * @property {Verdict} verdict
 */
