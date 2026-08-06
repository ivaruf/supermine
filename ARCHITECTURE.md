# SUPERMINE — Architecture & Working Contract

**Read this fully before touching anything.** Phase 1 built the engine and the vertical
slice. Phases 2 and 3 run **in parallel on the same repo**, so the file-ownership rules
below are not advisory — breaking them means merge conflicts and a broken build.

---

## 0. Ground rules

| Rule | Detail |
|---|---|
| No build step | Plain HTML/CSS/JS. Open `index.html` from `file://` and it runs. |
| No libraries | No Three.js, no npm, no CDN, no fonts, no images. Everything procedural. |
| Classic scripts only | **Never** use `import`/`export` or `type="module"` — ES modules are blocked on `file://`. |
| One global | Everything hangs off `SM`. Each file starts with `var SM = SM || {};` and assigns `SM.<module> = (function(){...})();` |
| No new files | The 14 JS files + `index.html` + `style.css` are the complete set. |

### World orientation (memorise this)

```
                      -y   = FORWARD (the vehicle drives "up" the screen)
                       ^
        -x  <----------+---------->  +x
                       v
                      +y   = BEHIND the vehicle
```

* `x` is clamped to the lane: `[-LANE_HALF_WIDTH, +LANE_HALF_WIDTH]` = `[-640, +640]`.
* Distance travelled / "depth" is `SM.config.START_Y - vehicle.getY()` and is always ≥ 0.
* **There is no gravity.** This is a top-down excavation view. Loose material is slowed
  by per-material drag and stopped by collisions, never by falling.

---

## 1. File ownership

### FROZEN — nobody edits these

```
index.html      js/main.js      js/config.js
js/events.js    js/input.js     js/particles.js
```

If you believe you need a change in a frozen file, you almost certainly need an **event**
or a **new constant at the top of a file you own** instead. The one legitimate exception
is a genuine bug; fix it minimally and say so loudly in your report.

### Agent 2 — GAMEPLAY owns

```
js/materials.js   js/terrain.js   js/vehicle.js   js/upgrades.js   js/level.js
```

### Agent 3 — PRESENTATION owns

```
js/camera.js   js/effects.js   js/sound.js   js/ui.js   style.css
```

### Rules that make parallel work safe

1. **Constants go at the top of a file you own**, in the `/* ----- Agent-N tunables ----- */`
   block that is already there. Do not add to `js/config.js`.
2. **Public API signatures must not change.** `main.js` calls a fixed set of functions in a
   fixed order (§3). Adding new exported functions is fine; changing or removing existing
   ones is not.
3. **Cross-module talk is events or documented getters only.** Never reach into another
   module's closure state, and never add a direct call from a file you own into a file the
   other agent owns beyond the getters listed in §4.
4. **New events are encouraged.** Namespace them `noun:verb` (`upgrade:offered`,
   `fx:screenflash`). Document new ones in your report.
5. `SM.particles.data` is **read-only**. Writing to those typed arrays bypasses the pool
   bookkeeping and will corrupt the simulation.

---

## 2. Module map & load order

`index.html` loads these as classic scripts, in this exact order:

| # | File | Module | Depends on (at runtime) |
|---|---|---|---|
| 1 | `js/config.js` | `SM.config` | — |
| 2 | `js/events.js` | `SM.events` | — |
| 3 | `js/materials.js` | `SM.materials` | — |
| 4 | `js/input.js` | `SM.input` | config, events |
| 5 | `js/camera.js` | `SM.camera` | config, vehicle (getters) |
| 6 | `js/particles.js` | `SM.particles` | config, events, materials, camera |
| 7 | `js/terrain.js` | `SM.terrain` | particles, upgrades, camera, vehicle |
| 8 | `js/vehicle.js` | `SM.vehicle` | config, input, particles, events |
| 9 | `js/upgrades.js` | `SM.upgrades` | vehicle, camera, events |
| 10 | `js/level.js` | `SM.level` | upgrades, vehicle, events |
| 11 | `js/effects.js` | `SM.effects` | materials, camera, vehicle, events |
| 12 | `js/sound.js` | `SM.sound` | vehicle, events |
| 13 | `js/ui.js` | `SM.ui` | everything, events |
| 14 | `js/main.js` | `SM.main` | everything |

