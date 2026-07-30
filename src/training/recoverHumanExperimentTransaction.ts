import { resolve } from 'node:path'
import { CURRENT_HUMAN_EXPERIMENT_DIRECTORY } from '@/experiments/humanExperimentConfig'
import { recoverHumanExperimentTransaction } from '@/experiments/humanExperimentTransaction'

/**
 * Deshace una ingesta interrumpida antes de que el lanzador compruebe que el árbol Git está
 * limpio. Una transacción a medio publicar deja cambios reales en `registry.json` y
 * `metadata.json`, así que sin este paso la comprobación de limpieza los ve, aborta la sesión
 * y la única forma de recuperarlos —arrancar el vigilante— queda fuera de alcance.
 */
const directory = resolve(process.argv[2] ?? CURRENT_HUMAN_EXPERIMENT_DIRECTORY)
const recovered = await recoverHumanExperimentTransaction(directory)
console.log(
  recovered
    ? `Transacción de ingesta pendiente recuperada en ${directory}`
    : `Sin transacciones de ingesta pendientes en ${directory}`,
)
