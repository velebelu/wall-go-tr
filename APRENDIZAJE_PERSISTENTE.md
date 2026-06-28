# Aprendizaje Persistente del LearningAgent

## Cambios Realizados en Esta Sesión

### 1. **src/agents/LearningAgent.ts** (Enhancements)

#### Cambios Principales:

**A) Constructor y Persistencia Automática:**
```typescript
private gameTrace: Array<{ state: GameSnapshot; action: PlayerAction }> = []
private readonly storageKey = 'wall-go-learning-agent-q-table'

constructor() {
  this.worker = new Worker(...)
  this.loadFromLocalStorage() // 👈 Carga tabla Q al iniciar
}
```

**B) Registro de Acciones en getAction():**
- Ahora guarda cada acción en `gameTrace` durante la partida
- Permite calcular recompensas retrospectivamente

**C) Actualización de updateAfterGame():**
```typescript
public updateAfterGame(
  result: 'win' | 'loss' | 'draw',
  playerSide: 'R' | 'B',
): void {
  // ... calcula Q-values usando gameTrace
  this.saveToLocalStorage() // 👈 Guarda automáticamente
  this.gameTrace = [] // 👈 Limpia historial
}
```

**D) Métodos de Persistencia:**
- `saveToLocalStorage()`: Guarda tabla Q en localStorage + muestra contador en consola
- `loadFromLocalStorage()`: Carga tabla Q de localStorage (privado, se llama en constructor)
- `getQTableSize()`: Retorna número de entradas aprendidas
- `logStats()`: Muestra estadísticas completas en consola

---

### 2. **src/components/Game.tsx** (Integración)

#### Cambios Principales:

**A) Referencia al LearningAgent:**
```typescript
const learningAgentRef = useRef<LearningAgent | null>(null)
```

**B) Guardando Referencia en setupTurnManager():**
```typescript
const learningAgent = new LearningAgent()
learningAgentRef.current = learningAgent
const agents = {
  R: learningAgent,
  B: new RandomAgent(),
}
```

**C) Llamada a updateAfterGame() al Terminar Partida:**
```typescript
if (gameMode === 'ai-vs-ai' && learningAgentRef.current) {
  const learningResult = result.tie ? 'draw' : result.winner === 'R' ? 'win' : 'loss'
  learningAgentRef.current.updateAfterGame(learningResult, 'R')
  learningAgentRef.current.logStats() // 👈 Muestra estadísticas
}
```

---

## Flujo de Aprendizaje Ahora

1. **Inicio del Modo IA vs IA:**
   - Se crea nuevo LearningAgent
   - Constructor carga tabla Q de localStorage (si existe)
   - Consola muestra: `[LearningAgent] Tabla Q cargada. Entradas aprendidas: X`

2. **Durante la Partida:**
   - Cada acción que realiza LearningAgent se registra en `gameTrace`
   - Epsilon se controla por el worker

3. **Fin de la Partida:**
   - Se determina resultado (win/loss/draw) desde perspectiva de rojo
   - Se llama `updateAfterGame(resultado, 'R')`
   - Se actualizan valores Q usando gameTrace
   - Se guarda tabla Q en localStorage
   - Se muestra: `[LearningAgent] Tabla Q guardada. Entradas aprendidas: Y`
   - Se muestran estadísticas con `logStats()`

4. **Persistencia:**
   - Tabla Q persiste en localStorage
   - Al recargar página/abrir navegador, tabla Q se carga automáticamente
   - El aprendizaje continúa acumulándose

---

## Cómo Comprobar que Funciona

### 1. Ver que la Tabla Q Aumenta (En la Misma Sesión)

**En el navegador:**
1. Abre consola (F12)
2. Selecciona "IA vs IA"
3. Ve cómo juegan rojo (LearningAgent) vs azul (RandomAgent)
4. Cuando termina, en la consola verás:
   ```
   [LearningAgent] Tabla Q guardada. Entradas aprendidas: 15
   [LearningAgent] Estadísticas
   Entradas Q-table: 15
   Epsilon (exploración): 0.2985
   Learning Rate: 0.1
   Discount Factor: 0.9
   ```