Load order only guarantees that the objects **exist**. All the cross-references above
happen at *runtime*, inside `update()`/`render()`, so circular references are fine.

---

## 3. Call order — the contract `main.js` enforces

### `SM.main.init()` (once, on DOMContentLoaded)

```
input.init(canvas)
particles.init()
camera.init()
resize()                 <- viewport known before anything reads camera bounds
vehicle.init()
upgrades.init()
level.init()             <- MUST run before terrain: it places the gates
terrain.init()           <- carves gate openings while generating
effects.init()
sound.init()
ui.init()
```

### One fixed simulation step (60 Hz, `dt = 1/60`)

```
input.update(dt)
level.update(dt)
terrain.update(dt)       <- stream in ahead / recycle behind
vehicle.update(dt)       <- steer, CUT, move, push state into particles
particles.update(dt)     <- integrate, rebuild hash, relax, sleep
upgrades.update(dt)      <- gate crossing test, progression zoom
camera.update(dt)
effects.update(dt)
sound.update(dt)
ui.update(dt)
```

Why: terrain must generate before the cutter reaches it; the vehicle cuts *before*
particles integrate so debris moves on the same step it is created; camera follows the
final vehicle position; effects/sound/ui only ever react to what already happened.

### Render (once per animation frame)

```
ctx.setTransform(dpr,0,0,dpr,0,0)        base transform, CSS pixels
fill background
save(); camera.applyTransform(ctx)       -> world space
    terrain.render(ctx)                  background, bedrock walls, depth ruler
    particles.render(ctx)                the field + debris
    upgrades.render(ctx)                 gates (under the machine)
    vehicle.render(ctx)                  the machine
    effects.render(ctx)                  dust / sparks / rings (on top)
restore()                                -> screen space
vignette
```

The DOM overlay (`#ui-root`) floats above the canvas; `ui.js` never draws to canvas.

### `SM.main.restart()`

```
vehicle.reset(); camera.reset();   <- position AND default zoom first, because
particles.reset();                    terrain sizes its window from camera bounds
upgrades.reset(); level.reset();   <- gates cleared, then re-placed
terrain.reset();                   <- repopulates the pool
effects.reset(); sound.reset(); input.reset();
events.emit('run:reset', null)
```

Triggered by the `input:restart` event (R key, RESTART button, or anyone emitting it).

---

## 4. Public API reference

Only the members listed here are contract. Anything else you find in the source is
internal and may be changed by its owner.

### `SM.config` — frozen constant table

Read freely. See the file for grouped, commented values. Coupled values to be aware of:

* `LANE_HALF_WIDTH` ⟷ `CAM_ZOOM` ⟷ `TERRAIN_SPACING` ⟷ `PARTICLE_CAPACITY`.
  The lane must fill most of a 16:9 viewport at the default zoom or the screen reads as
  two black bars. Widening the lane multiplies the particle count quadratically.
* `MAX_SPEED * FIXED_DT` **must stay below `GRID_CELL`** (currently 15 < 23) or the 3×3
  neighbourhood scan can miss contacts.
* `SPRITE_MAX_RADIUS * 2` **must stay ≤ `GRID_CELL`** (currently 22 ≤ 23).

### `SM.events` — synchronous pub/sub *(frozen)*

```js
SM.events.on(name, fn)      // returns an unsubscribe function
SM.events.off(name, fn)
SM.events.once(name, fn)
SM.events.emit(name, payload)
SM.events.clear([name])
SM.events.count(name)
```

* Handlers run **synchronously inside `emit()`**. A handler that throws is caught and
  logged; it never breaks the frame.
