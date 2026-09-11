> **Read this first.** The HTML mockups in `mockups/` are now authoritative for
> design and behaviour. This spec is background: the reasoning behind decisions
> and the parts not built yet (server, D1, archive). Where it contradicts a
> mockup, the mockup is the more recent decision and this document is stale.

# Trivia App — Spec

*Current state as of this collation. Folds `trivia-app-spec.md`, `trivia-app-decisions_v2.md`, and `trivia-app-decisions_v3.md` into one document; where they conflicted, the newer decision won. Supersedes all three.*

Lightweight self-hosted Jackbox-alike. Personal use, parties <20. Players scan a QR code → HTML in the phone browser, no download. Separate host controller.

**Stack:** Cloudflare Workers + Durable Objects over WebSockets. D1 for the archive and the long-term player table.

---

## Architecture: fully detached from the deck

The app never renders slides and has no display client for questions. The TV runs PowerPoint independently. The app is a scoring and identity system running alongside a deck the host authors and advances separately.

- The deck holds question slides *and* answer slides; the host presents answers aloud
- Double-advancing (deck + app, per question) is an accepted cost
- **Rejected:** attached mode, an attached/detached toggle, app-choreographed reveals, slide rendering in-app
- **Pinned:** optional deck upload for *reference only* — low-res thumbnails and/or extracted question text on the host client, to confirm sync and label the review queue. Not a display source. Blocked on Workers being unable to run LibreOffice; likeliest path is host-exported images

**Known cost:** any question format that depends on app-driven reveal choreography is off the table. Reveals are the host speaking over their own screen.

---

## Locked architectural decisions

- **Server authoritative.** No browser holds game state. A host refresh must not end the game. Every client is a view.
- **Scores derived, never stored.** Append-only answer log: `{questionId, personId, deviceId, payload, submittedAt, verdict}`. The leaderboard is a fold over the log. This is what enables host correction, mid-game join, rejoin, and post-game stats.
- **Identity is two-layer: device → person, many-to-one.** Both keys are opaque random UUIDs. Nothing is derived from a name, phone number, or hash, so neither key ever has to change.
  - `deviceId` — `crypto.randomUUID()`, generated in the browser on first visit, held in localStorage. Identifies a browser.
  - `personId` — `crypto.randomUUID()`, minted server-side the first time a new person appears. Identifies a human.
  - Storage is two maps: `device:<deviceId> → personId` and `person:<personId> → {v:1, displayName, deviceIds[], tags[], gamesPlayed}`.
  - Everything downstream — roster, answer log, leaderboard, history — keys on `personId`. `deviceId` is recorded alongside for diagnostics only.
- **`device:<deviceId> → personId` is a hint about the last user, not a binding.** It is overwritten by whatever the player taps on join. A device may point at different people on different nights. Treating it as a binding is what forces conflict-resolution code for the borrowed-phone case.
- Player record in a room is an object from day one: `{personId, displayName, connected, joinedAtQuestion}`.
- **Questions polymorphic-ready.** A question carries a `kind` field; the answer payload is JSON, not a bare string. Non-trivia game modes are explicitly out of scope — refactor if ever needed.
- **Phase machine:** `collecting (grading concurrent) → revealing`. Grading is not a separate phase; answers are graded as they arrive, while collection is still open. Grading is allowed to be slow and re-enterable.
- **Answer key never leaves the server.** Player payload and host payload differ. No single `broadcast(state)` that goes to all roles. Matching runs server-side only.
- **No timers anywhere.** A song is the time limit. The host closes the question when they decide, relying on the submission tracker to know when.
- Profile store is a separate keyspace from room state, and every profile record carries a `v` field from the first write.

---

## Entry model: one site, two doors

A single public site. Role is determined by which credential you present, not by a URL parameter.

