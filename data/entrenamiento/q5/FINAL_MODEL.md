# Modelo final Q5

- **Checkpoint final seleccionado:** Q5-1000.
- **Tabla Q:** `data/entrenamiento/q5/hybrid/final_checkpoint_1000/qtable_q5_hybrid_final_1000.json`.
- **Política final:** `minConfidence=10`, `qMargin=0.50`.

## Motivo de la selección

Q5-1000 ofrece el mejor resultado contra el rival heurístico en la comparación
homogénea de checkpoints con la política 5/0.25: 47,2 % de victorias y una
diferencia territorial media de -0,768, frente a 44,0 % y -1,928 para Q5-1500
normal, y 45,4 % y -1,262 para Q5-1500 conservadora. En la comparación de
políticas sobre Q5-1000, la configuración 10/0.50 alcanza además el mayor
porcentaje de victorias contra el rival heurístico (48,0 %) y limita las
sustituciones de la decisión heurística a 3.

Q5-1500 normal y Q5-1500 conservadora se conservan únicamente como resultados
experimentales y no forman parte del modelo final.
