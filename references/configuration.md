# Configuration

## Files

- `lottery-predict-config.json`: runtime tuning (optional)
- `lottery-predict-config.example.json`: reference template
- `lottery-closure-rules.json`: custom closure rules (optional)
- `lottery-closure-rules.example.json`: closure template

## Runtime Areas

### Issue window and validation

- `issueWindow`: analysis history length
- `validation.sampleSize`: cross-check sample size
- `validation.minChecked`: minimum matched draws before trusting coverage
- `validation.minCoverage`: minimum acceptable coverage ratio

### History freshness and cache

- `history.cacheMaxAgeDays` / `history.cacheMaxAgeMs`
- `history.maxMissedDraws`
- `history.hardMaxStaleDays`

### Backtest

- `backtest.evaluationLimit`
- `backtest.windowCandidates`
- `backtest.bootstrapIterations`
- `backtest.groupTicketCount`
- `backtest.groupStrategyOrder`

### Ticket generation

- `ticketGeneration.maxSchemes`
- `ticketGeneration.strategyOrder`
- `ticketGeneration.adaptiveMixEnabled`
- `ticketGeneration.adaptiveLookbackDraws`
- `ticketGeneration.adaptiveProbeTickets`
- `ticketGeneration.candidateAttempts`
- `ticketGeneration.minDistanceFloor`
- `ticketGeneration.minDistanceRatio`

## Tuning Principles

- Keep changes incremental and measurable.
- Re-run `node regression-check.js` after any threshold adjustment.
- Prefer reporting uncertainty instead of overfitting hyper-parameters.
