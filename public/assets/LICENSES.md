# Built-in sticker/SFX pack — sources & licenses

Bundled with the app so a project always has a few usable overlays and sound
effects with no copyright risk on TikTok/Shopee. Keep this file in sync with
any sticker/SFX added later.

## Stickers (`assets/stickers/*.png`)
Source: [Twemoji](https://github.com/twitter/twemoji) by Twitter, Inc.
License: **CC-BY 4.0** — attribution required.
Attribution: "Graphics by Twemoji."

20 files, 72×72px PNG, downloaded 2026-11-14:
fire, laugh, wow, eyes, heart, thumbsup, check, cross, party, money, cart,
star, pin, love_eyes, clap, point_right, warning, 100, thinking, cry.

## SFX (`assets/sfx/*.mp3`)
Source: **self-generated** with ffmpeg (`sine`/`anoisesrc` synthetic tones),
2026-11-14 — not derived from any recording, so no license/attribution
applies.

6 files: ding, pop, whoosh, error, success, click.

## Adding more later
- Any new Twemoji file: same CC-BY 4.0 terms, no extra step needed.
- A different source (Kenney.nl SFX/music, Pixabay, OpenMoji, GIPHY/Tenor):
  add its own license line here before shipping it, and add it to
  `LIBRARY_ASSETS` in `src/api.ts` (server allowlist) — a file not in that
  allowlist cannot be inserted into a project from the picker.
