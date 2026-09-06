# Message set — the WebSocket contract

Build-order step 1 (see `CLAUDE.md`). This is the full frame vocabulary for
every role, both directions, defined **before** any socket code. The canonical
machine-readable version is `src/messages.js`; this file is the prose that
explains *why* each frame exists and how a whole exchange flows.

## Ground rules (from the spec)

- Every frame is JSON with a `t` discriminator: `{ "t": "c2s.join", ... }`.
- **Per-role payloads, never a broadcast blob.** The answer key stays
  server-side; player and host frames are composed separately.
- **Server is the only clock.** Every timed question carries an absolute
  `deadline` (epoch ms). Clients render `deadline - now`. `SNAPSHOT.serverTime`
  lets a client measure its own clock skew and correct. The server *also*
  enforces the cutoff itself — a client with a wrong clock can't cheat the timer.
- **Reconnect = push a full snapshot, not a merge.** Scores are a fold over the
  append-only answer log, so a fresh, fully-correct snapshot is always cheap.

## Frame index

### Client → Server (`C2S`)

| `t` | Role | Fields | Meaning |
|---|---|---|---|
| `c2s.hello` | any | `deviceId`, `role` | First frame after open. Server replies `s2c.snapshot`. |
| `c2s.join` | player | `personId` **or** `displayName` | Tapped an existing name, or `+ New player`. Repoints `device→person`. |
| `c2s.answer` | player | `questionId`, `payload` | Submit an answer (payload is JSON). |
| `c2s.start` | host | — | Leave lobby, begin. |
| `c2s.next` | host | — | Advance to next question, open collecting. |
| `c2s.close` | host | — | Stop collecting early (collecting → grading). |
| `c2s.reveal` | host | — | Publish reveal (grading → revealing). |
| `c2s.setVerdict` | host | `questionId`, `personId`, `matched` | Flip one review verdict; recomputes scores. |

### Server → Client (`S2C`)

| `t` | To | Fields | Meaning |
|---|---|---|---|
| `s2c.snapshot` | any | `serverTime`, `phase`, `you`, `roster` (+ host: `progress`, `review`) | Full role-scoped state, on connect and every reconnect. |
| `s2c.roster` | any | `roster[]` | Roster changed. |
| `s2c.phase` | any | `phase`, `questionId` | Phase transition → switch screens. |
| `s2c.question` | player/host | player: `questionId,kind,prompt,media?,deadline`; host: + `acceptedAnswers` | Current question, role-scoped. **Player frame has no key.** |
| `s2c.answerAck` | player | `questionId`, `accepted`, `submittedAt` | Submission received (or rejected after cutoff). |
| `s2c.progress` | host | `questionId`, `answered[]`, `total` | Live "who has answered." |
| `s2c.review` | host | `questionId`, `items[]` | Non-exact verdicts, accepted+rejected, sorted by distance. |
| `s2c.results` | player/host | player: `correct,yourVerdict`; host: full verdicts | Reveal payload, role-scoped. |
| `s2c.leaderboard` | host/display | `standings[]` | The score fold. Players post-MVP only. |
| `s2c.error` | any | `code`, `message` | Non-fatal problem with the last frame. |

## Typical flows

**Player joins mid-game and it just works:**
```
open → c2s.hello{deviceId,role:player}
     ← s2c.snapshot{serverTime, phase:collecting, roster, you:null}
c2s.join{personId}                         # tapped a pre-highlighted name
     ← s2c.snapshot{... you:{personId,...}} # now bound; full current view
     ← s2c.question{questionId,prompt,deadline}   # if a question is live
c2s.answer{questionId,payload}
     ← s2c.answerAck{accepted:true,submittedAt}
```

**Host runs one question:**
```
c2s.next     ← s2c.phase{collecting} + s2c.question{...,acceptedAnswers}
             ← s2c.progress{answered:[...]}   (repeated as answers arrive)
c2s.close    ← s2c.phase{grading} + s2c.review{items sorted by distance}
c2s.setVerdict{...matched:true}  ← s2c.review{...} + s2c.leaderboard{...}  # re-enterable
c2s.reveal   ← s2c.phase{revealing} + s2c.results{...} + s2c.leaderboard{...}
```

**Reconnect:** just re-send `c2s.hello`; the server answers with a single
`s2c.snapshot` that fully replaces the client's view. No client-side merge, no
lost score — the log is the source of truth.

## Deliberately deferred

- Heartbeat / liveness frames. The WebSocket **Hibernation API** may cover
  ping/pong and idle timeouts natively; that's verified at build-order step 2
  before hand-rolling a heartbeat (see `CLAUDE.md` open questions).
- `display` role frames (big-screen view) — post-MVP; the `ROLE.DISPLAY`
  constant is reserved so the discriminator space already has room.
- Matcher internals — the `verdict` shape is fixed here, but the Python matcher
  port fills `distance`/`method` (build-order step 4).
