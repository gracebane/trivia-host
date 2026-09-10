#!/usr/bin/env python3
"""Regenerate mockups/rbd_player.html from mockups/player.html.

The Reilly Birthday Mode phone is functionally IDENTICAL to the normal one --
same states, same guesses, same team logic, same mirroring. Only the look
differs. Keeping it as a generated file rather than a hand-maintained copy
means a behaviour change made once in player.html reaches both, and the
aesthetic lives entirely in rbd.css where it can be designed freely.

Run after any change to player.html:

    python3 scripts/sync_rbd.py
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "mockups" / "player.html"
OUT = ROOT / "mockups" / "rbd_player.html"

BANNER = """\t\t<!-- ================================================================
\t\t     GENERATED FILE - do not edit by hand.

\t\t     Built from player.html by scripts/sync_rbd.py. Behaviour is identical
\t\t     to the normal player by construction; the whole difference is rbd.css
\t\t     and the `rbd` class on <body>. Change behaviour in player.html and
\t\t     re-run the script; change the look in rbd.css.
\t\t     ================================================================ -->
"""

STRICT = """\t\t<script>
\t\t\t// Strict EGA and the type switch are both layers over the skin, set from
\t\t\t// the device wall and read here so a fresh frame comes up in the right one.
\t\t\ttry {
\t\t\t\tif (localStorage.getItem("mockEgaStrict") === "1") document.body.classList.add("strict");
\t\t\t\tif (localStorage.getItem("mockEgaFont") === "mono") document.body.classList.add("mono");
\t\t\t} catch {}
\t\t</script>
"""

# (description, pattern, replacement) -- every one must match, or we abort.
EDITS = [
    (
        "title",
        r"<title>Trivia — Player</title>",
        "<title>Trivia — Player (Birthday)</title>",
    ),
    (
        "stylesheet",
        r'<link rel="stylesheet" href="styles\.css" />',
        '<link rel="stylesheet" href="styles.css" />\n\t\t<!-- the skin: everything that makes this look unlike the normal phone -->\n\t\t<link rel="stylesheet" href="rbd.css" />\n\t\t<!-- strict EGA on top of it, only when <body> also has the `strict` class -->\n\t\t<link rel="stylesheet" href="rbd-strict.css" />\n\t\t<!-- the type switch, last so it wins: `mono` swaps SCUMM for the DOS stack -->\n\t\t<link rel="stylesheet" href="rbd-font.css" />',
    ),
    (
        "body class",
        r'<body class="player">',
        '<body class="player rbd">',
    ),
    (
        "sim bar label",
        r"<b>Simulate host</b> \(mock only\)",
        "<b>Simulate host</b> (mock only) &nbsp;<span class=\"rbd-tag\">Birthday skin</span>",
    ),
]


def main() -> int:
    if not SRC.exists():
        print(f"missing {SRC}", file=sys.stderr)
        return 1
    html = SRC.read_text()

    for name, pattern, repl in EDITS:
        html, n = re.subn(pattern, repl, html, count=1)
        if n != 1:
            print(f"anchor not found: {name}", file=sys.stderr)
            return 1

    # banner goes right after <body ...>, then the strict-mode switch: a class
    # on <body> driven by the same localStorage flag the device wall sets
    html, n = re.subn(r"(<body class=\"player rbd\">\n)", r"\1" + BANNER + STRICT, html, count=1)
    if n != 1:
        print("could not place the banner", file=sys.stderr)
        return 1

    OUT.write_text(html)
    print(f"wrote {OUT.relative_to(ROOT)} ({len(html):,} bytes) from {SRC.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
