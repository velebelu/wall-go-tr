# Methodology

This is a diagnostic-only audit. Production MCTS and official configuration are not modified.
The Vitest harness wraps `getLegalActions` only for the exact audited root snapshot. Descendant
nodes use the unmodified generator. Every order experiment preserves the legal action set.

Budget curves use 25, 50, 100, 150, 250, 500, 750 and 1,000 simulations with five adjacent
Mulberry32 seeds. The seed sweep uses 32 adjacent seeds at the fixture's captured playable
configuration. Order sensitivity holds seed and budget fixed and changes root enumeration only.

Reported `rawAction` is the MCTS maximum-visits/then-mean result. Reported `action` is the
playable result after the already-enabled tactical verification. Values are not rounded before
comparison. RNG calls include expansion tie shuffles, UCT ties, rollouts, final ties and tactical
verification.
