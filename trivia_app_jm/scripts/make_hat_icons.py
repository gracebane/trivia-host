#!/usr/bin/env python3
"""Generate the crew icons for team captains and mutinies.

    python3 scripts/make_hat_icons.py

Writes into assets/ega/hat/:

    hat-pirate-red-{13,17,21,25}.png    black tricorn, red skull
    hat-pirate-green-{13,17,21,25}.png  black tricorn, green skull
    bandana-red-{12,16,20,24}.png       red bandana
    bandana-green-{12,16,20,24}.png     green bandana

Mutinies alternate colour: the first is red, the second green, the third red
again. The captain wears the tricorn of the mutiny that put them in, and the
crew that voted wear bandanas to match.

Two things this file is careful about, both learned the hard way:

* The tricorn is rendered on ODD widths. A skull is symmetric, so it needs a
  real middle column to sit on; an even grid has none and the skull always
  lands half a pixel off. The source is mirrored onto itself first so the hat's
  own centre is the middle column too.
* The skulls are hand-authored per size rather than one shape scaled down. At
  these sizes the crown is only three to six pixels tall and any resampling
  turns the skull to mush.

The plain navy captain's hat is NOT regenerated here: it came from a source
image outside the repo. It already exists in the same folder.
"""

from __future__ import annotations

import pathlib
import sys

import numpy as np
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "ega" / "hat"
TRICORN_SRC = ROOT / "assets" / "ega" / "lookatmeiamthecaptainnow.png"
BANDANA_SRC = ROOT / "assets" / "black-pirate-bandana-md.png"

BLACK = (0x00, 0x00, 0x00)
WHITE = (0xFF, 0xFF, 0xFF)
COLOURS = {"red": (0xFF, 0x55, 0x55), "green": (0x55, 0xFF, 0x55)}  # EGA bright red / bright green

# Every icon is drawn with a one-pixel outline, because a shape with no outline
# disappears the moment it lands on a background of its own colour: the navy
# captain's hat on the birthday skin's EGA blue, or the black tricorn on the
# black top bar. Dark shapes get a white edge, bright ones a black edge, so both
# read on a light background and a dark one. The outline grows the sprite by one
# pixel on every side, which is why the CSS widths are 26 and 27 rather than
# 24 and 25.
OUTLINE = {"dark": WHITE, "bright": BLACK}

# Teeth appear only at 25, where a gapped row still reads as teeth.
SKULLS = {
    13: ["###",
         "#.#",
         ".#."],
    17: ["###",
         "#.#",
         ".#."],
    21: [".###.",
         "#.#.#",
         ".###.",
         ".#.#."],
    25: [".###.",
         "#####",
         "#.#.#",
         ".###.",
         ".#.#."],
}
DROP = 2  # rows below the crown; 1 sat the skull on the very top edge
BANDANA_SIZES = (12, 16, 20, 24)


def shrink(mask: np.ndarray, tw: int, th: int) -> np.ndarray:
    """Area coverage of a boolean mask on a tw x th grid."""
    H, W = mask.shape
    out = np.zeros((th, tw))
    for y in range(th):
        for x in range(tw):
            y0, y1 = round(y * H / th), max(round((y + 1) * H / th), round(y * H / th) + 1)
            x0, x1 = round(x * W / tw), max(round((x + 1) * W / tw), round(x * W / tw) + 1)
            out[y, x] = mask[y0:y1, x0:x1].mean()
    return out


def crop(mask: np.ndarray) -> np.ndarray:
    ys, xs = np.nonzero(mask)
    return mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1]


def outline(im: Image.Image, colour: tuple[int, int, int]) -> Image.Image:
    """Add a one-pixel border around every opaque pixel, on a canvas one bigger."""
    a = np.asarray(im.convert("RGBA"))
    h, w = a.shape[:2]
    out = np.zeros((h + 2, w + 2, 4), np.uint8)
    out[1:h + 1, 1:w + 1] = a
    solid = out[:, :, 3] > 0
    edge = np.zeros_like(solid)
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
        edge |= np.roll(np.roll(solid, dy, 0), dx, 1)
    edge &= ~solid
    out[edge] = (*colour, 255)
    return Image.fromarray(out)


