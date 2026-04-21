#!/usr/bin/env node

/**
 * 彩票预测系统 - 真实数据版
 * 使用近500期真实数据做统计分析并生成推荐号码。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ISSUE_WINDOW = 500;
const FETCH_TIMEOUT_SECONDS = 20;
const VALIDATION_SAMPLE_SIZE = 30;
const VALIDATION_MIN_CHECKED = 20;
const VALIDATION_MIN_COVERAGE = 0.8;
const HOLIDAY_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7天
const HOLIDAY_CACHE_FILE = '.auto-holidays-cache.json';
const HOLIDAY_CACHE_VERSION = 5;
const CLOSURE_RULES_FILE = 'lottery-closure-rules.json';
const PREDICT_CONFIG_FILE = 'lottery-predict-config.json';
const HISTORY_CACHE_PREFIX = '.history-cache-';
const HISTORY_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 14; // 14天
const HISTORY_MAX_MISSED_DRAWS = 1;
const HISTORY_HARD_MAX_STALE_DAYS = 45;
const BACKTEST_EVAL_LIMIT = 120;
const BACKTEST_WINDOW_CANDIDATES = [80, 160];
const HOLIDAY_REMOTE_BASE = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master';

// 彩票市场休市规则（参考财政部年度公告的长期口径）
const DEFAULT_LOTTERY_CLOSURE_RULES = [
  { festival: '春节', displayName: '春节休市', lengthDays: 10, startMonths: [1, 2] },
  { festival: '国庆节', displayName: '国庆休市', lengthDays: 4, startMonths: [10] },
];

// 默认节假日配置（可通过同目录 holidays.json 扩展）
const DEFAULT_HOLIDAYS = {
  // 2026年春节休市
  '2026-02-14': { name: '春节休市开始', endDate: '2026-02-23' },
  '2026-02-15': { name: '春节休市', endDate: '2026-02-23' },
  '2026-02-16': { name: '春节休市', endDate: '2026-02-23' },
  '2026-02-17': { name: '春节休市', endDate: '2026-02-23' },
  '2026-02-18': { name: '春节休市', endDate: '2026-02-23' },
  '2026-02-19': { name: '春节休市', endDate: '2026-02-23' },
  '2026-02-20': { name: '春节休市', endDate: '2026-02-23' },
  '2026-02-21': { name: '春节休市', endDate: '2026-02-23' },
  '2026-02-22': { name: '春节休市', endDate: '2026-02-23' },
  '2026-02-23': { name: '春节休市结束', endDate: '2026-02-23' },
};

function readJsonFileSafe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonFileSafe(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // 缓存写入失败不影响主流程
  }
}

const DAY_MS = 1000 * 60 * 60 * 24;
const ALLOWED_STRATEGIES = new Set(['hot', 'cold', 'mixed', 'random']);
const BASE_ADAPTIVE_STRATEGIES = ['hot', 'cold', 'mixed'];

const DEFAULT_RUNTIME_OPTIONS = {
  issueWindow: ISSUE_WINDOW,
  validation: {
    sampleSize: VALIDATION_SAMPLE_SIZE,
    minChecked: VALIDATION_MIN_CHECKED,
    minCoverage: VALIDATION_MIN_COVERAGE,
  },
  history: {
    cacheMaxAgeMs: HISTORY_CACHE_MAX_AGE_MS,
    maxMissedDraws: HISTORY_MAX_MISSED_DRAWS,
    hardMaxStaleDays: HISTORY_HARD_MAX_STALE_DAYS,
  },
  backtest: {
    evaluationLimit: BACKTEST_EVAL_LIMIT,
    windowCandidates: [...BACKTEST_WINDOW_CANDIDATES],
    bootstrapIterations: 500,
    groupTicketCount: 5,
    groupStrategyOrder: ['hot', 'cold', 'mixed', 'mixed', 'mixed'],
  },
  ticketGeneration: {
    maxSchemes: 5,
    strategyOrder: ['hot', 'cold', 'mixed', 'mixed', 'mixed'],
    candidateAttempts: 120,
    minDistanceFloor: 4,
    minDistanceRatio: 0.6,
    distanceWeight: 5,
    patternPenaltyWeight: 3,
    objectiveHitWeight: 1,
    objectivePrizeWeight: 0.7,
    adaptiveMixEnabled: true,
    adaptiveLookbackDraws: 24,
    adaptiveMinLookback: 10,
    adaptiveProbeTickets: 12,
  },
};

function toPositiveInt(value, fallback, min = 1, max = Number.POSITIVE_INFINITY) {
  const num = Number(value);
  if (!Number.isInteger(num)) return fallback;
  if (num < min || num > max) return fallback;
  return num;
}

function toFloatRange(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  if (num < min || num > max) return fallback;
  return num;
}

function normalizeStrategyOrder(input, fallback, minLength = 1) {
  const source = Array.isArray(input) ? input : fallback;
  const filtered = source
    .map(item => String(item || '').trim().toLowerCase())
    .filter(item => ALLOWED_STRATEGIES.has(item));
  if (filtered.length < minLength) return [...fallback];
  return filtered;
}

function normalizeWindowCandidates(input, fallback) {
  const source = Array.isArray(input) ? input : fallback;
  const normalized = [...new Set(
    source
      .map(item => Number(item))
      .filter(num => Number.isInteger(num) && num >= 60 && num <= 400)
  )].sort((a, b) => a - b);
  return normalized.length > 0 ? normalized : [...fallback];
}

function toBoolean(value, fallback) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    if (text === 'true') return true;
    if (text === 'false') return false;
  }
  return fallback;
}

function loadPredictRuntimeOptions() {
  const configPath = path.join(__dirname, PREDICT_CONFIG_FILE);
  const raw = readJsonFileSafe(configPath);
  const config = raw && typeof raw === 'object' ? raw : {};

  const validation = config.validation && typeof config.validation === 'object'
    ? config.validation
    : {};
  const history = config.history && typeof config.history === 'object'
    ? config.history
    : {};
  const backtest = config.backtest && typeof config.backtest === 'object'
    ? config.backtest
    : {};
  const ticketGeneration = config.ticketGeneration && typeof config.ticketGeneration === 'object'
    ? config.ticketGeneration
    : {};

  const cacheMaxAgeDays = toPositiveInt(
    history.cacheMaxAgeDays,
    Math.round(DEFAULT_RUNTIME_OPTIONS.history.cacheMaxAgeMs / DAY_MS),
    1,
    90
  );
  const cacheMaxAgeMs = toPositiveInt(
    history.cacheMaxAgeMs,
    cacheMaxAgeDays * DAY_MS,
    DAY_MS,
    365 * DAY_MS
  );

  return {
    issueWindow: toPositiveInt(config.issueWindow, DEFAULT_RUNTIME_OPTIONS.issueWindow, 100, 5000),
    validation: {
      sampleSize: toPositiveInt(validation.sampleSize, DEFAULT_RUNTIME_OPTIONS.validation.sampleSize, 10, 120),
      minChecked: toPositiveInt(validation.minChecked, DEFAULT_RUNTIME_OPTIONS.validation.minChecked, 5, 120),
      minCoverage: toFloatRange(validation.minCoverage, DEFAULT_RUNTIME_OPTIONS.validation.minCoverage, 0.1, 1),
    },
    history: {
      cacheMaxAgeMs,
      maxMissedDraws: toPositiveInt(history.maxMissedDraws, DEFAULT_RUNTIME_OPTIONS.history.maxMissedDraws, 0, 10),
      hardMaxStaleDays: toPositiveInt(history.hardMaxStaleDays, DEFAULT_RUNTIME_OPTIONS.history.hardMaxStaleDays, 7, 180),
    },
    backtest: {
      evaluationLimit: toPositiveInt(backtest.evaluationLimit, DEFAULT_RUNTIME_OPTIONS.backtest.evaluationLimit, 30, 300),
      windowCandidates: normalizeWindowCandidates(
        backtest.windowCandidates,
        DEFAULT_RUNTIME_OPTIONS.backtest.windowCandidates
      ),
      bootstrapIterations: toPositiveInt(
        backtest.bootstrapIterations,
        DEFAULT_RUNTIME_OPTIONS.backtest.bootstrapIterations,
        100,
        2000
      ),
      groupTicketCount: toPositiveInt(
        backtest.groupTicketCount,
        DEFAULT_RUNTIME_OPTIONS.backtest.groupTicketCount,
        1,
        10
      ),
      groupStrategyOrder: normalizeStrategyOrder(
        backtest.groupStrategyOrder,
        DEFAULT_RUNTIME_OPTIONS.backtest.groupStrategyOrder,
        1
      ),
    },
    ticketGeneration: {
      maxSchemes: toPositiveInt(ticketGeneration.maxSchemes, DEFAULT_RUNTIME_OPTIONS.ticketGeneration.maxSchemes, 1, 10),
      strategyOrder: normalizeStrategyOrder(
        ticketGeneration.strategyOrder,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.strategyOrder,
        1
      ),
      candidateAttempts: toPositiveInt(
        ticketGeneration.candidateAttempts,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.candidateAttempts,
        20,
        500
      ),
      minDistanceFloor: toPositiveInt(
        ticketGeneration.minDistanceFloor,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.minDistanceFloor,
        1,
        12
      ),
      minDistanceRatio: toFloatRange(
        ticketGeneration.minDistanceRatio,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.minDistanceRatio,
        0,
        1
      ),
      distanceWeight: toFloatRange(
        ticketGeneration.distanceWeight,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.distanceWeight,
        0.1,
        20
      ),
      patternPenaltyWeight: toFloatRange(
        ticketGeneration.patternPenaltyWeight,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.patternPenaltyWeight,
        0,
        20
      ),
      objectiveHitWeight: toFloatRange(
        ticketGeneration.objectiveHitWeight,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.objectiveHitWeight,
        0.1,
        5
      ),
      objectivePrizeWeight: toFloatRange(
        ticketGeneration.objectivePrizeWeight,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.objectivePrizeWeight,
        0,
        5
      ),
      adaptiveMixEnabled: toBoolean(
        ticketGeneration.adaptiveMixEnabled,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.adaptiveMixEnabled
      ),
      adaptiveLookbackDraws: toPositiveInt(
        ticketGeneration.adaptiveLookbackDraws,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.adaptiveLookbackDraws,
        6,
        120
      ),
      adaptiveMinLookback: toPositiveInt(
        ticketGeneration.adaptiveMinLookback,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.adaptiveMinLookback,
        4,
        60
      ),
      adaptiveProbeTickets: toPositiveInt(
        ticketGeneration.adaptiveProbeTickets,
        DEFAULT_RUNTIME_OPTIONS.ticketGeneration.adaptiveProbeTickets,
        4,
        80
      ),
    },
  };
}

const RUNTIME_OPTIONS = loadPredictRuntimeOptions();
const EFFECTIVE_ISSUE_WINDOW = RUNTIME_OPTIONS.issueWindow;

function formatDateKeyLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, days) {
  const date = new Date(`${dateStr}T00:00:00`);
  date.setDate(date.getDate() + days);
  return formatDateKeyLocal(date);
}

function isDateKey(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''));
}

function normalizeClosureRule(rawRule, fallbackRule) {
  const rule = rawRule && typeof rawRule === 'object' ? rawRule : {};
  const fallback = fallbackRule || {};
  const festival = String(rule.festival || fallback.festival || '').trim();
  if (!festival) return null;

  const displayName = String(rule.displayName || fallback.displayName || `${festival}休市`).trim();
  const lengthRaw = Number(rule.lengthDays);
  const fallbackLength = Number(fallback.lengthDays);
  const lengthDays = Number.isInteger(lengthRaw) && lengthRaw > 0
    ? lengthRaw
    : (Number.isInteger(fallbackLength) && fallbackLength > 0 ? fallbackLength : 1);

  const startMonthsRaw = Array.isArray(rule.startMonths) && rule.startMonths.length > 0
    ? rule.startMonths
    : fallback.startMonths;
  const startMonths = (Array.isArray(startMonthsRaw) ? startMonthsRaw : [])
    .map(value => Number(value))
    .filter(value => Number.isInteger(value) && value >= 1 && value <= 12);

  const yearLengthDays = {};
  const rawYearLengthDays = rule.yearLengthDays && typeof rule.yearLengthDays === 'object'
    ? rule.yearLengthDays
    : fallback.yearLengthDays;
  if (rawYearLengthDays && typeof rawYearLengthDays === 'object') {
    for (const [year, value] of Object.entries(rawYearLengthDays)) {
      const n = Number(value);
      if (Number.isInteger(n) && n > 0) {
        yearLengthDays[String(year)] = n;
      }
    }
  }

  const yearStartDates = {};
  const rawYearStartDates = rule.yearStartDates && typeof rule.yearStartDates === 'object'
    ? rule.yearStartDates
    : fallback.yearStartDates;
  if (rawYearStartDates && typeof rawYearStartDates === 'object') {
    for (const [year, value] of Object.entries(rawYearStartDates)) {
      if (isDateKey(value)) {
        yearStartDates[String(year)] = String(value);
      }
    }
  }

  return {
    festival,
    displayName,
    lengthDays,
    startMonths,
    yearLengthDays,
    yearStartDates,
  };
}

function loadClosureRules() {
  const rulesPath = path.join(__dirname, CLOSURE_RULES_FILE);
  const custom = readJsonFileSafe(rulesPath);
  const baseRules = DEFAULT_LOTTERY_CLOSURE_RULES
    .map(rule => normalizeClosureRule(rule, null))
    .filter(Boolean);

  if (!custom || !Array.isArray(custom.rules)) {
    return { rules: baseRules, source: 'default' };
  }

  const customRules = custom.rules
    .map(rule => normalizeClosureRule(rule, null))
    .filter(Boolean);
  const byFestival = new Map(customRules.map(rule => [rule.festival, rule]));

  const merged = [];
  for (const base of baseRules) {
    merged.push(normalizeClosureRule(byFestival.get(base.festival), base));
    byFestival.delete(base.festival);
  }
  for (const extra of byFestival.values()) {
    merged.push(extra);
  }

  return {
    rules: merged,
    source: String(custom.source || `custom:${CLOSURE_RULES_FILE}`),
  };
}

function buildHolidayWindow(startDate, lengthDays, name) {
  const map = {};
  if (!startDate || !Number.isInteger(lengthDays) || lengthDays <= 0) return map;

  const end = addDays(startDate, lengthDays - 1);
  const endDate = new Date(`${end}T00:00:00`);
  let cursor = new Date(`${startDate}T00:00:00`);
  while (cursor <= endDate) {
    const key = formatDateKeyLocal(cursor);
    map[key] = { name, endDate: end };
    cursor.setDate(cursor.getDate() + 1);
  }

  return map;
}

function fetchHolidayCnYear(year) {
  const url = `${HOLIDAY_REMOTE_BASE}/${year}.json`;
  const payload = fetchJson(url);
  if (!payload || Number(payload.year) !== Number(year) || !Array.isArray(payload.days)) {
    throw new Error(`节假日数据结构异常: ${year}`);
  }
  return payload;
}

function getMonthFromDateKey(dateStr) {
  const month = Number(String(dateStr || '').slice(5, 7));
  return Number.isInteger(month) ? month : null;
}

function findFestivalStartDate(days, rule) {
  const matched = days.filter(day => day && String(day.name || '').includes(rule.festival));
  const monthFiltered = matched.filter(day => {
    if (!Array.isArray(rule.startMonths) || rule.startMonths.length === 0) return true;
    const month = getMonthFromDateKey(day.date);
    return month != null && rule.startMonths.includes(month);
  });

  const dates = (monthFiltered.length > 0 ? monthFiltered : matched)
    .map(day => String(day.date))
    .sort();
  return dates[0] || null;
}

function buildAutoLotteryClosures(years, closureRules) {
  const map = {};
  for (const year of years) {
    const data = fetchHolidayCnYear(year);
    const yearKey = String(year);
    for (const rule of closureRules) {
      const startDate = isDateKey(rule?.yearStartDates?.[yearKey])
        ? rule.yearStartDates[yearKey]
        : findFestivalStartDate(data.days, rule);
      if (!startDate) continue;
      const customLength = Number(rule?.yearLengthDays?.[yearKey]);
      const lengthDays = Number.isInteger(customLength) && customLength > 0
        ? customLength
        : rule.lengthDays;
      Object.assign(map, buildHolidayWindow(startDate, lengthDays, rule.displayName));
    }
  }
  return map;
}

function loadHolidays() {
  const customPath = path.join(__dirname, 'holidays.json');
  const cachePath = path.join(__dirname, HOLIDAY_CACHE_FILE);
  const custom = readJsonFileSafe(customPath);
  const closureRuleConfig = loadClosureRules();
  const closureRules = closureRuleConfig.rules;
  const closureRulesSignature = JSON.stringify(closureRules);
  const currentYear = new Date().getFullYear();
  const years = [currentYear, currentYear + 1];

  let auto = null;
  const cache = readJsonFileSafe(cachePath);
  const cacheYears = Array.isArray(cache?.years) ? cache.years : [];
  const cacheVersionValid = Number(cache?.version) === HOLIDAY_CACHE_VERSION;
  const cacheFresh = Number.isFinite(cache?.fetchedAt) && Date.now() - cache.fetchedAt < HOLIDAY_CACHE_TTL_MS;
  const cacheHasYears = years.every(y => cacheYears.includes(y));
  const cacheRulesValid = String(cache?.closureRulesSignature || '') === closureRulesSignature;
  if (
    cacheVersionValid &&
    cacheFresh &&
    cacheHasYears &&
    cacheRulesValid &&
    cache?.holidays &&
    typeof cache.holidays === 'object'
  ) {
    auto = cache.holidays;
  }

  if (!auto) {
    try {
      auto = buildAutoLotteryClosures(years, closureRules);
      writeJsonFileSafe(cachePath, {
        version: HOLIDAY_CACHE_VERSION,
        fetchedAt: Date.now(),
        years,
        source: `${HOLIDAY_REMOTE_BASE}/{year}.json`,
        closureRulesSource: closureRuleConfig.source,
        closureRulesSignature,
        closureRules,
        holidays: auto,
      });
    } catch {
      auto = {};
    }
  }

  return {
    ...DEFAULT_HOLIDAYS,
    ...auto,
    ...(custom && typeof custom === 'object' ? custom : {}),
  };
}

const HOLIDAYS = loadHolidays();

// 彩票类型配置
const LOTTERY_CONFIG = {
  dlt: {
    name: '大乐透',
    redRange: { min: 1, max: 35 },
    blueRange: { min: 1, max: 12 },
    redCount: 5,
    blueCount: 2,
    drawDays: [1, 3, 6], // 周一、三、六
    drawTime: '21:30',
    pricePerTicket: 2,
  },
  ssq: {
    name: '双色球',
    redRange: { min: 1, max: 33 },
    blueRange: { min: 1, max: 16 },
    redCount: 6,
    blueCount: 1,
    drawDays: [2, 4, 7], // 周二、四、日
    drawTime: '21:15',
    pricePerTicket: 2,
  }
};

const DATA_SOURCES = {
  dltOfficial: '中国体彩网官方开奖接口（webapi.sporttery.cn）',
  dlt500: '500彩票网历史开奖页（datachart.500.com）',
  dltValidated: '中国体彩网官方接口 + 500彩票网历史页（交叉校验）',
  ssq500: '500彩票网历史开奖页（datachart.500.com）',
  ssqZhcw: '中彩网开奖接口（jc.zhcw.com）',
  ssqValidated: '500彩票网历史页 + 中彩网开奖接口（交叉校验）',
};

/**
 * 检查是否是节假日
 */
