# Data Pipeline

## Lottery Coverage

- 大乐透 (`dlt`): `35` 选 `5` + `12` 选 `2`
- 双色球 (`ssq`): `33` 选 `6` + `16` 选 `1`

## Source Strategy

### 大乐透 (`dlt`)

1. Primary: 中国体彩网官方接口 `webapi.sporttery.cn`
2. Fallback: 500历史页 `datachart.500.com`（多 URL 尝试）

### 双色球 (`ssq`)

1. Primary: 500历史页 `datachart.500.com`
2. Verification: 中彩网接口 `jc.zhcw.com`（JSONP）
3. Cross-check recent sample and require minimum coverage threshold

## Data Quality Rules

- Validate number count and valid ranges per lottery type
- Remove duplicates by normalized issue id
- Reject output if required issue window is not met
- Do not silently synthesize mock draws

## Freshness & Fail-Closed Rules

- Evaluate freshness by draw cadence (not fixed day count only)
- Include closure windows when deciding expected draw progress
- If latest draw time cannot be parsed, fail closed
- Cache can be used only when age and freshness constraints pass

## Holiday Handling

- Default closure policy: 春节 `10` 天 + 国庆 `4` 天
- Support year-specific overrides via `lottery-closure-rules.json`
- Report should disclose whether next draw date is holiday-adjusted

## Backtest Notes

- Use walk-forward evaluation windows (short/long)
- Compare model ticket group vs random baseline ticket group
- Report p-values, confidence intervals, and robustness hints
- Do not market backtest as guaranteed forward edge
