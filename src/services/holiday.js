import fs from 'fs/promises';
import path from 'path';
import yaml from 'yaml';

/**
 * 节假日/调休日历
 *
 * 5 段 cron 表达不了「排除周末/节假日」，所以这类规则不能塞进表达式，
 * 只能作为调度元数据，在触发时按当天日期判断是否跳过。
 *
 * 数据来源（优先级从高到低）：
 *   1. config/holidays.yaml —— 人工维护的权威数据，可覆盖任何来源
 *   2. data/holidays-cache.json —— 远程接口拉取后的本地缓存（离线可用）
 *   3. 远程接口（默认 timor.tech 的中国节假日接口），仅在缺该年份时按需拉取
 *
 * 拿不到数据时的策略：**不跳过**。宁可多跑一次，也不要因为数据缺失
 * 让「排除周末/节假日」的任务静默停摆；同时会打印一次告警。
 */

/** 日期限定的三种取值 */
export const DAY_RULES = ['any', 'only', 'exclude'];

/** 归一化非法值，避免脏配置把调度改坏 */
export const normalizeDayRule = (value, fallback = 'any') => (
  DAY_RULES.includes(value) ? value : fallback
);

const pad = (n) => String(n).padStart(2, '0');

/**
 * 取指定时区的 YYYY-MM-DD
 * 用 Intl 而不是 getMonth()/getDate()：服务器时区可能是 UTC，
 * 直接用本地时间会让「晚上 8 点之后」的触发算到第二天，导致节假日判断错位
 */
