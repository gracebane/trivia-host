/**
 * Message set — the wire contract, version 2. See BLUEPRINT.md §3.
 *
 * Every frame is JSON `{ t, ...fields }`. Names were read off the mockups' own
 * action functions, one frame per thing a page can already do, so the list is
 * complete by construction.
 *
 * The heartbeat is the one non-JSON exchange: the raw strings "ping" / "pong",
 * answered by the runtime without waking the room.
 *
 * The server never sends one blob to every role. Each socket gets a snapshot
 * composed for its role, so the answer key never reaches a player's phone.
 */

export const C2S = Object.freeze({
	// any role
	HELLO: "hello",

	// player
	JOIN: "join", // { personId } | { displayName }
	TEAM_CREATE: "team.create", // { name }
	TEAM_JOIN: "team.join", // { teamId }
	STEP_DOWN: "captain.stepDown",
	VOTE: "captain.vote", // toggles the caller's vote
	ANSWER: "answer", // { questionId, payload: {text} | {items[]} }

	// host
	ROOM_OPEN: "room.open",
	ROOM_CLOSE: "room.close",
	START: "game.start",
	NEXT: "question.next",
	CLOSE: "question.close",
	END: "game.end", // toggles, as the mock's undo does
	RESET: "game.reset", // back to the lobby for another game: log, teams and grants cleared; people kept
	QUESTIONS_LOAD: "questions.load", // { pack }
	QUESTION_UPDATE: "question.update", // { questionId, patch }
	QUESTION_ADD: "question.add",
	AUTHOR_SET: "author.set", // { questionId, personId | "none" }
	VERDICT_SET: "verdict.set", // { rowId, state, matched }
	VERDICT_CONFIRM: "verdict.confirm", // { rowId }
	VERDICT_MARK: "verdict.mark", // { rowId, index }
	SEND_BACK: "verdict.sendBack", // { questionId, unitId }
	SETTINGS_SET: "settings.set", // { patch }
	TEAMS_DEAL: "teams.deal",
	TEAMS_ROTATE: "teams.rotate",
	TEAM_RENAME: "team.rename", // { teamId, name }
	TEAM_SET_CAPTAIN: "team.setCaptain", // { teamId, personId }
	TEAM_MOVE: "team.move", // { personId, teamId | null }
	TEAM_DISBAND: "team.disband", // { teamId }
	TEAM_CLEAR_VOTES: "team.clearVotes", // { teamId }
	PLAYERS_ADD: "players.add", // { personId }
	PEOPLE_TAG: "people.tag", // { personId, tags[] }
	SAY: "say", // { text }; empty clears
});

export const S2C = Object.freeze({
	SNAPSHOT: "snapshot", // the whole role-scoped view; replaces the client's state outright
	SAY: "say", // players: { text, at } — a line to deliver, at that moment
	GRANT: "grant", // one player: { questionId } — your latest guess was sent back, answer again
	ERROR: "error", // { code, message }; the socket stays open
});

export const ROLE = Object.freeze({ PLAYER: "player", HOST: "host", BOARD: "board" });

/** The mockups' phase machine. No grading phase, no timers. */
export const PHASE = Object.freeze({ LOBBY: "lobby", COLLECTING: "collecting", CLOSED: "closed", ENDED: "ended" });