- `/` — landing page. Player lobby-password field, plus a smaller link to the host entrance
- **Player password: `imstupid`** — shared with all guests
- **Host passphrase: `imwithstupid`** — private to the host
- The QR code encodes the player path with the lobby password embedded, so scanning bypasses the form entirely. Manual password entry is the fallback for camera trouble
- `/host` — passphrase field. A correct passphrase mints a host session token, stored in localStorage so a refresh doesn't re-prompt. **The passphrase itself remains sufficient from any device**, which is the battery-death recovery path
- The two credentials are independent. Neither is derived from the other

**Both passwords are mutable later.** Hardcoded for now.

### Single-instance assumption

Exactly one game exists at a time. Consequences:

- **The 4-letter room code is cut.** The lobby password *is* the room identifier. Carrying both is redundant
- When multi-room arrives, the password becomes per-room and the code returns. Refactor accepted

### Host reconnect

Supported and first-class. Host authority lives in the passphrase, not in a device, socket, or session. A dead laptop is recoverable by typing the passphrase on anything else.

---

## Physical setup

- Laptop → TV via HDMI, set to **Extend** (never Duplicate — that leaks the host screen)
- PowerPoint full-screen on the TV, Presenter View on the laptop
- **Host client is laptop-primary.** Phone host is a nice-to-have
- The leaderboard is a `?view=leaderboard` client, opened as a tab, torn out to the TV once at setup, and alt-tabbed when wanted
- Rejected `window.open` popups and position hints as less reliable than tearing out a tab
- The leaderboard URL is shown next to the button so a tablet or second laptop can serve instead

**The leaderboard is shown every handful of questions / between rounds — not continuously.** It's a moment, not an ambient display.

---

## Joining and identity

- **Join is a picker, not a name textbox.** The server sends the known roster; the phone shows tappable names with the device's last-known person pre-highlighted, plus `+ New player`. One tap to join. This collapses nearly every identity case into a UI affordance instead of matching logic — no fuzzy name matching, no confirmation prompt, no phone numbers
- **The roster can be preloaded from D1**, not just grown by `+ New player` taps. Player records carry `tags: string[]`, manually editable by the host from a **total player list** view independent of any single room. This lets the host seed a lobby by friend group or any other grouping
- Duplicate connection: **close the older socket.** Live players are colour-coded and sorted to the bottom of the roster picker; possibly a prompt
- Ping-a-device to identify whose phone it is — nice-to-have, deferred
- A missed question scores 0; host setting later if wanted

### Identity cases, and how each resolves

| Case | Resolution |
|---|---|
| Same person, same phone | Name pre-highlighted; one tap. |
| Same person, new phone | Nothing pre-highlighted; they tap their name. Server appends the new `deviceId` to `deviceIds[]`. Both phones resolve instantly from then on. |
| Borrowed phone | They tap a different name than the pre-highlighted one. Server points `device:<id>` at that person. No conflict to resolve — the mapping is just the most recent tap. |
| Genuinely new person | Tap `+ New player`, type a name, server mints a `personId`. |
| Two people sharing one phone in the same game | **Not supported.** One connection is one player. They share an entry or someone uses a laptop. |
| Anything else | Host panel: rename, merge, delete. |

---

## Questions and grading

### Question identity: Version A

The app knows which question is which. Questions have stable IDs; the host client's slide tracker maps app state to deck slides.

- Enables review-queue labelling, per-question settings, and question references in the archive
- **Accepted cost:** deck drift. The app's idea of the current question can diverge from what's on the TV
- Strengthens the case for the pinned optional deck upload (thumbnails / extracted question text, reference only)

### Question kinds

A question carries a `kind`. Two exist:

- **Single answer** (`single`) — one response judged against a list of accepted answers. Everything the app did before kinds existed. Scored by the per-guess points schedule.
- **List answer** (`list`) — several elements judged against a **grid**, scoring a fixed number of points **per element matched**. `grid[row][col]` holds the accepted wordings of one element; a plain list is a one-column grid. Two independent flags say whether order counts, and they act on separate axes: `orderX` means column order counts *within* a row (country then capital), `orderY` means the rows themselves must arrive in grid order. An axis with only one element ignores its flag. A submission is read in the grid's own shape, `cols` elements per row; with `orderY` off, each submitted row is assigned to the unused grid row it answers best. The question's maximum is `pointsPer × filled cells`, so it depends on the size of the grid rather than a fixed number.

