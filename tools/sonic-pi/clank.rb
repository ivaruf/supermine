# clank — cutter striking something valuable (material value 25+).
#
# Up to 9 a second, layered over break. Deliberately THIN: a narrow metallic
# ping with almost no body, so it cuts through the bed on information value
# without adding weight to a mix that already has break and the grinder in it.
use_random_seed 3390

with_fx :hpf, cutoff: 72 do
  with_fx :reverb, room: 0.3, mix: 0.14 do
    # Two inharmonic partials is enough to read as metal; more turns to bell.
    synth :tri, note: :a5, attack: 0.001, decay: 0.09, sustain: 0,
          release: 0.05, amp: 0.30
    synth :tri, note: :d6 + 0.4, attack: 0.001, decay: 0.06, sustain: 0,
          release: 0.04, amp: 0.18
  end
end
