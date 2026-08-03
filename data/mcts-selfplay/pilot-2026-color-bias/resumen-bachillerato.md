# Resumen sencillo del experimento de autoenfrentamiento

## ¿Qué queríamos saber?

En Wall Go siempre empieza el jugador rojo. Nos preguntamos si eso da alguna ventaja. Para
averiguarlo hicimos que la inteligencia artificial del proyecto jugara contra una copia
exactamente igual a ella misma. Como las dos son idénticas, si una gana más veces no puede ser
porque juegue mejor: tiene que ser por algo del propio juego, como el orden de los turnos.

## ¿Cómo lo hicimos?

Jugamos 10 partidas ordenadas en 5 parejas. En cada
pareja se juegan dos partidas iguales pero con los papeles cambiados: la serie de números
aleatorios que llevaba el rojo pasa a llevarla el azul. Así, si una serie de números tenía
suerte, esa suerte se reparte entre los dos colores y no falsea el resultado.

Todas las partidas usan exactamente la misma configuración de la IA, con semillas anotadas, de
modo que cualquiera puede volver a ejecutarlas y obtener el mismo resultado.

## ¿Qué salió?

- Rojo ganó 3 partidas (30,0 %).
- Azul ganó 7 partidas (70,0 %).
- Hubo 0 empates (0,0 %).
- De media, rojo terminó con 15,70 casillas de territorio y
  azul con 18,70.

Para decidir si esa diferencia es real o es simple casualidad calculamos un intervalo de
confianza del 95 %. Un intervalo de confianza es el rango de valores donde razonablemente
esperamos que esté el resultado verdadero. Aquí va de [0,100 ; 0,500] para la
puntuación media del rojo, donde 0,5 significaría empate perfecto entre colores.

## ¿Qué significa?

El 0,5 queda dentro de ese intervalo, así que la pequeña diferencia que vemos es perfectamente compatible con la casualidad. Con 10 partidas no encontramos pruebas de que empezar primero dé ventaja.

Hay que tener cuidado con una cosa importante: como las reglas dicen que rojo empieza siempre,
no podemos separar "ser rojo" de "jugar primero". Son la misma cosa en este experimento. Y
tampoco podemos afirmar que la simetría sea perfecta: solo que, si hay un desequilibrio, es
más pequeño que lo que 10 partidas permiten detectar.

## Conclusión en una frase

Dos IA idénticas reparten las victorias de forma aproximadamente equilibrada, tal como predecía la hipótesis.