5. Juega otra partida. Verás:
   ```
   [LearningAgent] Tabla Q guardada. Entradas aprendidas: 28
   [LearningAgent] Estadísticas
   Entradas Q-table: 28
   Epsilon (exploración): 0.2970
   ...
   ```

**El número debe ir aumentando: 15 → 28 → 42 → ...**

### 2. Ver que la Memoria Persiste (Entre Recargas)

**En la consola del navegador:**

**Primera sesión:**
1. Juega varias partidas de IA vs IA
2. Anota el número final de entradas, ej: "45 entradas"
3. Abre consola y ejecuta:
   ```javascript
   const snapshot = JSON.parse(localStorage.getItem('wall-go-learning-agent-q-table') || '{}')
   console.log('Entradas guardadas:', Object.keys(snapshot).length)
   ```
   Verás: `Entradas guardadas: 45`

**Segunda sesión (después de recargar):**
1. Recarga la página (Ctrl+F5)
2. La consola mostrará automáticamente al iniciar:
   ```
   [LearningAgent] Tabla Q cargada. Entradas aprendidas: 45
   ```
3. Selecciona IA vs IA nuevamente
4. Juega una partida
5. Al terminar, verás un número mayor, ej:
   ```
   [LearningAgent] Tabla Q guardada. Entradas aprendidas: 58
   ```

**Esto prueba que:**
- ✅ La tabla Q persistió entre recargas
- ✅ El aprendizaje se continuó acumulando (45 → 58)

### 3. Ver Comportamiento del Agente

**En la consola (modo Consola > filtro `LearningAgent`):**

Después de varias partidas (20+), puedes ejecutar:
```javascript
// Ver tabla Q completa
const snapshot = JSON.parse(localStorage.getItem('wall-go-learning-agent-q-table') || '{}')
console.table(Object.entries(snapshot).slice(0, 20)) // Mostrar primeras 20 entradas
```

Verás algo como:
```
placing|R|0|0|0|||place|3|4     →  0.15
placing|R|0|0|0|||place|5|2     →  0.08
playing|R|4|2|50|||move|1|2|1|3 → -0.05
playing|R|4|2|50|||wall|2|3|top → 0.32
...
```

---

## Archivos Tocados en Esta Sesión

| Archivo | Líneas Modificadas | Cambios |
|---------|-------------------|---------|
| `src/agents/LearningAgent.ts` | ~60 | Persistencia, registro de acciones, contador |
| `src/components/Game.tsx` | ~15 | Referencia a LearningAgent, llamada a updateAfterGame |
| **Total** | ~75 líneas | Aprendizaje persistente completamente integrado |

---

## CSV No Afectado

El guardado CSV sigue igual:
- La partida se registra con `tipo_partida = 'ia_vs_ia_automatico'`
- `jugador_rojo = 'ia_aleatoria'` ← **Nota:** Puede cambiar después a 'ia_aprendiz'
- `jugador_azul = 'ia_aleatoria'`
- El aprendizaje es transparente para el CSV

---

## Notas Importantes

1. **Tabla Q es local del navegador:** Se guarda en `localStorage` del navegador actual
   - Diferente navegador/dispositivo → tabla Q vacía
   - Limpiar cookies/localStorage → tabla Q se borra

2. **Cantidad de entradas es variable:**
   - Depende de los estados y acciones que vea
   - Primeras partidas: crecimiento rápido (explorando)
   - Partidas posteriores: crecimiento más lento (menos nuevos estados)

3. **Aprendizaje es lento:**
   - Es normal que epsilon apenas baje (0.30 → 0.297 por partida)
   - El verdadero cambio se ve después de 50+ partidas

4. **Para TR recomendado:**
   - Documentar el número de entradas Q después de X partidas
   - Mostrar que existe persistencia (tabla Q entre sesiones)
   - Mostrar evolución de epsilon (0.30 → 0.15 después de 50 partidas)
