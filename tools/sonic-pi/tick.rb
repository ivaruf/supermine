# tick — one per second while the clock is under ten seconds.
#
# Pure tension. It arrives when the player is already stressed and is the last
# thing they hear before a run ends, so it stays dry and small: no reverb, no
# pitch, nothing that rings into the next second. The dread comes from the
# regularity, not from the volume.
use_random_seed 6033

with_fx :bpf, centre: 88, res: 0.6 do
  synth :noise, attack: 0.0005, decay: 0.018, sustain: 0, release: 0.010,
        cutoff: 100, amp: 0.42
end
