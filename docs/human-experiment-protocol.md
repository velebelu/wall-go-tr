# Protocolo del experimento humano Wall-Go

## Objetivo e hipótesis

El experimento compara descriptivamente el rendimiento de participantes humanos con la IA
`FINAL_HUMAN_CHALLENGE_MCTS_CONFIG`, que permanece congelada y sin aprendizaje. La hipótesis de
trabajo es que la experiencia previa se asociará con diferencias observables en victorias,
territorio y duración. El diseño no permite atribuir causalidad.

## Muestra y pseudonimización

El tamaño previsto debe fijarse antes de iniciar la recogida. Cada participante recibe un
identificador pseudónimo que no contiene nombre, correo, ruta ni datos de contacto. La tabla de
correspondencias, si el consentimiento exige conservarla, se guarda separada del repositorio.

## Condiciones

Cada persona juega exactamente dos partidas: una como rojo (`R`) y otra como azul (`B`). El orden
se contrabalancea y queda fijado antes de la primera partida. Se usa el mismo dispositivo,
versión, IA final, instrucciones, límite temporal por turno y entorno para toda la muestra. La IA
no aprende ni se adapta entre participantes.

Antes del experimento se declara el número de partidas previas de Wall-Go, el grupo de experiencia
y el número de partidas de práctica. La práctica permitida debe ser igual para participantes o
quedar registrada como desviación.

## Instrucciones al participante

1. No comunique datos personales al operador durante el registro.
2. Juegue con normalidad y sin ayuda externa.
3. Informe de interrupciones, recargas o problemas de rendimiento.
4. Complete las dos partidas en el orden de color asignado.

## Métricas

Se registran ganador, territorios, diferencia desde la perspectiva humana, turnos, duración total,
color, semilla, configuración efectiva, commit, traza reproducible e incidencias. La duración
abarca desde el inicio del bucle jugable hasta que el motor confirma el resultado; los tiempos de
decisión permanecen separados.

## Incidencias y exclusión

Se usan códigos controlados: `performance-warning`, `participant-interruption`,
`application-reload`, `trace-download-failure`, `wrong-color-order`,
`practice-protocol-deviation`, `missing-commit-pilot-only` y `other`. `other` requiere una
descripción breve y no personal.

Antes de recoger datos se fijarán criterios de exclusión. Como mínimo: falta o corrupción de la
traza, configuración distinta de la congelada, commit ausente, orden de colores incumplido o
partida no terminal. Nunca se decide una exclusión después de conocer si ganó la persona.

## Privacidad y almacenamiento

Los datos publicados contienen únicamente pseudónimos. No se guardan IP, usuario del sistema ni
rutas absolutas. Las trazas y el registro se almacenan en un directorio de acceso restringido, con
copias de seguridad y plazo de conservación definido en el consentimiento. Las notas se limitan a
240 caracteres y las incidencias a 160.

## Registro, validación y exportación

El operador registra primero el participante, después cada traza. El registro deriva colores,
semilla, resultado, territorios, turnos y configuración de la traza. Se rechazan duplicados,
incoherencias, hashes incorrectos y configuraciones distintas de la final. Las escrituras del
registro son atómicas.

Los comandos de registro reciben siempre la raíz explícita del experimento. No se infiere la raíz
desde la carpeta que contiene la plantilla:

```powershell
npm run human-experiment:register-participant -- <experiment-directory> <participant.json>
npm run human-experiment:register-game -- <experiment-directory> <game.json> <trace.json>
```

`<experiment-directory>/registry.json` debe existir previamente y su `experimentId` debe coincidir
con el de la entrada. Los comandos no crean registros secundarios junto a las plantillas.

La exportación produce `participants.csv`, `games.csv`, `summary.json` y `manifest.json`. El
manifiesto contiene hashes SHA-256, commits, conteos y el resultado de validación.

## Análisis y limitaciones

El análisis se limita a conteos, tasas, medias y mediana descriptiva, globales y agrupados por
color, experiencia y número de partida. No se calculan significación, causalidad ni aprendizaje
estadístico sin diseño y muestra que lo justifiquen. Dos partidas por persona son sensibles al
azar, al efecto de orden, al cansancio y a diferencias de hardware.
