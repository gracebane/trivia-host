# Trivia app — working context

Self-hosted Jackbox-alike for house parties, <20 players. Full spec in `trivia-app-spec.md` — read it before proposing anything architectural. The locked decisions there are load-bearing and were argued through; don't relitigate them without saying why.

## Stack (decided)

Cloudflare Workers + Durable Objects, WebSockets, question pack as a static JSON file. One Durable Object per room, keyed by the 4-letter room code. The object terminates all sockets for that room and owns all state. LAN-only Node server was the fallback and is now off the table.

Scaffolded with `npm create cloudflare@latest`, Hello World + Worker/Durable Objects template, JavaScript. Compatibility date `2026-08-25` — leave it pinned. Durable Object class must be registered under `new_sqlite_classes` in the migrations block (SQLite-backed DOs are what the free tier allows).

## Owner context

Comfortable in Python, new to JavaScript. Prefers reading working code over having idioms explained abstractly. Server is JS because the browser clients have to be JS anyway and splitting languages across a tightly-coupled socket boundary isn't worth it. Explain JS-specific choices briefly when they're non-obvious; don't over-explain general programming.

The answer matcher is being prototyped separately in Python (pure function, easy to iterate against the question pack) and ported. Don't write the matching logic in JS until that's settled.

## Verify before building

Model knowledge of Cloudflare APIs goes stale fast — Cloudflare's own skills say to prefer retrieval over pre-training for this. Check live docs for:

- **WebSocket Hibernation API** inside Durable Objects. Needed so ~20 idle phones between questions don't rack up duration charges. This shapes the socket handler structure, so confirm the API before writing it, not after.
- `getByName()` vs the older `idFromName()` + `get()` pattern for resolving a room code to an object.
- Current `wrangler.jsonc` binding and migration field names.

`AGENTS.md` in this repo is Cloudflare's own guidance file — treat it as authoritative over recollection.

## Build order

1. **Message set first.** Define every frame type, both directions, for all roles. What the player sends, what the host sends, what the server pushes to each. This is the contract the whole app hangs off and it's portable if the platform ever changes.
2. Socket plumbing: connect, hello, join, disconnect, reconnect-with-snapshot.
3. Phase machine (`collecting → grading → revealing`), host controls.
4. Matcher port + host review queue.
5. Question pack and polish.

## Non-obvious constraints from the spec

- **Per-role payloads, never a broadcast blob.** The answer key stays server-side. Player payload and host payload are composed separately.
- **Scores are a fold over the append-only answer log**, never stored. This is what makes reconnect, mid-game join, and host verdict correction all fall out for free — reconnect is "push a full snapshot," not a merge.
- **`device:<deviceId> → personId` is a hint, not a binding.** Overwritten by whatever the player taps on join. No conflict resolution code.
- **Timers are server-authoritative.** Send an absolute deadline; server sends its own clock on connect for drift correction; server independently enforces cutoff.
- `crypto.randomUUID()` requires a secure context — fine on `https://*.workers.dev`, would have broken on the LAN fallback.

## Open questions

- Room code in the URL is not authentication. Fine for a house party; revisit if the host socket ever needs protecting.
- Heartbeat interval and the timeout after which a player is marked `connected: false`. Roughly 20–30s ping, ~45s timeout, but check what hibernation handles automatically before hand-rolling it.
