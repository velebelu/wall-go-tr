# Evaluación de política de territorio asegurado

- Simulaciones MCTS por decisión: 20
- Partidas por color y plan: 1
- Intervenciones: 9
- Beneficiosas/perjudiciales/neutrales/inconclusas: 2/1/6/0
- Fallbacks: 1
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
    "winRateWilson95": [
      0.34238022750665303,
      1
    ],
    "territoryMean": 27.5,
    "opponentTerritoryMean": 14,
    "cappedGames": 0
  },
  "candidate-vs-random": {
    "games": 2,
    "wins": 2,
    "losses": 0,
    "draws": 0,
    "scoreRate": 1,
    "winRateWilson95": [
      0.34238022750665303,
      1
    ],
    "territoryMean": 35.5,
    "opponentTerritoryMean": 5,
    "cappedGames": 0
  },
  "baseline-vs-heuristic": {
    "games": 2,
    "wins": 2,
    "losses": 0,
    "draws": 0,
    "scoreRate": 1,
    "winRateWilson95": [
      0.34238022750665303,
      1
    ],
    "territoryMean": 28,
    "opponentTerritoryMean": 10.5,
    "cappedGames": 0
  },
  "candidate-vs-heuristic": {
    "games": 2,
    "wins": 1,
    "losses": 0,
    "draws": 1,
    "scoreRate": 0.75,
    "winRateWilson95": [
      0.09453120573423074,
      0.9054687942657693
    ],
    "territoryMean": 27,
    "opponentTerritoryMean": 17,
    "cappedGames": 0
  },
  "baseline-vs-mcts": {
    "games": 2,
    "wins": 1,
    "losses": 1,
    "draws": 0,
    "scoreRate": 0.5,
    "winRateWilson95": [
      0.09453120573423074,
      0.9054687942657693
    ],
    "territoryMean": 17,
    "opponentTerritoryMean": 17,
    "cappedGames": 0
  },
  "candidate-vs-mcts": {
    "games": 2,
    "wins": 1,
    "losses": 1,
    "draws": 0,
    "scoreRate": 0.5,
    "winRateWilson95": [
      0.09453120573423074,
      0.9054687942657693
    ],
    "territoryMean": 20.5,
    "opponentTerritoryMean": 21.5,
    "cappedGames": 0
  },
  "candidate-vs-baseline": {
    "games": 2,
    "wins": 1,
    "losses": 1,
    "draws": 0,
    "scoreRate": 0.5,
    "winRateWilson95": [
      0.09453120573423074,
      0.9054687942657693
    ],
    "territoryMean": 23,
    "opponentTerritoryMean": 23.5,
    "cappedGames": 0
  }
}
```
