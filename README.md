# SUPERMINE

A browser mining-rig prototype inspired by the "spectacular mining" mobile-game ads —
except the game actually plays the way the ads look.

Drive an industrial mining vehicle up through a field of thousands of physical
particles. Terrain erupts into tumbling rubble, loot is magnetically hoovered into
the hopper, and every upgrade gate visibly bolts more machinery onto the rig until
it occupies most of the lane.

## Run it

No build step, no dependencies — open `index.html` directly in a browser
(Chrome/Edge/Firefox/Safari), or serve the folder if you prefer:

```
python3 -m http.server 8000
# then http://localhost:8000
```

## Controls

| Input | Action |
|---|---|
| A / D or ← / → | steer |
| Mouse / touch drag | steer |
| R | restart |
| M | mute |

## The run

One replayable ~3.5–5 minute level: SURFACE CUT → IRON LANES → THE GRANITE WALL →
GOLDFIELDS → THE THROAT → GEM HOLLOWS → DEEP BARRIER → CRYSTAL CAVERNS →
PRESSURE LOCK → THE MOTHERLODE → THE CORE. Paired upgrade gates offer a SAFE or a
HARD route — harder rock, rarer loot, stronger upgrades. 13 upgrade effects, all
repeatable with tiered falloff, all visible on the machine.

## Roadmap

Adventure mode's design backlog lives in `ROADMAP.md` — the lift/depth-level
plan, station infrastructure, level events, and the unbuilt machine upgrades.

## Code

Plain ES5-style JavaScript on a single `SM` namespace, classic script tags (works
from `file://`), Canvas 2D. See `SPEC.md` for the design brief and
`ARCHITECTURE.md` for module APIs, the event contract, and performance notes.
The engine simulates ~5,000+ pooled particles with a spatial hash, sleeping, and
pre-baked sprite atlases; a full run holds 120 fps in headless Chrome with zero
console errors.
