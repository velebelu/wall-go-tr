/**
 * EJEMPLO: Cómo usar LearningAgent en Wall-Go
 * Este archivo muestra ejemplos de integración del LearningAgent.
 *
 * No es código en uso, sino más bien documentación ejecutable.
 */

import { LearningAgent, HeuristicAgent, RandomAgent } from '@/agents'
import type { GameSnapshot, PlayerAction } from '@/lib/types'

// ============================================
// 1. INSTANCIACIÓN BÁSICA
// ============================================

// Crear un nuevo agente de aprendizaje
const learningAgent = new LearningAgent()

// ============================================
// 2. USAR EN MODO IA VS IA (ejemplo para Game.tsx)
// ============================================

/*
// En setupTurnManager() de Game.tsx:
if (gameMode === 'ai-vs-ai') {
  const agents = {
    R: new LearningAgent(),      // Rojo aprende
    B: new HeuristicAgent(),     // Azul es heurística
  }
  // ... resto de configuración
}
*/

// ============================================
// 3. TABLA Q - PERSISTENCIA (localStorage)
// ============================================

// Guardar tabla Q después de que el agente juegue varias partidas
function saveAgentLearning(agent: LearningAgent): void {
  const qSnapshot = agent.getQTableSnapshot()
  localStorage.setItem('wall-go-learning-agent-q-table', JSON.stringify(qSnapshot))
  console.log('Tabla Q guardada. Pares entrenados:', Object.keys(qSnapshot).length)
}

// Cargar tabla Q al iniciar la aplicación
function loadAgentLearning(agent: LearningAgent): void {
  const saved = localStorage.getItem('wall-go-learning-agent-q-table')
  if (saved) {
    try {
      const qSnapshot = JSON.parse(saved)
      agent.loadQTable(qSnapshot)
      console.log('Tabla Q cargada. Pares entrenados:', Object.keys(qSnapshot).length)
    } catch (e) {
      console.error('Error cargando tabla Q:', e)
    }
  }
}

// ============================================
// 4. APRENDIZAJE DESPUÉS DE UNA PARTIDA
// ============================================

interface GameTrace {
  states: GameSnapshot[]
  actions: PlayerAction[]
}

function updateAgentAfterGame(
  agent: LearningAgent,
  gameTrace: GameTrace,
  result: 'win' | 'loss' | 'draw',
  playerSide: 'R' | 'B',
): void {
  // Convertir trazas a formato que espera updateAfterGame
  const trace = gameTrace.states
    .slice(0, -1) // Excluir último estado (finished)
    .map((state, index) => ({
      state,
      action: gameTrace.actions[index]!,
    }))

  agent.updateAfterGame(trace, result, playerSide)
  console.log(`Agente actualizado: ${result} (lado: ${playerSide})`)
  console.log(`Epsilon actual: ${agent['epsilon'].toFixed(4)}`)
}

// ============================================
// 5. INSPECCIONAR APRENDIZAJE (debugging)
// ============================================

function debugAgentLearning(agent: LearningAgent): void {
  const qTable = agent.getQTableSnapshot()
  const totalEntries = Object.keys(qTable).length

  console.group('🤖 LearningAgent Debug Info')
  console.log(`Total Q-entries: ${totalEntries}`)

  // Mostrar top 10 valores Q más altos
  const sorted = Object.entries(qTable).sort((a, b) => b[1] - a[1])
  console.log('Top 10 acciones más valiosas:')
  sorted.slice(0, 10).forEach(([key, value], i) => {
    console.log(`  ${i + 1}. ${key.substring(0, 50)}... = ${value.toFixed(4)}`)
  })

  console.groupEnd()
}

// ============================================
// 6. COMPARAR AGENTES EN MODO AI VS AI
// ============================================

/*
// Ejemplo para entrenar LearningAgent vs diferentes oponentes:

async function runTrainingSession(
  agent: LearningAgent,
  trainingRounds: number = 10,
): Promise<void> {
  let wins = 0
  let losses = 0
  let draws = 0

  for (let i = 0; i < trainingRounds; i++) {
    // Simular una partida (pseudo-código)
    // const result = await playGame(agent, new HeuristicAgent())
    
    // if (result === 'win') wins++
    // else if (result === 'loss') losses++
    // else draws++

    // agent.updateAfterGame(gameTrace, result, 'R')
    
    if ((i + 1) % 10 === 0) {
      console.log(`Ronda ${i + 1}/${trainingRounds} - W: ${wins}, L: ${losses}, D: ${draws}`)
    }
  }

  console.log('📊 Resultados finales:', { wins, losses, draws })
  saveAgentLearning(agent)
}
*/

// ============================================
// 7. NOTAS SOBRE PARÁMETROS
// ============================================

/*
LearningAgent es altamente personalizable:

- learningRate (0.1): Qué tan rápido aprende. Mayor = más impacto de nuevas experiencias.
- discountFactor (0.9): Cuánto valora recompensas futuras. 0 = solo recompensa inmediata.
- epsilon (0.3): Probabilidad de exploración. 1 = solo aleatorio, 0 = solo explotación.
- decayEpsilon (0.995): Cómo reduce epsilon con el tiempo. Mayor = reducción más lenta.

Modificar estos valores puede hacerse editando LearningAgent.ts.
*/

console.log('✅ Ejemplos de LearningAgent cargados. Ver comentarios para más detalles.')