**Which guess counts differs by kind.** A single answer takes the *earliest* confirmed-correct guess. A list takes the *best* confirmed guess — a later, fuller list should beat an earlier thin one, and a guess still in the queue can only improve the score.

**List autograding is conservative:** a clean sweep of the grid auto-confirms, anything partial goes to the review queue. Partial credit is a judgment call and gets a human look by default.

**Grading a list is per element, by clicking.** The review queue shows the submitted elements as boxes, green for the ones that count, grouped in brackets one bracket per grid row when the grid has more than one column. The grader clicks an element to toggle it, so accepting a wording the matcher missed is one click. The submission tracker shows the same bracketed elements read-only alongside the point total, and a ✓ to sign the total off. A grader can never be credited with more elements than the grid holds.

### Question packs

- JSON, bidirectionally editable — the host can hand-write it or build it in the UI and export
- Per-question: point total, acceptable answers, autograde toggle, second-guess policy
- Brought by the host per game; **transient in the room, archived at game end**
- Not stored server-side before a game

### Answer matching

Normalize (lowercase, strip punctuation and accents, drop leading articles, collapse whitespace), then Damerau-Levenshtein with a length-scaled threshold, `floor(len/3)` — so answers under three characters require an exact match. Per-question override allowed, and a session default.

### Verdicts

- Three-state: `correct`, `incorrect`, `pending`
- Exact matches auto-resolve to correct and skip review
- Fuzzy matches land in the review queue **ungraded**, with the best candidate pre-highlighted but all options selectable
- Session setting `autoPassFuzzy`, default off — auto-resolves fuzzy matches to correct instead of queueing them
- Verdicts are retractable at any time, including questions later — the retroactive override case ("actually that should have counted") is fully supported and comes free from the append-only log
- Verdict stored with its reasoning: `{matched, distance, method, overridden}`
- Scores fold over resolved entries only

### Verdict visibility

Session setting `showVerdictsLive`, **default off** — players don't see verdicts until reveal. Live verdicts would mean players watch points get retracted.

---

## Two distinct host powers, different lifetimes

**Guess allowance** — per question, 1 to 6, default 2. A player may submit up to that many guesses while the question is open; each is its own row in the log and is graded on its own. The host's tracker shows one column per allowed guess.

**Which guess counts.** The **earliest confirmed-correct guess** wins. First right and second wrong is correct; a later wrong guess never cancels an earlier right one. First wrong and second right is also correct, and pays the second-guess amount below. Both right pays the first-guess amount.

**Points are a schedule**, one entry per guess: what a player gets if that guess is the first one confirmed correct. `8 · 8` is no deduction, `8 · 4` is half off the second guess. A bare number in a pack means the same for every guess. The schedule always has exactly as many entries as the question has guesses; changing the guess count pads it by repeating the last value, or trims it.

**Question defaults** — *every* field in a question's settings has a default in session settings; that pairing is the rule, not a coincidence, and a new field should be added in both places. The panel is grouped by question kind: **all questions** (type, guesses, autograde, fuzzy threshold), **single answer** (the points schedule, default `8 · 8`), **list answer** (points per element, default 2, and the two order flags). The schedule always shows all six boxes with the unused ones greyed, so changing the guess count doesn't reflow the row. Every new question starts with them, whether added by hand, imported from a deck, or collated for birthday mode. Existing questions keep theirs.

**Resubmission grant** — per-player, only while the question is open. The host hands one player their textbox back (typo, incomplete answer). It replaces their latest guess rather than adding one; the replaced text is kept, struck through.

Not a phase change:

```
canSubmit = room.collecting || grants.has(personId)
```

Grants clear per question. The yellow "send back / clarify" button is this same mechanism.

**Verdict override** — any question, any time, permanent. Changes judgment, not the answer.

