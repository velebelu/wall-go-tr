# IA aprendiz Q5: modelo de inferencia

El modo humano contra **IA aprendiz Q5** usa exclusivamente el checkpoint final Q5-1000:

`data/entrenamiento/q5/hybrid/final_checkpoint_1000/qtable_q5_hybrid_final_1000.json`

- SHA-256: `CD3DFF73D54B8B3CD0A225EBECEBC82E66B4BF61CBDB9B710597CEAF15E396A2`.
- Entradas Q: 27.815.
- Política: `minConfidence=10`, `qMargin=0.50`, `epsilon=0`.
- Aprendizaje, actualización y persistencia: desactivados.

Vite publica los archivos originales como recursos mediante `new URL(..., import.meta.url)`. No se
copia, mueve ni modifica el checkpoint. El cargador se ejecuta una sola vez, comprueba el SHA-256 y
mantiene la tabla congelada en memoria durante toda la sesión.

La confianza reproduce el evaluador congelado: para cada clave usa el máximo entre las observaciones
heredadas de `heuristic_initial_qtable/build_summary.json` y el número de actualizaciones acumuladas
en los `q_update_log.jsonl` de `final_checkpoint_500` y `final_checkpoint_1000`. Estos datos solo se
leen y tampoco se modifican.

Si falla una descarga, el parseo o la verificación de integridad, se genera un `Q5ModelLoadError` y
el juego muestra el mensaje como un error controlado.
