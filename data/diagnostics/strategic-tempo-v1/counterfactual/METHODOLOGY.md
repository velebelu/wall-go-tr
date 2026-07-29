# Metodología contrafactual de tempo estratégico

## Alcance

Piloto causal sobre 13 estados independientes: cuatro ambiguos, cuatro de movilidad, cuatro de
preparación de muro y uno de reposicionamiento. No usa trazas V3 ni modifica la política jugable.

## Acciones

- `original`: acción registrada.
- `immediate-progress`: candidato raíz con mayor clave lexicográfica de progreso.
- `conservative-tiebreak`: acción de la variante `value-0.025-visits-0.15`.
- `visit-control`: segundo candidato por visitas y después valor.

La señal ordena, en este orden: territorio confirmado; cierre/estructura/amenaza; movilidad
relativa; potencial de frontera o muro. Cada componente se conserva por separado.

## Variantes de empate

- `exact-value`: diferencia de valor exactamente cero.
- `value-0.01`: diferencia absoluta de valor menor o igual a 0,01.
- `value-0.025`: diferencia absoluta de valor menor o igual a 0,025.
- `value-0.05`: diferencia absoluta de valor menor o igual a 0,05.
- `value-0.025-visits-0.15`: además exige diferencia relativa de visitas menor o igual al 15 %.
- `saturated-equal`: igualdad exacta y ambos valores con valor absoluto uno.

## Emparejamiento

Tres semillas piloto por estado y acción. Tras la intervención inicial continúa la política MCTS
final normal contra el mismo rival heurístico. El experimento persistente aplica únicamente la
variante conservadora después de cada búsqueda normal, sin cambiar árbol, rollouts o evaluación.

## Etiquetas fijadas antes del análisis

El efecto es la diferencia territorial final de la alternativa menos la original, con las mismas
semillas.

- `beneficial`: límite inferior bootstrap mayor que cero, o media al menos +1 con dos de tres
  efectos positivos y ninguno menor que -1.
- `harmful`: criterio simétrico negativo.
- `neutral`: todos los efectos son cero.
- `inconclusive`: cualquier otro resultado.

Estas reglas son de cribado piloto y no autorizan adopción.
