# Evaluación de política de territorio asegurado

- Simulaciones MCTS por decisión: 20
- Partidas por color y plan: 1
- Intervenciones: 4
- Beneficiosas/perjudiciales/neutrales/inconclusas: 0/0/4/0
- Fallbacks: 0
- Acciones ilegales: 0
- Decisión: **keep-final-policy-disabled**

```json
{
  "baseline-vs-random": {
    "games": 2,
    "wins": 2,
    "losses": 0,
    "draws": 0,
    "scoreRate": 1,
    "territoryMean": 27.5,
    "opponentTerritoryMean": 14,
    "winRateWilson95": [
      0.34238022750665303,
      1
    ],
    "cappedGames": 0,
    "byColor": {
      "R": {
        "games": 1,
        "wins": 1,
        "losses": 0,
        "draws": 0,
        "scoreRate": 1,
        "territoryMean": 27,
        "opponentTerritoryMean": 22
      },
      "B": {
        "games": 1,
        "wins": 1,
        "losses": 0,
        "draws": 0,
        "scoreRate": 1,
        "territoryMean": 28,
        "opponentTerritoryMean": 6
      }
    }
  },
  "candidate-vs-random": {
    "games": 2,
    "wins": 2,
    "losses": 0,
    "draws": 0,
    "scoreRate": 1,
    "territoryMean": 35.5,
    "opponentTerritoryMean": 5,
    "winRateWilson95": [
      0.34238022750665303,
      1
    ],
    "cappedGames": 0,
    "byColor": {
      "R": {
        "games": 1,
        "wins": 1,
        "losses": 0,
        "draws": 0,
        "scoreRate": 1,
        "territoryMean": 37,
        "opponentTerritoryMean": 5
      },
      "B": {
        "games": 1,
        "wins": 1,
        "losses": 0,
        "draws": 0,
        "scoreRate": 1,
        "territoryMean": 34,
        "opponentTerritoryMean": 5
      }
    }
  },
  "baseline-vs-heuristic": {
    "games": 2,
    "wins": 2,
    "losses": 0,
    "draws": 0,
    "scoreRate": 1,
    "territoryMean": 28,
    "opponentTerritoryMean": 10.5,
    "winRateWilson95": [
      0.34238022750665303,
      1
    ],
    "cappedGames": 0,
    "byColor": {
      "R": {
        "games": 1,
        "wins": 1,
        "losses": 0,
        "draws": 0,
        "scoreRate": 1,
        "territoryMean": 35,
        "opponentTerritoryMean": 13
      },
      "B": {
        "games": 1,
        "wins": 1,
        "losses": 0,
        "draws": 0,
        "scoreRate": 1,
        "territoryMean": 21,
        "opponentTerritoryMean": 8
      }
    }
  },
  "candidate-vs-heuristic": {
    "games": 2,
    "wins": 2,
    "losses": 0,
    "draws": 0,
    "scoreRate": 1,
    "territoryMean": 26.5,
    "opponentTerritoryMean": 15,
    "winRateWilson95": [
      0.34238022750665303,
      1
    ],
    "cappedGames": 0,
    "byColor": {
      "R": {
        "games": 1,
        "wins": 1,
        "losses": 0,
        "draws": 0,
        "scoreRate": 1,
        "territoryMean": 22,
        "opponentTerritoryMean": 19
      },
      "B": {
        "games": 1,
        "wins": 1,
        "losses": 0,
        "draws": 0,
        "scoreRate": 1,
        "territoryMean": 31,
        "opponentTerritoryMean": 11
      }
    }
  },
  "baseline-vs-mcts": {
    "games": 2,
    "wins": 1,
    "losses": 1,
    "draws": 0,
    "scoreRate": 0.5,
    "territoryMean": 17,
    "opponentTerritoryMean": 17,
    "winRateWilson95": [
      0.09453120573423074,
      0.9054687942657693
    ],
    "cappedGames": 0,
    "byColor": {
      "R": {
        "games": 1,
        "wins": 1,
        "losses": 0,
        "draws": 0,
        "scoreRate": 1,
        "territoryMean": 25,
        "opponentTerritoryMean": 9
      },
      "B": {
        "games": 1,
        "wins": 0,
        "losses": 1,
        "draws": 0,
        "scoreRate": 0,
        "territoryMean": 9,
        "opponentTerritoryMean": 25
      }
    }
  },
  "candidate-vs-mcts": {
    "games": 2,
    "wins": 1,
    "losses": 1,
    "draws": 0,
    "scoreRate": 0.5,
    "territoryMean": 19.5,
    "opponentTerritoryMean": 19.5,
    "winRateWilson95": [
      0.09453120573423074,
      0.9054687942657693
    ],
    "cappedGames": 0,
    "byColor": {
      "R": {
        "games": 1,
        "wins": 0,
        "losses": 1,
        "draws": 0,
        "scoreRate": 0,
        "territoryMean": 13,
        "opponentTerritoryMean": 26
      },
      "B": {
        "games": 1,
        "wins": 1,
        "losses": 0,
        "draws": 0,
        "scoreRate": 1,
        "territoryMean": 26,
        "opponentTerritoryMean": 13
      }
    }
  },
  "candidate-vs-baseline": {
    "games": 2,
    "wins": 1,
    "losses": 1,
    "draws": 0,
    "scoreRate": 0.5,
    "territoryMean": 23.5,
    "opponentTerritoryMean": 23.5,
    "winRateWilson95": [
      0.09453120573423074,
      0.9054687942657693
    ],
    "cappedGames": 0,
    "byColor": {
      "R": {
        "games": 1,
        "wins": 0,
        "losses": 1,
        "draws": 0,
        "scoreRate": 0,
        "territoryMean": 22,
        "opponentTerritoryMean": 25
      },
      "B": {
        "games": 1,
        "wins": 1,
        "losses": 0,
        "draws": 0,
        "scoreRate": 1,
        "territoryMean": 25,
        "opponentTerritoryMean": 22
      }
    }
  }
}
```
