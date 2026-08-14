# SUPERMINE — ADVENTURE MODE: Architecture & Working Contract

**Read this fully, then read `ARCHITECTURE.md`, before touching anything.**
`ARCHITECTURE.md` documents the engine and is still accurate — the particle
system, the event contract, the material table and the performance notes all
apply unchanged. This document adds the second game mode on top of it.

Four agents build this **in parallel on one repo**. The file-ownership table is
not advisory.

---

## 0. What we are building

Classic SUPERMINE is a 60-second score attack: the machine drives itself, you
steer left and right, the clock runs out.

**ADVENTURE MODE** keeps the engine and changes the game around it:

* You **drive** — free 2D movement on a translucent joystick. No auto-advance.
* You own a **company**: cash, a day counter, a machine, and mining rights.
* You pick a **mine** from a world map, buy **fuel**, and descend.
* You fill a **cargo hold** that has volume, not just value.
* You **come back up** and sell, or you strand and lose the load.
* You **upgrade the machine** in a workshop, and the upgrades change what you
  can reach, not just what the numbers say.

The loop: **Prepare → Enter → Explore → Drill → Fill → Push or run → Escape →
Sell → Upgrade → Unlock.**

The feeling we are chasing, in one sentence: *coming up with a full hold should
feel good, and deciding whether to go deeper should be genuinely difficult.*

### Two decisions already made for you

**No gravity.** The engine has none — `particles.js` is frozen and its debris is
slowed by drag, not by falling, and every material's `friction`/`restitution` is
tuned for that. Adventure movement is therefore **direct 2D drive**: the machine
crawls where the stick points and stops when the stick centres. It is a tracked
digger chewing through material that closes around it, not a jetpack. This keeps
a frozen, tuned, load-bearing module untouched. Sell it in the *feel* — weight,
inertia, the hull grinding to a halt against rock it cannot cut.

**Mines are wide, and the window is a rectangle.** *(Revised. This originally read
"the shaft is a fixed-width column", because `particles.js` could only despawn on
a Y line, which forced the streamer to keep the full width resident.)*
`particles.js` now also exports
`despawnOutsideRect(minX, minY, maxX, maxY, keepLoose)`, so `advterrain.js`
windows in **both** axes. `ADV.MINE_HALF_WIDTH` is **2600** — 5200 units, 520 m
across — and width is nearly free: the screen only ever shows ~2000 units, so a
wider mine costs no extra resident particles and no extra draw calls, only a
bigger carve mask (one byte per cell: 64 KB for Old Creek, ~435 KB for The Rift).

**The limit on the window is the SPATIAL HASH, not the pool.** `particles.js`
wraps its grid with a bitmask over `GRID_COLS x GRID_CELL` = **2944** units in x
and `GRID_ROWS x GRID_CELL` = **5888** in y. Two live particles further apart than
that alias into the same hash cell and collision detection corrupts **silently**,
with no error to trace. `advterrain.js` clamps the live extent to 2800 x 5600 for
exactly that reason, and the clamp covers loose debris too — a heap dumped 3000
units away would otherwise stay live and break the hash on its own. Measured peak
live extent in play: 2778 x 1896. Widening the *mine* further is cheap; widening
the *window* past those numbers means raising `GRID_COLS`.

---

## 1. File ownership

### FROZEN — nobody edits these

```
index.html       js/config.js     js/events.js     js/particles.js
js/input.js      js/main.js       js/level.js      js/upgrades.js
js/ui.js         js/sound.js      style.css
```

The plumbing you need in those files is **already done** (§2). If you are
convinced you need more, say so in your report and route around it for now —
do not edit them and do not let your work depend on a change to them. The one
legitimate exception is a genuine bug: fix it minimally and flag it loudly.

### Agent 1 — RUN & FEEL

```
js/adv.js  (new)      js/vehicle.js      js/camera.js
```

### Agent 2 — PROGRESSION & PERSISTENCE

