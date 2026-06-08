# Reglas del juego Wall Go

## 1. Tablero

- El juego se juega en un tablero cuadrado de 7x7 casillas.
- Cada casilla puede estar vacía u ocupada por una ficha.
- Las fichas no pueden ocupar la misma casilla.
- Los muros se colocan entre casillas y bloquean el paso entre ellas.

## 2. Jugadores

- Hay 2 jugadores.
- Cada jugador controla varias fichas.
- Cada jugador empieza con 2 fichas.
- Cada jugador dispone de 8 muros.
- El jugador 1 será el jugador humano.
- El jugador 2 podrá ser otro humano o una inteligencia artificial.

## 3. Colocación inicial

- Al inicio de la partida, los jugadores colocan sus fichas en el tablero.
- Las fichas se colocan por turnos.
- No se puede colocar una ficha en una casilla ocupada.

## 4. Turnos

En cada turno, el jugador puede realizar una única acción:

1. Mover una ficha.
2. Colocar un muro.

## 5. Movimiento de fichas

- Una ficha puede moverse una casilla.
- El movimiento solo puede ser horizontal o vertical.
- No se permite el movimiento en diagonal.
- Una ficha no puede atravesar un muro.
- Una ficha no puede moverse a una casilla ocupada.

## 6. Colocación de muros

- Un muro se coloca entre dos casillas.
- Los muros pueden ser horizontales o verticales.
- Un muro bloquea el movimiento entre las dos casillas que separa.
- No se pueden colocar muros fuera del tablero.
- No se pueden colocar más muros de los disponibles para cada jugador.

## 7. Final de partida

La partida termina cuando se cumple una de estas condiciones:

- Ningún jugador puede realizar movimientos útiles.
- Los jugadores han usado todos sus muros y ya no pueden expandir claramente su territorio.
- Se alcanza un número máximo de 100 turnos.

## 8. Cálculo del ganador

- Al final de la partida se calcula cuántas casillas controla cada jugador.
- Cada jugador controla las casillas conectadas a sus fichas que no estén bloqueadas por muros.
- Gana el jugador que controle más casillas.
- Si ambos jugadores controlan el mismo número de casillas, la partida termina en empate.

## 9. Datos que se guardarán de cada partida

Al finalizar cada partida se registrarán los siguientes datos:

- Fecha de la partida.
- Tipo de jugador 1: humano o IA.
- Tipo de jugador 2: humano o IA.
- Ganador.
- Territorio controlado por el jugador 1.
- Territorio controlado por el jugador 2.
- Número total de turnos.
- Muros usados por el jugador 1.
- Muros usados por el jugador 2.
- Movimientos realizados por el jugador 1.
- Movimientos realizados por el jugador 2.
- Dificultad de la IA del jugador 1, si corresponde.
- Dificultad de la IA del jugador 2, si corresponde.
- Observaciones de la partida.