#!/usr/bin/env python3
"""Generate the evaluator's star, in the crew icons' sizes.

    python3 scripts/make_star_icons.py

Writes into assets/ega/hat/:

    star-{13,17,21,25}.png    EGA yellow five-point star, black outline

In Birthday Mode the author of a question grades it, so on their team's crew
list they wear this instead of a hat for that question. Same rules as the
tricorn in make_hat_icons.py: an ODD width, because a star's top point needs a
real middle column; the shape is mirrored onto itself so it is exactly
symmetric; and the one-pixel outline grows the file by one pixel each side,
so the 25 is 27 wide on disk, like hat-pirate-25.
"""

from __future__ import annotations

import math
import pathlib

import numpy as np
from PIL import Image, ImageDraw

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "ega" / "hat"

YELLOW = (0xFF, 0xFF, 0x55)  # EGA bright yellow
BLACK = (0x00, 0x00, 0x00)
SIZES = (13, 17, 21, 25)
SUPER = 64  # supersample factor for area coverage


def star_mask(w: int) -> np.ndarray:
    """A five-point star, w pixels wide, as a boolean mask of about the same height."""
    h = w  # a regular star is a touch shorter than wide; on this few pixels, square reads better
    big = Image.new("L", (w * SUPER, h * SUPER), 0)
    d = ImageDraw.Draw(big)
    cx, cy = w * SUPER / 2, h * SUPER / 2 + h * SUPER * 0.04  # a hair low: the top point is the tallest
    ro = w * SUPER / 2
    ri = ro * 0.42
    pts = []
    for i in range(10):
        r = ro if i % 2 == 0 else ri
        a = -math.pi / 2 + i * math.pi / 5
        pts.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    d.polygon(pts, fill=255)
    a = np.asarray(big) > 0
    cov = a.reshape(h, SUPER, w, SUPER).mean(axis=(1, 3))
    m = cov >= 0.45
    m = m | m[:, ::-1]  # exact left-right symmetry
    # trim empty rows so the star sits on its points, not in a box
    ys = np.nonzero(m.any(axis=1))[0]
    return m[ys.min() : ys.max() + 1]


def outline(im: Image.Image, colour: tuple[int, int, int]) -> Image.Image:
    a = np.asarray(im.convert("RGBA"))
    h, w = a.shape[:2]
    out = np.zeros((h + 2, w + 2, 4), np.uint8)
    out[1 : h + 1, 1 : w + 1] = a
    solid = out[:, :, 3] > 0
    edge = np.zeros_like(solid)
    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
        edge |= np.roll(np.roll(solid, dy, 0), dx, 1)
    edge &= ~solid
    out[edge] = (*colour, 255)
    return Image.fromarray(out)


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    made = []
    for w in SIZES:
        m = star_mask(w)
        img = np.zeros((*m.shape, 4), np.uint8)
        img[m] = (*YELLOW, 255)
        im = outline(Image.fromarray(img), BLACK)  # bright shape: black edge, like the bandanas
        cx = (im.width - 1) / 2
        xs = np.nonzero(np.asarray(im)[:, :, 3])[1]
        assert (xs.min() + xs.max()) / 2 == cx, f"{w}: off centre"
        im.save(OUT / f"star-{w}.png")
        made.append((f"star-{w}", im.size))

    # a sheet on the EGA blue the phones use, next to a captain's hat for scale
    scale, pad = 8, 12
    ims = [Image.open(OUT / f"star-{w}.png") for w in SIZES]
    hat = OUT / "hat-navy-24.png"
    if hat.exists():
        ims.append(Image.open(hat))
    cw = sum(i.width * scale + pad for i in ims) + pad
    ch = max(i.height for i in ims) * scale + 2 * pad
    sheet = Image.new("RGB", (cw, ch), (0, 0, 0xAA))
    x = pad
    for im in ims:
        big = im.convert("RGBA").resize((im.width * scale, im.height * scale), Image.NEAREST)
        sheet.paste(big, (x, pad), big)
        x += big.width + pad
    sheet.save(OUT / "sheet-star.png")

    for name, size in made:
        print(f"{name:12} {size[0]}x{size[1]}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
