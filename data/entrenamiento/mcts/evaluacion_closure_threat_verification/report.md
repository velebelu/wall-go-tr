# Piloto de verificación experimental de cierre territorial

## Clasificación

`promising-needs-confirmation`

La variante es exclusivamente experimental y no está conectada a la interfaz.

## Detector

Se examinan hasta cuatro candidatas después del top-2 táctico. Para cada candidata se ordenan respuestas
con muro primero y se limitan a 80 respuestas o 250 ms. Es grave: ganancia rival ≥12, caída accesible propia
≥12, pérdida de la última ficha propia en una componente disputada ≥15, o diferencia terminal ≤-12.
Si hay candidatas seguras se prefiere la de más visitas; si todas colapsan se conserva la acción original.

## Resultados

- Observaciones críticas: 6.
- Controles negativos: 10.
- Cambios críticos: 1.
- Cambios de control: 0.
- Coste medio del detector: 40.201 ms.
- Coste máximo: 46.368 ms.

Turnos 34 y 36 contienen candidatas con amenaza grave, pero la acción baseline ya es segura a una respuesta.
En turno 38 todas las candidatas principales colapsan y se aplica correctamente el fallback sin inventar defensa.

## Continuaciones

```json
[
  {
    "turn": 34,
    "baselineAction": {
      "type": "move",
      "from": {
        "x": 4,
        "y": 1
      },
      "pos": {
        "x": 4,
        "y": 2
      },
      "followUp": {
        "type": "wall",
        "from": {
          "x": 4,
          "y": 2
        },
        "pos": {
          "x": 4,
          "y": 2
        },
        "dir": "top"
      }
    },
    "experimentalAction": {
      "type": "move",
      "from": {
        "x": 4,
        "y": 1
      },
      "pos": {
        "x": 4,
        "y": 2
      },
      "followUp": {
        "type": "wall",
        "from": {
          "x": 4,
          "y": 2
        },
        "pos": {
          "x": 4,
          "y": 2
        },
        "dir": "top"
      }
    },
    "actionChanged": false,
    "baseline": {
      "winner": "B",
      "territory": {
        "R": 7,
        "B": 27
      },
      "territoryDiffRed": -20,
      "turns": 13,
      "reachedLimit": false,
      "detectorChanges": 0
    },
    "experimental": {
      "winner": "B",
      "territory": {
        "R": 7,
        "B": 27
      },
      "territoryDiffRed": -20,
      "turns": 13,
      "reachedLimit": false,
      "detectorChanges": 0
    }
  },
  {
    "turn": 36,
    "baselineAction": {
      "type": "move",
      "from": {
        "x": 1,
        "y": 5
      },
      "pos": {
        "x": 1,
        "y": 6
      },
      "followUp": {
        "type": "wall",
        "from": {
          "x": 1,
          "y": 6
        },
        "pos": {
          "x": 1,
          "y": 6
        },
        "dir": "left"
      }
    },
    "experimentalAction": {
      "type": "move",
      "from": {
        "x": 1,
        "y": 5
      },
      "pos": {
        "x": 1,
        "y": 6
      },
      "followUp": {
        "type": "wall",
        "from": {
          "x": 1,
          "y": 6
        },
        "pos": {
          "x": 1,
          "y": 6
        },
        "dir": "top"
      }
    },
    "actionChanged": true,
    "baseline": {
      "winner": "B",
      "territory": {
        "R": 6,
        "B": 34
      },
      "territoryDiffRed": -28,
      "turns": 5,
      "reachedLimit": false,
      "detectorChanges": 0
    },
    "experimental": {
      "winner": "B",
      "territory": {
        "R": 4,
        "B": 25
      },
      "territoryDiffRed": -21,
      "turns": 21,
      "reachedLimit": false,
      "detectorChanges": 1
    }
  },
  {
    "turn": 38,
    "baselineAction": {
      "type": "move",
      "from": {
        "x": 4,
        "y": 1
      },
      "pos": {
        "x": 4,
        "y": 2
      },
      "followUp": {
        "type": "wall",
        "from": {
          "x": 4,
          "y": 2
        },
        "pos": {
          "x": 4,
          "y": 2
        },
        "dir": "right"
      }
    },
    "experimentalAction": {
      "type": "move",
      "from": {
        "x": 4,
        "y": 1
      },
      "pos": {
        "x": 4,
        "y": 2
      },
      "followUp": {
        "type": "wall",
        "from": {
          "x": 4,
          "y": 2
        },
        "pos": {
          "x": 4,
          "y": 2
        },
        "dir": "right"
      }
    },
    "actionChanged": false,
    "baseline": {
      "winner": "B",
      "territory": {
        "R": 7,
        "B": 19
      },
      "territoryDiffRed": -12,
      "turns": 15,
      "reachedLimit": false,
      "detectorChanges": 0
    },
    "experimental": {
      "winner": "B",
      "territory": {
        "R": 7,
        "B": 25
      },
      "territoryDiffRed": -18,
      "turns": 11,
      "reachedLimit": false,
      "detectorChanges": 1
    }
  }
]
```

## Decisión

El detector de una respuesta es preciso y barato, pero solo debe pasar a confirmación si la continuación
reduce o retrasa el cierre defendible. Los criterios completos están en `summary.json`.
