# Message set — the WebSocket contract, version 2

The machine-readable version is `src/messages.js`. This is the prose. The
full frame table with each frame's mockup origin is in `BLUEPRINT.md` §3;
this file records what is true of every frame.

## Ground rules

- Every frame is JSON with a `t` field: `{ "t": "answer", ... }`.
- **The server is the only authority.** Every rule the mockups run in the
  page runs in the room instead. The pages render what they are sent.
- **Snapshot, never merge.** After every handled frame the room recomputes
  each socket's role-scoped view and sends the whole thing as `snapshot`.
  A client replaces its state with it and redraws. Reconnect is the same
  frame: say `hello`, receive the present.
- **Per-role payloads.** A player snapshot never carries question text, the
  answer key, other players' guesses, or verdicts the settings hide.
- **No timers.** The host closing the question is the only cutoff.
- **The heartbeat is not JSON.** A client sends the raw string `ping` every
  15 s; the runtime answers `pong` without waking the room.

## Events, not state

Three frames exist outside the snapshot because they are moments the phone
must react to, not state it renders:

| Frame | To | Meaning |
|---|---|---|
| `say` | players | `{ text, at }` — a line for Reilly to deliver now |
| `grant` | one player | `{ questionId }` — your latest guess was sent back, answer again |
| `error` | one socket | `{ code, message }` — the frame was refused; the message is the toast wording |

## Auth

Players have no password. The host's `room.open` / `room.close` is the gate,
and a `join` against a closed room is refused with `room_closed`.

The host passphrase is a Worker secret. A host socket opens with
`/ws?role=host&key=…&device=…`; the Worker checks the key before the room
ever sees the socket, so a host socket inside the room is trusted by
construction.

## Verified

`scripts/smoke.mjs` drives scripted phones through every frame against a
running Worker, local or live, and states the rule each check proves.
`test/*.test.mjs` pin the pure rules and the matcher.
