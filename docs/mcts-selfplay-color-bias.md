# Autoenfrentamiento MCTS: metodología del experimento de sesgo de color

Este documento describe **cómo** está diseñado el experimento y **por qué**. Los resultados
numéricos no se copian aquí: viven en
`data/mcts-selfplay/final-2026-color-bias-v1/`, se generan automáticamente a partir de las
partidas y se regeneran con un comando, de modo que nunca pueden quedar desfasados respecto a
los datos.

- Informe técnico completo: `data/mcts-selfplay/final-2026-color-bias-v1/informe-tecnico.md`
- Resumen divulgativo: `data/mcts-selfplay/final-2026-color-bias-v1/resumen-bachillerato.md`
- Datos y validación: `data/mcts-selfplay/final-2026-color-bias-v1/README.md`

## Pregunta

Dos agentes MCTS idénticos no pueden diferir en habilidad. Si aun así uno gana más veces, la
causa tiene que estar en el sistema: el turno inicial, el orden de colocación, el consumo de
aleatoriedad o alguna asimetría de la implementación. El experimento mide si ese desequilibrio
existe y de qué tamaño puede ser.

## Cómo consume aleatoriedad el programa

Es la pregunta previa que condiciona todo el diseño. En
[`humanChallengeMCTS.ts`](../src/agents/humanChallengeMCTS.ts) cada decisión llama a
[`createPlayableMCTSRng(seed)`](../src/agents/mctsWorkerDecision.ts), que **crea un generador
nuevo** a partir de la semilla de esa decisión. No existe un estado aleatorio que se arrastre
entre decisiones ni entre partidas. Dentro de una decisión, ese generador alimenta la
selección UCT, la expansión, los rollouts (incluida la heurística, mediante una sustitución
temporal de `Math.random`), el desempate de la acción final y el desempate de la verificación
táctica.

De ahí se siguen dos consecuencias que el experimento aprovecha:

1. Una partida queda determinada por el par (semilla base de rojo, semilla base de azul), y es
   **independiente del orden de ejecución**. Se puede jugar aislada, en cualquier proceso, y
   sale igual. Por eso el experimento se puede paralelizar sin comprometer la validez.
2. La aleatoriedad se consume **en función del estado**, no como una cinta de números fijada de
   antemano. Esto es lo que impide un intercambio perfecto de flujos (véase más abajo).

## Emparejamiento

Cada pareja define dos flujos de semillas, α y β, en bloques disjuntos:

```
αBase = BASE + (pareja − 1) · 2000
βBase = αBase + 1000
semilla de una decisión = baseDeEseLado + índiceDeDecisiónDeEseLado
```

- Partida **directa**: α juega con rojo, β con azul.
- Partida **intercambiada**: β juega con rojo, α con azul.

Cada flujo juega exactamente una vez con cada color. Llamando `s₁` y `s₂` a la puntuación de
rojo en las dos partidas de la pareja, se obtienen dos contrastes **ortogonales**:

| Contraste | Fórmula | Qué mide |
| --- | --- | --- |
| Color | `(s₁ + s₂) / 2` | Ventaja de ser rojo (y, por tanto, de empezar) |
| Flujo | `(s₁ + 1 − s₂) / 2` | Suerte de una secuencia concreta de semillas |

El segundo funciona como **control negativo** del primero: si apareciera un desequilibrio de
color, el control indica si procede de las semillas o no.

### Lo que este emparejamiento no consigue

No es un esquema de *números aleatorios comunes* perfecto. Como el consumo depende del estado,
en cuanto las dos partidas de una pareja divergen —lo que ocurre casi de inmediato— las
tiradas dejan de ser comparables una a una. Lo que sí garantiza es que **ningún flujo quede
asignado sistemáticamente a un color**, que es la fuente de sesgo que estaba bajo nuestro
control. Reproducir las mismas tiradas en el papel contrario exigiría rediseñar la
arquitectura de aleatoriedad del agente, cosa que la congelación metodológica prohíbe.

## Por qué la unidad de análisis es la pareja

Las dos partidas de una pareja comparten sus dos flujos de semillas. No hay ninguna garantía de
que sean independientes, y una prueba binomial sobre las 200 partidas supone precisamente eso.
Si existiera correlación positiva dentro de la pareja, esa prueba daría un valor p demasiado
pequeño: parecería significativo algo que no lo es.

