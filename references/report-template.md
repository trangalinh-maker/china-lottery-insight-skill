# Report Template

Use Chinese output and keep sections in this order.

```markdown
# {LotteryType} 预测分析报告

## 📅 基本信息
- **分析期数**: 近 {count} 期（真实数据）
- **数据来源**: {source_domain}
- **下期开奖**: {next_draw_date}

## 📊 历史数据分析
- **热号 (Hot)**: {hot_numbers}
- **冷号 (Cold)**: {cold_numbers}
- **统计结论**: {significance_summary}

## 🔮 推荐号码
根据历史走势分析，为您生成以下推荐：

| 方案 | 红球/前区 | 蓝球/后区 | 说明 |
| :--- | :--- | :--- | :--- |
| 1 | {front_1} | {back_1} | {reason_1} |
| 2 | {front_2} | {back_2} | {reason_2} |

## 💡 购彩建议 (预算: {funds}元)
- **可购买注数**: {ticket_count} 注
- **每注价格**: {ticket_price} 元
- **建议**: {suggestion}

> **⚠️ 风险提示**: 彩票是独立随机事件，分析结果仅供娱乐参考，请理性投注。
> **📅 休市提醒**: 节假日休市以财政部年度彩票市场休市公告为准。
```

## Rendering Rules

- Show cross-validation or fallback warnings in basic info when applicable.
- Keep wording conservative when p-values or confidence intervals indicate random-like behavior.
- If closure adjustment happened, disclose the specific adjustment reason.
- Do not remove the risk disclaimer.
