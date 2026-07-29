# Final conclusion: strategic-tempo investigation

## Decision

```text
status: closed
decision: no-change
recommendation: reject-general-modification
reason: isolated-non-generalizable-cases
```

The investigation is closed. The frozen official MCTS configuration must remain unchanged.

## Chronology and evidence

1. **Initial observation.** Diagnostic play occasionally produced movements that appeared
   inefficient inside already controlled territory. This was an observation to investigate, not
   evidence that every internal movement was useful or useless.

2. **`securedTerritoryPolicy`.** A candidate filtering policy was designed and evaluated. Its
   counterfactual results were worse, so the approach was rejected and remains disabled. See the
   secured-territory diagnostic evidence referenced by [README.md](README.md).

3. **Broad diagnostic.** The retained sample contained 36 diagnostic traces and four attributable
   pre-V3 human traces. Across 932 MCTS decisions, 22 independent movements were initially marked
   suspicious. The classification was observational: 12 mobility-improving, five future-wall
   preparation, one strategic repositioning and four ambiguous. See
   [diagnostic-report.json](diagnostic-report.json).

4. **Counterfactual comparison.** Thirteen representative states were replayed with paired seeds.
   The immediate-progress alternative had mean effect **-0.56** territory points. The persistent
   policy had mean effect **-1.36** and intervened in **54.5%** of AI decisions. These causal
   counterfactual results rejected both a general `strategicProgressScore` and a persistent
   progress tiebreak. See [counterfactual/aggregate-report.json](counterfactual/aggregate-report.json)
   and [counterfactual/METHODOLOGY.md](counterfactual/METHODOLOGY.md).

5. **Confirmed redundant cases.** Three individual alternatives were beneficial in the paired
   pilot and were provisionally reclassified as redundant: `2eac0bd16e43`, `d8c69cdbde8d` and
   `f197c3b937e4`. Three cases do not establish a population frequency.

6. **Root-selection audit.** The three states were reconstructed across budgets, seeds and legal
   action orders. The audit separated the raw root winner from the later tactical-verification
   result. See [root-selection-audit/README.md](root-selection-audit/README.md) and
   [root-selection-audit/detailed-audits.json](root-selection-audit/detailed-audits.json).

7. **Different causes.**

   - `2eac0bd16e43`: a stochastic near tie; the recorded movement uniquely won raw MCTS by 24
     visits to 22.
   - `d8c69cdbde8d`: deliberate post-root tactical replacement of a raw winner that permitted an
     immediate terminal loss.
   - `f197c3b937e4`: terminal-value saturation, exact ties, RNG selection and a stable top-two slice
     that excluded the raw winner.

   Because these mechanisms differ, no common limited correction was demonstrated.

8. **Tactical-saturation audit.** A selected corpus of 13 historical diagnostic states plus six
   reproducible synthetic normal controls produced 152 paired decisions. Within this deliberately
   selected diagnostic corpus, exact maximum ties occurred in **44.7%**, multiple saturation in
   **91.4%**, the raw winner was outside the tactical top two in **28.9%**, and reversing storage
   order changed the final action in **46.7%**. These values describe this enriched diagnostic
   corpus only; they are not estimates for all games or all MCTS decisions. Tactical scores were
   screening measurements, not win rates. See
   [tactical-saturation-audit/METHODOLOGY.md](tactical-saturation-audit/METHODOLOGY.md) and
   [tactical-saturation-audit/aggregate-results.json](tactical-saturation-audit/aggregate-results.json).

9. **Rejected tactical variants.** Always including the raw winner still retained substantial
   order sensitivity and changed useful controls. Exact-tie and saturation expansions activated
   too broadly and changed normal/useful controls. The deterministic representative sample removed
   order sensitivity only by changing most decisions and requiring preliminary evaluation of all
   children. No variant passed the prerequisite for a competitive league, so no league was run.

10. **Final decision.** The evidence does not justify changing the definitive AI without material
    regression risk. The correct action is no change.

## Approaches not adopted

- No prohibition on movement inside own territory.
- No tempo penalty or `strategicProgressScore`.
- No progress-based or persistent tempo tiebreak.
- No general adaptive tactical-candidate expansion.
- No change to `tacticalCandidateCount`.
- No general MCTS budget increase.

The diagnostic artifacts describe experiments only. None of these rejected variants is an
implemented production policy.
