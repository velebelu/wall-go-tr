# Auditoría de derrota humana g_e09743f2

## Resultado verificable

- Replay: correcto, 42/42 decisiones.
- Resultado: IA roja 5 – humano azul 32.
- La configuración congelada no se modificó.

## Punto causal

La amenaza emerge en el turno 34: la región disputada tiene {"size":44,"redStones":2,"blueStones":4}.
El turno 36 es la última oportunidad defensiva: {"size":39,"redStones":2,"blueStones":4}.
En el turno 38 la región queda sostenida por una sola ficha roja ({"size":35,"redStones":1,"blueStones":4})
y el cierre azul del turno 39 ya no puede evitarse; solo puede terminarse antes o reducir marginalmente el marcador.
Las distancias 3/2/1 son las del plan azul efectivamente observado, no una prueba exhaustiva de profundidad mínima.

## Explicación del salto

El movimiento azul 39 desplaza la última ficha azul necesaria y coloca el muro superior en (1,4).
La componente disputada de 35 celdas pierde su única ficha roja: 30 celdas quedan en una componente
exclusivamente azul. Por eso B pasa de 0 a 30 y la accesibilidad roja cae de 39 a 9.

## Evaluación

La evaluación solo contiene territorio consolidado (peso 10), movilidad (2), fichas atrapadas (8) y
expansión/accesibilidad (1). En el turno 38 todavía puntúa la posición antes de actuar con +17 para rojo,
aunque existe un cierre azul terminal a una jugada. Falta un término prospectivo para componentes grandes
disputadas sostenidas por una única ficha, abertura crítica y pérdida máxima de accesibilidad tras respuesta rival.

## Presupuesto adaptativo

El campo `simulations=250` es el presupuesto base configurado y no el ejecutado. `rootVisits=500`
demuestra que la misma raíz se amplió a 500. Ninguna decisión auditada quedó por debajo de 500; el límite
de 5.000 ms no impidió la ampliación en las posiciones críticas.

## Contrafactual

El piloto usa dos semillas emparejadas por candidata y la configuración final sin cambios para ambos colores.
Todos los continuadores terminan en derrota roja: no es evidencia de una acción ganadora, sino de reducción o
retraso del cierre. En turno 34 la acción real promedia 5,5–22,5 y evita una componente azul ≥20 en ambas
semillas; la alternativa de 31 visitas con heurística +26 colapsa inmediatamente 12–34. En turno 36 la acción
real promedia 6–26 y retrasa el cierre grande hasta 13/15 turnos de continuación. En turno 38 todas las
candidatas pierden; el colapso ya es inevitable y la mejor reducción observada queda alrededor de 7–30.

| Turno | Fuente | Acción | Visitas | Valor | Heurística tras acción | Marcador medio R–B | Máx. región B | Turnos a cierre |
|---:|---|---|---:|---:|---:|---:|---:|---|
| 34 | played+recorded-visits-35 | `{"type":"wall","from":{"x":4,"y":1},"pos":{"x":4,"y":1},"dir":"top"}` | 35 | -0.9714285714285714 | -20 | 5.5–22.5 | 12.5 | sin ≥20/sin ≥20 |
| 34 | recorded-visits-31 | `{"type":"move","from":{"x":4,"y":1},"pos":{"x":5,"y":0},"followUp":{"type":"wall","from":{"x":5,"y":0},"pos":{"x":5,"y":0},"dir":"left"}}` | 31 | -1 | 26 | 12.0–34.0 | 34.0 | 2/2 |
| 34 | recorded-visits-31+generated-defensive | `{"type":"move","from":{"x":4,"y":1},"pos":{"x":5,"y":0},"followUp":{"type":"wall","from":{"x":5,"y":0},"pos":{"x":5,"y":0},"dir":"right"}}` | 31 | -1 | -16 | 5.0–33.5 | 27.0 | sin ≥20/7 |
| 36 | played+recorded-visits-50 | `{"type":"move","from":{"x":1,"y":5},"pos":{"x":1,"y":6},"followUp":{"type":"wall","from":{"x":1,"y":6},"pos":{"x":1,"y":6},"dir":"top"}}` | 50 | -1 | -24 | 6.0–26.0 | 22.5 | 15/13 |
| 36 | recorded-visits-50 | `{"type":"move","from":{"x":4,"y":1},"pos":{"x":4,"y":2},"followUp":{"type":"wall","from":{"x":4,"y":2},"pos":{"x":4,"y":2},"dir":"right"}}` | 50 | -1 | -4 | 5.5–24.5 | 18.0 | 10/sin ≥20 |
| 36 | recorded-visits-50+generated-defensive | `{"type":"move","from":{"x":4,"y":1},"pos":{"x":4,"y":2},"followUp":{"type":"wall","from":{"x":4,"y":2},"pos":{"x":4,"y":2},"dir":"top"}}` | 50 | -1 | -24 | 7.5–26.0 | 26.0 | 10/11 |
| 38 | played+recorded-visits-56 | `{"type":"move","from":{"x":4,"y":1},"pos":{"x":4,"y":2},"followUp":{"type":"wall","from":{"x":4,"y":2},"pos":{"x":4,"y":2},"dir":"right"}}` | 56 | -1 | 4 | 6.5–29.5 | 24.0 | sin ≥20/5 |
| 38 | recorded-visits-56 | `{"type":"move","from":{"x":1,"y":6},"pos":{"x":0,"y":6},"followUp":{"type":"wall","from":{"x":0,"y":6},"pos":{"x":0,"y":6},"dir":"top"}}` | 56 | -1 | -1000000 | 7.0–33.0 | 33.0 | 0/0 |
| 38 | recorded-visits-55+generated-defensive | `{"type":"move","from":{"x":1,"y":6},"pos":{"x":0,"y":5},"followUp":{"type":"wall","from":{"x":0,"y":5},"pos":{"x":0,"y":5},"dir":"bottom"}}` | 55 | -1 | 17 | 7.0–30.0 | 30.0 | 2/5 |

Los datos completos están en `counterfactual_summary.json` (3 posiciones).

## Recomendación mínima

No cambiar presupuestos ni umbrales. La corrección mínima a validar en un experimento separado es añadir
a la evaluación/verificación táctica una penalización de amenaza de cierre territorial de una a tres jugadas,
basada en el tamaño de la componente expuesta, número de fichas propias que la mantienen conectada,
aberturas críticas y máxima caída contrafactual de accesibilidad. Primero debe probarse sobre estos fixtures
y controles negativos; no se adopta ni se activa en este informe.
