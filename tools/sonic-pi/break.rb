# break — a single deposit cracking.
#
# The hottest sound in the game: play() lets one through every 50 ms, so at
# full drill this fires 20 times a second. It therefore has to read as
# TEXTURE, not as an event. Dark, dry, under 60 ms, no tail to overlap the
# next one, and no high end — the clank and sparkle layers own that range and
# three bright layers at once is what made the old mix rasp.
use_random_seed 2401

with_fx :lpf, cutoff: 86 do
  # The body: a filtered noise tick. Decay short enough that two back-to-back
  # breaks read as two, not as a smear.
  synth :noise, attack: 0.001, decay: 0.035, sustain: 0, release: 0.015,
        cutoff: 78, amp: 0.55
  # A little pitched weight underneath so it has mass rather than being hiss.
  synth :tri, note: :c2, attack: 0.001, decay: 0.05, sustain: 0, release: 0.02,
        amp: 0.30
end
