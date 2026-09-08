# sparkle — a high-value deposit revealed (value 80+, or rare loot collected).
#
# The reward sound, and the one most likely to become shrill: it can fire 10
# times a second alongside break and clank. Kept as a soft two-note bell with
# a gentle attack, not a bright ping — the information is "something good",
# which a warm sound carries as well as a piercing one and survives repetition
# far better.
use_random_seed 8802

with_fx :reverb, room: 0.5, mix: 0.20 do
  with_fx :lpf, cutoff: 112 do
    synth :pretty_bell, note: :e6, attack: 0.004, decay: 0.16, sustain: 0,
          release: 0.20, amp: 0.26
    sleep 0.055
    synth :pretty_bell, note: :b6, attack: 0.004, decay: 0.12, sustain: 0,
          release: 0.16, amp: 0.16
  end
end
