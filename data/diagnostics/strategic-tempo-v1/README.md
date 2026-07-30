# Diagnóstico de tempo estratégico MCTS

Análisis pasivo: no modifica la selección de MCTS ni la configuración humana congelada.

- Trazas diagnósticas: 36
- Trazas humanas pre-V3 revisadas: 4
- Decisiones MCTS examinadas: 932
- Ocurrencias sospechosas: 22
- Casos independientes: 22
- Fixtures mínimos: 13
- Empates estadísticos próximos: 18
- Casos redundantes confirmados posteriormente por comparación contrafactual: 3

Las etiquetas son diagnósticas. `redundant` exige una ventana posterior medible y una
alternativa con ventaja contrafactual; no se utiliza para modificar decisiones.

Las trazas V3 no se leen ni se modifican.

La investigación está cerrada con decisión `no-change`. Véanse
[FINAL-CONCLUSION.md](FINAL-CONCLUSION.md) y [final-decision.json](final-decision.json).