* **Payload objects are REUSED** by the hot emitters. Read what you need immediately.
  Never stash the payload object, never push it into an array.

### `SM.materials` — data table *(Agent 2)*

```js
SM.materials.list          // array, indexed by the Uint8 stored per particle
SM.materials.breakStyles   // {crumble, fracture, burst} presets
SM.materials.count
SM.materials.get(index)    // -> material object
SM.materials.getById('gold')
SM.materials.indexOf('gold')  // -> numeric index, 0 if unknown
```

**Never reorder or delete entries in `list` — append only.** Indices are baked into the
particle arrays and the sprite atlases.

### `SM.input` *(frozen)*

```js
SM.input.getSteer()          // -1 (full left) .. +1 (full right)
SM.input.isPointerDown()
SM.input.consumeFirstGesture()
SM.input.reset()
```

Emits `input:firstgesture`, `input:restart` (R), `input:mutetoggle` (M).

### `SM.camera` *(Agent 3)*

```js
SM.camera.update(dt)
SM.camera.applyTransform(ctx)
SM.camera.shake(strength)        // ~3 = rumble, ~35 = big hit
SM.camera.setZoomTarget(z)
SM.camera.getZoom() / getScale() / getX() / getY()
SM.camera.getViewBounds()        // REUSED {minX,minY,maxX,maxY}
SM.camera.worldToScreen(x,y)     // REUSED {x,y}
SM.camera.screenToWorld(x,y)     // REUSED {x,y}
SM.camera.setViewport(w,h)       // called by main.js on resize
SM.camera.reset()
```

`getViewBounds()` returns a **reused object** — `terrain.js` and `particles.js` both call
it every frame for culling and streaming. Do not cache the reference across frames, and
do not stop returning a live rectangle.

