# LearningAgent - Guía de Implementación

## 📋 Resumen

Se ha implementado un nuevo agente de aprendizaje llamado **LearningAgent** al proyecto Wall-Go. Este agente utiliza una tabla Q simplificada (sin redes neuronales ni dependencias externas) para aprender mediante refuerzo durante las partidas.

## ✅ Verificaciones Completadas

- ✓ **TypeScript**: Sin errores de compilación
- ✓ **Linting**: Sin errores en archivos modificados
- ✓ **Interfaz PlayerAgent**: Implementada correctamente
- ✓ **Integración Worker**: Configurada en AIWorker.ts
- ✓ **Exportaciones**: Agregadas a index.ts
- ✓ **Sin conflictos**: RandomAgent, HeuristicAgent, MinimaxAgent intactos

---

## 📁 Archivos Modificados/Creados

### 1. **src/agents/LearningAgent.ts** (CREADO)
Archivo principal del agente de aprendizaje.

**Características principales:**
- Implementa interfaz `PlayerAgent`
- Tabla Q interna: `Map<string, number>`
- Estrategia epsilon-greedy (exploración vs explotación)
- Parámetros de aprendizaje configurables

**Métodos clave:**
```typescript
// Selecciona acciones usando epsilon-greedy
private chooseAction(gameState: GameSnapshot, legalActions: PlayerAction[]): PlayerAction

// Genera clave única para estado del juego
private getStateKey(gameState: GameSnapshot): string

// Genera clave única para una acción
private getActionKey(action: PlayerAction): string

// Actualiza valores Q después de una partida
public updateAfterGame(gameTrace: Array<{state, action}>, result, playerSide): void

// Exportar/cargar tabla Q para persistencia
public getQTableSnapshot(): Record<string, number>
public loadQTable(snapshot: Record<string, number>): void
```

**Parámetros de aprendizaje (modificables):**
- `learningRate`: 0.1 (velocidad de aprendizaje)
- `discountFactor`: 0.9 (valor de recompensas futuras)
- `epsilon`: 0.3 (probabilidad de exploración)
- `decayEpsilon`: 0.995 (reducción gradual de epsilon)

---

### 2. **src/agents/AIWorker.ts** (MODIFICADO)
Se agregó soporte para el tipo de agente 'learning'.

**Cambios:**
- Agregadas funciones helper:
  - `getStateKey(gameState)` - clave de estado
  - `getActionKey(action)` - clave de acción
  - `getQValue(qTable, stateKey, actionKey)` - obtener valor Q
  - `chooseLearningAction(gameState, legalActions, epsilon, qTable)` - selector epsilon-greedy

- Agregado caso `'learning'` en ambos switches:
  - Fase 'placing': usa epsilon-greedy
  - Fase 'playing': usa epsilon-greedy

---

### 3. **src/agents/index.ts** (MODIFICADO)
Agregada exportación del nuevo agente.

```typescript
export * from './LearningAgent'
```

---

### 4. **src/agents/LearningAgent.example.ts** (CREADO - DOCUMENTACIÓN)
Archivo con ejemplos de uso y patrones de integración. No es código activo, solo referencia.

---

## 🧪 Cómo Probar

### Opción 1: Verificación Rápida (Sin tocar Game.tsx)
```bash
# Compilar TypeScript
npx tsc --noEmit

# Verificar linting
npm run lint

# Ejecutar tests (si existen)
npm run test:unit
```

### Opción 2: Integración Completa en Game.tsx

**Paso 1:** Importar el agente en `src/components/Game.tsx`:
```typescript
import { HumanAgent, RandomAgent, HeuristicAgent, MinimaxAgent, LearningAgent } from '@/agents'
```

**Paso 2:** Modificar `setupTurnManager()` para usar LearningAgent en modo ai-vs-ai:
```typescript
if (gameMode === 'ai-vs-ai') {
  const agents = {
    R: new LearningAgent(),      // Rojo aprende
    B: new HeuristicAgent(),     // Azul es heurística (puede cambiar)
  }
  // ... resto de la lógica existente
}
```