export function formatDateInTz(date = new Date(), timeZone = 'Asia/Shanghai') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type) => parts.find((p) => p.type === type)?.value;
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/** 是否为周六/周日（不看调休） */
export function isWeekendDate(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

/** 生成 YYYY-MM-DD 的年份 */
const yearOf = (dateStr) => Number(String(dateStr).slice(0, 4));

export default class HolidayService {
  /**
   * @param {object} options
   * @param {string} [options.filePath]
   * @param {string} [options.cachePath]
   * @param {boolean} [options.remoteEnabled] - 缺年份时是否允许远程拉取
   * @param {string} [options.urlTemplate]
   * @param {number} [options.timeoutMs]
   * @param {Function} [options.fetchImpl] - 便于测试注入
   * @param {string} [options.timezone]
   */
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(process.cwd(), 'config', 'holidays.yaml');
    this.cachePath = options.cachePath || path.join(process.cwd(), 'data', 'holidays-cache.json');
    this.timezone = options.timezone || 'Asia/Shanghai';
    this.remote = {
      enabled: options.remoteEnabled !== false,
      urlTemplate: options.urlTemplate || 'https://timor.tech/api/holiday/year/{year}',
      timeoutMs: options.timeoutMs || 3000,
    };
    this.fetchImpl = options.fetchImpl || globalThis.fetch;
    // year(string) -> { holidays:Set, workdays:Set, source, known }
    this.years = new Map();
    // 拉取失败后的短暂记忆，避免每次触发都打一次网络
    this._missing = new Map();
    this._inflight = new Map();
    this._loaded = false;
  }

  async init() {
    await this._loadFile();
    await this._loadCache();
    this._loaded = true;
    return this;
  }

  /** 重新读取本地文件与缓存（config/holidays.yaml 改动后调用） */
  async reload() {
    this.years.clear();
    this._missing.clear();
    this._loaded = false;
    return this.init();
  }

  async _loadFile() {
    let raw = '';
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch {
      return; // 没有配置文件 = 完全依赖缓存/远程
    }
    let parsed;
    try {
      parsed = yaml.parse(raw) || {};
    } catch (e) {
      console.warn(`[Holiday] config/holidays.yaml 解析失败: ${e.message}`);
      return;
    }

    if (parsed.remote && parsed.remote.enabled === false) {
      this.remote.enabled = false;
    }
    if (typeof parsed.remote?.url === 'string' && parsed.remote.url.trim()) {
      this.remote.urlTemplate = parsed.remote.url.trim();
    }

    for (const [year, info] of Object.entries(parsed.holidays || {})) {
      if (!/^\d{4}$/.test(String(year))) continue;
      this._setYear(year, {
        holidays: info?.holidays || [],
        workdays: info?.workdays || [],
        source: 'file',
      });
    }
  }

  async _loadCache() {
    try {
      const raw = await fs.readFile(this.cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [year, info] of Object.entries(parsed || {})) {
        if (this.years.has(year)) continue; // 本地文件优先级更高
        this._setYear(year, {
          holidays: info?.holidays || [],
          workdays: info?.workdays || [],
          source: 'cache',
        });
      }
    } catch {
      // 没有缓存是正常情况
    }
  }

  _setYear(year, info) {
    const holidays = new Set((info.holidays || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))));
    const workdays = new Set((info.workdays || []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))));
    this.years.set(String(year), {
      holidays,
      workdays,
      source: info.source || 'file',
      known: holidays.size > 0 || workdays.size > 0,
    });
  }

  /**
   * 确保某年份数据已就绪
   * @param {number|string} year
   * @returns {Promise<{holidays:Set<string>, workdays:Set<string>, source:string, known:boolean}>}
   */
  async ensureYear(year) {
    const key = String(year);
    if (this.years.has(key)) return this.years.get(key);

    const missing = this._missing.get(key);
    if (missing && missing.expiresAt > Date.now()) return missing.entry;

    if (!this._inflight.has(key)) {
      const task = this._fetchYear(Number(year)).finally(() => this._inflight.delete(key));
      this._inflight.set(key, task);
    }
    return this._inflight.get(key);
  }

  async _fetchYear(year) {
    const unknown = {
      holidays: new Set(),
      workdays: new Set(),
      source: 'missing',
      known: false,
    };

    if (!this.remote.enabled) {
      this._rememberMissing(year, unknown);
      return unknown;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.remote.timeoutMs);
    try {
      const url = this.remote.urlTemplate.replace('{year}', String(year));
      const res = await this.fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!res || !res.ok) throw new Error(`HTTP ${res?.status ?? 'error'}`);
      const json = await res.json();
      const parsed = this._parseRemote(json, year);
      if (!parsed) throw new Error('返回结构不符合预期');

      this._setYear(year, { ...parsed, source: 'remote' });
      const entry = this.years.get(String(year));
      await this._saveCache();
      console.log(`[Holiday] ${year} 年节假日已同步：${entry.holidays.size} 天放假 / ${entry.workdays.size} 天调休上班`);
      return entry;
    } catch (e) {
      console.warn(`[Holiday] ${year} 年节假日数据不可用（${e.message}），将按「无节假日数据」处理`);
      this._rememberMissing(year, unknown);
      return unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 失败后 6 小时内不再重试，避免任务每分钟触发就发一次请求 */
  _rememberMissing(year, entry) {
    this._missing.set(String(year), {
      entry,
      expiresAt: Date.now() + 6 * 60 * 60 * 1000,
    });
  }

  /**
   * 解析远程接口（timor.tech 风格）：
   * { holiday: { "01-01": { holiday: true }, "01-04": { holiday: false } } }
   * holiday=true 为放假，false 为调休补班。
   */
  _parseRemote(json, year) {
    const map = json?.holiday;
    if (!map || typeof map !== 'object') return null;

    const holidays = [];
    const workdays = [];
    for (const [key, item] of Object.entries(map)) {
      const date = typeof item?.date === 'string' ? item.date : `${year}-${key}`;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      if (item?.holiday === true) holidays.push(date);
      else if (item?.holiday === false) workdays.push(date);
    }
    if (holidays.length === 0 && workdays.length === 0) return null;
    return { holidays, workdays };
  }

  async _saveCache() {
    try {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
      const payload = {};
      for (const [year, info] of this.years) {
        if (info.source === 'file') continue; // 文件是事实来源，不重复缓存
        payload[year] = {
          holidays: [...info.holidays],
          workdays: [...info.workdays],
          fetchedAt: new Date().toISOString(),
        };
      }
      await fs.writeFile(this.cachePath, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) {
      console.warn(`[Holiday] 写缓存失败: ${e.message}`);
    }
  }

  /** 强制重新拉取某年（WebUI 的「更新节假日数据」按钮） */
  async refreshYear(year) {
    this.years.delete(String(year));
    this._missing.delete(String(year));
    return this.ensureYear(year);
  }

  getStatus(year) {
    const key = String(year);
    const info = this.years.get(key);
    if (!info) {
      return { year: key, known: false, source: 'missing', holidays: 0, workdays: 0 };
    }
    return {
      year: key,
      known: info.known,
      source: info.source,
      holidays: info.holidays.size,
      workdays: info.workdays.size,
    };
  }

  isHoliday(dateStr, info) {
    return Boolean(info?.holidays?.has?.(dateStr));
  }

  /** 调休补班的周六/周日算工作日，不算周末 */
  isWorkday(dateStr, info) {
    if (info?.workdays?.has?.(dateStr)) return true;
    if (info?.holidays?.has?.(dateStr)) return false;
    return !isWeekendDate(dateStr);
  }

  /**
   * 按日期规则判断当天是否允许执行
   *
   * @param {string} dateStr - YYYY-MM-DD（不传则取当前时区日期）
   * @param {{weekend?:string, holiday?:string}} rules
   * @returns {Promise<{run:boolean, reason:string, date:string, known:boolean}>}
   */
  async shouldRun(dateStr, rules = {}) {
    const weekend = normalizeDayRule(rules.weekend);
    const holiday = normalizeDayRule(rules.holiday);
    const date = dateStr || formatDateInTz(new Date(), this.timezone);

    if (weekend === 'any' && holiday === 'any') {
      return { run: true, reason: '', date, known: true };
    }

    const info = await this.ensureYear(yearOf(date));
    // 调休上班的周六日按工作日算，否则「排除周末」会把补班日误杀掉
    const restWeekend = isWeekendDate(date) && !info.workdays.has(date);
    const onHoliday = info.holidays.has(date);

    if (weekend === 'only' && !restWeekend) {
      return { run: false, reason: 'not-weekend', date, known: info.known };
    }
    if (weekend === 'exclude' && restWeekend) {
      return { run: false, reason: 'weekend', date, known: info.known };
    }
    if (holiday === 'only' && !onHoliday) {
      return { run: false, reason: 'not-holiday', date, known: info.known };
    }
    if (holiday === 'exclude' && onHoliday) {
      return { run: false, reason: 'holiday', date, known: info.known };
    }

    return { run: true, reason: '', date, known: info.known };
  }
}

export { HolidayService };