Once the host closes a question, no resubmissions. Verdict editing remains available forever.

### Superseded answers

- A resubmission appends a new row; the old row stays, marked superseded
- Fold rule: the latest row per person-question is live
- Superseded rows do **not** appear in the review queue
- Visible in the player tracker; kept because storage is cheap and it makes grants auditable

---

## Host client structure

Tabbed: **slide tracker · guess evaluator · player management · session settings**

- Question settings live inside slide-tracker rows; session settings are their own tab
- Settings are read at point of use, not baked in at game start — a mid-game change applies going forward only. This is the rule for all session settings; none are special-cased
- If a setting ever turns up that genuinely can't change mid-game, it gets locked in the UI once the game starts rather than earning a prose exception

### Submission tracker (MVP, not nice-to-have)

Players listed with live status as answers arrive. Green pass / red fail / yellow send-back. The host can close and fail non-submitters, but sees exactly who and how many first.

This is the only signal the host has for when to move on, given no timer.

---

## Leaderboard

- **Tie handling is a session setting, `sharedRank`, default on.** On, tied players share the better rank and the next rank skips: `1 · 2 · 2 · 4`. Off, they take the average of the ranks they cover: `1 · 2.5 · 2.5 · 4`
- Superseded: average-of-tied-ranks used to be the only rule. It is now the off position, kept because the archive may prefer a single number per placing
- Shared ranks are always integers, which also removes the "fractional ranks are awkward in the archive" problem when the default is left on
- **Scores shown alongside ranks: toggleable, default on**
- Final-standing ties (prize allocation, etc.) handled later — out of scope for now

---

## Game lifecycle

Socket disconnection is **not** a lifecycle signal. Phones sleep, wifi drops, people step outside — connection count is a bad proxy for "is anyone still playing." Activity is the direct signal.

**A game ends exactly two ways:**

1. **Host clicks End Game.** Immediate. Archives the log and freezes the room
2. **Idle garbage collection.** No host action and no answer submission for **12 hours**, tracked by a Durable Object alarm reset on each activity

The idle timeout exists only to stop abandoned rooms accumulating, not to serve any UX need — the host can always return and end a game manually. So it is generous rather than quick. A party cannot outlast 12 hours; an abandoned room is gone by the next afternoon. Cloudflare hibernates idle Durable Objects regardless, so a stale room costs storage and nothing else.

**End Game freezes rather than deletes.** The leaderboard stays reachable afterward and a mis-click is undoable. The idle alarm does the actual deleting.

**Disconnection is purely cosmetic.** It sets `connected: false` on the roster and greys the player in the tracker. No timers hang off it and no lifecycle consequences follow from it — which removes an entire class of bug where the room evaporates because everyone's screen locked at once.

### Rounds

Not a software concept. Purely an out-of-app way to chunk breaks.

---

## Room gate

The room starts **closed**. The open/close button is in session settings, not the control strip: it is a once-a-party action, not a per-question verb. A JOIN frame against a closed room is rejected with a reason the phone shows ("the host hasn't opened the room yet") and no roster entry is made. The host opens it with one button in the control strip, and can close it again at any time; closing never removes anyone already in. Reconnects of existing players are not joins and are never gated.

Why: the party fills up before the host is ready, and stragglers trickle in during play. The gate is what makes "everyone who's in is in" a decision rather than an accident, which matters most for team assignment.

---

## Teams

A session setting, off by default, with two on positions:

- **Players pick.** After the name and before any question the phone shows one rectangle per team plus "New team". Whoever starts a team names it and is its captain. Players can switch teams until the game starts.
- **Random.** The setting is **max players per team**. Players who join sit in a lobby and are told to wait; the host deals them with a **Deal teams** button in session settings, which is the only thing that ever deals. Nothing is dealt implicitly at Start, so a hand-adjusted arrangement survives. Teams fill to the max and the remainder is the small team (6 at 4 → 4 + 2, not 3 + 3); a remainder of one borrows a player from a full team (9 at 4 → 4 + 3 + 2). Teams are named Team 1..N. Nobody picks.

