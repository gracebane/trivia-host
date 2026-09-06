# assets

Images for the trivia app and the tooling that renders them.

- `originals/` — source photos, untouched
- `ega/` — 16-colour EGA renders (Monkey Island 1990 look)
- `ega.html` — interactive converter: drop an image, move sliders, watch it change
- `ega.py` — the same conversion from the command line; output lands in `ega/`

## Interactive

Double-click `assets/ega.html`, or open it in a browser. Drop in an image and
adjust. Nothing is uploaded — it all runs in the page. Presets sit at the top
left; **Warm bar photo** is the one tuned for dim indoor shots.

It shows the equivalent `ega.py` command for whatever the sliders are set to, so
the way to batch a folder is: tune one image here, copy the command, swap the
filename for a glob. Your settings are remembered between visits.

## Command line

```
python3 assets/ega.py assets/originals/photo.jpg
python3 assets/ega.py assets/originals/*.jpg --sat 1.6 --contrast 1.15 --spread 0.22 --matrix 4
python3 assets/ega.py --help
```

The two are the same pipeline: box-filter downscale → brightness, contrast,
saturation → nearest EGA colour with dithering → nearest-neighbour upscale. The
browser version is a port of the Python one, verified pixel-identical on a PNG
source at default settings. Change one, change the other.

JPEG sources can differ by a few percent of pixels between the two, because
Chrome and Pillow decode JPEG slightly differently. It is not visible.

Slide thumbnails for a deck are a separate pipeline: `scripts/deck2pack.py`.
