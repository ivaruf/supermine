# SUPERMINE — Adventure Mode Roadmap

What is planned beyond the current build, in rough order. This is the design
backlog that came out of the depth-levels discussion — kept here so the ideas
survive between sessions and so each one can be checked against the two rules
that have held up so far:

1. **An upgrade changes what you can DO, not just a number** (the drill tiers
   cross real hardness thresholds; a lift level buys access to a stratum).
2. **Feel over feature count.** A short loop that is tense and readable beats a
   complete feature list that plays like a spreadsheet.

Where an item leans on machinery that already exists, that is called out —
most of this roadmap is cheaper than it looks because the engine underneath
(persistent carve masks, deterministic geology, the day counter, the pile
system, the event bus) was built to carry it.

---

## SHIPPED — v1.7.0

### Depth levels: the elevator
The mine entrance is a lift. Levels snap to the geological strata, are
purchased progressively ("Level 3 — Silver Veins — $1,200"), and each mine's
levels finance the next mine's rights. Riding is free; boarding and choosing
SURFACE is extraction; the HUD gauge is distance-to-exit while absolute depth
lives on the lift's big red LED boards in the world. This is the VERTICAL
expansion axis of the owner's two-axis sketch; rails (NEXT) are the horizontal.

Why it leads the roadmap: the 3× deeper mines created a commute problem, and
the lift converts the commute into a purchased checkpoint — the same shape
SteamWorld Dig and Spelunky landed on. It also establishes the pattern
everything in the NEXT section follows: **money → permanent, per-mine,
physically visible infrastructure.**

---

## NEXT — rails & checkpoints (the horizontal axis)

*(Corrected against the owner's side-view sketch: fuel and deposit do NOT hang
on the lift stations, as an earlier draft of this section had it. They hang on
RAILS built horizontally into a level. A mine expands two ways —*

```
    ELEVATOR                    the mine, seen from the side
   +--------+   +---------------------------------------------+
   |        |   |  lvl 1        rails -> o------o------o       |
   |        |   |---------------------------------------------|
   |        |   |  lvl 2                                       |
   | buys   |   |---------------------------------------------|
   | DEEPER |   |  lvl 3                                       |
   |        |   |---------------------------------------------|
   |        |   |  lvl 4                                       |
   +--------+   +---------------------------------------------+
                     rails buy FURTHER OUT, per level
```

*— the elevator (shipped, v1.7.0) buys depth; rails buy reach.)*

- **A checkpoint** is purchased at a distance out along a level, progressively
  pricier with distance and depth — the lateral twin of the level ladder. The
  rail draws physically from the station to it: owned ground, visible.
- **FUEL at a checkpoint** refuels at a markup, so the surface fill stays the
  sensible early default while deep lateral work becomes possible at a price.
- **DEPOSIT at a checkpoint SECURES the hold** — safe from stranding, credited
  when you next surface. Deliberately not instant banking: extraction stays the
  loop's heartbeat; what dies is the hold-pressure round trip, and what is
  gained is that ore already carried to a checkpoint survives a strand.
- **Rails are a fast lane**: the free-travel gear gets a further multiplier on
  your own rail, so built ground feels built.
- **Lighting mains** stay on this list (a lit radius around stations and
  checkpoints, growing with tier — the worklight language, cached gradients).

Why the two axes matter together, from the lift's own verification report:
fuel pressure is now LATERAL (rails answer it the way the elevator answered
depth), and levels raise $/minute rather than $/run (a deposit checkpoint
raises $/run — reach and throughput become different purchases).

## THEN — levels with identity

Once levels exist, they can carry events. **The day counter already exists and
rolls on every sale**, so anything with a repair or recovery timer comes almost
free.

- **Cave-ins.** A level is blocked until cleared — pay a crew (days + money) or
  dig through it yourself (fuel + time). Pairs naturally with a **hydraulic
  supports** rig upgrade that prevents them (see the machine backlog below).
- **Flooding.** A discovered-but-drowned level: buy the pump-out, wait the
  days, own the level. A different acquisition verb than "buy".
- **Gas pockets.** A stratum hazard that gates on a ventilation/cooling tier
  the way heat already gates depth — a second use for an existing gate shape.
- **Found infrastructure.** Some levels are discovered rather than bought:
  abandoned workings with pre-carved drifts *(the generator already produces
  timbered drifts deterministically — this is flagging, not new tech)*.

---

## MACHINE BACKLOG — from the original brief, still unbuilt

- **Explosive charges.** The frozen engine already exposes
  `SM.particles.explode(x, y, radius, damage, force)` — this is a rig slot, a
  cost, and a cooldown away from existing. The natural answer to "the drill
  chews granite too slowly and I only need one wall gone."
