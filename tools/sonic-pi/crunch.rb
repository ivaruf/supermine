# crunch — many deposits collapsing at once (26+ in one step).
#
# Rarer than break (one per 160 ms at most) so it can afford to be an event.
# Still kept low and short: it stacks on top of the grinder bed, and anything
# with a long tail turns a collapse into mud.
use_random_seed 7714

with_fx :lpf, cutoff: 96 do
  with_fx :reverb, room: 0.25, mix: 0.10 do
    # Rubble: two offset noise bodies so it tumbles rather than thuds once.
    synth :noise, attack: 0.002, decay: 0.11, sustain: 0, release: 0.06,
          cutoff: 84, amp: 0.60
    sleep 0.035
    synth :noise, attack: 0.002, decay: 0.08, sustain: 0, release: 0.05,
          cutoff: 74, amp: 0.38
  end
end
