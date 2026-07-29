# Diagnostic variants

- **A**: the current stable ranking by visits descending, then mean value descending, sliced to two.
- **B**: A plus the raw root winner when absent; at most three.
- **C3/C4/C6/C8**: exact maximum-visit and value ties, tolerance `1e-12`, capped.
- **D3/D4/D6/D8**: expand only when at least three candidates have mean exactly `1` or `-1`, capped.
- **E**: deterministic representative set: raw winner, top-ranked candidate, best preliminary tactical score and a different action type when available.

Every candidate's tactical score is measured by the existing one-ply worst-opponent-reply
verification. No territorial, progress or tempo signal is introduced.