def tricorn(w: int, skull: tuple[int, int, int]) -> Image.Image:
    src = np.asarray(Image.open(TRICORN_SRC).convert("L")).astype(int)
    shape = crop(src < 128)
    shape = shape | shape[:, ::-1]  # a true centre column needs a symmetric source
    H, W = shape.shape
    h = max(1, round(H * w / W))
    hat = shrink(shape, w, h) >= 0.42
    img = np.zeros((h, w, 4), np.uint8)
    img[hat] = (*BLACK, 255)

    cx = (w - 1) // 2
    top = int(np.argmax(hat[:, cx]))
    rows = SKULLS[w]
    sw = len(rows[0])
    for yy, row in enumerate(rows):
        for xx, ch in enumerate(row):
            if ch == "#":
                y, x = top + DROP + yy, cx - sw // 2 + xx
                assert 0 <= y < h and 0 <= x < w, f"{w}: skull runs off the hat"
                img[y, x] = (*skull, 255)

    red = np.nonzero(img[:, :, 3] & (img[:, :, 0] != 0) | (img[:, :, 1] != 0))[1]
    hats = np.nonzero(hat)[1]
    assert (red.min() + red.max()) / 2 == cx == (hats.min() + hats.max()) / 2, f"{w}: off centre"
    return Image.fromarray(img)


def bandana(w: int, colour: tuple[int, int, int]) -> Image.Image:
    src = np.asarray(Image.open(BANDANA_SRC).convert("RGBA"))
    shape = crop(src[:, :, 3] > 128)
    H, W = shape.shape
    h = max(1, round(H * w / W))
    d = shrink(shape, w, h)
    img = np.zeros((h, w, 4), np.uint8)
    img[d >= 0.40] = (*colour, 255)
    return Image.fromarray(img)


def main() -> int:
    for src in (TRICORN_SRC, BANDANA_SRC):
        if not src.exists():
            print(f"missing source: {src}", file=sys.stderr)
            return 1
    OUT.mkdir(parents=True, exist_ok=True)

    made = []
    for name, colour in COLOURS.items():
        for w in sorted(SKULLS):
            im = outline(tricorn(w, colour), OUTLINE["dark"])  # black hat: white edge
            im.save(OUT / f"hat-pirate-{name}-{w}.png")
            made.append((f"hat-pirate-{name}-{w}", im.size))
        for w in BANDANA_SIZES:
            im = outline(bandana(w, colour), OUTLINE["bright"])  # bright cloth: black edge
            im.save(OUT / f"bandana-{name}-{w}.png")
            made.append((f"bandana-{name}-{w}", im.size))

    # The navy captain's hat came from a source outside the repo, so it is
    # outlined from the file itself. The un-outlined master is kept in src/ the
    # first time, which makes re-running this script safe.
    src_dir = OUT / "src"
    src_dir.mkdir(exist_ok=True)
    for w in BANDANA_SIZES:
        master = src_dir / f"hat-navy-{w}.png"
        live = OUT / f"hat-navy-{w}.png"
        if not master.exists():
            if not live.exists():
                continue
            Image.open(live).convert("RGBA").save(master)
        im = outline(Image.open(master).convert("RGBA"), OUTLINE["dark"])  # navy on EGA blue needs it most
        im.save(live)
        made.append((f"hat-navy-{w}", im.size))

    # a side-by-side sheet, both colours, on the EGA blue the phones use
    scale, pad = 8, 12
    rows = []
    for w in sorted(SKULLS):
        rows.append([Image.open(OUT / f"hat-pirate-{c}-{w}.png") for c in COLOURS])
    for w in BANDANA_SIZES:
        rows.append([Image.open(OUT / f"bandana-{c}-{w}.png") for c in COLOURS])
    cw = max(sum(i.width * scale + pad for i in r) for r in rows) + pad
    ch = sum(max(i.height for i in r) * scale + pad for r in rows) + pad
    sheet = Image.new("RGB", (cw, ch), (0, 0, 0xAA))
    y = pad
    for r in rows:
        x = pad
        for im in r:
            big = im.resize((im.width * scale, im.height * scale), Image.NEAREST)
            sheet.paste(big, (x, y), big)
            x += big.width + pad
        y += max(i.height for i in r) * scale + pad
    sheet.save(OUT / "sheet-crew.png")

    for name, size in made:
        print(f"{name:26} {size[0]}x{size[1]}")
    print(f"\n{len(made)} icons + sheet-crew.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
