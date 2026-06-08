# Reglas del juego Wall Go

## 1. Tablero

* El juego se juega en un tablero cuadrado de 7x7 casillas.
* Cada casilla puede estar vacía u ocupada por una ficha.
* Las fichas no pueden ocupar la misma casilla.
* Los muros se colocan entre casillas y bloquean el paso entre ellas.

## 2. Jugadores y fichas

* Hay 2 jugadores.
* Cada jugador controla 4 fichas.
* El jugador rojo controla 4 fichas rojas.
* El jugador azul controla 4 fichas azules.
* En total hay 8 fichas en el tablero.
* El jugador 1 podrá ser humano o inteligencia artificial.
* El jugador 2 podrá ser humano o inteligencia artificial.

## 3. Colocación inicial

* Al inicio de la partida, los jugadores colocan sus fichas en el tablero.
* Las fichas se colocan por turnos.
* No se puede colocar una ficha en una casilla ocupada.
* Cuando ambos jugadores han colocado sus 4 fichas, empieza la fase principal de la partida.

## 4. Turnos

En cada turno, el jugador realiza una acción de juego.

Las acciones principales son:

1. Mover una ficha.
2. Colocar un muro.

La colocación de muros forma parte del desarrollo normal de la partida. En esta versión del juego, los muros no se entienden como un recurso individual fijo de cada jugador, sino como elementos que van apareciendo durante la partida según los turnos jugados.

## 5. Movimiento de fichas

* Una ficha puede moverse una casilla.
* El movimiento solo puede ser horizontal o vertical.
* No se permite el movimiento en diagonal.
* Una ficha no puede atravesar un muro.
* Una ficha no puede moverse a una casilla ocupada.
* Una ficha no puede salir fuera del tablero.

## 6. Colocación de muros

* Un muro se coloca entre dos casillas.
* Los muros pueden ser horizontales o verticales.
* Un muro bloquea el movimiento entre las dos casillas que separa.
* No se pueden colocar muros fuera del tablero.
* No se puede colocar un muro encima de otro muro ya existente.
* Durante la partida se coloca un muro por turno, por lo que el número de muros no se calcula como “muros disponibles por jugador”, sino como el total de muros que aparecen durante la partida.

## 7. Final de partida

La partida termina cuando se cumple una de estas condiciones:

* Ningún jugador puede realizar movimientos útiles.
* El tablero queda suficientemente dividido por muros y ya no se puede expandir claramente el territorio.
* Se alcanza un número máximo de 100 turnos.

El límite de 100 turnos sirve para evitar partidas demasiado largas y facilitar la comparación entre partidas humanas y partidas de inteligencia artificial.

## 8. Cálculo del territorio

* Al final de la partida se calcula cuántas casillas controla cada jugador.
* Cada jugador controla las casillas conectadas a sus fichas que no estén bloqueadas por muros.
* Una casilla se considera conectada a una ficha si se puede llegar hasta ella mediante movimientos horizontales o verticales sin atravesar muros.
* Si una zona puede ser alcanzada por fichas de ambos jugadores, se considera zona disputada y no suma para ningún jugador.
* El territorio final de cada jugador se mide contando el número de casillas controladas.

## 9. Cálculo del ganador

* Gana el jugador que controle más casillas al final de la partida.
* Si el jugador 1 controla más casillas, gana el jugador 1.
* Si el jugador 2 controla más casillas, gana el jugador 2.
* Si ambos jugadores controlan el mismo número de casillas, la partida termina en empate.

## 10. Datos que se guardarán de cada partida

Al finalizar cada partida se registrarán los siguientes datos:

* Fecha de la partida.
* Tipo de jugador 1: humano o IA.
* Tipo de jugador 2: humano o IA.
* Dificultad de la IA del jugador 1, si corresponde.
* Dificultad de la IA del jugador 2, si corresponde.
* Ganador.
* Territorio controlado por el jugador 1.
* Territorio controlado por el jugador 2.
* Número total de turnos.
* Número total de muros colocados durante la partida.
* Movimientos realizados por el jugador 1.
* Movimientos realizados por el jugador 2.
* Observaciones de la partida.

## 11. Objetivo del registro de datos

El registro de datos permitirá analizar y comparar diferentes tipos de partidas:

* Humano contra humano.
* Humano contra inteligencia artificial.
* Inteligencia artificial contra inteligencia artificial.
* Diferentes niveles de dificultad de la inteligencia artificial.

Estos datos servirán para estudiar cómo toman decisiones los jugadores y cómo cambia el rendimiento de la inteligencia artificial según su estrategia.
