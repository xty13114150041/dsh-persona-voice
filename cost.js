// 用转述调用自己的 Token 日志估算，不读取主模型的用量。
const FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output'];
const CURRENCIES = ['USD', 'CNY'];

export function normalizeRate(rate) {
  if (!rate || !CURRENCIES.includes(rate.currency)) throw new Error('Choose USD or CNY for the model rate.');
  const values = FIELDS.map(key => {
    const raw = rate[key];
    const value = typeof raw === 'number' || (typeof raw === 'string' && raw.trim()) ? Number(raw) : NaN;
    if (!Number.isFinite(value) || value < 0) throw new Error('Enter all four non-negative rates. Use 0 only for free tokens.');
    return [key, value];
  });
  const source = ['anthropic5m', 'deepseekPeak'].includes(rate.source) ? rate.source : undefined;
  return { currency: rate.currency, ...Object.fromEntries(values), ...(source ? { source } : {}) };
}

function decodeRoute(value) {
  try {
    const route = JSON.parse(value);
    if (Array.isArray(route) && route.length === 2 && route.every(id => typeof id === 'string' && id)) return route;
  } catch {}
  return null;
}

const newTotals = () => ({ calls: 0, unpriced: 0, amounts: {} });
const newUsage = () => ({ calls: 0, missing: 0, tokens: [0, 0, 0, 0] });

export function summarizeCosts(log, rates = {}, now = new Date(), timeZone) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const today = day.format(now);
  const summary = { today: newTotals(), total: newTotals(), rows: [] };
  const routes = new Map();
  const legacy = new Map();
  function addRoute(route) {
    const key = JSON.stringify(route);
    if (!routes.has(key)) {
      const [provider, model] = route;
      routes.set(key, { provider, model, rate: rates[key] ?? null, rateInvalid: rates[key] === null, today: newUsage(), total: newUsage() });
    }
    return routes.get(key);
  }
  for (const key of Object.keys(rates)) {
    const route = decodeRoute(key);
    if (route) addRoute(route);
  }
  for (const line of log.split('\n')) {
    const start = line.match(/^\S+ turn (\S+) route=([^/]+)\/(.+) effort=\S+$/);
    if (start) {
      legacy.set(start[1], [start[2], start[3]]);
      continue;
    }
    const done = line.match(/^(\S+) usage (\S+) in=(\d+|\?) cacheRead=(\d+|\?) cacheWrite=(\d+|\?) out=(\d+|\?) finish=\S+(?: route=(.+))?$/);
    if (!done) continue;
    const [, at, key, input, read, write, output, id] = done;
    const time = new Date(at);
    const route = id ? decodeRoute(id) : legacy.get(key);
    legacy.delete(key);
    if (!Number.isFinite(time.getTime())) continue;
    const periods = day.format(time) === today ? ['today', 'total'] : ['total'];
    const usage = [input, read, write, output].map(Number);
    for (const period of periods) {
      const totals = summary[period];
      totals.calls++;
      if (!route) { totals.unpriced++; continue; }
      const row = addRoute(route)[period];
      row.calls++;
      if (usage.some(n => !Number.isSafeInteger(n))) row.missing++;
      else usage.forEach((n, i) => { row.tokens[i] += n; });
    }
  }
  summary.rows = [...routes.values()].sort((a, b) => b.total.calls - a.total.calls);
  for (const row of summary.rows) {
    for (const period of ['today', 'total']) {
      const usage = row[period];
      const priced = row.rate ? usage.calls - usage.missing : 0;
      const totals = summary[period];
      totals.unpriced += usage.calls - priced;
      usage.unpriced = usage.calls - priced;
      usage.cost = null;
      if (priced) {
        const { currency } = row.rate;
        usage.cost = usage.tokens.reduce((sum, tokens, i) => sum + tokens * (row.rate[FIELDS[i]] / 1_000_000), 0);
        totals.amounts[currency] = (totals.amounts[currency] ?? 0) + usage.cost;
      }
    }
  }
  return summary;
}
