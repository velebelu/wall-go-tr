# Diagnóstico separado: muros internos propios

Este diagnóstico es independiente de `inactive-scored-territory-selection`.

La traza oficial de `P02-1` no está disponible en V3-R1: el registro remoto conserva a P02 sin
partidas y `participants/P02/traces` contiene únicamente `.gitkeep`. Por ello no se afirma una
reproducción exacta del turno observado. Los fixtures de esta rama son sintéticos y reproducibles.

La hipótesis evaluada es más restrictiva: un muro solo se considera estrictamente interno cuando
ambos extremos estaban en el mismo componente, el componente era propio y sin fichas rivales, y
no cambia influencia rival ni movilidad exterior observable. El prototipo no se conecta a MCTS final.

Prioridad A: detectar únicamente pérdida territorial propia inmediata y conservar muros neutrales.
Las intervenciones B, C y D deben evaluarse por separado antes de considerar cualquier cambio de
producción. Esta rama no modifica V3-R1, su allowlist ni sus datos oficiales.

## Resultado de la primera evaluación

La evidencia persistida está en `evidence-v4/counterfactual-report.json`.

- El caso exacto de P02-1 no puede reproducirse: P02 sigue registrado con cero partidas y no
	existe una traza oficial.
- En el fixture de pérdida, el muro `(1,1) right` es estructuralmente interno, divide el
	componente y pierde 3 casillas propias al crear una subregión sin fichas.
- En el fixture neutral, el mismo tipo de muro divide el componente pero conserva exactamente el
	territorio propio.
- Las continuaciones emparejadas sintéticas produjeron 4 comparaciones beneficiosas frente al
	muro perjudicial y 4 neutrales frente al muro neutral; no constituyen una muestra humana.
- La selección MCTS global del fixture no debe confundirse con una reproducción de P02-1: el
	informe conserva por separado la acción global y la mejor acción de muro raíz.

Conclusión provisional: no se acepta ninguna intervención. Si una futura traza real demuestra la
pérdida territorial inmediata, solo debe evaluarse A, limitada a ese caso. B, C y D requieren
evidencia independiente; los muros neutrales no deben excluirse por esta investigación.