Por eso las **100 parejas** son las unidades independientes y todas las pruebas principales
operan sobre valores por pareja:

- **Bootstrap por conglomerados** (10 000 remuestreos de parejas, semilla fija) para el
  intervalo de confianza del 95 %. Con conglomerados de tamaño constante 2, la media de las
  medias por pareja coincide con la media global, así que remuestrear parejas es exactamente el
  bootstrap por conglomerados de la proporción.
- **Wilcoxon de rangos con signo** sobre las diferencias por pareja: no supone normalidad y
  tolera los empates, frecuentes en una escala {0; 0,25; 0,5; 0,75; 1}.
- **Prueba z** sobre las medias por pareja como comprobación cruzada.

La prueba **binomial exacta del signo** se conserva solo como análisis de sensibilidad, junto
con la **correlación intraclase** medida y el **efecto de diseño** que se deriva de ella. Si el
efecto de diseño está cerca de 1, ambas familias de pruebas coinciden y la sensibilidad
respalda el análisis principal; si se aparta, prevalece el análisis por parejas.

Además de la proporción de victorias se analiza la **diferencia de territorio**, que es
continua y por tanto más potente: detecta desequilibrios que el recuento de victorias, al
reducir cada partida a un bit, dejaría pasar.

## La desviación documentada: el reloj

El agente desplegado corta cada decisión a los 5 000 ms para no hacer esperar a la persona que
juega. Ese guardián se mide contra el reloj real, y en la confirmación final del modelo llegó a
cortar el 21,7 % de las decisiones. Offline eso tiene dos consecuencias inaceptables: el
resultado dependería de la carga de la máquina —el experimento no sería reproducible— y la
contención de CPU podría recortar más a un color que a otro, introduciendo justo el tipo de
asimetría que queremos medir.

La solución es inyectar un **reloj virtual congelado** por el parámetro `now`, que ya forma
parte de la firma oficial de `chooseHumanChallengeMCTSDecision`. Ningún parámetro de búsqueda
se modifica: simulaciones, exploración, profundidad, rollout, progressive widening, ordenación
heurística y verificación táctica quedan intactos. Todas las decisiones completan su
presupuesto de 250/500 simulaciones, igual para los dos colores. El validador exige que el
número de decisiones cortadas por tiempo sea exactamente cero.

## Aviso sobre el entorno de ejecución

Los comandos `npm run` pasan por `scripts/run-ts-node-esm.mjs`, que resuelve el `tsconfig.json`
de la raíz. Ese archivo solo declara *project references*, sin `compilerOptions`, de modo que
ts-node compila con el objetivo por defecto, **ES5**. Con ES5 y sin `downlevelIteration`,
`[...new Set(x)]` y `for (const [i, v] of arr.entries())` **producen resultados vacíos en
silencio**. Vitest transpila con esbuild y no comparte ese comportamiento, así que la batería
de tests no puede detectar esta clase de error por sí sola.

El código del experimento evita esos constructos y un test fija la huella de una partida
medida bajo ts-node, de modo que ambos entornos quedan atados. El motor de juego
(`src/engine`, `src/utils/ai`, `src/store`, `src/lib`) no contiene ninguno, así que el
experimento y la aplicación juegan partidas idénticas. Fuera del alcance de este experimento,
`src/utils/humanMCTSTrace.ts` y `src/agents/LearningAgent.ts` sí los usan; convendría revisarlo
si alguna vez se ejecutan por esta vía.

## Confundido por diseño

Rojo coloca la primera piedra y realiza la primera acción de la fase de juego en todas las
partidas, porque así lo dicen las reglas y este experimento no las altera. **Color y turno
inicial son, por tanto, indistinguibles aquí.** La posición inicial es exactamente simétrica al
reflejar el tablero en horizontal e intercambiar los colores —hay un test que lo comprueba—,
así que el color no tiene contenido geométrico: si apareciera una ventaja, la explicación
razonable sería el orden de juego, no la etiqueta del color. Demostrarlo por separado exigiría
un experimento distinto, con las reglas modificadas.
