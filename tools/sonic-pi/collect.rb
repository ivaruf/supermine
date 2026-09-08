# collect — one rung of the loot ladder.
#
# Rendered at C4 and pitch-shifted at runtime by playbackRate to walk the
# scale, so this must be ONE clean pitch with no vibrato, no chord and no
# noise transient — anything inharmonic here turns into a chirp when it is
# shifted up an octave for the top of a ladder.
#
# Up to ~18 of these a second during a torrent, so the tail has to be short
# enough that a fast run reads as separate notes rather than a chord.
use_random_seed 1206

with_fx :reverb, room: 0.3, mix: 0.14 do
  synth :pluck, note: :c4, attack: 0.001, decay: 0.14, sustain: 0,
        release: 0.10, amp: 0.55
end
