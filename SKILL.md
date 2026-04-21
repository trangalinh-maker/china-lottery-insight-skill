name: china-lottery-insight
description: Analyzes Double Color Ball (双色球, ssq) and Super Lotto (大乐透, dlt) with real historical data, cross-source validation, freshness checks, and holiday-aware schedule handling. Use when users ask in Chinese for 双色球或大乐透的分析、推荐、预算建议或风险透明的号码参考。
---

# China Lottery Insight

Use this skill to produce Chinese lottery insight reports for 双色球 (`ssq`) and 大乐透 (`dlt`) with real data, transparent methods, and explicit risk disclosure.

## Quick Start

```bash
# 大乐透，预算10元
node lotteryPredict.js dlt 10

# 双色球，预算20元
node lotteryPredict.js ssq 20

# 回归检查（解析/校验/新鲜度/顺延/回测字段）
node regression-check.js

# 可选：生成本地配置文件
cp lottery-predict-config.example.json lottery-predict-config.json
cp lottery-closure-rules.example.json lottery-closure-rules.json
```

## Execution Workflow

1. Parse user intent into `lotteryType` and optional `budget` (default `10`).
2. Fetch real history only; do not silently fall back to simulated data.
3. Validate data quality (range, count, de-duplication, issue normalization).
4. Check freshness with draw cadence + closure-aware rules.
5. Generate diversified tickets (hot/cold/mixed/random mix with structural constraints).
6. Produce a Chinese report that includes method transparency and risk disclaimer.

## Required Output Blocks

- 基本信息：分析期数、数据来源、下期开奖时间
- 数据质量：新鲜度、交叉校验、缓存使用信息（若触发）
- 历史分析：热号、冷号、统计显著性与结构区间
- 推荐号码：1-5 组，附策略说明
- 购彩建议：预算可购买注数与分散建议
- 风险提示：彩票独立随机，结果仅供娱乐参考

## Guardrails

- Do not claim guaranteed returns or deterministic winning patterns.
- Keep wording explicit: “仅供娱乐参考，请理性投注”。
- If latest draw date cannot be parsed, fail closed and stop prediction.
- If required issue window is not satisfied, return an error instead of partial silent fallback.

## Progressive References

- Use [references/data-pipeline.md](references/data-pipeline.md) for retrieval, validation, freshness, and fallback rules.
- Use [references/configuration.md](references/configuration.md) for runtime options and closure overrides.
- Use [references/report-template.md](references/report-template.md) for report rendering and field conventions.

## Maintenance Checklist

- Run `node regression-check.js` after behavior changes.
- Smoke-test at least one `dlt` and one `ssq` command.
- Keep docs and actual CLI behavior aligned.
