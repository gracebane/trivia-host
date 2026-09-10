# trivia_app_jm — John's version

A parallel take on the same trivia app, dropped in here so the two can be
compared. Nothing in this folder affects the app at the repo root.

## Stack

Cloudflare Workers + Durable Objects, one object per room, state over
WebSockets, D1 for the archive and the long-term player table. No React, no
build step for the UI mockups — they are plain HTML you can open directly.

## Where to look

| Path | What it is |
|---|---|
| `trivia-app-spec_v4.md` | The spec. Locked decisions and the reasoning behind them. Start here. |
| `mockups/host.html` | Host controller — open in a browser, no build. Has a "simulate players" bar so the whole flow is clickable. |
| `mockups/player.html` | Player client in a phone frame. |
| `mockups/leaderboard.html` | The tear-out leaderboard tab. |
| `docs/messages.md` | The WebSocket message contract, both directions, per role. |
| `src/room.js` | The Durable Object: sockets, join, roster, reconnect. |
| `scripts/deck2pack.py` | .pptx → question pack + slide thumbnails via LibreOffice. |
| `assets/` | Side quest: an EGA pixel-art converter, CLI and browser. Not part of the app. |

## Status

Working, as clickable mockups against fake data: the host controller end to
end (question kinds, up to six guesses with a points schedule, list answers
graded per element from a grid, a review queue, session defaults), the player
client matching all of it, the landing page with a host passphrase, the
tear-out leaderboard, and Reilly Birthday Mode — everyone brings a two-slide
deck, the collate script merges them, the author grades their own question on
a dark hand-off screen and sits it out, and the host never sees the answers.

Working for real: socket plumbing (connect, join, disconnect, reconnect with a
full snapshot), deck import from .pptx in the browser, thumbnail rendering via
LibreOffice, and an EGA pixel-art converter (CLI and browser) in `assets/`.

Not built yet: the phase machine and scoring on the server, D1, the real
answer matcher (Python prototype first, then ported), and any socket between
the mockups and the server.

## Overlapping pieces worth diffing

Both versions independently solved several of the same problems, so these are
the most direct comparisons:

- **Deck parsing** — `scripts/deck2pack.py` and the port inside
  `mockups/host.html` vs `src/lib/pptxParser.js`
- **Thumbnails** — LibreOffice → PDF → PNG, run locally, vs
  `src/lib/generateThumbnail.js`
- **Answer matching** — normalise then Damerau-Levenshtein with a
  length-scaled threshold vs `src/lib/answerMatching.js`
- **Player identity** — two-layer device → person, many-to-one, with a roster
  picker instead of a name box, vs `src/lib/playerIdentity.js`

## Design notes

Two decisions that shape everything else. Scores are never stored, they are a
fold over an append-only answer log, which is what makes reconnect, mid-game
join, and retroactive verdict changes fall out for free. And the app is fully
detached from the deck: it never renders slides, PowerPoint runs independently
on the TV, and the host advances both.
