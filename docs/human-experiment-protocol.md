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
```

`<experiment-directory>/registry.json` debe existir previamente y su `experimentId` debe coincidir
con el de la entrada. El comando no crea registros secundarios junto a las plantillas.

`human-experiment:register-game` fue retirado y ahora falla con una indicación explícita.
Escribía `registry.json` por su cuenta sin validar `sessionType`, commits, replay ni
`traceSha256`, y sin actualizar `metadata.json`, el archivo de partida ni la traza oficial, de
modo que dejaba el experimento fallando `human-experiment:validate-v3`. El registro de partidas
se hace únicamente con `human-experiment:ingest-latest`, que publica traza, registro, archivo de
partida y metadatos dentro de una sola transacción recuperable.

Para la recogida definitiva se dispone de un flujo CLI abreviado:

```powershell
npm run human-experiment:setup-participant -- P02 basic 3
npm run human-experiment:start
npm run human-experiment:ingest-latest -- P02 1
npm run human-experiment:ingest-latest -- P02 2
```

`start` obtiene e inyecta el commit completo. `setup-participant` valida la coherencia entre
experiencia y partidas previas y actualiza plantilla y registro. `ingest-latest` examina únicamente
carpetas habituales de descargas, conserva el original, se detiene ante ambigüedad, copia la traza
sin sobrescribir y registra contra la raíz definitiva. Se puede proporcionar una ruta explícita
como tercer argumento para resolver una descarga ambigua.

La exportación produce `participants.csv`, `games.csv`, `summary.json` y `manifest.json`. El
manifiesto contiene hashes SHA-256, commits, conteos y el resultado de validación.

## Trazas rechazadas: cuarentena bruta y sesiones invalidadas

Son dos cosas distintas y conviene no confundirlas:

|                            | `final-2026-v3/quarantine/`       | `invalid-sessions-v3/`                  |
| -------------------------- | --------------------------------- | --------------------------------------- |
| Quién escribe              | El vigilante, automáticamente     | El operador, de forma manual y auditada |
| Contenido                  | Copia bruta de la traza rechazada | Manifiesto curado de la sesión          |
| Versionado en Git          | No (ignorado)                     | Sí                                      |
| Lo comprueba `validate-v3` | No                                | Sí                                      |
| Ciclo de vida              | Efímero, se puede borrar          | Permanente, forma parte del TR          |

El recorrido normal es: el vigilante rechaza una traza, guarda una copia en `quarantine/`, el
operador la examina y, si la sesión se declara inválida, escribe el manifiesto correspondiente en
`invalid-sessions-v3/` con `status`, `validity`, `traceSha256` y el motivo. Sólo ese manifiesto
tiene valor documental; la copia bruta es material de trabajo.

La cuarentena guarda únicamente lo que ya no puede prosperar: un rechazo definitivo o un
contenido que agotó sus reintentos. Un archivo aún en escritura o un fallo de entrada/salida se
reintentan sin dejar copia, hasta tres veces por contenido.

`quarantine/` y `.ingestion-transaction/` están ignorados por Git de forma nominal. Es
deliberado que sean sólo esas dos rutas: ningún dato real del experimento queda oculto, y a
cambio una traza rechazada deja de bloquear el arranque de la siguiente sesión oficial, que
exige un árbol de trabajo limpio.

## Congelado científico y capa operacional

El congelado cubre la IA, el MCTS, las reglas, la configuración y el runtime jugable: nada de eso
cambia mientras se recogen partidas. La capa operacional —recogida, ingesta, validación,
cuarentena y conservación de los datos— sí admite correcciones auditadas, siempre que no alteren
las condiciones experimentales. Las rutas concretas que pueden cambiar tras el congelado están
enumeradas una a una en `OPERATIONAL_EXPERIMENT_PATHS`, dentro de
`scripts/start-human-experiment.mjs`, y el lanzador aborta si se modifica cualquier otra.

## Cierre y validación histórica de V3

V3 está cerrada permanentemente para nuevas sesiones oficiales. El cambio diagnóstico posterior
en `Game.tsx` no se declara retroactivamente compatible con su code freeze. Por eso se separan:

- `human-experiment:validate-v3-archive`, que comprueba los artefactos conservados y que el binding
  histórico fue el hijo inmediato, metadata-only, de la implementación V3;
- `human-experiment:start -- official ...`, que rechaza cualquier nueva sesión V3 antes de iniciar
  Vite o el watcher.

P01-1 conserva su validez técnica, contenido, hash y trazabilidad originales. No se combinará con
una segunda partida ejecutada bajo otro runtime y queda excluida del futuro análisis emparejado.
El intento P01-2 con sesión `d4eab366-bb21-43c8-b7bc-b84b615d06c4` se documenta sin inventar
snapshots, acción fallida, commits ni hashes que el runtime no persistió.

## Diagnóstico de divergencias motor/store

Ante una divergencia, el runtime clona sincrónicamente el estado anterior, la acción rechazada,
el estado esperado, el committed, la metadata y las decisiones confirmadas. Inicia después una
única descarga no oficial sin esperarla y lanza inmediatamente el mismo error de transición.
Un fallo de descarga sólo se registra en consola.

Los paquetes `HumanExperimentTransitionMismatchV1` declaran `official: false` y
`registrationAllowed: false`. El watcher los separa antes de la ingesta, conserva el paquete y
la traza parcial en cuarentena y prepara un manifiesto inválido. Ni el registro, ni
`metadata.gameCount`, ni los slots de partidas oficiales se modifican.

## Análisis y limitaciones

El análisis se limita a conteos, tasas, medias y mediana descriptiva, globales y agrupados por
color, experiencia y número de partida. No se calculan significación, causalidad ni aprendizaje
estadístico sin diseño y muestra que lo justifiquen. Dos partidas por persona son sensibles al
azar, al efecto de orden, al cansancio y a diferencias de hardware.