```
js/mines.js  (new)    js/rig.js  (new)   js/save.js  (new)
```

### Agent 3 — GEOLOGY & WORLD

```
js/advterrain.js (new)  js/scanner.js (new)  js/terrain.js  js/materials.js
```

### Agent 4 — INTERFACE & PRESENTATION

```
js/advui.js (new)  js/advhud.js (new)  js/joystick.js (new)
style-adventure.css (new)              js/effects.js
```

### Rules that make parallel work safe

1. **Never edit a file you do not own.** Not a one-line fix, not a typo.
2. **The stub APIs are contract.** Every new file already exists with its full
   exported surface and a documented header. Other agents are coding against
   those names *right now*. **Add** functions freely; do not rename, remove, or
   change the meaning or units of what is there. If a signature is genuinely
   wrong, implement it as specified, then say so in your report.
3. **Your constants go at the top of a file you own**, in the
   `/* ----- Agent-N tunables ----- */` block that is already there. Do not add
   to `js/config.js`. `SM.config.ADV` is shared and frozen — read it.
4. **Cross-module talk is events or documented getters.** Never reach into
   another module's closure state.
5. **Feature-detect across the seam.** While the others are still working,
   their modules are stubs returning zeros and nulls. Your file must not throw
   when `SM.rig.getFuelCap()` returns a placeholder or `SM.advterrain.probe()`
   returns null. Guard, default, carry on. This is also what keeps the build
   runnable at every point during the parallel phase.
6. **`SM.particles.data` is read-only.** Writing those typed arrays corrupts the
   pool bookkeeping.
7. **Classic mode must not regress.** Both existing modes have to play exactly
   as they do today. Every branch you add is `if (adventure) ... else <exactly
   what happened before>`.

---

## 2. Plumbing that already exists

Do not rebuild any of this.

### `SM.config.ADV` — shared constants (frozen)

```
METERS_PER_UNIT 0.1     MINE_CEILING_Y 0        MINE_HALF_WIDTH 2600
SPACING 21              SOLID_BUDGET 5200       STREAM_MARGIN 240
CAM_ZOOM 0.80           EXIT_RADIUS 200
SAVE_KEY / SAVE_SLOTS 3 / SAVE_VERSION 1
```

Depth in metres is `(y - MINE_CEILING_Y) * METERS_PER_UNIT`, clamped at 0.
Orientation is unchanged from classic: **-y is up / towards the surface**.

### `SM.input` — the movement vector (frozen, already implemented)

```js
SM.input.setStick(x, y)     // js/joystick.js pushes here; magnitude clamped to 1
SM.input.clearStick()
SM.input.isStickActive()
SM.input.getMove()          // REUSED {x, y, mag} — never stash it
SM.input.getMoveX() / getMoveY() / getMoveMag()
```

W/A/S/D and all four arrows already feed the same vector, diagonals are
normalised, and the keyboard wins over the stick while a key is held. `getSteer()`
is untouched — classic mode is unaffected.

### `js/main.js` — loop integration (frozen, already implemented)

```js
// one fixed step
input.update -> (adv.update | level.update) -> terrain.update -> vehicle.update
   -> particles.update -> [upgrades.update if classic] -> camera.update
   -> effects.update -> sound.update -> ui.update -> [advhud.update if adventure]

// render, inside the world transform
terrain -> particles -> [upgrades if classic] -> vehicle -> effects
   -> [adv.renderWorld if adventure]
      = scanner.render -> effects.renderDarkness -> advterrain.renderLit
        (renderLit is the EMISSIVE pass: the lift's red level boards draw AFTER
         the darkness because a lit sign is a light source, not lit geometry —
         drawn before it they were crushed to black at starter lights)
```

* `SM.adv.holdsSim()` zeroes the fixed-step accumulator on every meta screen.
  The world still renders behind the map; time does not pass. Do **not** use
  `SM.main.setPaused()` for this — it emits `game:paused`, which opens the
  classic pause card.