**Latecomers.** Once the teams exist, a player who joins in random mode is placed by protocol, never at random across all teams: **the smallest team, and at parity a random one of the smallest**. This keeps the sizes within one of each other however people trickle in. Max per team is a cap rather than a target, so when every team is full the latecomer starts a new one; a team still holding a single player at Start is folded into the smallest other team, which is the one case a team may sit one over the max. In pick mode a latecomer picks like everyone else. Anyone still unassigned at Start is placed by the same rule.

Either way, once the game starts the team list is fixed. A late joiner picks a team (or is dealt to the smallest). The team mode setting itself locks at Start, because the answer log is keyed by team from then on.

**The team is the scoring unit.** Every answer row carries both `personId` (who typed it) and `unitId` (who it counts for: the team, or the person when teams are off). The fold, the outcome, the submission tracker, the stats, the standings and the leaderboard all walk units. Nothing else about grading changes: guesses, send-back, verdicts and points all work per team exactly as they did per player.

**Captain.** Each team has one. Only the captain's phone gets the answer box; everyone else on the team sees who the captain is, what the team has sent, and a nudge to go tell the captain the answer. The captain is:

- by default the first person onto the team (the one who named it, or the first dealt in)
- re-drawn at random every question if the "random captain every question" setting is on
- replaceable from within the team, two ways:
  - the captain has a **step down** button; the role goes to a random teammate
  - anyone else can **vote to replace**; at 50 % + 1 of the team (captain included in the count) the role goes to a random *voter*, and the votes clear. Votes are visible on the team screen and to the host.
- replaceable by the host at any time from the team table

The phone marks the captain with the small hat icon (`assets/ega/hat/`) and shows the player's own name in a different colour on the roster.

**Host client.** Player management gains a team table: rank, team, captain, players, score, and a "new captain" button per team; plus "Assign randomly" (lobby only) and "New captains". The player table shows each player's team and inherits the team's rank and score. The submission tracker's first column becomes the team, with the captain underneath, and the review queue names the team with the captain in brackets.

**Frames** (to add in build step 1): `OPEN_ROOM` / `CLOSE_ROOM` host→server; `JOIN` rejection reason `room_closed`; `TEAM_CREATE {name}`, `TEAM_JOIN {teamId}`, `TEAM_LEAVE`, `CAPTAIN_STEP_DOWN`, `CAPTAIN_VOTE` player→server; `TEAM_ASSIGN {n}`, `TEAM_SET_CAPTAIN {teamId, personId}`, `TEAM_ROTATE` host→server; the lobby snapshot carries every team, its members, captain and current vote count.

**Not decided yet:** whether a team with every phone offline still counts in the close tally; a cap on team size in pick mode; whether the host can rename teams.

---

## Reilly Birthday Mode

A session setting, off by default, for a party where **every guest brings one question** as a two-slide `.pptx` and **grades it themselves**. The host is a player too.

**Collation.** `scripts/birthday_collate.py` merges one folder of guest decks into a single presentation: slide 1 is an index of who's up in what order, then each guest's question slide followed by their answer slide. Names come from the filenames. Order is random by default, seeded and printed so the draw is fair *and* reproducible; alphabetical, file order, an explicit list, and `--first` / `--last` pins are also available. It writes a pack alongside with **no question or answer text**, only author, slide numbers and points, and it never prints question text either.

**Self-describing deck.** The index slide carries a small machine-readable footer. Loading the merged `.pptx` into the host client detects it, switches the mode on, and takes the order from the footer, reading nothing else from the deck: no pictures, no slide text, no mapper.

**What the mode changes in the host client** (all read at point of use; toggling is live, no reload):

