# Methodology

The corpus contains 13 retained strategic-tempo fixtures and six reproducible synthetic normal
states. Synthetic fixtures are explicitly marked as non-human and unrelated to V3. Eight adjacent
Mulberry32 seeds are used per state, for 152 paired root decisions at a 500-simulation staged
budget (250→500).

MCTS runs with the captured official configuration except that automatic tactical verification is
disabled so every variant receives the same root tree. The existing exported tactical verifier is
then run independently for each root child. Variants differ only in candidate-set construction.
The input array is also reversed while retaining identical visits, values and scores to isolate
storage-order sensitivity.

This screen measures candidate coverage, selected tactical score, activation, controls and timing.
It does not claim win-rate evidence. A competitive league is allowed only after a variant passes
all fixture, normal-control and order-stability conditions.