* `SM.main.restart()` delegates to `SM.adv.restart()` while adventure is active.
* `init()` order: `mines → rig → save` early (pure data), then
  `advterrain → scanner → joystick → advhud → advui → adv` after `ui.init()`.

### `js/ui.js` — the handoff (frozen, already implemented)

An **ADVENTURE** card sits on the main menu. Tapping it adds `sm-adv` to
`#ui-root`, takes the menu down, and calls `SM.adv.open()`. `ui.update()`,
the classic pause card and the summary are all disabled while adventure is
active. `SM.ui.leaveAdventure()` puts the menu back — `SM.adv.close()` must
call it.

---

## 2b. The lift (depth levels) — seams as shipped

The mine entrance is a lift; purchasable stations snap to the geological
strata. Station cage: circle of radius `ADV.EXIT_RADIUS` at
`(getMouthX(), yOfDepth(depthM))`.

```
SM.adv.getLevels()            LIVE [{i,name,depthM,y,price,owned}], i=0 surface
SM.adv.getLevel()             station the run is based at
SM.adv.buyLevel(i)            next unowned level only; LEGAL MID-RUN — advterrain
                              re-cuts the shaft through resident rows on
                              `lift:bought` (reopenLift), verified end-to-end
SM.adv.rideTo(i)              free; i=0 extracts; needs getBoardable() >= 0
SM.adv.getBoardable()         deep cages boardable by definition; only the
                              SURFACE keeps the leave-first arming rule (a deep
                              station acts only on explicit rideTo, so arming
                              would just lock a returning machine out)
SM.adv.getDistanceToExit[M]() distance to the NEAREST OWNED station — the
                              reserve maths and TURN BACK follow automatically
SM.mines.levelsOf(id)         [{name,depthM,price,layerIndex,rate}]
SM.save                       mines[id].levels = integer count (no holes)
Events: lift:bought {i,price,mineId}   lift:ride {from,to}
```

Machine spawn/park at a station sits `ADV_SPAWN_Y` (120 units = 12 m) below the
station centre — remember it when asserting depth in tests. Descending
auto-buys a full tank (partial if cash is short); the prep fuel widget is gone.
The shaft is STRUCTURAL carving derived from ownership at generation time — it
must never be written into the player mask (mask ones == carved count is the
regression check).

## 3. Module contracts

Each new file carries its full contract in its own header — **read the file you
own before you start; it is written for you and it contains design direction,
not just signatures.** The short version:

| Module | Owns |
|---|---|
| `SM.adv` | state machine, fuel/cargo/heat/integrity, the ledger, run lifecycle |
| `SM.rig` | eight part categories, tiers, prices, derived stats, visual flags |
| `SM.mines` | mine catalogue, layer tables, material prices and volumes |
| `SM.save` | three slots in localStorage, per-mine tunnel persistence |
| `SM.advterrain` | deterministic geology, the carve mask, 2D streaming |
| `SM.scanner` | ore signatures through rock |
| `SM.joystick` | the translucent thumbstick → `SM.input.setStick()` |
| `SM.advhud` | in-mine gauges, adventure pause |
| `SM.advui` | slots, world map, workshop, prep, results |

### The seams that cross an ownership line

These are the ones to get exactly right, because two agents meet at each.

| Seam | Producer | Consumer |
|---|---|---|
| `SM.rig.getPartFlags()` → machine geometry | 2 | 1 (`vehicle.js` render) |
| `SM.rig.get*()` stats → movement, drill, lights | 2 | 1, 3, 4 |
| `SM.mines` layer tables → generation | 2 | 3 |
| `SM.mines.priceOf/volumeOf` → cargo & selling | 2 | 1, 4 |
| `SM.advterrain.exportMask()` ↔ `SM.save.encodeMask()` | 3 | 2 |
| `SM.adv.getPiles()` / `consumePile()` → dropped cargo respawn | 1 | 3 |
| `SM.adv.burnFuel/addHeat/damage/offerCargo` | 1 | 1 (`vehicle.js`) |
| `SM.advterrain.probeAll()` → scanner contacts | 3 | 3 |
| `adv:state` event → which screen is up | 1 | 4 |
| `SM.adv` getters → gauges | 1 | 4 |
| `SM.effects.renderDarkness(ctx)` → the headlight | 4 | 1 (`adv.renderWorld`) |

