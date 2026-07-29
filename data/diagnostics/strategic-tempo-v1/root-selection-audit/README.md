# Root-selection audit

Common mechanism: **none demonstrated**

Diagnostic recommendation: **C — isolated, non-generalizable cases**

- `2eac0bd16e43`: stochastic near tie; the captured action was the unique raw-MCTS winner.
- `d8c69cdbde8d`: the captured action was a post-root tactical-verification override.
- `f197c3b937e4`: terminal-value saturation created exact root ties; tactical verification then
  selected the captured action.

All three are seed- and enumeration-sensitive, but that sensitivity acts through different
mechanisms and does not justify a shared selector change. The focused extra round was not run
because the prerequisite—three cases explained by the same two-candidate near tie—was false.

The machine-readable detailed reconstruction is in `detailed-audits.json`. Curves and raw
observations are in the three CSV files and `individual-results.json`. No strategic progress
signal, territorial rule, or production selector change is included.