- Questions are named after their author everywhere: the guess evaluator's picker, the status strip, the deck-sync hint
- The slide tracker shows participant, slide numbers, points and status. No question, no answers, no thumbnails, no flags
- Per-question settings shrink to points, deck slide and second-guess policy
- Nothing autogrades. Every answer lands in the review queue as **ungraded** (grey outline, nothing pre-highlighted) and the author calls it
- The author sits out their own question: not expected to answer, not counted in the close tally or the stats, scores 0 on it. Fair as long as everyone brings exactly one
- **The host cannot read the guesses.** The host is playing too, so while they hold the laptop every submitted answer is covered in the guess evaluator: the review queue and the tracker show masked placeholders instead of text. Everything else stays live — who has answered, verdict states, counts, point totals, and every grading control. Handing the laptop to the author uncovers the text for them.
- **Hand-off runs dark.** The whole page switches to a dark theme for the duration. It only ever happens in this mode, and the colour change is the signal, readable across a room, that the laptop is not the host's any more.
- **Hand-off.** A "Hand to *name*" button hides the control strip, the tabs and the question picker, leaving only the live question's queue and tracker. The bar has three buttons: **Close question**, **Done, hand to *next name*** (disabled until the question is closed; advances and stays in hand-off for the next author, so the laptop can go round the whole room without returning to the host; on the last question it ends the chain), and **Return to host** as the escape. In the real client, Return requires the host passphrase; in the mockup it is a button

**Not decided yet:** compensation when someone brings zero or two questions; whether the birthday person plays, grades, or only presents; a grader credential cheaper than the host passphrase.

---

## Archive

The game log goes to permanent storage (D1) at game end.

**Stats are player-centric, not question-centric** — so the archive needs question references for display, not full pack copies. Lower stakes than previously assumed.

**D1 is in the MVP.** Preloading a roster is cross-game player querying, which was the stated trigger for pulling D1 in. The archive layer and the player table must exist before the first party, not after it.

---

## MVP scope

- Landing page with player lobby-password entry; QR with the password embedded
- `/host` passphrase entry, host session token in localStorage
- Player client: join via roster picker, single textbox answer, waiting and results states
- Host client: the four tabs, question advance, close question, reveal, submission tracker, review queue
- `?view=leaderboard` client
- Host-supplied JSON question pack, loaded per game
- Server-side answer matching with review queue
- Reconnect by `deviceId` with score intact
- D1: player table (with tags) and game-log archive

---

## Nice to have (post-MVP)

- Live leaderboard on player devices during play
- Add and remove players mid-game; kick
- Host identity panel: rename a person, merge two people (move `deviceIds`, rewrite `personId` in the answer log, recompute), delete a person
- Contradiction flag: two live connections resolving to the same person (produces duplicate answers in the log)
- Ping-a-device to identify whose phone it is
- Phone host client
- Deck upload for reference thumbnails / extracted question text
- Post-game stats: fastest answers, most-missed question, head-to-head
- Results export

---

## Deferred, explicitly

- **Pack schema** — field names, types, and defaults for the host-authored JSON. Needed before the matcher port
- **Player-side display of multiple guesses.** With up to 6 guesses per question, the player client needs a way to show what they've sent that adapts to the allowance: one textbox per remaining guess, or a single cell that lists "first guess: …, second guess: …" and grows. Not designed yet; the host side is done
- Final-tie resolution
- Where packs live if ever stored server-side
- How stats handle a question whose answer list changed between parties

---

## Known non-starters

- **Timers.** Cut entirely. A song is the time limit.
- **A question-display client** (`?view=display`). Replaced by `?view=leaderboard`; the deck is the display.
- **Media questions (image/audio) and multiple choice.** Out of scope — the deck handles all media.
- **IP-based device pairing.** Every phone at the party is behind one NAT, so the signal is a constant. Coarse fingerprinting (user agent, screen size, timezone) fails for the same reason.
- **LLM-assisted grading.** Normalization plus fuzzy distance plus host review covers it.
- **Phone numbers as an identity key.** Mutable, recycled by carriers, inconsistently formatted, unverified, and they'd add a typing step for all 20 guests to disambiguate two. The roster picker covers the same cases at one tap. (An optional post-game opt-in attribute is still fine if ever wanted — stored hashed, never as a key.)