`SM.adv.renderWorld(ctx)` is the single world-space hook adventure mode gets.
It must call, in this order: `SM.scanner.render(ctx)` then
`SM.effects.renderDarkness(ctx)`. Agent 1 owns the call; Agents 3 and 4 own the
bodies.

---

## 4. New events

Namespace `noun:verb`. **Payload objects must be reused** if they can fire more
than a few times a second, exactly as in the existing engine.

| Event | Payload | Emitted by |
|---|---|---|
| `adv:state` | `{state, prev}` | adv |
| `adv:entered` | `{mineId, depth}` | adv |
| `adv:extracted` | `{gross, cargo, depthM, reason}` | adv |
| `adv:stranded` | `{reason, depthM, lost}` | adv |
| `adv:cash` | `{cash, delta, reason}` | adv |
| `adv:fuellow` | `{pct}` | adv |
| `adv:cargofull` | `null` | adv |
| `adv:dumped` | `{matIndex, units, x, y}` | adv |
| `adv:rig` | `{partKey, tier}` | adv |
| `adv:rights` | `{mineId, price}` | adv |
| `adv:day` | `{day}` | adv |
| `adv:heat` | `{pct}` | adv |
| `adv:damage` | `{integrity, source}` | adv |
| `scan:contact` | `{matIndex, dist, bearing}` | scanner |
| `mine:layer` | `{name, depthM}` | advterrain |

Add more if you need them; document them in your report.

---

## 5. Performance budget — non-negotiable

The engine's cost is **rasterisation**, not physics (`ARCHITECTURE.md` §10).
Adventure mode makes that harder in two specific ways, so:

* **Resident solids ≤ `ADV.SOLID_BUDGET` (5200).** The shaft is 1760 wide at
  `SPACING` 21 — about 84 deposits per row — so the streamed slab may be roughly
  60 rows tall. Trim **every** edge (`despawnOutsideRect`, both axes);
  adventure players drive back up. Watch `SM.particles.getStats().free` and keep
  the classic `DEBRIS_RESERVE` discipline: the graceful failure is "streaming
  pauses", never "pool exhausted".
* **The darkness composite is full-screen blending.** One radial gradient and
  one fill, not a per-particle lighting pass. If it costs more than a couple of
  milliseconds it is wrong.
* **No DOM work in the fixed step.** `advhud.update()` is called from inside the
  fixed step and can run several times per rendered frame. Guard every write
  with a "did the string change?" check and never read a layout property.
* **The scanner probes on a cycle, not every step.**
* Target: **60 fps on a mid-range phone**, 120 in headless Chrome, zero console
  errors across a full expedition and a clean return to the menu.

---

## 6. When you are done

1. **Verify by running it.** `python3 -m http.server 8000`, then drive a full
   expedition: menu → adventure → new company → map → buy rights → prep → buy
   fuel → descend → drill → fill the hold → come back up → sell → workshop →
   buy an upgrade → descend again. Confirm the tunnels you dug are still there.
2. **Regression-test classic.** TIME ATTACK and FREESTYLE must play exactly as
   they do today, including the pause menu, the summary and the high scores.
3. **Check the console.** Zero errors, zero warnings.
4. **Report**: what you implemented, every new event and exported function, every
   constant another agent may want to tune, anything you had to work around, and
   anything you believe is wrong with this contract.

Prioritise **feel over feature count**. A short expedition that is tense,
readable and satisfying beats a complete feature list that plays like a
spreadsheet. If you run short on time, cut scope — never cut polish on what you
do ship.