function isHoliday(dateStr) {
  return HOLIDAYS[dateStr];
}

function parseDrawTime(drawTime) {
  const [hourRaw, minuteRaw] = String(drawTime || '').split(':');
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  return {
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
  };
}

/**
 * 获取下期开奖日期
 */
function getNextDrawDate(lotteryType, fromDate = new Date()) {
  const config = LOTTERY_CONFIG[lotteryType];
  if (!config) {
    throw new Error(`未知的彩票类型: ${lotteryType}`);
  }

  const currentDate = new Date(fromDate);
  let daysToAdd = 0;
  const skippedHolidayNames = new Set();
  
  while (true) {
    const checkDate = new Date(currentDate);
    checkDate.setDate(currentDate.getDate() + daysToAdd);
    const dateStr = formatDateKeyLocal(checkDate);
    
    // 检查节假日
    const holiday = isHoliday(dateStr);
    if (holiday) {
      const holidayEnd = new Date(holiday.endDate);
      holidayEnd.setHours(23, 59, 59, 999); // 设置为当天结束时间
      // 如果在节假日期间（包括结束日），跳过
      if (checkDate <= holidayEnd) {
        skippedHolidayNames.add(String(holiday.name || '节假日休市'));
        daysToAdd++;
        continue;
      }
    }
    
    // 检查是否是开奖日
    const dayOfWeek = checkDate.getDay(); // 0=周日, 1=周一, ...
    const adjustedDay = dayOfWeek === 0 ? 7 : dayOfWeek;
    
    if (config.drawDays.includes(adjustedDay)) {
      // 当天已过开奖时刻时，顺延到下一个开奖日。
      if (daysToAdd === 0) {
        const { hour, minute } = parseDrawTime(config.drawTime);
        const currentMinutes = currentDate.getHours() * 60 + currentDate.getMinutes();
        const drawMinutes = hour * 60 + minute;
        if (currentMinutes >= drawMinutes) {
          daysToAdd++;
          continue;
        }
      }

      const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
      return {
        date: checkDate,
        dateStr: `${checkDate.getFullYear()}年${(checkDate.getMonth() + 1).toString().padStart(2, '0')}月${checkDate.getDate().toString().padStart(2, '0')}日`,
        weekday: weekdays[dayOfWeek],
        time: config.drawTime,
        lotteryName: config.name,
        isHoliday: !!holiday,
        holidayAdjusted: skippedHolidayNames.size > 0,
        holidayNames: [...skippedHolidayNames],
      };
    }
    
    daysToAdd++;
  }
}

/**
 * 构建某个数字区间（包含边界）。
 */
function buildRange(min, max) {
  const values = [];
  for (let n = min; n <= max; n++) {
    values.push(n);
  }
  return values;
}

/**
 * Fisher-Yates 洗牌。
 */
