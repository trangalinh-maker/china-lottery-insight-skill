#!/usr/bin/env node

const assert = require('assert');
const {
  LOTTERY_CONFIG,
  parse500HistoryRows,
  crossValidateDraws,
  assessHistoryFreshness,
  evaluateTicketGroupHits,
  getNextDrawDate,
  runBacktest,
} = require('./lotteryPredict');

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateToYmd(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function buildUniqueNumbers(seed, count, max) {
  const set = new Set();
  let x = (seed >>> 0) || 1;
  while (set.size < count) {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    set.add((x % max) + 1);
  }
  return [...set].sort((a, b) => a - b);
}

function makeSyntheticDraws(lotteryType, count) {
  const config = LOTTERY_CONFIG[lotteryType];
  const anchor = new Date(2026, 3, 6);
  anchor.setHours(0, 0, 0, 0);

  const draws = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(anchor);
    date.setDate(anchor.getDate() - i);
    draws.push({
      issue: String(90000 - i),
      drawTime: dateToYmd(date),
      reds: buildUniqueNumbers(i + 11, config.redCount, config.redRange.max),
      blues: buildUniqueNumbers(i + 701, config.blueCount, config.blueRange.max),
    });
  }
  return draws;
}

function testParse500HistoryRows() {
  const html = `
    <table>
      <tr class="t_tr1">
        <td>26035</td><td>06</td><td>08</td><td>16</td><td>21</td><td>29</td><td>01</td><td>05</td><td>2026-04-04</td>
      </tr>
      <tr>
        <td>26034</td><td>01</td><td>02</td><td>11</td><td>20</td><td>30</td><td>06</td><td>07</td><td>2026-04-02</td>
      </tr>
    </table>
  `;
  const parsed = parse500HistoryRows(html, 'dlt', 10);
  assert.strictEqual(parsed.length, 2, '500解析应能解析 class 行和通用行');
  assert.strictEqual(parsed[0].issue, '26035', '首行期号解析错误');
  assert.deepStrictEqual(parsed[0].reds, [6, 8, 16, 21, 29], '前区解析错误');
  assert.deepStrictEqual(parsed[0].blues, [1, 5], '后区解析错误');
}

function testCrossValidationCoverageThreshold() {
  const base = makeSyntheticDraws('dlt', 30);
  const verifyLowCoverage = base.slice(0, 20);
  const lowCoverage = crossValidateDraws(base, verifyLowCoverage, 30, 20, 0.8);
  assert.strictEqual(lowCoverage.checked, 20, '低覆盖样本检查期数错误');
  assert.strictEqual(lowCoverage.pass, false, '覆盖率不足时不应判定通过');

  const verifyFullCoverage = base.slice(0, 30);
  const fullCoverage = crossValidateDraws(base, verifyFullCoverage, 30, 20, 0.8);
  assert.strictEqual(fullCoverage.pass, true, '覆盖率足够且无冲突应通过');
}

function testFreshnessFailClosed() {
  const draws = [{
    issue: '26035',
    drawTime: 'invalid-date',
    reds: [6, 8, 16, 21, 29],
    blues: [1, 5],
  }];
  const freshness = assessHistoryFreshness(draws, 'dlt');
  assert.strictEqual(freshness.isFresh, false, '开奖日期不可解析时应 fail-closed');
  assert.strictEqual(freshness.reason, 'unparsed_draw_time', 'fail-closed 原因码不正确');
}

function testHolidayPostponement() {
  const date = new Date(2026, 1, 15, 12, 0, 0); // 2026-02-15
  const next = getNextDrawDate('dlt', date);
  assert.strictEqual(next.holidayAdjusted, true, '春节期间应触发顺延');
  assert.strictEqual(next.dateStr.includes('2026年02月25日'), true, '顺延后目标开奖日应为2026-02-25');
}

function testBacktestOutputShape() {
  const draws = makeSyntheticDraws('dlt', 320);
  const backtest = runBacktest(draws, LOTTERY_CONFIG.dlt, 'dlt');
  assert.ok(backtest, '回测结果不应为空');
  assert.strictEqual(backtest.mode, 'group', '回测应使用5注组合口径');
  assert.ok(Number.isInteger(backtest.groupTicketCount) && backtest.groupTicketCount >= 1, '回测应输出组合注数');
  assert.ok(Array.isArray(backtest.stages) && backtest.stages.length >= 1, '应包含分阶段回测');
  assert.ok(backtest.consistency && typeof backtest.consistency.frontDeltaRange === 'number', '应包含稳健性字段');
  assert.ok(backtest.delta && backtest.delta.frontSign && typeof backtest.delta.frontSign.pValue === 'number', '应包含显著性字段');
  assert.ok(typeof backtest.delta.prizeScore === 'number', '应包含奖级目标分差值');
  assert.ok(Array.isArray(backtest.delta.prizeCI95), '应包含奖级目标分置信区间');
  assert.ok(backtest.delta.prizeSign && typeof backtest.delta.prizeSign.pValue === 'number', '应包含奖级目标分显著性');
}

function testGroupHitNoCrossTicketMixing() {
  const target = {
    reds: [1, 2, 3, 4, 5],
    blues: [1, 2],
  };
  const tickets = [
    { reds: [1, 2, 3, 4, 30], blues: [9, 10] }, // 前区4中，后区0中
    { reds: [20, 21, 22, 23, 24], blues: [1, 2] }, // 前区0中，后区2中
  ];

  const hit = evaluateTicketGroupHits('dlt', tickets, target, LOTTERY_CONFIG.dlt);
  // 旧逻辑会混拼成 front=4/back=2（不存在于同一注），新逻辑必须只取单注结果。
  assert.ok(
    (hit.selectedFront === 4 && hit.selectedBack === 0) ||
      (hit.selectedFront === 0 && hit.selectedBack === 2),
    '组内命中不应跨注混拼'
  );
  assert.ok(hit.selectedTier === 5 || hit.selectedTier === 6 || hit.selectedTier === null, '奖级识别应存在且合法');
}

function main() {
  const tests = [
    testParse500HistoryRows,
    testCrossValidationCoverageThreshold,
    testFreshnessFailClosed,
    testHolidayPostponement,
    testBacktestOutputShape,
    testGroupHitNoCrossTicketMixing,
  ];

  for (const test of tests) {
    test();
    console.log(`PASS ${test.name}`);
  }
  console.log(`\n所有回归检查通过，共 ${tests.length} 项。`);
}

main();