- **Hydraulic supports.** Prevent cave-ins on the level you are working;
  pairs with the cave-in event above. Visible as bracing on the hull.
- **Automated ore collection.** A trailing collector drone/arm — a collect
  radius that keeps working while you drill. Late-game, expensive, visible.
- **Auxiliary fuel tanks / underground caches.** Mostly superseded by the
  fuel depot (which is better because it is *placed*), but a droppable cache
  could be the poor-man's depot before stations are owned.

Every one of these must appear on the machine. `rig.getPartFlags()` is the
contract; the workshop draws the real renderer, so a bought upgrade that is
not visible is a bug by definition.

---

## WORLD & ECONOMY

- **The Rift as levels of content.** 3,600 m stops being one long shaft with a
  prize at the bottom: each stratum gets its own character and its own
  motherlode. The per-mine layer tables already support this; it is level
  design, not engineering.
- **Scanner as a planning tool.** With multiple entry points, "gold signature
  at 780 m" becomes a decision — work it from Level 5 above, or buy Level 6
  and come at it from below. Possibly a prep-screen survey view that shows
  known signatures per level.
- **Richer company identity.** Slot cards and the map showing the empire:
  "Mines: 3 · Levels: 11 · Day 47." The `seen` field and per-mine records
  already persist; this is presentation.
- **New regions.** The map's region system (Foothills → Frostpeak → Cinder
  Fell → the Rift) extends naturally; a new mine is a data entry in
  `mines.js` plus map art hooks that already exist.

---

## LATER — way down the line

### Monsters in the depths, and weapon systems
Not scoped, deliberately — but written down so the earlier layers are built
with it in mind.

The design constraint that should survive until then: **threats must attack
the run, not add a twitch-combat layer.** The mode's tension is fuel, cargo,
hull and distance-from-exit; a creature is interesting here as a moving
pressure on those — it drains the tank you budgeted, chews the hull you have
to pay to repair, scatters the hold you were carrying — not as a health-bar
duel. If a fight ever feels like a separate game glued on, it is wrong.

What the engine already gives it:

- **Damage plumbing exists.** `adv.damage()`, armor-as-divisor, the always-on
  HULL gauge and repair economy were built for ram impacts and heat — a
  monster is another caller.
- **The darkness is the atmosphere engine.** Something moving at the edge of
  the headlight radius is frightening with zero new tech; the lights tier
  suddenly becomes a defensive stat, which is exactly the "upgrades change
  what you can do" rule paying out again.
- **Depth-gates come free.** Strata already gate by hardness and heat;
  creatures gate the deepest levels the same way, giving lift levels combat
  identity ("Level 6 is where things live") and the scanner a new job —
  contacts that *move*.
- **The first weapons are already on the machine.** The drill is a melee
  weapon by construction, and `SM.particles.explode()` sits unused in the
  frozen engine waiting for the explosive-charges rig slot above. A dedicated
  weapon system would be the ninth rig category — note that the workshop and
  `getPartFlags()` contract currently assume eight, so that seam is the first
  thing to widen.

What it genuinely costs, which is why it is LATER: creature entities live
outside the particle pool (new actor system), pathfinding through the carve
mask, AI that respects streaming/persistence, and a balance pass over every
pressure at once. None of it is small.

## TECH DEBT — known, measured, parked

- **The balance pass is DEFERRED by owner decision** until the core mechanics
  (elevator, rails, checkpoints) settle — numbers tuned now would be tuned
  against a leash that is still changing shape. Known items for that pass:
  Blackstone rights measure 7.3 previous-mine runs vs the intended 1.5–4; the
  fuel-tank ladder was sized for surface round trips and needs re-anchoring
  once checkpoint refuelling exists; the whole income ladder re-measured after
  both expansion axes land (`SM.mines.audit()` is the tool).

- **Frame rate headroom.** Adventure sits ~42 fps against a ~70 ceiling; the
  remainder is the shaft rock pattern fill and strata polylines in
  `advterrain.render`. Real (confirmed with GPU raster), not yet player-hurting.
- **Wider resident window.** The spatial hash wraps at 2944 × 5888 world
  units; the streaming window is clamped at 2800 × 5600. If a future feature
  needs a bigger live area, `GRID_COLS` must be raised — documented in
  ADVENTURE.md, silent corruption if ignored.
- **Pile keep-clear vs. slab height.** With a maxed magnet, a dumped heap has
  a narrow band to respawn in and can wait until you return. Correct but
  tunable if it reads oddly in play.
- Small UI edges: two map regions revealing at once show one toast; the
  garage view includes the collector-field ring.

---

*Classic TIME ATTACK and FREESTYLE are frozen: every item above is adventure-
side, and the seed-424242 terrain histogram remains the regression gate.*