function shuffle(input, rng = Math.random) {
  const arr = [...input];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * 简单 HTML 文本清洗。
 */
function cleanCellText(rawText) {
  return rawText
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, '')
    .replace(/&#160;/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 从文本中抽取整数（保留两位字符串也会正确转数值）。
 */
function parseNum(text) {
  if (!/^\d+$/.test(text)) {
    return NaN;
  }
  return parseInt(text, 10);
}

/**
 * 校验号码是否符合彩种规则。
 */
function isValidPick(config, reds, blues) {
  if (!Array.isArray(reds) || !Array.isArray(blues)) return false;
  if (reds.length !== config.redCount || blues.length !== config.blueCount) return false;

  const redSet = new Set(reds);
  const blueSet = new Set(blues);
  if (redSet.size !== reds.length || blueSet.size !== blues.length) return false;

  const redValid = reds.every(
    n => Number.isInteger(n) && n >= config.redRange.min && n <= config.redRange.max
  );
  const blueValid = blues.every(
    n => Number.isInteger(n) && n >= config.blueRange.min && n <= config.blueRange.max
  );

  return redValid && blueValid;
}

function fetchByCurl(url, extraHeaders = []) {
  const attempts = 3;
  let lastError = null;

  for (let i = 0; i < attempts; i++) {
    const args = ['-L', '-s', '--compressed', '--max-time', String(FETCH_TIMEOUT_SECONDS), url];
    for (const header of extraHeaders) {
      args.push('-H', header);
    }

    try {
      const body = execFileSync('curl', args, {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      });
      if (!String(body).trim()) {
        throw new Error('空响应');
      }
      return body;
    } catch (err) {
      lastError = err;
    }
  }

  const msg = lastError?.stderr?.toString?.().trim?.() || lastError?.message || '未知错误';
  throw new Error(`curl请求失败: ${msg}`);
}

/**
 * HTTP GET（JSON）。
 */
function parseJsonBody(body) {
  const text = String(body || '').trim();
  try {
    return JSON.parse(text);
  } catch {}

  const jsonpMatch = text.match(/^[\w$.]+\(([\s\S]+)\)\s*;?$/);
  if (jsonpMatch) {
    return JSON.parse(jsonpMatch[1]);
  }

  throw new Error('无法识别JSON/JSONP结构');
}

function fetchJson(url, extraHeaders = []) {
  const body = fetchByCurl(url, extraHeaders);
  try {
    return parseJsonBody(body);
  } catch (err) {
    throw new Error(`JSON解析失败: ${err.message}`);
  }
}

/**
 * HTTP GET（文本）。
 */
function fetchText(url, extraHeaders = []) {
  return fetchByCurl(url, extraHeaders);
}

/**
 * 从500历史开奖页抽取近N期数据（ssq/dlt）。
 */
function extractRowsByRegex(html, regex) {
  const flags = regex.flags.includes('g') ? regex.flags : `${regex.flags}g`;
  const re = new RegExp(regex.source, flags);
  const rows = [];
  let match = re.exec(html);
  while (match) {
    rows.push(match[0]);
    match = re.exec(html);
  }
  return rows;
}

function parse500RowToDraw(rowHtml, lotteryType) {
  const config = LOTTERY_CONFIG[lotteryType];
  const row = String(rowHtml || '').replace(/<!--[\s\S]*?-->/g, '');
  const cells = [];
  const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/g;
  let cellMatch = cellRegex.exec(row);
  while (cellMatch) {
    cells.push(cleanCellText(cellMatch[1]));
    cellMatch = cellRegex.exec(row);
  }

  const requiredCells = 1 + config.redCount + config.blueCount;
  if (cells.length < requiredCells) return null;

  const issueMatch = String(cells[0] || '').match(/\d{5,7}/) || row.match(/\b\d{5,7}\b/);
  if (!issueMatch) return null;
  const issue = issueMatch[0];

  // 500页面列顺序可能微调，优先抽取 issue 之后的纯数字单元格再切片。
  const numericCells = cells
    .slice(1)
    .filter(value => /^\d{1,2}$/.test(String(value)))
    .map(parseNum)
    .filter(Number.isFinite);
  if (numericCells.length < config.redCount + config.blueCount) return null;

  const reds = numericCells.slice(0, config.redCount);
  const blues = numericCells.slice(config.redCount, config.redCount + config.blueCount);
  if (!isValidPick(config, reds, blues)) return null;

  const drawTime = cells.find(cell => /\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(cell)) || cells[cells.length - 1] || '';
  return {
    issue,
    drawTime,
    reds: [...reds].sort((a, b) => a - b),
    blues: [...blues].sort((a, b) => a - b),
  };
}

function parse500HistoryRows(html, lotteryType, limit) {
  const rows = [];
  const issueSeen = new Set();
  const addRowCandidates = rowCandidates => {
    for (const rowHtml of rowCandidates) {
      if (rows.length >= limit) break;
      const parsed = parse500RowToDraw(rowHtml, lotteryType);
      if (!parsed || issueSeen.has(parsed.issue)) continue;
      issueSeen.add(parsed.issue);
      rows.push(parsed);
    }
  };

  const strictRows = [
    ...extractRowsByRegex(html, /<tr[^>]*class=['"][^'"]*\bt_tr1\b[^'"]*['"][^>]*>[\s\S]*?<\/tr>/i),
    ...extractRowsByRegex(html, /<tr[^>]*class=['"][^'"]*\bt_tr2\b[^'"]*['"][^>]*>[\s\S]*?<\/tr>/i),
  ];
  addRowCandidates(strictRows);

  if (rows.length < limit) {
    const genericRows = extractRowsByRegex(html, /<tr\b[^>]*>[\s\S]*?<\/tr>/i)
      .filter(rowHtml => /\b\d{5,7}\b/.test(rowHtml));
    addRowCandidates(genericRows);
  }

  return rows;
}

const FIVE_HUNDRED_HISTORY_URLS = {
  dlt: [
    'https://datachart.500.com/dlt/history/newinc/history.php?start=00001&end=99999',
    'https://datachart.500.com/dlt/history/history.shtml',
  ],
  ssq: [
    'https://datachart.500.com/ssq/history/newinc/history.php?start=00001&end=99999',
    'https://datachart.500.com/ssq/history/history.shtml',
  ],
};

function fetch500HistoryWithFallback(lotteryType, limit = EFFECTIVE_ISSUE_WINDOW) {
  const urls = FIVE_HUNDRED_HISTORY_URLS[lotteryType];
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error(`未配置500数据源地址: ${lotteryType}`);
  }

  const errors = [];
  for (const url of urls) {
    try {
      const html = fetchText(url, ['Referer: https://datachart.500.com/']);
      const raw = parse500HistoryRows(html, lotteryType, limit + 150);
      const normalized = normalizeDraws(raw, lotteryType, limit);
      if (normalized.length >= limit) {
        return {
          draws: normalized,
          url,
        };
      }
      errors.push(`${url} 仅${normalized.length}期`);
    } catch (err) {
      errors.push(`${url} 失败: ${err.message}`);
    }
  }

  throw new Error(`500源全部不可用: ${errors.join(' | ')}`);
}

function parseIssueNumber(issue) {
  const match = String(issue || '').match(/\d+/);
  return match ? Number(match[0]) : NaN;
}

function normalizeDraws(rawDraws, lotteryType, limit) {
  const config = LOTTERY_CONFIG[lotteryType];
  const byIssue = new Map();

  for (const draw of rawDraws) {
    const issue = String(draw?.issue || '').trim();
    if (!issue) continue;
    const reds = Array.isArray(draw.reds) ? draw.reds : [];
    const blues = Array.isArray(draw.blues) ? draw.blues : [];
    if (!isValidPick(config, reds, blues)) continue;

    // 首次出现保留，避免重复期号污染统计。
    if (!byIssue.has(issue)) {
      byIssue.set(issue, {
        issue,
        drawTime: String(draw.drawTime || ''),
        reds: [...reds].sort((a, b) => a - b),
        blues: [...blues].sort((a, b) => a - b),
      });
    }
  }

  const draws = [...byIssue.values()].sort((a, b) => {
    const issueA = parseIssueNumber(a.issue);
    const issueB = parseIssueNumber(b.issue);
    if (Number.isFinite(issueA) && Number.isFinite(issueB)) {
      return issueB - issueA;
    }
    return String(b.issue).localeCompare(String(a.issue));
  });

  return draws.slice(0, limit);
}

/**
 * 获取大乐透近N期真实数据（优先官方接口，失败时回退500历史页）。
 */
function fetchDltHistoryFromOfficial(limit = EFFECTIVE_ISSUE_WINDOW) {
  const config = LOTTERY_CONFIG.dlt;
  const draws = [];
  const pageSize = 100;
  const pages = Math.ceil(limit / pageSize);

  for (let pageNo = 1; pageNo <= pages; pageNo++) {
    const url =
      `https://webapi.sporttery.cn/gateway/lottery/getHistoryPageListV1.qry` +
      `?gameNo=85&provinceId=0&pageSize=${pageSize}&pageNo=${pageNo}`;
    const data = fetchJson(url);
    const list = data?.value?.list;
    if (!Array.isArray(list)) {
      throw new Error('官方接口返回结构异常');
    }

    for (const item of list) {
      const parts = String(item.lotteryDrawResult || '')
        .trim()
        .split(/\s+/)
        .map(parseNum)
        .filter(Number.isFinite);
      const reds = parts.slice(0, config.redCount);
      const blues = parts.slice(config.redCount, config.redCount + config.blueCount);
      if (!isValidPick(config, reds, blues)) continue;

      draws.push({
        issue: String(item.lotteryDrawNum || ''),
        drawTime: String(item.lotteryDrawTime || ''),
        reds: [...reds].sort((a, b) => a - b),
        blues: [...blues].sort((a, b) => a - b),
      });
      if (draws.length >= limit) break;
    }
    if (draws.length >= limit) break;
  }

  const normalized = normalizeDraws(draws, 'dlt', limit);
  if (normalized.length < limit) {
    throw new Error(`官方接口仅返回${normalized.length}期，低于要求的${limit}期`);
  }
  return normalized;
}

function fetchDltHistoryFrom500(limit = EFFECTIVE_ISSUE_WINDOW) {
  const result = fetch500HistoryWithFallback('dlt', limit);
  return result.draws;
}

function fetchDltHistory(limit = EFFECTIVE_ISSUE_WINDOW) {
  try {
    const primary = fetchDltHistoryFromOfficial(limit);

    try {
      const verify = fetchDltHistoryFrom500(limit);
      const validation = crossValidateDraws(primary, verify);

      if (!validation.pass) {
        const mismatchHint =
          validation.mismatches.length > 0 ? `，冲突期号: ${validation.mismatches.slice(0, 5).join(', ')}` : '';
        return {
          draws: primary,
          source: DATA_SOURCES.dltOfficial,
          validation: {
            providerA: DATA_SOURCES.dltOfficial,
            providerB: DATA_SOURCES.dlt500,
            ...validation,
            warning:
              `大乐透双源校验未通过（已校验${validation.checked}期，覆盖率${Math.round(validation.coverage * 100)}%）` +
              mismatchHint,
          },
        };
      }

      return {
        draws: primary,
        source: DATA_SOURCES.dltValidated,
        validation: {
          providerA: DATA_SOURCES.dltOfficial,
          providerB: DATA_SOURCES.dlt500,
          ...validation,
        },
      };
    } catch (verifyErr) {
      return {
        draws: primary,
        source: DATA_SOURCES.dltOfficial,
        validation: {
          providerA: DATA_SOURCES.dltOfficial,
          providerB: DATA_SOURCES.dlt500,
          pass: false,
          checked: 0,
          matched: 0,
          mismatches: [],
          coverage: 0,
          warning: `500校验不可用: ${verifyErr.message}`,
        },
      };
    }
  } catch (officialErr) {
    const fallbackDraws = fetchDltHistoryFrom500(limit);
    if (fallbackDraws.length < limit) {
      throw new Error(
        `大乐透真实数据不足：官方失败(${officialErr.message})，500回退仅${fallbackDraws.length}期`
      );
    }
    return {
      draws: fallbackDraws,
      source: DATA_SOURCES.dlt500,
      validation: {
        providerA: DATA_SOURCES.dltOfficial,
        providerB: DATA_SOURCES.dlt500,
        pass: false,
        checked: 0,
        matched: 0,
        mismatches: [],
        coverage: 0,
        warning: `官方源不可用，已回退500源: ${officialErr.message}`,
      },
    };
  }
}

/**
 * 获取双色球近N期真实数据（500历史页）。
 */
function fetchSsqHistoryFrom500(limit = EFFECTIVE_ISSUE_WINDOW) {
  const result = fetch500HistoryWithFallback('ssq', limit);
  return result.draws;
}

function fetchSsqHistoryFromZhcw(limit = EFFECTIVE_ISSUE_WINDOW) {
  const config = LOTTERY_CONFIG.ssq;
  const draws = [];
  const pageSize = 100;
  const pages = Math.ceil(limit / pageSize);
  const extraHeaders = [
    'Referer: https://www.zhcw.com/kjxx/ssq/',
    'User-Agent: Mozilla/5.0',
  ];

  for (let pageNum = 1; pageNum <= pages; pageNum++) {
    const url =
      'https://jc.zhcw.com/port/client_json.php' +
      `?transactionType=10001001&lotteryId=1&type=0&pageNum=${pageNum}` +
      `&pageSize=${pageSize}&issueCount=${limit}&startIssue=&endIssue=&startDate=&endDate=&callback=cb`;
    const payload = fetchJson(url, extraHeaders);
    const list = Array.isArray(payload?.data) ? payload.data : [];
    if (list.length === 0) break;

    for (const item of list) {
      const reds = String(item.frontWinningNum || '')
        .trim()
        .split(/\s+/)
        .map(parseNum)
        .filter(Number.isFinite);
      const blues = String(item.backWinningNum || '')
        .trim()
        .split(/\s+/)
        .map(parseNum)
        .filter(Number.isFinite);
      if (!isValidPick(config, reds, blues)) continue;

      draws.push({
        issue: String(item.issue || ''),
        drawTime: String(item.openTime || ''),
        reds: [...reds].sort((a, b) => a - b),
        blues: [...blues].sort((a, b) => a - b),
      });
    }
  }

  return normalizeDraws(draws, 'ssq', limit);
}

function buildDrawSignature(draw) {
  return `${draw.reds.join('-')}|${draw.blues.join('-')}`;
}

function normalizeIssueKey(issue) {
  const digits = String(issue || '').replace(/\D/g, '');
  if (digits.length >= 5) {
    return digits.slice(-5);
  }
  return digits;
}

function crossValidateDraws(
  primaryDraws,
  verifyDraws,
  sampleSize = RUNTIME_OPTIONS.validation.sampleSize,
  minChecked = RUNTIME_OPTIONS.validation.minChecked,
  minCoverage = RUNTIME_OPTIONS.validation.minCoverage
) {
  const verifyMap = new Map(verifyDraws.map(draw => [normalizeIssueKey(draw.issue), draw]));
  const sample = primaryDraws.slice(0, sampleSize);
  const mismatches = [];
  let checked = 0;
  let matched = 0;

  for (const draw of sample) {
    const verify = verifyMap.get(normalizeIssueKey(draw.issue));
    if (!verify) continue;
    checked += 1;
    if (buildDrawSignature(draw) === buildDrawSignature(verify)) {
      matched += 1;
    } else {
      mismatches.push(draw.issue);
    }
  }

  const coverage = sample.length > 0 ? checked / sample.length : 0;
  return {
    checked,
    matched,
    mismatches,
    coverage: roundTo(coverage, 3),
    pass:
      checked >= Math.min(minChecked, sample.length) &&
      coverage >= minCoverage &&
      mismatches.length === 0,
  };
}

function getHistoryCachePath(lotteryType) {
  return path.join(__dirname, `${HISTORY_CACHE_PREFIX}${lotteryType}.json`);
}

function writeHistoryCache(lotteryType, payload) {
  const cachePath = getHistoryCachePath(lotteryType);
  writeJsonFileSafe(cachePath, {
    lotteryType,
    fetchedAt: Date.now(),
    ...payload,
  });
}

function readHistoryCache(lotteryType) {
  const cachePath = getHistoryCachePath(lotteryType);
  return readJsonFileSafe(cachePath);
}

function fetchSsqHistory(limit = EFFECTIVE_ISSUE_WINDOW) {
  const primary = fetchSsqHistoryFrom500(limit);
  if (primary.length < limit) {
    throw new Error(`双色球真实数据不足：500源仅获取到${primary.length}期，要求${limit}期`);
  }

  try {
    const verify = fetchSsqHistoryFromZhcw(limit);
    const validation = crossValidateDraws(primary, verify);

    if (!validation.pass) {
      const mismatchHint =
        validation.mismatches.length > 0 ? `，冲突期号: ${validation.mismatches.slice(0, 5).join(', ')}` : '';
      throw new Error(
        `双色球双源校验未通过（已校验${validation.checked}期，覆盖率${Math.round(validation.coverage * 100)}%）${mismatchHint}`
      );
    }

    return {
      draws: primary,
      source: DATA_SOURCES.ssqValidated,
      validation: {
        providerA: DATA_SOURCES.ssq500,
        providerB: DATA_SOURCES.ssqZhcw,
        ...validation,
      },
    };
  } catch (verifyErr) {
    return {
      draws: primary,
      source: DATA_SOURCES.ssq500,
      validation: {
        providerA: DATA_SOURCES.ssq500,
        providerB: DATA_SOURCES.ssqZhcw,
        pass: false,
        checked: 0,
        matched: 0,
        mismatches: [],
        coverage: 0,
        warning: `中彩网校验不可用: ${verifyErr.message}`,
      },
    };
  }
}

/**
 * 获取彩种近N期真实数据。
 */
function fetchFreshHistory(lotteryType, issueCount = EFFECTIVE_ISSUE_WINDOW) {
  if (lotteryType === 'dlt') {
    return fetchDltHistory(issueCount);
  }
  if (lotteryType === 'ssq') {
    return fetchSsqHistory(issueCount);
  }
  throw new Error(`未知的彩票类型: ${lotteryType}`);
}

function parseDrawDate(drawTime) {
  const text = String(drawTime || '').trim();
  if (!text) return null;
  const match = text.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

function toStartOfDay(dateLike) {
  const date = new Date(dateLike);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getAdjustedWeekday(date) {
  const day = date.getDay();
  return day === 0 ? 7 : day;
}

function isExpectedDrawDay(lotteryType, date) {
  const config = LOTTERY_CONFIG[lotteryType];
  if (!config) return false;
  const dateKey = formatDateKeyLocal(date);
  if (isHoliday(dateKey)) return false;
  return config.drawDays.includes(getAdjustedWeekday(date));
}

function getFreshnessEndDate(lotteryType, now = new Date()) {
  const config = LOTTERY_CONFIG[lotteryType];
  const endDate = toStartOfDay(now);
  if (!config) return endDate;

  if (isExpectedDrawDay(lotteryType, endDate)) {
    const { hour, minute } = parseDrawTime(config.drawTime);
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const drawMinutes = hour * 60 + minute;
    if (currentMinutes < drawMinutes) {
      endDate.setDate(endDate.getDate() - 1);
    }
  }
  return endDate;
}

function listExpectedDrawDatesBetween(lotteryType, latestDate, endDate) {
  const expected = [];
  if (!(latestDate instanceof Date) || Number.isNaN(latestDate.getTime())) return expected;
  if (!(endDate instanceof Date) || Number.isNaN(endDate.getTime())) return expected;

  const cursor = toStartOfDay(latestDate);
  const end = toStartOfDay(endDate);
  cursor.setDate(cursor.getDate() + 1);

  let guard = 0;
  while (cursor <= end && guard < 1200) {
    if (isExpectedDrawDay(lotteryType, cursor)) {
      expected.push(formatDateKeyLocal(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  return expected;
}

function assessHistoryFreshness(draws, lotteryType, options = {}) {
  const defaultMaxMissedDraws = RUNTIME_OPTIONS.history.maxMissedDraws;
  const defaultHardMaxStaleDays = RUNTIME_OPTIONS.history.hardMaxStaleDays;
  const maxMissedDraws =
    Number.isInteger(options.maxMissedDraws) && options.maxMissedDraws >= 0
      ? options.maxMissedDraws
      : defaultMaxMissedDraws;
  const hardMaxStaleDays =
    Number.isInteger(options.hardMaxStaleDays) && options.hardMaxStaleDays > 0
      ? options.hardMaxStaleDays
      : defaultHardMaxStaleDays;
  const now = options.now instanceof Date ? new Date(options.now) : new Date();

  if (!Array.isArray(draws) || draws.length === 0) {
    return {
      isFresh: false,
      latestDrawDate: null,
      ageDays: Number.POSITIVE_INFINITY,
      maxMissedDraws,
      hardMaxStaleDays,
      missedDraws: Number.POSITIVE_INFINITY,
      effectiveEndDate: formatDateKeyLocal(toStartOfDay(now)),
      reason: 'empty_draws',
    };
  }

  let latestDate = null;
  for (const draw of draws) {
    const drawDate = parseDrawDate(draw?.drawTime);
    if (!drawDate) continue;
    if (!latestDate || drawDate > latestDate) {
      latestDate = drawDate;
    }
  }

  if (!latestDate) {
    return {
      isFresh: false,
      latestDrawDate: null,
      ageDays: null,
      maxMissedDraws,
      hardMaxStaleDays,
      missedDraws: null,
      effectiveEndDate: formatDateKeyLocal(toStartOfDay(now)),
      reason: 'unparsed_draw_time',
    };
  }

  const endDate = getFreshnessEndDate(lotteryType, now);
  const expectedDrawDates = listExpectedDrawDatesBetween(lotteryType, latestDate, endDate);
  const missedDraws = expectedDrawDates.length;
  const ageMs = Math.max(0, endDate.getTime() - latestDate.getTime());
  const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
  const staleByMissedDraws = missedDraws > maxMissedDraws;
  const staleByHardDays = ageDays > hardMaxStaleDays;
  const reason = staleByMissedDraws
    ? 'missed_expected_draws'
    : staleByHardDays
      ? 'stale_draw_time'
      : null;

  return {
    isFresh: !staleByMissedDraws && !staleByHardDays,
    latestDrawDate: formatDateKeyLocal(latestDate),
    ageDays,
    maxMissedDraws,
    hardMaxStaleDays,
    missedDraws,
    expectedDrawDates: expectedDrawDates.slice(0, 8),
    effectiveEndDate: formatDateKeyLocal(endDate),
    reason,
  };
}

/**
 * 获取彩种近N期真实数据（实时优先，失败回退离线缓存）。
 */
function fetchRealHistory(lotteryType, issueCount = EFFECTIVE_ISSUE_WINDOW) {
  try {
    const fresh = fetchFreshHistory(lotteryType, issueCount);
    const freshness = assessHistoryFreshness(fresh.draws, lotteryType);
    if (!freshness.isFresh) {
      const latest = freshness.latestDrawDate || '未知日期';
      if (freshness.reason === 'unparsed_draw_time') {
        throw new Error('实时源开奖日期无法解析，已拒绝使用该批数据');
      }
      if (freshness.reason === 'missed_expected_draws') {
        throw new Error(
          `实时源开奖进度落后（最新${latest}，预计已遗漏${freshness.missedDraws}次开奖，阈值${freshness.maxMissedDraws}次）`
        );
      }
      throw new Error(
        `实时源最新开奖过旧（最新${latest}，距今${freshness.ageDays}天，硬阈值${freshness.hardMaxStaleDays}天）`
      );
    }

    const mergedValidation = {
      ...(fresh.validation || {}),
      latestDrawDate: freshness.latestDrawDate,
      ageDays: freshness.ageDays,
      missedDraws: freshness.missedDraws,
      maxMissedDraws: freshness.maxMissedDraws,
      freshnessEndDate: freshness.effectiveEndDate,
    };
    const freshResult = {
      ...fresh,
      validation: Object.keys(mergedValidation).length > 0 ? mergedValidation : null,
    };

    writeHistoryCache(lotteryType, {
      source: freshResult.source,
      validation: freshResult.validation || null,
      draws: freshResult.draws,
    });
    return freshResult;
  } catch (freshErr) {
    const cache = readHistoryCache(lotteryType);
    const cacheFetchedAt = Number(cache?.fetchedAt);
    const cacheAgeMs = Number.isFinite(cacheFetchedAt) ? Date.now() - cacheFetchedAt : Number.POSITIVE_INFINITY;
    const cacheMaxAgeMs = RUNTIME_OPTIONS.history.cacheMaxAgeMs;
    if (!Number.isFinite(cacheFetchedAt) || cacheAgeMs > cacheMaxAgeMs) {
      throw new Error(
        `实时拉取失败且本地缓存过期（缓存阈值${Math.floor(cacheMaxAgeMs / DAY_MS)}天）: ${freshErr.message}`
      );
    }

    const cachedRaw = Array.isArray(cache?.draws) ? cache.draws : [];
    const cachedDraws = normalizeDraws(cachedRaw, lotteryType, issueCount);

    if (cachedDraws.length >= issueCount) {
      const freshness = assessHistoryFreshness(cachedDraws, lotteryType);
      if (!freshness.isFresh) {
        const latest = freshness.latestDrawDate || '未知日期';
        if (freshness.reason === 'unparsed_draw_time') {
          throw new Error(
            `实时拉取失败且缓存开奖日期无法解析，拒绝使用缓存数据: ${freshErr.message}`
          );
        }
        if (freshness.reason === 'missed_expected_draws') {
          throw new Error(
            `实时拉取失败且缓存开奖进度落后（最新${latest}，预计已遗漏${freshness.missedDraws}次开奖，阈值${freshness.maxMissedDraws}次）: ${freshErr.message}`
          );
        }
        throw new Error(
          `实时拉取失败且缓存开奖过旧（最新${latest}，距今${freshness.ageDays}天，硬阈值${freshness.hardMaxStaleDays}天）: ${freshErr.message}`
        );
      }

      return {
        draws: cachedDraws,
        source: `${cache?.source || '历史开奖数据'}（离线缓存）`,
        validation: {
          pass: false,
          cacheUsed: true,
          cachedAt: cacheFetchedAt,
          cacheAgeDays: roundTo(cacheAgeMs / (1000 * 60 * 60 * 24), 2),
          latestDrawDate: freshness.latestDrawDate,
          ageDays: freshness.ageDays,
          missedDraws: freshness.missedDraws,
          maxMissedDraws: freshness.maxMissedDraws,
          freshnessEndDate: freshness.effectiveEndDate,
          warning: `实时拉取失败，已回退本地缓存: ${freshErr.message}`,
        },
      };
    }

    throw new Error(`实时拉取失败且本地缓存不足: ${freshErr.message}`);
  }
}

function roundTo(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function formatLocalDateTime(input) {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '-';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${hh}:${mm}:${ss}`;
}

function createSeededRng(seedText) {
  let seed = 2166136261;
  const text = String(seedText || '');
  for (let i = 0; i < text.length; i++) {
    seed ^= text.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }

  return function nextRandom() {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4294967296;
  };
}

function combination(n, k) {
  if (!Number.isInteger(n) || !Number.isInteger(k) || k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;

  const m = Math.min(k, n - k);
  let result = 1;
  for (let i = 1; i <= m; i++) {
    result = (result * (n - m + i)) / i;
  }
  return Math.round(result);
}

function calculateJackpotOdds(config) {
  const redSize = config.redRange.max - config.redRange.min + 1;
  const blueSize = config.blueRange.max - config.blueRange.min + 1;
  return combination(redSize, config.redCount) * combination(blueSize, config.blueCount);
}

function buildZoneStatistics(counter, issueCount, picksPerDraw, rangeSize) {
  const expectedCount = (issueCount * picksPerDraw) / rangeSize;
  const hitProbability = picksPerDraw / rangeSize;
  const variance = issueCount * hitProbability * (1 - hitProbability);
  const stdDev = variance > 0 ? Math.sqrt(variance) : 0;
  const significantThreshold = 1.5;

  const details = Object.entries(counter)
    .map(([num, count]) => {
      const number = Number(num);
      const zScore = stdDev > 0 ? (count - expectedCount) / stdDev : 0;
      return { number, count, zScore };
    })
    .sort((a, b) => a.number - b.number);

  const chiSquare = details.reduce((sum, item) => {
    if (expectedCount <= 0) return sum;
    return sum + ((item.count - expectedCount) ** 2) / expectedCount;
  }, 0);

  const maxAbsZ = details.reduce((max, item) => {
    return Math.max(max, Math.abs(item.zScore));
  }, 0);

  const significantHot = details
    .filter(item => item.zScore >= significantThreshold)
    .sort((a, b) => b.zScore - a.zScore || a.number - b.number)
    .map(item => item.number);

  const significantCold = details
    .filter(item => item.zScore <= -significantThreshold)
    .sort((a, b) => a.zScore - b.zScore || a.number - b.number)
    .map(item => item.number);

  return {
    expectedCount: roundTo(expectedCount, 2),
    stdDev: roundTo(stdDev, 2),
    chiSquare: roundTo(chiSquare, 2),
    significantThreshold,
    maxAbsZ: roundTo(maxAbsZ, 2),
    significantHot,
    significantCold,
  };
}

function countConsecutivePairsInSorted(numbers) {
  let count = 0;
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] - numbers[i - 1] === 1) {
      count += 1;
    }
  }
  return count;
}

function buildPatternProfile(draws, config) {
  const redSums = [];
  const oddCounts = [];
  const spans = [];
  const consecutivePairs = [];

  for (const draw of draws) {
    const reds = Array.isArray(draw?.reds) ? [...draw.reds].sort((a, b) => a - b) : [];
    if (reds.length !== config.redCount) continue;

    redSums.push(reds.reduce((sum, n) => sum + n, 0));
    oddCounts.push(reds.filter(n => n % 2 !== 0).length);
    spans.push(reds[reds.length - 1] - reds[0]);
    consecutivePairs.push(countConsecutivePairsInSorted(reds));
  }

  const minPossibleSum = Array.from({ length: config.redCount }, (_, idx) => config.redRange.min + idx)
    .reduce((sum, n) => sum + n, 0);
  const maxPossibleSum = Array.from({ length: config.redCount }, (_, idx) => config.redRange.max - idx)
    .reduce((sum, n) => sum + n, 0);
  const maxPossibleSpan = config.redRange.max - config.redRange.min;

  if (redSums.length === 0) {
    return {
      sampleSize: 0,
      redSumRange: [minPossibleSum, maxPossibleSum],
      oddCountRange: [0, config.redCount],
      spanRange: [0, maxPossibleSpan],
      maxConsecutivePairs: Math.max(1, config.redCount - 2),
    };
  }

  const sortedSums = [...redSums].sort((a, b) => a - b);
  const sortedOddCounts = [...oddCounts].sort((a, b) => a - b);
  const sortedSpans = [...spans].sort((a, b) => a - b);
  const sortedConsecutive = [...consecutivePairs].sort((a, b) => a - b);

  let sumLow = Math.floor(percentile(sortedSums, 0.1));
  let sumHigh = Math.ceil(percentile(sortedSums, 0.9));
  sumLow = Math.max(minPossibleSum, sumLow);
  sumHigh = Math.min(maxPossibleSum, sumHigh);
  if (sumLow > sumHigh) {
    sumLow = minPossibleSum;
    sumHigh = maxPossibleSum;
  }

  let oddLow = Math.floor(percentile(sortedOddCounts, 0.15));
  let oddHigh = Math.ceil(percentile(sortedOddCounts, 0.85));
  oddLow = Math.max(0, Math.min(config.redCount, oddLow));
  oddHigh = Math.max(0, Math.min(config.redCount, oddHigh));
  if (oddLow > oddHigh) {
    oddLow = 0;
    oddHigh = config.redCount;
  }

  let spanLow = Math.floor(percentile(sortedSpans, 0.1));
  let spanHigh = Math.ceil(percentile(sortedSpans, 0.9));
  spanLow = Math.max(0, Math.min(maxPossibleSpan, spanLow));
  spanHigh = Math.max(0, Math.min(maxPossibleSpan, spanHigh));
  if (spanLow > spanHigh) {
    spanLow = 0;
    spanHigh = maxPossibleSpan;
  }

  let maxConsecutivePairs = Math.ceil(percentile(sortedConsecutive, 0.9));
  maxConsecutivePairs = Math.max(0, Math.min(config.redCount - 1, maxConsecutivePairs));

  return {
    sampleSize: redSums.length,
    redSumRange: [sumLow, sumHigh],
    oddCountRange: [oddLow, oddHigh],
    spanRange: [spanLow, spanHigh],
    maxConsecutivePairs,
  };
}

function computeFrequencyAnalysis(draws, config) {
  const redCounter = {};
  const blueCounter = {};
  const redLastSeen = {};
  const blueLastSeen = {};

  for (const n of buildRange(config.redRange.min, config.redRange.max)) {
    redCounter[n] = 0;
    redLastSeen[n] = Number.POSITIVE_INFINITY;
  }
  for (const n of buildRange(config.blueRange.min, config.blueRange.max)) {
    blueCounter[n] = 0;
    blueLastSeen[n] = Number.POSITIVE_INFINITY;
  }

  draws.forEach((draw, idx) => {
    draw.reds.forEach(num => {
      redCounter[num] += 1;
      if (redLastSeen[num] === Number.POSITIVE_INFINITY) {
        redLastSeen[num] = idx;
      }
    });
    draw.blues.forEach(num => {
      blueCounter[num] += 1;
      if (blueLastSeen[num] === Number.POSITIVE_INFINITY) {
        blueLastSeen[num] = idx;
      }
    });
  });

  const hotReds = Object.entries(redCounter)
    .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))
    .slice(0, 10)
    .map(([num]) => parseInt(num, 10));

  const hotBlues = Object.entries(blueCounter)
    .sort((a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]))
    .slice(0, 5)
    .map(([num]) => parseInt(num, 10));

  const coldReds = Object.entries(redCounter)
    .sort(
      (a, b) =>
        a[1] - b[1] ||
        redLastSeen[Number(b[0])] - redLastSeen[Number(a[0])] ||
        Number(a[0]) - Number(b[0])
    )
    .slice(0, 10)
    .map(([num]) => parseInt(num, 10));

  const coldBlues = Object.entries(blueCounter)
    .sort(
      (a, b) =>
        a[1] - b[1] ||
        blueLastSeen[Number(b[0])] - blueLastSeen[Number(a[0])] ||
        Number(a[0]) - Number(b[0])
    )
    .slice(0, 5)
    .map(([num]) => parseInt(num, 10));

  const redRangeSize = config.redRange.max - config.redRange.min + 1;
  const blueRangeSize = config.blueRange.max - config.blueRange.min + 1;
  const redStats = buildZoneStatistics(redCounter, draws.length, config.redCount, redRangeSize);
  const blueStats = buildZoneStatistics(blueCounter, draws.length, config.blueCount, blueRangeSize);

  return {
    hotReds,
    hotBlues,
    coldReds,
    coldBlues,
    redDistribution: redCounter,
    blueDistribution: blueCounter,
    redStats,
    blueStats,
    significantHotReds: redStats.significantHot,
    significantColdReds: redStats.significantCold,
    significantHotBlues: blueStats.significantHot,
    significantColdBlues: blueStats.significantCold,
    patternProfile: buildPatternProfile(draws, config),
  };
}

function uniqueNumbers(values) {
  return [...new Set((values || []).filter(Number.isFinite))];
}

function createWeightMap(numbers, baseWeight = 1) {
  const map = {};
  for (const n of numbers) {
    map[n] = baseWeight;
  }
  return map;
}

function applyRankBoost(weightMap, rankedNumbers, startBoost, decay, minBoost = 0) {
  rankedNumbers.forEach((num, idx) => {
    const boost = Math.max(minBoost, startBoost - decay * idx);
    if (Number.isFinite(weightMap[num])) {
      weightMap[num] += boost;
    }
  });
}

function applyRankPenalty(weightMap, rankedNumbers, startPenalty, decay, minPenalty = 0) {
  rankedNumbers.forEach((num, idx) => {
    const penalty = Math.max(minPenalty, startPenalty - decay * idx);
    if (Number.isFinite(weightMap[num])) {
      weightMap[num] -= penalty;
    }
  });
}

function clampWeights(weightMap, minWeight = 0.08) {
  for (const key of Object.keys(weightMap)) {
    weightMap[key] = Math.max(minWeight, Number(weightMap[key]) || minWeight);
  }
}

function pickWeightedNumbers(allNumbers, weightMap, count, rng = Math.random) {
  const pool = [...allNumbers];
  const selected = [];

  while (pool.length > 0 && selected.length < count) {
    let total = 0;
    for (const n of pool) {
      total += Number(weightMap[n]) || 0.08;
    }

    let r = rng() * total;
    let pickedIndex = 0;
    for (let i = 0; i < pool.length; i++) {
      const weight = Number(weightMap[pool[i]]) || 0.08;
      r -= weight;
      if (r <= 0) {
        pickedIndex = i;
        break;
      }
      pickedIndex = i;
    }
    selected.push(pool[pickedIndex]);
    pool.splice(pickedIndex, 1);
  }

  if (selected.length < count) {
    for (const n of shuffle(allNumbers, rng)) {
      if (selected.includes(n)) continue;
      selected.push(n);
      if (selected.length >= count) break;
    }
  }

  return selected.sort((a, b) => a - b);
}

function buildStrategyPools(config, analysis) {
  const fullReds = buildRange(config.redRange.min, config.redRange.max);
  const fullBlues = buildRange(config.blueRange.min, config.blueRange.max);

  const hotRedWeights = createWeightMap(fullReds, 0.2);
  const coldRedWeights = createWeightMap(fullReds, 0.2);
  const mixedRedWeights = createWeightMap(fullReds, 1);
  const hotBlueWeights = createWeightMap(fullBlues, 0.2);
  const coldBlueWeights = createWeightMap(fullBlues, 0.2);
  const mixedBlueWeights = createWeightMap(fullBlues, 1);

  applyRankBoost(hotRedWeights, analysis.hotReds, 3.2, 0.22, 0.7);
  applyRankBoost(hotRedWeights, analysis.significantHotReds, 2.3, 0.18, 0.6);
  applyRankPenalty(hotRedWeights, analysis.coldReds, 0.35, 0.02, 0.05);
  applyRankPenalty(hotRedWeights, analysis.significantColdReds, 0.5, 0.03, 0.08);

  applyRankBoost(coldRedWeights, analysis.coldReds, 3.2, 0.22, 0.7);
  applyRankBoost(coldRedWeights, analysis.significantColdReds, 2.3, 0.18, 0.6);
  applyRankPenalty(coldRedWeights, analysis.hotReds, 0.35, 0.02, 0.05);
  applyRankPenalty(coldRedWeights, analysis.significantHotReds, 0.5, 0.03, 0.08);

  applyRankBoost(mixedRedWeights, analysis.hotReds, 0.75, 0.05, 0.1);
  applyRankBoost(mixedRedWeights, analysis.coldReds, 0.75, 0.05, 0.1);
  applyRankBoost(mixedRedWeights, analysis.significantHotReds, 0.55, 0.05, 0.1);
  applyRankBoost(mixedRedWeights, analysis.significantColdReds, 0.55, 0.05, 0.1);

  applyRankBoost(hotBlueWeights, analysis.hotBlues, 3.6, 0.35, 1.1);
  applyRankBoost(hotBlueWeights, analysis.significantHotBlues, 2.4, 0.3, 0.8);
  applyRankPenalty(hotBlueWeights, analysis.coldBlues, 0.6, 0.08, 0.15);

  applyRankBoost(coldBlueWeights, analysis.coldBlues, 3.6, 0.35, 1.1);
  applyRankBoost(coldBlueWeights, analysis.significantColdBlues, 2.4, 0.3, 0.8);
  applyRankPenalty(coldBlueWeights, analysis.hotBlues, 0.6, 0.08, 0.15);

  applyRankBoost(mixedBlueWeights, analysis.hotBlues, 0.85, 0.08, 0.1);
  applyRankBoost(mixedBlueWeights, analysis.coldBlues, 0.85, 0.08, 0.1);

  clampWeights(hotRedWeights);
  clampWeights(coldRedWeights);
  clampWeights(mixedRedWeights);
  clampWeights(hotBlueWeights);
  clampWeights(coldBlueWeights);
  clampWeights(mixedBlueWeights);

  return {
    fullReds,
    fullBlues,
    hotTargetReds: uniqueNumbers([...analysis.significantHotReds, ...analysis.hotReds]),
    coldTargetReds: uniqueNumbers([...analysis.significantColdReds, ...analysis.coldReds]),
    hotTargetBlues: uniqueNumbers([...analysis.significantHotBlues, ...analysis.hotBlues]),
    coldTargetBlues: uniqueNumbers([...analysis.significantColdBlues, ...analysis.coldBlues]),
    hotRedWeights,
    coldRedWeights,
    mixedRedWeights,
    hotBlueWeights,
    coldBlueWeights,
    mixedBlueWeights,
  };
}

function countSetOverlap(values, targetSet) {
  let count = 0;
  for (const v of values) {
    if (targetSet.has(v)) count++;
  }
  return count;
}

function pickWeightedWithConstraint(options) {
  const {
    redsAll,
    redsWeights,
    redsCount,
    redsTargets,
    minRedOverlap,
    bluesAll,
    bluesWeights,
    bluesCount,
    bluesTargets,
    minBlueOverlap,
    rng,
    attempts = 80,
  } = options;

  const redSet = new Set(redsTargets || []);
  const blueSet = new Set(bluesTargets || []);
  const targetRedMin = Math.min(minRedOverlap, redSet.size);
  const targetBlueMin = Math.min(minBlueOverlap, blueSet.size);
  let best = null;
  let bestScore = -1;

  for (let i = 0; i < attempts; i++) {
    const reds = pickWeightedNumbers(redsAll, redsWeights, redsCount, rng);
    const blues = pickWeightedNumbers(bluesAll, bluesWeights, bluesCount, rng);
    const redOverlap = countSetOverlap(reds, redSet);
    const blueOverlap = countSetOverlap(blues, blueSet);
    const score = redOverlap * 10 + blueOverlap;

    if (score > bestScore) {
      bestScore = score;
      best = { reds, blues };
    }
    if (redOverlap >= targetRedMin && blueOverlap >= targetBlueMin) {
      return { reds, blues };
    }
  }

  return best || {
    reds: pickWeightedNumbers(redsAll, redsWeights, redsCount, rng),
    blues: pickWeightedNumbers(bluesAll, bluesWeights, bluesCount, rng),
  };
}

function generateTicketByStrategy(config, pools, strategy, rng) {
  if (strategy === 'hot') {
    const picked = pickWeightedWithConstraint({
      redsAll: pools.fullReds,
      redsWeights: pools.hotRedWeights,
      redsCount: config.redCount,
      redsTargets: pools.hotTargetReds,
      minRedOverlap: Math.max(2, Math.ceil(config.redCount * 0.6)),
      bluesAll: pools.fullBlues,
      bluesWeights: pools.hotBlueWeights,
      bluesCount: config.blueCount,
      bluesTargets: pools.hotTargetBlues,
      minBlueOverlap: Math.min(config.blueCount, 1),
      rng,
    });
    return {
      reds: picked.reds,
      blues: picked.blues,
      strategy: '热号策略',
    };
  }

  if (strategy === 'cold') {
    const picked = pickWeightedWithConstraint({
      redsAll: pools.fullReds,
      redsWeights: pools.coldRedWeights,
      redsCount: config.redCount,
      redsTargets: pools.coldTargetReds,
      minRedOverlap: Math.max(2, Math.ceil(config.redCount * 0.6)),
      bluesAll: pools.fullBlues,
      bluesWeights: pools.coldBlueWeights,
      bluesCount: config.blueCount,
      bluesTargets: pools.coldTargetBlues,
      minBlueOverlap: Math.min(config.blueCount, 1),
      rng,
    });
    return {
      reds: picked.reds,
      blues: picked.blues,
      strategy: '冷号策略',
    };
  }

  if (strategy === 'random') {
    return {
      reds: pickNumbers(config, pools.fullReds, config.redCount, config.redRange, rng),
      blues: pickNumbers(config, pools.fullBlues, config.blueCount, config.blueRange, rng),
      strategy: '随机基线',
    };
  }

  return {
    reds: pickWeightedNumbers(pools.fullReds, pools.mixedRedWeights, config.redCount, rng),
    blues: pickWeightedNumbers(pools.fullBlues, pools.mixedBlueWeights, config.blueCount, rng),
    strategy: '混合策略',
  };
}

function countOverlap(a, b) {
  const bSet = new Set(b);
  let count = 0;
  for (const n of a) {
    if (bSet.has(n)) count++;
  }
  return count;
}

function symmetricDiffSize(a, b) {
  const aSet = new Set(a);
  const bSet = new Set(b);
  let diff = 0;
  for (const n of aSet) {
    if (!bSet.has(n)) diff++;
  }
  for (const n of bSet) {
    if (!aSet.has(n)) diff++;
  }
  return diff;
}

function ticketDistance(ticketA, ticketB) {
  return symmetricDiffSize(ticketA.reds, ticketB.reds) + symmetricDiffSize(ticketA.blues, ticketB.blues);
}

function ticketSignature(ticket) {
  return `${ticket.reds.join('-')}|${ticket.blues.join('-')}`;
}

function evaluateTicketPattern(ticket, patternProfile) {
  if (!patternProfile) {
    return {
      pass: true,
      penalty: 0,
      metrics: null,
    };
  }

  const reds = [...ticket.reds].sort((a, b) => a - b);
  const redSum = reds.reduce((sum, n) => sum + n, 0);
  const oddCount = reds.filter(n => n % 2 !== 0).length;
  const span = reds[reds.length - 1] - reds[0];
  const consecutivePairs = countConsecutivePairsInSorted(reds);

  const [sumLow, sumHigh] = Array.isArray(patternProfile.redSumRange)
    ? patternProfile.redSumRange
    : [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  const [oddLow, oddHigh] = Array.isArray(patternProfile.oddCountRange)
    ? patternProfile.oddCountRange
    : [0, reds.length];
  const [spanLow, spanHigh] = Array.isArray(patternProfile.spanRange)
    ? patternProfile.spanRange
    : [0, Number.POSITIVE_INFINITY];
  const maxConsecutivePairs = Number.isInteger(patternProfile.maxConsecutivePairs)
    ? patternProfile.maxConsecutivePairs
    : reds.length - 1;

  let penalty = 0;
  if (redSum < sumLow) penalty += Math.ceil((sumLow - redSum) / 2);
  if (redSum > sumHigh) penalty += Math.ceil((redSum - sumHigh) / 2);
  if (oddCount < oddLow) penalty += (oddLow - oddCount) * 2;
  if (oddCount > oddHigh) penalty += (oddCount - oddHigh) * 2;
  if (span < spanLow) penalty += Math.ceil((spanLow - span) / 2);
  if (span > spanHigh) penalty += Math.ceil((span - spanHigh) / 2);
  if (consecutivePairs > maxConsecutivePairs) penalty += (consecutivePairs - maxConsecutivePairs) * 2;

  return {
    pass: penalty === 0,
    penalty,
    metrics: {
      redSum,
      oddCount,
      span,
      consecutivePairs,
    },
  };
}

const PRIZE_TIER_SCORES = {
  dlt: { 1: 10, 2: 6, 3: 4, 4: 2.8, 5: 1.8, 6: 1.0 },
  ssq: { 1: 10, 2: 6.5, 3: 4.5, 4: 3.0, 5: 1.8, 6: 1.0 },
};

function getPrizeTier(lotteryType, frontHits, backHits) {
  if (lotteryType === 'dlt') {
    if (frontHits === 5 && backHits === 2) return 1;
    if (frontHits === 5 && backHits === 1) return 2;
    if (frontHits === 5 && backHits === 0) return 3;
    if (frontHits === 4 && backHits === 2) return 4;
    if ((frontHits === 4 && backHits === 1) || (frontHits === 3 && backHits === 2)) return 5;
    if (
      (frontHits === 4 && backHits === 0) ||
      (frontHits === 3 && backHits === 1) ||
      (frontHits === 2 && backHits === 2) ||
      (frontHits === 1 && backHits === 2) ||
      (frontHits === 0 && backHits === 2)
    ) return 6;
    return null;
  }

  if (lotteryType === 'ssq') {
    if (frontHits === 6 && backHits === 1) return 1;
    if (frontHits === 6 && backHits === 0) return 2;
    if (frontHits === 5 && backHits === 1) return 3;
    if ((frontHits === 5 && backHits === 0) || (frontHits === 4 && backHits === 1)) return 4;
    if ((frontHits === 4 && backHits === 0) || (frontHits === 3 && backHits === 1)) return 5;
    if ((frontHits === 2 && backHits === 1) || (frontHits === 1 && backHits === 1) || (frontHits === 0 && backHits === 1)) return 6;
    return null;
  }

  return null;
}

function getPrizeScore(lotteryType, tier) {
  if (!Number.isInteger(tier)) return 0;
  const map = PRIZE_TIER_SCORES[lotteryType];
  if (!map) return 0;
  return Number(map[tier] || 0);
}

function evaluateTicketAgainstTarget(lotteryType, config, ticket, target, weights) {
  const frontHits = countOverlap(ticket.reds, target.reds);
  const backHits = countOverlap(ticket.blues, target.blues);
  const normalizedHit = frontHits / Math.max(1, config.redCount) + backHits / Math.max(1, config.blueCount);
  const tier = getPrizeTier(lotteryType, frontHits, backHits);
  const prizeScore = getPrizeScore(lotteryType, tier);
  const hitWeight = Number(weights?.hitWeight) || RUNTIME_OPTIONS.ticketGeneration.objectiveHitWeight;
  const prizeWeight = Number(weights?.prizeWeight) || RUNTIME_OPTIONS.ticketGeneration.objectivePrizeWeight;
  const objective = normalizedHit * hitWeight + prizeScore * prizeWeight;
  return {
    frontHits,
    backHits,
    normalizedHit: roundTo(normalizedHit, 4),
    tier,
    prizeScore,
    objective: roundTo(objective, 4),
  };
}

function getMinTicketDistance(config) {
  const tg = RUNTIME_OPTIONS.ticketGeneration;
  const raw = Math.floor((config.redCount + config.blueCount) * tg.minDistanceRatio);
  return Math.max(tg.minDistanceFloor, raw);
}

function buildStrategyOrder(totalSchemes, customOrder, fallbackOrder, fallbackStrategy = 'mixed') {
  const source = normalizeStrategyOrder(customOrder, fallbackOrder, 1);
  const order = [];
  for (let i = 0; i < totalSchemes; i++) {
    order.push(source[i] || source[source.length - 1] || fallbackStrategy);
  }
  return order;
}

function allocateStrategyCounts(scores, totalSchemes, fallbackStrategy = 'mixed') {
  const entries = Object.entries(scores || {}).filter(([, value]) => Number(value) > 0);
  if (entries.length === 0 || totalSchemes <= 0) {
    return { [fallbackStrategy]: totalSchemes };
  }

  const totalScore = entries.reduce((sum, [, value]) => sum + Number(value), 0);
  if (totalScore <= 0) {
    return { [fallbackStrategy]: totalSchemes };
  }

  const counts = {};
  const fractions = [];
  let assigned = 0;
  for (const [strategy, value] of entries) {
    const exact = (Number(value) / totalScore) * totalSchemes;
    const base = Math.floor(exact);
    counts[strategy] = base;
    assigned += base;
    fractions.push({ strategy, frac: exact - base, score: Number(value) });
  }

  fractions.sort((a, b) => b.frac - a.frac || b.score - a.score || a.strategy.localeCompare(b.strategy));
  let remain = totalSchemes - assigned;
  let idx = 0;
  while (remain > 0 && fractions.length > 0) {
    const pick = fractions[idx % fractions.length];
    counts[pick.strategy] += 1;
    remain -= 1;
    idx += 1;
  }

  return counts;
}

function buildOrderByCounts(counts, strategyScores, totalSchemes, fallbackStrategy = 'mixed') {
  const order = [];
  const scoreMap = strategyScores || {};
  const sortedStrategies = Object.keys(counts)
    .sort((a, b) => (Number(scoreMap[b]) || 0) - (Number(scoreMap[a]) || 0) || a.localeCompare(b));

  let guard = 0;
  while (order.length < totalSchemes && guard < totalSchemes * 20) {
    let progressed = false;
    for (const strategy of sortedStrategies) {
      if ((counts[strategy] || 0) <= 0) continue;
      order.push(strategy);
      counts[strategy] -= 1;
      progressed = true;
      if (order.length >= totalSchemes) break;
    }
    if (!progressed) break;
    guard += 1;
  }

  while (order.length < totalSchemes) {
    order.push(fallbackStrategy);
  }
  return order;
}

function buildAdaptiveStrategyOrder(options) {
  const {
    lotteryType,
    config,
    pools,
    patternProfile,
    recentDraws,
    totalSchemes,
    baseOrder,
    seedText,
    fallbackStrategy = 'mixed',
  } = options;
  const tg = RUNTIME_OPTIONS.ticketGeneration;
  const fixedOrder = buildStrategyOrder(totalSchemes, baseOrder, DEFAULT_RUNTIME_OPTIONS.ticketGeneration.strategyOrder, fallbackStrategy);
  if (!tg.adaptiveMixEnabled || totalSchemes <= 0) {
    return {
      mode: 'fixed',
      order: fixedOrder,
      strategyCounts: null,
      strategyScores: null,
    };
  }

  const sourceDraws = Array.isArray(recentDraws) ? recentDraws : [];
  const lookback = Math.min(sourceDraws.length, tg.adaptiveLookbackDraws);
  if (lookback < tg.adaptiveMinLookback) {
    return {
      mode: 'fixed',
      order: fixedOrder,
      strategyCounts: null,
      strategyScores: null,
    };
  }

  const objectiveWeights = {
    hitWeight: tg.objectiveHitWeight,
    prizeWeight: tg.objectivePrizeWeight,
  };
  const evaluationDraws = sourceDraws.slice(0, lookback);
  const probeCount = tg.adaptiveProbeTickets;
  const strategyScores = {};

  for (const strategy of BASE_ADAPTIVE_STRATEGIES) {
    const rng = createSeededRng(`${seedText}:adaptive:${strategy}`);
    let objectiveSum = 0;
    let penaltySum = 0;
    for (let i = 0; i < probeCount; i++) {
      const ticket = generateTicketByStrategy(config, pools, strategy, rng);
      const patternEval = evaluateTicketPattern(ticket, patternProfile);
      let ticketObjective = 0;
      for (const draw of evaluationDraws) {
        const metric = evaluateTicketAgainstTarget(lotteryType, config, ticket, draw, objectiveWeights);
        ticketObjective += metric.objective;
      }
      ticketObjective = ticketObjective / lookback;
      penaltySum += patternEval.penalty;
      objectiveSum += ticketObjective;
    }
    const avgObjective = objectiveSum / probeCount;
    const avgPenalty = penaltySum / probeCount;
    const adjustedObjective = avgObjective - avgPenalty * tg.patternPenaltyWeight * 0.03;
    strategyScores[strategy] = roundTo(Math.max(0.001, adjustedObjective), 4);
  }

  const scoreValues = Object.values(strategyScores);
  const maxScore = Math.max(...scoreValues);
  const minScore = Math.min(...scoreValues);
  if (!Number.isFinite(maxScore) || !Number.isFinite(minScore) || maxScore - minScore < 0.002) {
    return {
      mode: 'fixed',
      order: fixedOrder,
      strategyCounts: null,
      strategyScores: strategyScores,
      lookback,
      probeCount,
    };
  }

  const counts = allocateStrategyCounts(strategyScores, totalSchemes, fallbackStrategy);
  const order = buildOrderByCounts({ ...counts }, strategyScores, totalSchemes, fallbackStrategy);
  return {
    mode: 'adaptive',
    order,
    strategyCounts: counts,
    strategyScores,
    lookback,
    probeCount,
  };
}

function buildTicketSchemes(options) {
  const {
    config,
    pools,
    patternProfile,
    totalSchemes,
    rng,
    strategyOrder,
    candidateAttempts,
    minDistance,
    distanceWeight,
    patternPenaltyWeight,
    fallbackStrategy = 'random',
    usePatternConstraint = true,
  } = options;

  const schemes = [];
  const usedSignatures = new Set();

  for (let i = 0; i < totalSchemes; i++) {
    const strategyType = strategyOrder[i] || strategyOrder[strategyOrder.length - 1] || fallbackStrategy;
    let bestCandidate = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let attempt = 0; attempt < candidateAttempts; attempt++) {
      const candidate = generateTicketByStrategy(config, pools, strategyType, rng);
      const signature = ticketSignature(candidate);
      if (usedSignatures.has(signature)) continue;

      const distance = schemes.length
        ? Math.min(...schemes.map(existing => ticketDistance(existing, candidate)))
        : Number.POSITIVE_INFINITY;
      const patternEval = usePatternConstraint
        ? evaluateTicketPattern(candidate, patternProfile)
        : { pass: true, penalty: 0 };
      const distanceScore = Number.isFinite(distance) ? distance : minDistance + 2;
      const score = distanceScore * distanceWeight - patternEval.penalty * patternPenaltyWeight;

      if (score > bestScore) {
        bestScore = score;
        bestCandidate = {
          ...candidate,
          patternPenalty: patternEval.penalty,
          patternPass: patternEval.pass,
        };
      }
      if (distance >= minDistance && patternEval.pass) break;
    }

    const chosenBase = bestCandidate || generateTicketByStrategy(config, pools, fallbackStrategy, rng);
    const chosenPattern = usePatternConstraint
      ? evaluateTicketPattern(chosenBase, patternProfile)
      : { pass: true, penalty: 0 };
    const chosen = {
      ...chosenBase,
      patternPenalty: chosenPattern.penalty,
      patternPass: chosenPattern.pass,
    };

    usedSignatures.add(ticketSignature(chosen));
    schemes.push({
      scheme: i + 1,
      reds: chosen.reds,
      blues: chosen.blues,
      strategy: chosen.strategy,
      patternPenalty: chosen.patternPenalty,
      patternPass: chosen.patternPass,
    });
  }

  return schemes;
}

function evaluateTicketGroupHits(lotteryType, tickets, target, config) {
  let selectedFront = 0;
  let selectedBack = 0;
  let selectedScore = Number.NEGATIVE_INFINITY;
  let selectedTier = null;
  let selectedPrizeScore = 0;
  let selectedObjective = Number.NEGATIVE_INFINITY;
  let fullHit = false;

  for (let i = 0; i < tickets.length; i++) {
    const ticket = tickets[i];
    const metric = evaluateTicketAgainstTarget(lotteryType, config, ticket, target);
    const front = metric.frontHits;
    const back = metric.backHits;
    const normalizedScore = metric.normalizedHit;
    const prizeScore = metric.prizeScore;
    const objectiveScore = metric.objective;

    // 仅允许“同一注”胜出，避免前后区来自不同注的混拼高估。
    const isBetter =
      objectiveScore > selectedObjective ||
      (objectiveScore === selectedObjective && normalizedScore > selectedScore) ||
      (objectiveScore === selectedObjective && normalizedScore === selectedScore && prizeScore > selectedPrizeScore) ||
      (objectiveScore === selectedObjective && normalizedScore === selectedScore && prizeScore === selectedPrizeScore && front > selectedFront) ||
      (objectiveScore === selectedObjective && normalizedScore === selectedScore && prizeScore === selectedPrizeScore && front === selectedFront && back > selectedBack);

    if (isBetter) {
      selectedScore = normalizedScore;
      selectedFront = front;
      selectedBack = back;
      selectedTier = metric.tier;
      selectedPrizeScore = prizeScore;
      selectedObjective = objectiveScore;
    }

    if (front === config.redCount && back === config.blueCount) {
      fullHit = true;
    }
  }

  return {
    selectedFront,
    selectedBack,
    selectedScore: roundTo(selectedScore, 4),
    selectedTier,
    prizeScore: roundTo(selectedPrizeScore, 4),
    objectiveScore: roundTo(selectedObjective, 4),
    fullHit,
  };
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0;
  const idx = (sortedValues.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedValues[lo];
  const w = idx - lo;
  return sortedValues[lo] * (1 - w) + sortedValues[hi] * w;
}

function bootstrapMeanCI(samples, rng, iterations = 400) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return { low: 0, high: 0 };
  }

  const n = samples.length;
  const means = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const pick = Math.floor(rng() * n);
      sum += samples[pick];
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);

  return {
    low: roundTo(percentile(means, 0.025), 3),
    high: roundTo(percentile(means, 0.975), 3),
  };
}

function twoSidedBinomialPValue(positiveCount, negativeCount) {
  const n = positiveCount + negativeCount;
  if (n <= 0) return 1;

  const tailK = Math.min(positiveCount, negativeCount);
  const base = Math.pow(0.5, n);
  let comb = 1; // C(n, 0)
  let cumulative = comb * base;
  for (let k = 1; k <= tailK; k++) {
    comb *= (n - k + 1) / k;
    cumulative += comb * base;
  }

  return Math.min(1, 2 * cumulative);
}

function buildSignTest(samples) {
  let positive = 0;
  let negative = 0;
  let zero = 0;

  for (const value of samples) {
    if (value > 0) positive += 1;
    else if (value < 0) negative += 1;
    else zero += 1;
  }

  const pValue = twoSidedBinomialPValue(positive, negative);
  return {
    positive,
    negative,
    zero,
    pValue: roundTo(pValue, 4),
    significant: pValue < 0.05,
  };
}

function normalizeDeltaSign(value, epsilon = 0.02) {
  if (!Number.isFinite(value) || Math.abs(value) < epsilon) return 0;
  return value > 0 ? 1 : -1;
}

function runBacktestStage(draws, config, lotteryType, windowSize, stageName) {
  const backtestOptions = RUNTIME_OPTIONS.backtest;
  const ticketOptions = RUNTIME_OPTIONS.ticketGeneration;
  const chronological = [...draws].reverse();
  const evaluationCount = Math.min(backtestOptions.evaluationLimit, chronological.length - windowSize);
  if (evaluationCount <= 0) return null;

  const startIndex = chronological.length - evaluationCount;
  let modelFrontHits = 0;
  let modelBackHits = 0;
  let modelPrizeScore = 0;
  let randomFrontHits = 0;
  let randomBackHits = 0;
  let randomPrizeScore = 0;
  let modelFullHits = 0;
  let randomFullHits = 0;
  let completed = 0;
  const frontDeltaSamples = [];
  const backDeltaSamples = [];
  const prizeDeltaSamples = [];
  const modelTierCounter = {};
  const randomTierCounter = {};

  for (let idx = startIndex; idx < chronological.length; idx++) {
    const trainStart = idx - windowSize;
    if (trainStart < 0) continue;

    const trainWindow = chronological.slice(trainStart, idx);
    const target = chronological[idx];
    const trainDesc = [...trainWindow].reverse();
    const analysis = computeFrequencyAnalysis(trainDesc, config);
    const pools = buildStrategyPools(config, analysis);
    const patternProfile = analysis.patternProfile || null;
    const groupTicketCount = Math.max(1, backtestOptions.groupTicketCount);
    const minDistance = getMinTicketDistance(config);
    const modelBaseOrder = buildStrategyOrder(
      groupTicketCount,
      backtestOptions.groupStrategyOrder,
      ticketOptions.strategyOrder,
      'mixed'
    );
    const adaptivePlan = buildAdaptiveStrategyOrder({
      lotteryType,
      config,
      pools,
      patternProfile,
      recentDraws: trainDesc,
      totalSchemes: groupTicketCount,
      baseOrder: modelBaseOrder,
      seedText: `${lotteryType}:${stageName}:idx${idx}`,
      fallbackStrategy: 'mixed',
    });
    const modelOrder = adaptivePlan.order;
    const randomOrder = Array.from({ length: groupTicketCount }, () => 'random');

    const modelRng = createSeededRng(`${lotteryType}:${stageName}:idx${idx}:model`);
    const randomRng = createSeededRng(`${lotteryType}:${stageName}:idx${idx}:random`);
    const modelTickets = buildTicketSchemes({
      config,
      pools,
      patternProfile,
      totalSchemes: groupTicketCount,
      rng: modelRng,
      strategyOrder: modelOrder,
      candidateAttempts: ticketOptions.candidateAttempts,
      minDistance,
      distanceWeight: ticketOptions.distanceWeight,
      patternPenaltyWeight: ticketOptions.patternPenaltyWeight,
      fallbackStrategy: 'mixed',
      usePatternConstraint: true,
    });
    const randomTickets = buildTicketSchemes({
      config,
      pools,
      patternProfile: null,
      totalSchemes: groupTicketCount,
      rng: randomRng,
      strategyOrder: randomOrder,
      candidateAttempts: ticketOptions.candidateAttempts,
      minDistance,
      distanceWeight: ticketOptions.distanceWeight,
      patternPenaltyWeight: 0,
      fallbackStrategy: 'random',
      usePatternConstraint: false,
    });

    const modelHit = evaluateTicketGroupHits(lotteryType, modelTickets, target, config);
    const randomHit = evaluateTicketGroupHits(lotteryType, randomTickets, target, config);
    const modelRed = modelHit.selectedFront;
    const modelBlue = modelHit.selectedBack;
    const randomRed = randomHit.selectedFront;
    const randomBlue = randomHit.selectedBack;

    modelFrontHits += modelRed;
    modelBackHits += modelBlue;
    modelPrizeScore += modelHit.prizeScore;
    randomFrontHits += randomRed;
    randomBackHits += randomBlue;
    randomPrizeScore += randomHit.prizeScore;
    frontDeltaSamples.push(modelRed - randomRed);
    backDeltaSamples.push(modelBlue - randomBlue);
    prizeDeltaSamples.push(modelHit.prizeScore - randomHit.prizeScore);

    if (Number.isInteger(modelHit.selectedTier)) {
      modelTierCounter[modelHit.selectedTier] = (modelTierCounter[modelHit.selectedTier] || 0) + 1;
    }
    if (Number.isInteger(randomHit.selectedTier)) {
      randomTierCounter[randomHit.selectedTier] = (randomTierCounter[randomHit.selectedTier] || 0) + 1;
    }

    if (modelHit.fullHit) modelFullHits++;
    if (randomHit.fullHit) randomFullHits++;

    completed++;
  }

  if (completed <= 0) return null;

  const bootstrapRng = createSeededRng(`${lotteryType}:${stageName}:backtest:${windowSize}`);
  const frontCI = bootstrapMeanCI(frontDeltaSamples, bootstrapRng, backtestOptions.bootstrapIterations);
  const backCI = bootstrapMeanCI(backDeltaSamples, bootstrapRng, backtestOptions.bootstrapIterations);
  const prizeCI = bootstrapMeanCI(prizeDeltaSamples, bootstrapRng, backtestOptions.bootstrapIterations);
  const frontSign = buildSignTest(frontDeltaSamples);
  const backSign = buildSignTest(backDeltaSamples);
  const prizeSign = buildSignTest(prizeDeltaSamples);

  return {
    mode: 'group',
    groupTicketCount: Math.max(1, backtestOptions.groupTicketCount),
    stage: stageName,
    windowSize,
    evaluationCount: completed,
    model: {
      avgFrontHits: roundTo(modelFrontHits / completed, 3),
      avgBackHits: roundTo(modelBackHits / completed, 3),
      avgPrizeScore: roundTo(modelPrizeScore / completed, 4),
      fullHits: modelFullHits,
      tierHits: modelTierCounter,
    },
    random: {
      avgFrontHits: roundTo(randomFrontHits / completed, 3),
      avgBackHits: roundTo(randomBackHits / completed, 3),
      avgPrizeScore: roundTo(randomPrizeScore / completed, 4),
      fullHits: randomFullHits,
      tierHits: randomTierCounter,
    },
    delta: {
      front: roundTo((modelFrontHits - randomFrontHits) / completed, 3),
      back: roundTo((modelBackHits - randomBackHits) / completed, 3),
      prizeScore: roundTo((modelPrizeScore - randomPrizeScore) / completed, 4),
      frontCI95: [frontCI.low, frontCI.high],
      backCI95: [backCI.low, backCI.high],
      prizeCI95: [prizeCI.low, prizeCI.high],
      frontSign,
      backSign,
      prizeSign,
      likelyRandom:
        frontCI.low <= 0 &&
        frontCI.high >= 0 &&
        backCI.low <= 0 &&
        backCI.high >= 0 &&
        prizeCI.low <= 0 &&
        prizeCI.high >= 0 &&
        !frontSign.significant &&
        !backSign.significant &&
        !prizeSign.significant,
    },
  };
}

function runBacktest(draws, config, lotteryType) {
  const drawCount = Array.isArray(draws) ? draws.length : 0;
  if (drawCount <= 0) return null;
  const backtestOptions = RUNTIME_OPTIONS.backtest;

  const candidateWindows = [...new Set(
    backtestOptions.windowCandidates
      .map(size => Math.min(size, drawCount - 30))
      .filter(size => Number.isInteger(size) && size >= 60)
  )].sort((a, b) => a - b);

  const stages = [];
  for (let i = 0; i < candidateWindows.length; i++) {
    const windowSize = candidateWindows[i];
    const stageName =
      candidateWindows.length === 1
        ? `窗口${windowSize}`
        : i === 0
          ? `短窗${windowSize}`
          : i === candidateWindows.length - 1
            ? `长窗${windowSize}`
            : `中窗${windowSize}`;
    const stage = runBacktestStage(draws, config, lotteryType, windowSize, stageName);
    if (stage) {
      stages.push(stage);
    }
  }

  if (stages.length === 0) {
    const fallbackWindow = Math.min(120, Math.max(80, Math.floor(drawCount * 0.3)));
    const fallbackStage = runBacktestStage(draws, config, lotteryType, fallbackWindow, `自适应${fallbackWindow}`);
    if (!fallbackStage) return null;
    return {
      ...fallbackStage,
      stages: [fallbackStage],
      consistency: {
        stageCount: 1,
        frontDirectionConsistent: true,
        backDirectionConsistent: true,
        prizeDirectionConsistent: true,
        likelyRandomAll: fallbackStage.delta.likelyRandom,
        frontDeltaRange: 0,
        backDeltaRange: 0,
        prizeDeltaRange: 0,
        possibleOverfit: false,
      },
    };
  }

  const primary = stages[stages.length - 1];
  const frontValues = stages.map(stage => stage.delta.front);
  const backValues = stages.map(stage => stage.delta.back);
  const prizeValues = stages.map(stage => stage.delta.prizeScore || 0);
  const frontSigns = stages.map(stage => normalizeDeltaSign(stage.delta.front)).filter(sign => sign !== 0);
  const backSigns = stages.map(stage => normalizeDeltaSign(stage.delta.back)).filter(sign => sign !== 0);
  const prizeSigns = stages.map(stage => normalizeDeltaSign(stage.delta.prizeScore || 0, 0.03)).filter(sign => sign !== 0);
  const frontDirectionConsistent = frontSigns.length <= 1 || frontSigns.every(sign => sign === frontSigns[0]);
  const backDirectionConsistent = backSigns.length <= 1 || backSigns.every(sign => sign === backSigns[0]);
  const prizeDirectionConsistent = prizeSigns.length <= 1 || prizeSigns.every(sign => sign === prizeSigns[0]);
  const frontDeltaRange = roundTo(Math.max(...frontValues) - Math.min(...frontValues), 3);
  const backDeltaRange = roundTo(Math.max(...backValues) - Math.min(...backValues), 3);
  const prizeDeltaRange = roundTo(Math.max(...prizeValues) - Math.min(...prizeValues), 4);
  const likelyRandomAll = stages.every(stage => stage.delta.likelyRandom);
  const possibleOverfit =
    stages.length > 1 &&
    (
      !frontDirectionConsistent ||
      !backDirectionConsistent ||
      !prizeDirectionConsistent ||
      frontDeltaRange > 0.22 ||
      backDeltaRange > 0.12 ||
      prizeDeltaRange > 0.25
    );

  return {
    ...primary,
    stages,
    consistency: {
      stageCount: stages.length,
      frontDirectionConsistent,
      backDirectionConsistent,
      prizeDirectionConsistent,
      likelyRandomAll,
      frontDeltaRange,
      backDeltaRange,
      prizeDeltaRange,
      possibleOverfit,
    },
  };
}

/**
 * 基于近N期真实数据做统计分析。
 */
async function analyzeHistoricalData(lotteryType, issueCount = EFFECTIVE_ISSUE_WINDOW) {
  const config = LOTTERY_CONFIG[lotteryType];
  const { draws, source, validation } = await fetchRealHistory(lotteryType, issueCount);
  const frequency = computeFrequencyAnalysis(draws, config);
  const backtest = runBacktest(draws, config, lotteryType);

  return {
    issueCount: draws.length,
    dataSource: source,
    dataValidation: validation || null,
    latestIssue: draws[0]?.issue || '',
    oldestIssue: draws[draws.length - 1]?.issue || '',
    recentDraws: draws.slice(0, 120),
    backtest,
    ...frequency,
  };
}

/**
 * 从候选池中抽取不重复号码，不足时从全量区间补足。
 */
function pickNumbers(config, pool, count, range, rng = Math.random) {
  const selected = [];
  for (const n of shuffle(pool, rng)) {
    if (selected.includes(n)) continue;
    selected.push(n);
    if (selected.length >= count) break;
  }
  if (selected.length < count) {
    const full = buildRange(range.min, range.max);
    for (const n of shuffle(full, rng)) {
      if (selected.includes(n)) continue;
      selected.push(n);
      if (selected.length >= count) break;
    }
  }
  return selected.sort((a, b) => a - b);
}

/**
 * 生成预测结果。
 */
async function generatePredictions(lotteryType, budget = 10) {
  const config = LOTTERY_CONFIG[lotteryType];
  const analysis = await analyzeHistoricalData(lotteryType, EFFECTIVE_ISSUE_WINDOW);
  const nextDraw = getNextDrawDate(lotteryType);
  const patternProfile = analysis.patternProfile || null;
  const ticketOptions = RUNTIME_OPTIONS.ticketGeneration;

  const pricePerTicket = config.pricePerTicket;
  const maxTickets = Math.floor(budget / pricePerTicket);
  const totalSchemes = Math.min(ticketOptions.maxSchemes, maxTickets);
  const minDistance = getMinTicketDistance(config);
  const baseOrder = buildStrategyOrder(
    totalSchemes,
    ticketOptions.strategyOrder,
    DEFAULT_RUNTIME_OPTIONS.ticketGeneration.strategyOrder,
    'mixed'
  );
  const seedRng = createSeededRng(`${lotteryType}:${analysis.latestIssue}:${budget}`);
  const pools = buildStrategyPools(config, analysis);
  const adaptiveMix = buildAdaptiveStrategyOrder({
    lotteryType,
    config,
    pools,
    patternProfile,
    recentDraws: analysis.recentDraws,
    totalSchemes,
    baseOrder,
    seedText: `${lotteryType}:${analysis.latestIssue}:${budget}:predict`,
    fallbackStrategy: 'mixed',
  });
  const strategyOrder = adaptiveMix.order;
  const schemes = buildTicketSchemes({
    config,
    pools,
    patternProfile,
    totalSchemes,
    rng: seedRng,
    strategyOrder,
    candidateAttempts: ticketOptions.candidateAttempts,
    minDistance,
    distanceWeight: ticketOptions.distanceWeight,
    patternPenaltyWeight: ticketOptions.patternPenaltyWeight,
    fallbackStrategy: 'random',
    usePatternConstraint: true,
  });

  return {
    lotteryType,
    lotteryName: config.name,
    nextDraw,
    analysis,
    schemes,
    budget,
    maxTickets,
    strategyMix: adaptiveMix,
    pricePerTicket,
    jackpotOdds: calculateJackpotOdds(config),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * 格式化预测报告
 */
function formatPredictionReport(prediction) {
  const config = LOTTERY_CONFIG[prediction.lotteryType];
  const nextDraw = prediction.nextDraw;
  
  const report = [];
  report.push(`# ${prediction.lotteryName} 预测分析报告`);
  report.push('');

  report.push('## 📅 基本信息');
  report.push(`- **分析期数**: 近${prediction.analysis.issueCount}期（真实数据）`);
  report.push(`- **数据来源**: ${prediction.analysis.dataSource}`);
  if (prediction.analysis.dataValidation) {
    const v = prediction.analysis.dataValidation;
    if (v.pass) {
      report.push(
        `- **数据校验**: ${v.providerA} 与 ${v.providerB} 校验通过（已校验${v.checked}期，覆盖率${Math.round((v.coverage || 0) * 100)}%）`
      );
    } else {
      report.push(`- **数据校验**: ${v.warning || '双源校验暂不可用，已回退主源数据'}`);
    }
    if (v.cacheUsed && v.cachedAt) {
      report.push(`- **缓存时间**: ${formatLocalDateTime(v.cachedAt)}`);
    }
    if (Number.isFinite(v.cacheAgeDays)) {
      report.push(`- **缓存时效**: ${v.cacheAgeDays} 天`);
    }
    if (v.latestDrawDate && Number.isFinite(v.ageDays)) {
      report.push(`- **最新开奖新鲜度**: ${v.latestDrawDate}（距今${v.ageDays}天）`);
    }
    if (Number.isFinite(v.missedDraws) && Number.isFinite(v.maxMissedDraws)) {
      report.push(`- **开奖进度检查**: 预计遗漏 ${v.missedDraws} 次（阈值 ${v.maxMissedDraws} 次）`);
    }
    if (v.freshnessEndDate) {
      report.push(`- **新鲜度基准日**: ${v.freshnessEndDate}`);
    }
  }
  report.push(
    `- **数据区间**: ${prediction.analysis.latestIssue}期 至 ${prediction.analysis.oldestIssue}期`
  );
  report.push(`- **下期开奖**: ${nextDraw.dateStr}（${nextDraw.weekday}）${nextDraw.time}`);

  if (nextDraw.holidayAdjusted) {
    const names = nextDraw.holidayNames?.length ? nextDraw.holidayNames.join('、') : '休市安排';
    report.push(`- **⚠️ 顺延说明**: 受${names}影响，本次开奖日期已自动顺延`);
  }

  report.push('');

  const analysis = prediction.analysis;
  const frontLabel = config.blueCount === 2 ? '前区' : '红球';
  const backLabel = config.blueCount === 2 ? '后区' : '蓝球';
  report.push('## 📊 历史数据分析');
  report.push(`- **热号 (Hot)**: ${frontLabel} ${analysis.hotReds.map(n => n.toString().padStart(2, '0')).join(', ')} | ${backLabel} ${analysis.hotBlues.map(n => n.toString().padStart(2, '0')).join(', ')}`);
  report.push(`- **冷号 (Cold)**: ${frontLabel} ${analysis.coldReds.map(n => n.toString().padStart(2, '0')).join(', ')} | ${backLabel} ${analysis.coldBlues.map(n => n.toString().padStart(2, '0')).join(', ')}`);
  const threshold = analysis.redStats?.significantThreshold ?? 1.5;
  const redSigCount = (analysis.significantHotReds?.length || 0) + (analysis.significantColdReds?.length || 0);
  const blueSigCount = (analysis.significantHotBlues?.length || 0) + (analysis.significantColdBlues?.length || 0);
  report.push(
    `- **显著性校验 (|z|>=${threshold})**: ${frontLabel}偏离点 ${redSigCount} 个，${backLabel}偏离点 ${blueSigCount} 个`
  );
  report.push(
    `- **分布检验 (卡方)**: ${frontLabel} χ²=${analysis.redStats?.chiSquare ?? '-'}，${backLabel} χ²=${analysis.blueStats?.chiSquare ?? '-'}`
  );
  if (analysis.patternProfile) {
    const profile = analysis.patternProfile;
    const redSumRange = Array.isArray(profile.redSumRange) ? profile.redSumRange.join('~') : '-';
    const oddRange = Array.isArray(profile.oddCountRange) ? profile.oddCountRange.join('~') : '-';
    const spanRange = Array.isArray(profile.spanRange) ? profile.spanRange.join('~') : '-';
    report.push(
      `- **结构区间(P10-P90)**: 和值 ${redSumRange}，奇数个数 ${oddRange}，跨度 ${spanRange}，连号对数≤${profile.maxConsecutivePairs}`
    );
  }
  if (redSigCount === 0 && blueSigCount === 0) {
    report.push('- **统计结论**: 未发现稳定显著偏离，近期冷热分布更可能属于随机波动。');
  } else {
    report.push('- **统计结论**: 存在局部偏离，但不足以证明未来开奖会持续同方向偏移。');
  }
  report.push('');

  report.push('## 🔮 推荐号码');
  report.push('根据历史走势分析，为您生成以下推荐：');
  report.push('');

  if (config.blueCount === 1) {
    report.push('| 方案 | 红球 | 蓝球 | 说明 |');
  } else {
    report.push('| 方案 | 前区 | 后区 | 说明 |');
  }
  report.push('| :--- | :--- | :--- | :--- |');

  prediction.schemes.forEach(scheme => {
    const redsStr = scheme.reds.map(n => n.toString().padStart(2, '0')).join(' ');
    const bluesStr = scheme.blues.map(n => n.toString().padStart(2, '0')).join(' ');
    const strategyNote =
      Number(scheme.patternPenalty || 0) > 0
        ? `${scheme.strategy}（结构偏离惩罚:${scheme.patternPenalty}）`
        : `${scheme.strategy}（结构约束通过）`;
    report.push(`| ${scheme.scheme} | ${redsStr} | ${bluesStr} | ${strategyNote} |`);
  });
  const patternPassCount = prediction.schemes.filter(s => Number(s.patternPenalty || 0) <= 0).length;
  report.push('');
  report.push(
    `- **组合结构检查**: ${patternPassCount}/${prediction.schemes.length} 注满足和值/奇偶/跨度/连号约束`
  );
  if (prediction.strategyMix?.mode === 'adaptive' && prediction.strategyMix.strategyCounts) {
    const counts = prediction.strategyMix.strategyCounts;
    const scoreMap = prediction.strategyMix.strategyScores || {};
    const strategyParts = BASE_ADAPTIVE_STRATEGIES
      .map(key => `${key}:${counts[key] || 0}(评分${scoreMap[key] ?? '-'})`);
    report.push(
      `- **策略配比(自适应)**: ${strategyParts.join('，')}（窗口${prediction.strategyMix.lookback}期，探测${prediction.strategyMix.probeCount}次）`
    );
  } else if (prediction.strategyMix?.mode === 'fixed' && Array.isArray(prediction.strategyMix.order)) {
    report.push(`- **策略配比(固定)**: ${prediction.strategyMix.order.join(', ')}`);
  }

  report.push('');
  report.push('## 🎯 概率与校准');
  const jackpotOdds = prediction.jackpotOdds || calculateJackpotOdds(config);
  report.push(`- **单注一等奖理论概率**: 1 / ${Number(jackpotOdds).toLocaleString('en-US')}`);
  report.push('- **概率提示**: 每注理论概率在开奖前相同，冷热号不会改变数学期望。');

  if (analysis.backtest) {
    const bt = analysis.backtest;
    const isGroupMode = bt.mode === 'group' && Number.isInteger(bt.groupTicketCount) && bt.groupTicketCount > 0;
    const modelLabel = isGroupMode ? `模型${bt.groupTicketCount}注组` : '模型票';
    const randomLabel = isGroupMode ? `随机${bt.groupTicketCount}注组` : '随机票';
    report.push('');
    report.push('## 🧪 策略回测');
    report.push(`- **回测设置**: 滚动训练窗口 ${bt.windowSize} 期，评估 ${bt.evaluationCount} 期`);
    if (isGroupMode) {
      report.push('- **回测口径**: 每期比较“组内同一注联合最优命中”（按前后区归一化合分，避免跨注混拼高估）。');
    }
    report.push(`- **${modelLabel}平均命中**: ${frontLabel} ${bt.model.avgFrontHits}，${backLabel} ${bt.model.avgBackHits}`);
    report.push(`- **${randomLabel}平均命中**: ${frontLabel} ${bt.random.avgFrontHits}，${backLabel} ${bt.random.avgBackHits}`);
    report.push(`- **差值(模型组-随机组)**: ${frontLabel} ${bt.delta.front}，${backLabel} ${bt.delta.back}`);
    if (Number.isFinite(bt.model.avgPrizeScore) && Number.isFinite(bt.random.avgPrizeScore)) {
      report.push(
        `- **奖级目标分(均值)**: 模型 ${bt.model.avgPrizeScore}，随机 ${bt.random.avgPrizeScore}，差值 ${bt.delta.prizeScore}`
      );
    }
    if (Array.isArray(bt.delta.frontCI95) && Array.isArray(bt.delta.backCI95)) {
      report.push(
        `- **95%区间(差值)**: ${frontLabel} [${bt.delta.frontCI95[0]}, ${bt.delta.frontCI95[1]}]，${backLabel} [${bt.delta.backCI95[0]}, ${bt.delta.backCI95[1]}]`
      );
    }
    if (Array.isArray(bt.delta.prizeCI95)) {
      report.push(`- **95%区间(奖级目标分差值)**: [${bt.delta.prizeCI95[0]}, ${bt.delta.prizeCI95[1]}]`);
    }
    if (bt.delta.frontSign && bt.delta.backSign) {
      report.push(
        `- **Sign检验 p值**: ${frontLabel} ${bt.delta.frontSign.pValue}，${backLabel} ${bt.delta.backSign.pValue}`
      );
    }
    if (bt.delta.prizeSign) {
      report.push(`- **Sign检验 p值(奖级目标分)**: ${bt.delta.prizeSign.pValue}`);
    }
    if (Array.isArray(bt.stages) && bt.stages.length > 1) {
      report.push('- **分阶段回测**:');
      report.push('| 阶段 | 训练窗口 | 评估期数 | 前区差值 | 后区差值 | 前区p值 | 后区p值 |');
      report.push('| :--- | :--- | :--- | :--- | :--- | :--- | :--- |');
      bt.stages.forEach(stage => {
        report.push(
          `| ${stage.stage} | ${stage.windowSize} | ${stage.evaluationCount} | ${stage.delta.front} | ${stage.delta.back} | ${stage.delta.frontSign?.pValue ?? '-'} | ${stage.delta.backSign?.pValue ?? '-'} |`
        );
      });
    }
    if (bt.consistency) {
      report.push(
        `- **稳健性检查**: ${frontLabel}方向${bt.consistency.frontDirectionConsistent ? '一致' : '不一致'}，${backLabel}方向${bt.consistency.backDirectionConsistent ? '一致' : '不一致'}，奖级分方向${bt.consistency.prizeDirectionConsistent ? '一致' : '不一致'}，差值波动(${frontLabel}/${backLabel}/奖级分)=${bt.consistency.frontDeltaRange}/${bt.consistency.backDeltaRange}/${bt.consistency.prizeDeltaRange}`
      );
      if (bt.consistency.possibleOverfit) {
        report.push('- **过拟合提示**: 不同窗口表现差异偏大，建议把策略定位为“选号解释工具”而非收益工具。');
      }
    }
    report.push(
      bt.delta.likelyRandom
        ? '- **回测解读**: 与随机基线接近，当前策略主要用于组合多样化与可解释展示。'
        : '- **回测解读**: 历史窗口内存在轻微差异，但不代表未来具备稳定超额优势。'
    );
  }

  report.push('');

  report.push(`## 💡 购彩建议 (预算: ${prediction.budget}元)`);
  if (prediction.maxTickets > 0) {
    report.push(`- **可购买注数**: ${prediction.maxTickets}注`);
    report.push(`- **每注价格**: ${prediction.pricePerTicket}元`);
    report.push(`- **推荐方案**: 选择1-2组号码，分散风险`);
  } else {
    report.push(`- **预算不足**: ${prediction.budget}元无法购买完整注数`);
    report.push(`- **建议预算**: 至少${config.pricePerTicket}元`);
  }
  
  report.push('');
  report.push('> **⚠️ 风险提示**: 彩票是独立随机事件，分析结果仅供娱乐参考，请理性投注。');
  report.push('> **📅 休市提醒**: 节假日休市以财政部年度彩票市场休市公告为准。');

  return report.join('\n');
}

/**
 * 主函数
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.log('用法: node lotteryPredict.js <彩票类型> [预算]');
    console.log('彩票类型: dlt (大乐透) 或 ssq (双色球)');
    console.log('预算: 整数，单位元 (默认: 10)');
    console.log(`说明: 当前使用近${EFFECTIVE_ISSUE_WINDOW}期真实数据分析（可通过${PREDICT_CONFIG_FILE}调整）`);
    process.exit(1);
  }

  const lotteryType = args[0].toLowerCase();
  if (!LOTTERY_CONFIG[lotteryType]) {
    console.log(`错误: 未知的彩票类型 '${lotteryType}'`);
    console.log(`可用类型: ${Object.keys(LOTTERY_CONFIG).join(', ')}`);
    process.exit(1);
  }

  let budget = 10;
  if (args.length > 1) {
    budget = parseInt(args[1]);
    if (isNaN(budget) || budget <= 0) {
      console.log('错误: 预算必须是正整数');
      process.exit(1);
    }
  }

  try {
    const prediction = await generatePredictions(lotteryType, budget);
    const report = formatPredictionReport(prediction);
    console.log(report);

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const outputFile = `lottery_prediction_${lotteryType}_${timestamp}.json`;

    fs.writeFileSync(
      outputFile,
      JSON.stringify(prediction, null, 2),
      'utf8'
    );

    console.log(`\n📁 详细数据已保存到: ${outputFile}`);
  } catch (error) {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  }
}

// 执行主函数
if (require.main === module) {
  main().catch(error => {
    console.error(`错误: ${error.message}`);
    process.exit(1);
  });
}

module.exports = {
  LOTTERY_CONFIG,
  RUNTIME_OPTIONS,
  EFFECTIVE_ISSUE_WINDOW,
  generatePredictions,
  analyzeHistoricalData,
  fetchRealHistory,
  formatPredictionReport,
  getNextDrawDate,
  isHoliday,
  parse500HistoryRows,
  crossValidateDraws,
  assessHistoryFreshness,
  evaluateTicketGroupHits,
  runBacktest,
};
