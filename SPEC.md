# SUPERMINE — Design Specification

Build a polished browser-game prototype inspired by the spectacular mining gameplay commonly shown in mobile-game advertisements.

The prototype must run directly in the browser using HTML, CSS and JavaScript. Use HTML Canvas for rendering. Three.js may be used if it meaningfully improves the result, but a high-performance 2D canvas implementation is preferred if it can deliver the desired visual density and physics.

## Core concept

The player controls a large industrial mining vehicle viewed from an elevated top-down or slightly isometric camera.

The vehicle drives continuously upward through a wide excavation field made from hundreds or thousands of small physical objects representing:

* rock
* dirt
* iron ore
* gold
* gems
* crystal deposits
* loose rubble

The world should feel dense, tactile and highly dynamic. Mining should not look like deleting square tiles. Material should break apart, tumble, roll, scatter, pile up and flow around the machine.

The central visual fantasy is watching a modest machine become an absurdly powerful mining rig capable of destroying huge sections of terrain in seconds.

## Gameplay loop

The vehicle advances automatically.

The player steers left and right using:

* A and D
* left and right arrow keys
* mouse or touch dragging

The machine continuously destroys material that enters its cutting area.

Destroyed resources become loose collectible particles or chunks. They should briefly interact with the environment before being pulled toward the vehicle or collected by trailing machinery.

Collected resources increase the player's currency and upgrade progress.

During each run, the player encounters upgrade choices, gates or upgrade stations. These should produce large, immediate and visible changes to the vehicle.

Example upgrades:

* wider cutting blade
* additional drill heads
* larger rotating grinder
* faster movement
* stronger mining power
* magnetic resource collection
* larger storage
* side-mounted cutters
* additional harvesting lanes
* explosive mining pulses
* improved resource multiplier
* rear collection conveyor
* temporary overdrive mode

The machine should begin narrow and relatively weak. By the end of a successful run, it should occupy much of the available lane and destroy enormous quantities of material.

## Look and feel

The experience should resemble an elaborate kinetic toy, marble machine and industrial excavation simulator combined.

Prioritise:

* constant visible motion
* large quantities of physical objects
* satisfying chain reactions
* exaggerated destruction
* bright resource colours
* chunky industrial machinery
* readable upgrade transformations
* rapid escalation
* dramatic particle effects
* strong visual feedback

The terrain should contain layered resource regions.

Example visual hierarchy:

* brown and grey dirt
* dark stone
* metallic iron
* bright gold
* emerald green gems
* electric blue crystals
* rare purple or glowing deposits

Valuable regions should be clearly visible before the player reaches them, creating route choices.

Use sparks, dust, impact flashes, screen shake and flying debris when dense deposits are destroyed. Effects must feel energetic without making the screen unreadable.

## Physics and material behaviour

The prototype should create the illusion of thousands of interacting objects without becoming too slow.

Use performance-conscious techniques such as:

* object pooling
* spatial partitioning
* simplified circle or particle collisions
* sleeping inactive particles
* limiting interactions to nearby objects
* instanced rendering where appropriate
* merging distant particles visually
* fixed timestep simulation
* capped particle counts
* lower-detail behaviour outside the camera focus

Materials should have slightly different physical characteristics.

Examples:

* dirt breaks easily and produces light debris
* stone requires more contact time
* gold is heavier and rolls less
* gems bounce and sparkle
* crystals fracture into sharp fragments
* rare deposits trigger larger visual bursts

Loose material should be able to:

* roll down slopes
* pile against barriers
* spill into trenches
* bounce from moving cutters
* get caught in conveyors
* be attracted by collection magnets
* form short-lived avalanches

The goal is not perfect physical realism. The goal is convincing, readable and satisfying motion.

## Vehicle design

The vehicle should be built from visible modular parts.

Possible parts include:

* central chassis
* front cutting blade
* rotating drill heads
* side grinders
* tracks or heavy wheels
* rear storage container
* conveyor belts
* collection funnels
* magnetic collector arms
* exhaust pipes
* warning lights

Each upgrade should visibly add, enlarge or modify machinery.