> **`upgrades.js` currently drives `setZoomTarget()` every step** (progression zoom-out).
> If Agent 3 wants full camera authority, coordinate: either remove that call from
> `upgrades.js` (Agent 2's file) or have the camera treat it as one input among several.

### `SM.particles` *(frozen — the heart of the game)*

```js
// lifecycle
SM.particles.init() / reset() / update(dt) / render(ctx)

// spawning
SM.particles.spawnSolid(x, y, matIndex [, radius])   // -> slot index or -1
SM.particles.spawnLoose(x, y, matIndex, vx, vy, radius [, value])

// interaction
SM.particles.damageSolidInRect(minX, minY, maxX, maxY, damage, originX, originY)
SM.particles.queryRect(minX, minY, maxX, maxY, fn)   // fn(index) per overlap
SM.particles.explode(x, y, radius, damage, force)
SM.particles.collectInRadius(x, y, radius)
SM.particles.rebuildGrid()

// plumbing pushed in by the vehicle every step
SM.particles.setCollectorTarget(x, y, radius) / clearCollectorTarget()
SM.particles.setVehicleBody(cx, cy, halfW, halfH, vx, vy) / clearVehicleBody()

// streaming
SM.particles.despawnBehind(y) / despawnAhead(y)

// introspection
SM.particles.getStats()          // REUSED {active, solid, loose, collected, free}
SM.particles.getActiveCount() / getLooseCount() / getSolidCount() / getCapacity()
SM.particles.FREE / SOLID / LOOSE / COLLECTED    // state constants
SM.particles.data                // READ-ONLY typed arrays (see below)
```

`damageSolidInRect()` returns a **reused object**:

```js
{ broken,      // deposits destroyed this call
  damaged,     // deposits touched this call
  resistance,  // summed hardness of material that SURVIVED -> drives slowdown
  value }      // currency value of what broke
```

`data` exposes the raw storage for advanced read-only use:
`x, y, vx, vy, r, hp, value, rot, state, mat, asleep, activeList, activeCount`.

### `SM.terrain` *(Agent 2)*

```js
SM.terrain.init() / reset() / update(dt) / render(ctx)
SM.terrain.getGeneratedTo()   // most-forward y that has been generated
SM.terrain.setSeed(n)
```

### `SM.vehicle` *(Agent 2)*

```js
SM.vehicle.init() / reset() / update(dt) / render(ctx)
SM.vehicle.applyUpgrade(id)      // -> effect descriptor, or null if unknown
SM.vehicle.getUpgradeEffect(id)

// STABLE GETTERS — other modules depend on these; do not rename or change units
SM.vehicle.getX()               // world x
SM.vehicle.getY()               // world y (decreases as you advance)
SM.vehicle.getWidth()           // full lateral span, max(blade, body+tracks)
SM.vehicle.getSpeed()           // current forward speed, world units / second
SM.vehicle.getMiningPower()     // hardness points removed per second
SM.vehicle.getCollectRadius()   // magnet radius
SM.vehicle.getBladeWidth()
SM.vehicle.getBladeFrontY()     // y of the cutting edge
SM.vehicle.getBank()            // visual tilt, radians
SM.vehicle.getLateralSpeed()
SM.vehicle.getResistance()      // smoothed blocked hardness (0 = clear rock)
SM.vehicle.isTransforming()
SM.vehicle.getUpgradeCount()
SM.vehicle.getStat(name)        // 'power'|'blade'|'collect'|'speed'|'upgrades'
```

### `SM.upgrades` *(Agent 2)*

```js
SM.upgrades.init() / reset() / update(dt) / render(ctx)
SM.upgrades.addGate({id, upgradeId, x, y, width?, label?, description?})
SM.upgrades.getGates()          // LIVE array — terrain.js reads it to carve openings
SM.upgrades.clearGates()
SM.upgrades.trigger(upgradeId)  // apply with no gate; -> true/false
```

### `SM.level` *(Agent 2)*

```js
SM.level.init() / update(dt) / reset()
SM.level.getProgress()   // 0..1  — main.js and ui.js rely on this
SM.level.getDistance()
SM.level.isComplete()
```

### `SM.effects` *(Agent 3)*

```js
SM.effects.init() / reset() / update(dt) / render(ctx)
SM.effects.dust(x, y, matIndex, count, speed)
SM.effects.sparks(x, y, matIndex, count, speed)
SM.effects.ring(x, y, radius, life, r, g, b)
SM.effects.flash(x, y, size, matIndex)
SM.effects.getCount()
```

### `SM.sound` *(Agent 3)*

```js
SM.sound.init() / update(dt) / reset()
SM.sound.play(name)   // 'break' 'hit' 'collect' 'impact' 'gate' 'upgrade'
SM.sound.setMuted(b) / toggleMute() / isMuted()
```

### `SM.ui` *(Agent 3)*

```js
SM.ui.init() / reset() / update(dt)
SM.ui.toast(title, subtitle, seconds)
SM.ui.getCurrency()
```

### `SM.main` *(frozen)*

```js
SM.main.restart()
SM.main.getFps() / getStepMs()
SM.main.getCanvas() / getContext()
SM.main.getViewportWidth() / getViewportHeight()
SM.main.isRunning()
```

---

## 5. Event contract

### Emitted by the engine (Phase 1). Payload shapes are exact.

| Event | Payload | Emitted by | Frequency |
|---|---|---|---|
| `material:hit` | `{material:string, matIndex:int, x, y, intensity:0..1}` | particles | ≤3 / step (rate limited) |
| `material:destroyed` | `{material:string, matIndex:int, x, y, value:number}` | particles | **up to ~150 / step** |
| `resource:collected` | `{material:string, matIndex:int, x, y, value:number}` | particles | **up to ~30 / step** |
| `impact:heavy` | `{strength:0..1, x, y}` | particles | ≤1 / step |
| `gate:passed` | `{id, upgradeId, x, y}` | upgrades | rare |
| `gate:missed` | `{id, upgradeId, x, y}` | upgrades | rare |
| `upgrade:applied` | `{id, title, description}` | upgrades | rare |
| `level:started` | `null` | level | on init/reset |
| `level:complete` | `{distance}` | level | once per run |
| `run:reset` | `null` | main | on restart |
| `input:firstgesture` | `null` | input | once |
| `input:restart` | `null` | input / ui | on demand |
| `input:mutetoggle` | `null` | input | on demand |
| `sound:muted` | `boolean` | sound | on toggle |

### Two hard rules for handlers

1. **Payload objects are reused.** `material:destroyed` fires with the *same object*
   every time. Read the fields you need inside the handler and let it go. Storing the
   reference means you are holding a value that mutates under you.
2. **`material:destroyed` and `resource:collected` are hot.** At full tilt that is ~5 000
   handler invocations per second, each. Anything you do in those handlers must be O(1)
   and allocation-free, and any spawning must come out of a **per-step budget**
   (see `FX_BUDGET_PER_STEP` in `effects.js` for the pattern). Do not `console.log`,
   do not build strings, do not allocate objects.

### New events

Freely allowed. Namespace `noun:verb`. Suggested future ones so we don't collide:
`upgrade:offered`, `upgrade:chosen`, `zone:entered`, `combo:started`, `vehicle:overdrive`,
`fx:screenflash`, `fx:slowmo`.

---

## 6. The particle system — what it can already do

`js/particles.js` is frozen and material-agnostic. Everything below is available now.

### Storage & pooling

Struct-of-arrays over pre-allocated typed arrays, capacity `PARTICLE_CAPACITY` (7 500).
Three O(1) swap-remove index lists:

* `freeStack` — the object pool.
* `activeList` — every live particle (grid build, despawn, render).
* `dynList` — **only** `LOOSE` + `COLLECTED`. The dense static field never enters the
  physics loop, so simulation cost tracks debris count (~200), not total count (~5 000).
  This is the single most important performance property of the engine.

### Spatial hash

Uniform grid, `GRID_COLS × GRID_ROWS` (128×256) cells of `GRID_CELL` (23) world units,
indexed with a bitmask so it tiles infinitely as the world scrolls — no allocation, no
re-indexing. Wrap footprint is 2944 × 5888 world units versus a live window of roughly
1280 × 1300, so two different world cells can never alias. Rebuilt once per step from a
head/next linked list.

### States

| State | Behaviour |
|---|---|
| `SOLID` | Embedded terrain. Never integrated, never moves. Accumulates cutter damage against `material.hardness`. |
| `LOOSE` | Tumbling debris. Integrated, collides with solids and other debris, sleeps when settled. |
| `COLLECTED` | Flying to the collector. Collision ghost, homing only. |

### Sleeping

A `LOOSE` particle under `SLEEP_SPEED` for `SLEEP_TIME` sleeps: velocity zeroed,
integration and relaxation skipped. It **stays in the grid** so it is still an obstacle,
and any awake particle that pushes into it wakes it. Verified working.

### Collision

3 relaxation passes of positional correction per step; velocity response (restitution,
mass-weighted by `density`) on the first pass only — applying it every pass injects energy
and makes piles boil. Solids are treated as infinite mass.

### Collection feel — the two non-obvious bits

1. **`COLLECT_DELAY` (0.34 s)** — fresh debris is *immune to the magnet* while it erupts
   and tumbles. Without this the collector swallows fragments the instant they spawn and
   destruction reads as "tiles vanishing" instead of "ground erupting". Older settled
   debris has no immunity, so driving past a pile vacuums it up.
2. **Homing is STEERING, not force.** Each step a desired velocity is computed and the
   real velocity is lerped toward it, with a decaying tangential term for a curved arc.
   A naive "accelerate toward the target" implementation makes particles **orbit the
   collector forever and never arrive** — this was a real bug found in testing.

### Rendering

Per-material pre-baked sprite atlases: `SPRITE_SIZE_STEPS(8) × SPRITE_SHADE_STEPS(3)`
rows by `SPRITE_ROT_STEPS(8)` baked rotation columns, so the renderer never calls
`ctx.rotate()`. Cell size varies per size bucket and per material (glowing materials get
halo margin), which keeps the blended-pixel count down. Solids are bucketed by material
so we hammer one atlas at a time; debris draws last so it always reads on top. Damaged
deposits switch to the brightest shade row — free "cracking" feedback with zero extra
draw calls. Below `LOW_DETAIL_ZOOM` it falls back to colour-batched `fillRect`.

Particle radii are **quantised** to the atlas size buckets at spawn, so physics radius
always matches the drawn sprite exactly.

---

## 7. Adding a material (Agent 2) — no code outside `materials.js`

Append to `SM.materials.list`:

```js
{
  id: 'magma', name: 'Magma Rock',
  colors: ['#ff6a2b', '#a5300c', '#ffd08a'],  // [base, shadow, highlight] hex only
  hardness: 5.5,        // mining-power SECONDS to break one deposit
  value: 120,           // total currency, split evenly across its debris
  radius: [8.0, 11.0],  // world units; keep max <= SPRITE_MAX_RADIUS (11)
  density: 1.4,         // heavier -> thrown less far, wins collisions
  restitution: 0.4,     // 0..1 bounciness of the debris
  friction: 0.8,        // higher -> settles sooner (gold uses 0.95, "rolls less")
  debrisCount: 6,
  breakStyle: 'burst',  // 'crumble' | 'fracture' | 'burst', or a new preset
  glow: true,
  sparkle: 0.8,         // 0..1 weight for twinkle effects
  shape: 'chunk'        // optional: 'round' | 'chunk' | 'shard'
}
```

Then reference `SM.materials.indexOf('magma')` from `terrain.js`. `particles.js` rebuilds
its flat caches and bakes the new sprite atlas automatically in `init()`. Adding a new
`breakStyle` preset works the same way.

**Balance guide:** contact time is roughly `BLADE_DEPTH / vehicleSpeed` ≈ 0.17 s at the
starting speed, so a deposit breaks without slowing you if
`hardness < getMiningPower() * 0.17` (≈ 3.6 at the start). Anything harder blocks, which
feeds `resistance`, which slows the machine, which increases contact time — self-balancing
by design. That is the "denser stone / greater risk of slowing down" lever from the spec.

---

## 8. Adding an upgrade (Agent 2)

Append to `UPGRADE_EFFECTS` at the top of `js/vehicle.js`:

```js
drill_heads: {
  title: 'TRIPLE DRILL HEADS',
  description: 'Mining power +80%.',
  xPower: 1.8, xBlade: 1.15, xCollect: 1.0, xBody: 1.0, xSpeed: 1.0,
  parts: { drills: true }        // switches on extra geometry in render()
}
```

Supported keys: `xBlade`, `addBlade`, `xBody`, `xPower`, `addPower`, `xCollect`, `xSpeed`,
`parts`. Anything that changes a `*Target` value animates through the generic
`easeOutBack` morph automatically; `parts` flags just gate extra drawing.

Then place a gate from `level.js`:

```js
SM.upgrades.addGate({ id:'gate_2', upgradeId:'drill_heads', x:-260, y: C.START_Y - 3200 });
```

`terrain.js` reads `SM.upgrades.getGates()` while generating and carves the opening, so
gates must exist **before** the terrain band containing them is generated — which is why
`main.js` calls `level.init()` before `terrain.init()`.

---

## 9. Known rough edges & traps

1. **Progression zoom lives in `upgrades.js`.** It calls `SM.camera.setZoomTarget()` every
   step based on blade width. Agent 3 must coordinate before taking over zoom.
2. **Lane width vs. zoom-out.** The lane is a fixed 1280 units wide, so zooming out reveals
   *bedrock*, not more game. `camera.js` has a `MAX_WALL_VISIBLE` floor (300 units per
   side) that clamps the scale, and `upgrades.js` uses a deliberately gentle exponent.
   If Agent 2 adds many width upgrades, this needs revisiting together — probably by
   widening the lane *and* raising `TERRAIN_SPACING` to keep the particle budget.
3. **Terrain streaming is camera-aware.** It generates to `max(STREAM_AHEAD, visible +
   STREAM_VIEW_MARGIN)`, so zoom-outs never expose the world edge — but they *do* raise
   the particle count. `generateBand()` refuses to run when free pool slots drop below
   `DEBRIS_RESERVE + one band`, so the graceful failure is "streaming pauses", not "crash".
   Watch `getStats().free` if you add big fields.
4. **`START_CLEAR_RADIUS` matters.** The blade starts ~110 units in front of the vehicle
   origin. If you shrink the start pad, the machine begins buried.
5. **Sound is a stub.** Procedural WebAudio only, unlocked on the first gesture. Voice
   count and per-name rate limits exist because `material:destroyed` is so hot — keep
   equivalents when you replace the internals.
6. **`ui.update()` runs inside the fixed step**, so it can be called several times per
   rendered frame. Every DOM write is guarded by a "did the string change?" check. Keep
   that discipline or you will force layout 180 times a second.
7. **Screen shake saturates easily.** `impact:heavy` can fire several times a second while
   ploughing dense rock. Trauma accumulates and decays exponentially; small per-event
   values (2–20) are correct, big ones (30+) belong to upgrades and explosions only.
8. **Sprite atlases are rebuilt only in `particles.init()`.** Changing material colours at
   runtime will not take effect.
9. **The final spectacle zone doesn't exist yet.** `level.js` is a straight endless field
   plus one gate; `LEVEL_LENGTH` (34 000 ≈ 3 min) is a placeholder pace.
10. **Only one upgrade exists** (`wider_blade`) and there are no route choices yet.

---

## 10. Measured baseline (Phase 1, 1440×900, Chrome)

| Metric | Value |
|---|---|
| Particles on screen | ~5 000 solid + ~200 loose + ~150 in-flight |
| Draw calls / frame | ~4 000 |
| Simulation cost | 0.08 – 0.30 ms / step |
| Frame rate | 120 fps (headless, GPU raster, unthrottled) |
| Allocation churn | ~1 KB / frame, none of it in the particle hot loops |
| Pool | 7 500 capacity, steady state ~5 400 used, never exhausted over a 40 s run |

The simulation is essentially free; the budget is almost entirely **rasterisation**. If
frame rate becomes a problem, the lever is *blended pixels* (sprite cell margins, glow
halo size, particle count, DPR cap) — not the physics.

## 10. Post-integration notes (after the 3-agent build)

The parallel-work freeze in §1 has served its purpose — all three phases are merged
and verified. Notable seams closed during integration:

- **Value multiplier is applied at collection time.** Particle values are baked at
  spawn (`particles.js`), so the ORE REFINERY multiplier is applied where currency is
  accumulated: `ui.js` (`onCollected`, using its `multiplier:changed`-tracked state)
  and mirrored in `effects.js` so combo popups show the paid value.
- **Simulation start gate.** `main.js` holds the fixed-timestep accumulator at zero
  until `input:firstgesture` — the world renders behind the start overlay but time
  does not pass. Restart does not re-arm the gate.
- **Canonical gesture path.** `SM.input.noteGesture()` is exported; the start
  overlay's pointer handler (`ui.js`) routes through it so `input:firstgesture` fires
  exactly once for everyone (sim gate, audio unlock, overlay dismissal) regardless of
  whether the first gesture is an overlay click, a canvas drag, or a key press.

Full-run verification (headless Chrome 1440×900, scripted steering): 4.7-minute run
to `level:complete`, all 11 zones, 18 upgrades, 16 gates, 120 fps average, zero
console errors, clean restart.
