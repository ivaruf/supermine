# ui — menu and button click.
#
# 8 call sites here and 24 in supermine_adventure, so this is the sound the
# player hears most often outside the mine. A click is confirmation, not an
# announcement: it should be felt more than heard, and must never be the
# loudest thing in a menu.
use_random_seed 4417

with_fx :lpf, cutoff: 104 do
  # Woody rather than digital — a soft mallet tap ages better over hundreds of
  # presses than a filtered square blip does.
  synth :tri, note: :g4, attack: 0.001, decay: 0.030, sustain: 0,
        release: 0.020, amp: 0.34
  synth :noise, attack: 0.001, decay: 0.012, sustain: 0, release: 0.008,
        cutoff: 95, amp: 0.14
end