Do not represent upgrades only as numeric statistics. The player should immediately see the vehicle becoming wider, faster, heavier and more ridiculous.

Animated machinery should keep moving constantly:

* drill heads rotate
* grinders spin
* tracks move
* conveyors carry material
* collectors open and close
* pistons pump
* exhaust emits smoke
* warning lights flash

## Level structure

Create one replayable prototype level lasting roughly three to five minutes.

The level should contain:

* an easy opening section
* several resource-rich lanes
* hard stone barriers
* upgrade gates
* narrow passages
* wide resource fields
* large crystal formations
* one spectacular final excavation zone

Include meaningful left-right route choices.

One route might offer:

* easy resources
* a safe upgrade
* steady progression

Another might offer:

* denser stone
* rarer materials
* a more powerful upgrade
* greater risk of slowing down

The final section should allow the upgraded machine to demonstrate overwhelming power by destroying a huge, densely packed resource field.

## Upgrade presentation

Upgrade choices should interrupt the action as little as possible.

Good options include:

* driving through one of two gates
* choosing between two side lanes
* collecting enough material to trigger an automatic transformation
* passing through a machine-upgrade station
* selecting one of three large cards during a brief slow-motion moment

Use exaggerated transformation effects:

* metal parts slide into place
* additional cutters unfold
* drill heads multiply
* the machine widens
* sparks fly
* the camera briefly zooms
* the screen shakes
* large text announces the upgrade

## Camera and presentation

Use a smooth elevated camera that follows the vehicle.

The camera should subtly respond to progression:

* zoom out as the vehicle becomes wider
* shake during major impacts
* move slightly ahead to show upcoming choices
* slow down briefly during spectacular upgrades
* pull back for the final resource field

Keep the player and upcoming route clearly visible.

## Audio

Add simple generated or freely usable placeholder audio where practical.

Include:

* grinding loops
* stone impacts
* metallic clanks
* collection chimes
* gem sparkles
* upgrade sounds
* low industrial engine noise
* escalating mechanical intensity

Provide a mute button.

Audio should enhance impact but must not be required to understand the game.

## Interface

Keep the interface minimal.

Display:

* current currency
* current mining power
* storage or collection multiplier
* run progress
* temporary upgrade notifications
* restart button
* mute button

Avoid cluttering the main spectacle.

## Technical requirements

The project must:

* run locally without a build step if possible
* include a clear index.html entry point
* work with keyboard and mouse controls
* support touch input where practical
* resize cleanly with the browser window
* maintain good performance on a typical laptop
* avoid external paid assets
* use procedural shapes and simple generated art where possible
* be organised into understandable modules
* contain comments explaining important systems

Suggested module structure:

* main game loop
* renderer
* input controller
* vehicle system
* upgrade system
* terrain generator
* material particle system
* collision system
* camera controller
* effects system
* sound manager
* UI manager

## Development approach

Begin by implementing a small but convincing vertical slice:

1. A vehicle moves continuously upward.
2. The player steers left and right.
3. The vehicle breaks a dense field of physical rock particles.
4. Broken particles scatter and are collected.
5. One upgrade visibly widens the cutting mechanism.
6. Performance remains stable with a large number of objects.

Once the vertical slice feels satisfying, add:

* varied resources
* additional upgrades
* route choices
* conveyors and collection effects
* denser particle fields
* final spectacle sequence
* sound and polish

Prioritise feel over feature count.

The prototype succeeds when simply driving through a dense mineral field is visually impressive and enjoyable, even before progression systems are considered.

## Quality criteria

The final result should feel:

* spectacular
* tactile
* excessive
* kinetic
* colourful
* readable
* responsive
* progressively more powerful

Avoid making it resemble:

* a static tile-mining game
* an idle clicker
* a spreadsheet-style management game
* a conventional block-breaking game
* a slow realistic mining simulator

The most important experience is this:

A giant machine pushes into a seemingly solid landscape. The landscape erupts into thousands of moving fragments. Valuable material pours around the machine. The machinery expands and multiplies. Each upgrade makes the next collision more overwhelming than the last.