**Paso 3:** En el navegador:
1. Abre `localhost:5173` (o tu puerto de vite)
2. Selecciona "IA vs IA"
3. Observa cómo el agente rojo juega y aprende

---

## 💾 Persistencia de Aprendizaje

Para guardar y cargar el progreso de aprendizaje entre sesiones:

```typescript
// Guardar después de entrenar
const qSnapshot = learningAgent.getQTableSnapshot()
localStorage.setItem('wall-go-learning-q', JSON.stringify(qSnapshot))

// Cargar al iniciar
const saved = localStorage.getItem('wall-go-learning-q')
if (saved) {
  const qSnapshot = JSON.parse(saved)
  learningAgent.loadQTable(qSnapshot)
}
```

---

## 🎮 Comportamiento Esperado

**Inicio (epsilon = 0.3):**
- El agente explora: 30% acciones aleatorias, 70% acciones conocidas
- Comportamiento similar a RandomAgent al principio

**Progreso (epsilon decrece):**
- Después de varias partidas, epsilon se reduce gradualmente
- El agente favorece más sus acciones aprendidas

**Convergencia (epsilon → 0.05):**
- El agente es principalmente explotador
- Aplica lo aprendido, explora poco (mínimo 5%)

---

## 🔧 Configuración Avanzada

Si quieres ajustar parámetros de aprendizaje, edita `LearningAgent.ts`:

```typescript
// Constructor (línea ~20)
private learningRate: number = 0.1        // ↑ Aprende más rápido
private discountFactor: number = 0.9      // ↑ Valora más el futuro
private epsilon: number = 0.3             // ↑ Explora más
private decayEpsilon: number = 0.995      // ↓ Decae más rápido
```

---

## 🚀 Próximos Pasos (Opcionales)

1. **Persistencia mejorada**: Guardar tabla Q en base de datos o archivo
2. **Experiencias complejas**: Ampliar `getStateKey()` con más contexto
3. **Múltiples agentes**: Entrenar pares diferentes (Learning vs Random, Learning vs Learning)
4. **Visualización**: Mostrar progreso de aprendizaje en UI
5. **Explotación estratégica**: Implementar exploración por curiosidad o upper confidence bound

---

## ❓ Preguntas Comunes

**Q: ¿Mejora con el tiempo?**
A: Sí, pero lentamente. Después de 100+ partidas, deberías ver cambios en el comportamiento.

**Q: ¿Puede vencer a HeuristicAgent?**
A: No es probable sin ajustes. La tabla Q es muy simplificada. Esto es un punto de partida.

**Q: ¿Debo modificar RandomAgent o HeuristicAgent?**
A: No, ambos están completamente intactos y funcionales.

**Q: ¿Puede entrenar contra otro LearningAgent?**
A: Sí, puedes tener dos LearningAgent en la misma partida (aunque requiere persistencia separada).

---

## 📊 Estado de Archivos

```
✅ src/agents/LearningAgent.ts          (CREADO - 187 líneas)
✅ src/agents/AIWorker.ts               (MODIFICADO - +80 líneas)
✅ src/agents/index.ts                  (MODIFICADO - +1 línea)
✅ src/agents/LearningAgent.example.ts  (CREADO - Referencia)

✅ Todos pasan TypeScript compile check
✅ Todos pasan linting
✅ Sin cambios en otros agentes
```

---

## 🎯 Conclusión

El **LearningAgent** está completamente integrado y listo para usar. No rompe nada existente y puede ser introducido gradualmente en el código según tus necesidades.

Para comenzar a usarlo, simplemente actualiza `Game.tsx` con el código del Paso 2 de "Cómo Probar".

¿Preguntas o ajustes? Los parámetros de aprendizaje son fáciles de modificar sin tocar la arquitectura.
