# Trivia app — working context

Self-hosted Jackbox-alike for house parties, <20 players.

## What is authoritative

The design has moved faster than the documents. In order:

1. **`mockups/` is authoritative for design and behaviour.** Screens, states, rules, wording, settings. If it is in a mockup, that is how it works.
2. **`trivia-app-spec_v4.md` and this file** are background: the reasoning behind decisions, and the parts not built yet (the server, D1, the archive, reconnect). Use them for what the mockups cannot show. Where either one contradicts a mockup, the mockup wins, and the document is stale — say so rather than following it.

The architectural decisions (below, and in the spec) were argued through and still hold unless a mockup has visibly overtaken them.

## Stack (decided)

Cloudflare Workers + Durable Objects, WebSockets, question pack as a static JSON file. One Durable Object per room. (Earlier drafts keyed it by a 4-letter room code; the mockups have no room code — there is one room, gated by the host's Open room switch.) The object terminates all sockets for that room and owns all state. LAN-only Node server was the fallback and is now off the table.

Scaffolded with `npm create cloudflare@latest`, Hello World + Worker/Durable Objects template, JavaScript. Compatibility date `2026-08-25` — leave it pinned. Durable Object class must be registered under `new_sqlite_classes` in the migrations block (SQLite-backed DOs are what the free tier allows).

## Owner context

Comfortable in Python, new to JavaScript. Prefers reading working code over having idioms explained abstractly. Server is JS because the browser clients have to be JS anyway and splitting languages across a tightly-coupled socket boundary isn't worth it. Explain JS-specific choices briefly when they're non-obvious; don't over-explain general programming.

## The mockups are the spec for behaviour

The live app must behave exactly like the HTML mockups in `mockups/`: same screens, same states, same rules, same wording. The only difference is that it runs with real players over wifi. When the spec and a mockup disagree, the mockup is the more recent decision; flag it, don't silently pick. Building the server means moving each mockup's in-page game logic behind the socket and turning the pages into renderers of what the server sends. Their render functions should survive largely intact.

## Answer matcher (settled)

Autograde by Damerau-Levenshtein distance within a radius; anything the matcher is not sure of goes to the host's review queue, and the host is always the final word. Implementation details were delegated to Claude and are fixed as:

- **Normalise** both sides: Unicode NFKD with diacritics stripped, lowercase, `&` to `and`, punctuation removed, whitespace collapsed, a leading `the` / `a` / `an` dropped, number words zero to twenty mapped to digits.
- **Distance** is Damerau-Levenshtein (optimal string alignment) against every accepted answer; the closest one wins and is recorded as the matched candidate.
- **Radius** per question: `exact` is 0, a number is that number, `auto` is `floor(len / 3)` of the normalised matched answer.
- **Verdicts**: distance 0 is correct and confirmed. Inside the radius is correct, confirmed only when auto-pass fuzzy is on, otherwise pending. Outside is incorrect and pending. Autograde off, or Birthday Mode, is ungraded and pending.
- **List answers** apply the same rule per element, with the question's order-across / order-down flags deciding which grid cells an element may match.

It is a pure function; write it in JS with a table of test cases.

## Verify before building

Model knowledge of Cloudflare APIs goes stale fast — Cloudflare's own skills say to prefer retrieval over pre-training for this. Check live docs for:

- **WebSocket Hibernation API** inside Durable Objects. Needed so ~20 idle phones between questions don't rack up duration charges. This shapes the socket handler structure, so confirm the API before writing it, not after.
- `getByName()` vs the older `idFromName()` + `get()` pattern for resolving a room code to an object.
- Current `wrangler.jsonc` binding and migration field names.

`AGENTS.md` in this repo is Cloudflare's own guidance file — treat it as authoritative over recollection.

## Build order

1. **Message set first.** Define every frame type, both directions, for all roles. What the player sends, what the host sends, what the server pushes to each. This is the contract the whole app hangs off and it's portable if the platform ever changes.
2. Socket plumbing: connect, hello, join, disconnect, reconnect-with-snapshot.
3. Phase machine as the host mockup has it: `lobby → collecting → closed → … → ended`, with verdicts editable at any time after close. There is no separate grading phase.
4. Matcher (settled, see above) + host review queue.
5. Question pack and polish.

## Non-obvious constraints from the spec

- **Per-role payloads, never a broadcast blob.** The answer key stays server-side. Player payload and host payload are composed separately.
- **Scores are a fold over the append-only answer log**, never stored. This is what makes reconnect, mid-game join, and host verdict correction all fall out for free — reconnect is "push a full snapshot," not a merge.
- **`device:<deviceId> → personId` is a hint, not a binding.** Overwritten by whatever the player taps on join. No conflict resolution code.
- **There are no timers.** The host closing the question is the only cutoff, and the submission tracker is the host's only signal to move on. (An earlier draft had server-authoritative deadlines; the mockups dropped them.)
- `crypto.randomUUID()` requires a secure context — fine on `https://*.workers.dev`, would have broken on the LAN fallback.

## Open questions

- Room code in the URL is not authentication. Fine for a house party; revisit if the host socket ever needs protecting.
- Heartbeat interval and the timeout after which a player is marked `connected: false`. Roughly 20–30s ping, ~45s timeout, but check what hibernation handles automatically before hand-rolling it.
