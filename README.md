# China Lottery Insight Skill

一个面向 `大乐透(dlt)` 和 `双色球(ssq)` 的中文分析型 skill：基于真实历史开奖数据做交叉校验、新鲜度检查、休市顺延判断，并输出带有风险提示和预算建议的娱乐性号码参考。

## Quick Start

```bash
# 大乐透，预算10元
node lotteryPredict.js dlt 10

# 双色球，预算20元
node lotteryPredict.js ssq 20

# 回归检查
node regression-check.js
```

## Optional Config

```bash
cp lottery-predict-config.example.json lottery-predict-config.json
cp lottery-closure-rules.example.json lottery-closure-rules.json
```

- `lottery-predict-config.json`: 调整分析窗口、回测参数、策略配比。
- `lottery-closure-rules.json`: 自定义按年休市窗口（覆盖默认春节/国庆规则）。

## What This Skill Emphasizes

- 以分析透明度优先，而不是宣称“精准预测”
- 实时数据优先，缓存回退受新鲜度约束
- 双色球双源交叉校验与覆盖率提示
- 休市顺延可解释（春节/国庆可配置）
- 回测结果包含不确定性提示（p 值/区间）
- 明确风险声明：仅供娱乐参考

## Skill Docs

- 主说明: `SKILL.md`
- 数据流程: `references/data-pipeline.md`
- 配置说明: `references/configuration.md`
- 输出模板: `references/report-template.md`
