# impact — a stone thud, only when a collapse is huge (65+ destroys in a step).
#
# Rare enough to be the one destruction sound allowed real weight. Almost all
# of it is under 200 Hz so it lands in the chest without fighting the grinder
# bed, which lives in the 600-3000 Hz band.
use_random_seed 5150

with_fx :lpf, cutoff: 72 do
  with_fx :reverb, room: 0.4, mix: 0.16 do
    # A pitch drop is what makes a thud read as mass hitting ground.
    synth :sine, note: :c2, note_slide: 0.13, attack: 0.002, decay: 0.30,
          sustain: 0, release: 0.14, amp: 0.85
    control note: :f1
    synth :noise, attack: 0.002, decay: 0.16, sustain: 0, release: 0.10,
          cutoff: 70, amp: 0.40
  end
end
