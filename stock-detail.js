(() => {
  const qs = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
  const num = (value) => { const n = Number(value); return Number.isFinite(n) ? n : 0; };
  const pct = (value, digits = 2) => { const n = num(value); return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`; };
  const money = (value) => {
    const n = num(value); const abs = Math.abs(n);
    if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
    if (abs >= 1e4) return `${(n / 1e4).toFixed(0)}万`;
    return `${n.toFixed(0)}元`;
  };
  const cap = (value) => {
    const n = num(value);
    if (n >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`;
    if (n >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
    return `${n.toFixed(0)}元`;
  };
  const tone = (value) => num(value) > 0.0001 ? 'up' : num(value) < -0.0001 ? 'down' : 'flat';
  const toast = (message) => window.__radarShowToast?.(message);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const round = (value, digits = 0) => Number(value).toFixed(digits);
  const average = (list) => list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
  const averageLast = (list, count) => average(list.slice(-Math.min(count, list.length)));
  const detail = { current: null, requestId: 0 };
  const API = {
    quote: 'https://push2.eastmoney.com/api/qt/stock/get',
    kline: 'https://push2his.eastmoney.com/api/qt/stock/kline/get',
    klineBackup: 'https://push2.eastmoney.com/api/qt/stock/kline/get',
    flow: 'https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get',
    suggest: 'https://searchapi.eastmoney.com/api/suggest/get'
  };

  function jsonp(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const callback = `__radar_jsonp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const script = document.createElement('script');
      const timer = window.setTimeout(() => { cleanup(); reject(new Error('行情接口响应超时')); }, timeout);
      const cleanup = () => { window.clearTimeout(timer); delete window[callback]; script.remove(); };
      window[callback] = (data) => { cleanup(); resolve(data); };
      script.onerror = () => { cleanup(); reject(new Error('行情接口连接失败')); };
      script.src = `${url}${url.includes('?') ? '&' : '?'}cb=${callback}`;
      document.head.appendChild(script);
    });
  }

  function inferSecid(code) {
    const clean = String(code || '').replace(/\D/g, '');
    if (!/^\d{6}$/.test(clean)) return '';
    return /^(6|9)/.test(clean) ? `1.${clean}` : `0.${clean}`;
  }

  async function fetchQuote(secid) {
    const fields = 'f43,f44,f45,f46,f47,f48,f50,f57,f58,f60,f116,f117,f162,f167,f168,f169,f170,f171';
    const result = await jsonp(`${API.quote}?secid=${encodeURIComponent(secid)}&fltt=2&invt=2&fields=${fields}`);
    return result?.data || result || {};
  }

  async function fetchKline(secid, klt = 101, lmt = 180) {
    const fields1 = 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13';
    const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61';
    const query = `secid=${encodeURIComponent(secid)}&klt=${klt}&fqt=1&lmt=${lmt}&end=20500101&iscca=1&fields1=${fields1}&fields2=${fields2}`;
    try { return await jsonp(`${API.kline}?${query}`); }
    catch { return await jsonp(`${API.klineBackup}?${query}`); }
  }

  async function fetchFlow(secid) {
    const fields1 = 'f1,f2,f3,f7';
    const fields2 = 'f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63';
    return await jsonp(`${API.flow}?lmt=20&klt=101&secid=${encodeURIComponent(secid)}&fields1=${fields1}&fields2=${fields2}`);
  }

  function parseBars(payload) {
    const rows = payload?.data?.klines;
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const p = String(row).split(',');
      if (p.length < 11) return null;
      return { date: p[0], open: num(p[1]), close: num(p[2]), high: num(p[3]), low: num(p[4]), volume: num(p[5]), amount: num(p[6]), pct: num(p[8]), turnover: num(p[10]) };
    }).filter((bar) => bar && bar.close > 0);
  }

  function parseFlows(payload) {
    const rows = payload?.data?.klines;
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
      const p = String(row).split(',');
      if (p.length < 6) return null;
      return { date: p[0], mainInflow: num(p[1]), smallInflow: num(p[2]), mediumInflow: num(p[3]), largeInflow: num(p[4]), superInflow: num(p[5]) };
    }).filter(Boolean);
  }

  function smaSeries(values, period) {
    return values.map((_, index) => index < period - 1 ? null : average(values.slice(index - period + 1, index + 1)));
  }

  function rsi(closes, period = 14) {
    if (closes.length <= period) return 50;
    let gains = 0;
    let losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      if (change >= 0) gains += change;
      else losses -= change;
    }
    if (losses === 0) return 100;
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
  }

  function atrPercent(bars, period = 14, close = 0) {
    if (bars.length < 2 || close <= 0) return 0;
    const trs = [];
    for (let i = Math.max(1, bars.length - period); i < bars.length; i++) {
      const tr = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close));
      trs.push(tr);
    }
    return average(trs) / close * 100;
  }

  function normalizeScenario(a, b, c) {
    const aa = Math.max(1, a); const bb = Math.max(1, b); const cc = Math.max(1, c);
    const total = aa + bb + cc;
    return { bull: Math.round(aa / total * 100), neutral: Math.round(bb / total * 100), bear: Math.round(cc / total * 100) };
  }

  function computeAnalysis(bars, quote = {}, flows = [], meta = {}) {
    if (bars.length < 20) throw new Error('有效 K 线少于 20 根，暂时无法分析');
    const closes = bars.map((bar) => bar.close);
    const highs = bars.map((bar) => bar.high);
    const lows = bars.map((bar) => bar.low);
    const volumes = bars.map((bar) => bar.volume);
    const last = bars[bars.length - 1];
    const price = num(quote.f43) || last.close;
    const prevClose = num(quote.f60) || (bars.length > 1 ? bars[bars.length - 2].close : price);
    const changePct = num(quote.f170) || (prevClose ? (price / prevClose - 1) * 100 : 0);
    const amount = num(quote.f48) || last.amount;
    const ma5 = averageLast(closes, 5);
    const ma10 = averageLast(closes, 10);
    const ma20 = averageLast(closes, 20);
    const ma60 = averageLast(closes, 60);
    const ma20Slope5 = closes.length >= 25 && ma20 > 0 ? (ma20 / average(closes.slice(-25, -5)) - 1) * 100 : 0;
    const roc5 = closes.length >= 6 && closes[closes.length - 6] > 0 ? (price / closes[closes.length - 6] - 1) * 100 : 0;
    const roc20 = closes.length >= 21 && closes[closes.length - 21] > 0 ? (price / closes[closes.length - 21] - 1) * 100 : 0;
    const rsi14 = rsi(closes, 14);
    const atr = atrPercent(bars, 14, price);
    const high120 = Math.max(...highs.slice(-120));
    const low120 = Math.min(...lows.slice(-120));
    const position120 = high120 > low120 ? clamp((price - low120) / (high120 - low120), 0, 1) : 0.5;
    const volume5 = averageLast(volumes, 5);
    const volume20 = average(volumes.slice(-25, -5));
    const volumeRatio = volume20 > 0 ? volume5 / volume20 : 1;
    const high20Prev = highs.length > 20 ? Math.max(...highs.slice(-21, -1)) : Math.max(...highs);
    const high60 = Math.max(...highs.slice(-60));
    const low5 = Math.min(...lows.slice(-5));
    const low10 = Math.min(...lows.slice(-10));
    const bullishAlignment = price >= ma5 && ma5 >= ma10 && ma10 >= ma20 && ma20Slope5 > -0.3;
    const breakout = price >= high20Prev * 0.995;
    const accumulating = position120 >= 0.16 && position120 <= 0.72 && price >= ma20 * 0.96 && price <= ma20 * 1.065 && volumeRatio >= 0.55 && volumeRatio <= 1.7 && rsi14 >= 40 && rsi14 <= 69;
    const flowAvailable = flows.length > 0 || Number.isFinite(Number(meta.mainInflow));
    const mainInflow1 = flows.length ? flows[flows.length - 1].mainInflow : num(meta.mainInflow);
    const mainInflow3 = flows.length >= 3 ? flows.slice(-3).reduce((sum, row) => sum + row.mainInflow, 0) : num(meta.mainFlow3d);
    const mainInflow5 = flows.length >= 5 ? flows.slice(-5).reduce((sum, row) => sum + row.mainInflow, 0) : num(meta.mainFlow5d);
    const mainRatio = amount > 0 ? mainInflow1 / amount * 100 : num(meta.mainRatio);
    const trendScore = clamp((price > ma20 ? 28 : 0) + (ma5 > ma10 ? 14 : 0) + (ma10 > ma20 ? 14 : 0) + clamp(roc20, -12, 25) * 0.9 + (ma20Slope5 > 0 ? 12 : 0), 0, 100);
    const momentumScore = clamp(50 + roc5 * 3.5 + (rsi14 - 50) * 0.9, 0, 100);
    const capitalScore = flowAvailable ? clamp(50 + mainRatio * 3.2 + (mainInflow3 / Math.max(amount, 1)) * 100 * 1.8, 0, 100) : 50;
    const volumeScore = clamp(40 + (volumeRatio - 1) * 45 + (breakout ? 15 : 0), 0, 100);
    const riskScore = clamp((position120 > 0.85 ? 30 : 0) + Math.max(0, atr - 2) * 8 + (rsi14 > 74 ? 22 : 0) + (price < ma20 ? 14 : 0) + (roc20 > 35 ? 18 : 0) + (mainInflow3 < 0 ? 10 : 0), 0, 100);
    const bullBase = clamp(trendScore * 0.32 + momentumScore * 0.20 + capitalScore * 0.22 + volumeScore * 0.12 + (100 - riskScore) * 0.14, 0, 100);
    const bearBase = clamp(riskScore * 0.55 + (100 - trendScore) * 0.22 + (100 - capitalScore) * 0.13 + (rsi14 > 72 ? 8 : 0), 0, 100);
    const neutralBase = clamp(100 - Math.abs(bullBase - bearBase) * 0.35 - Math.abs(bullBase - 50) * 0.18, 16, 72);
    const swing = normalizeScenario(bullBase, neutralBase, bearBase);
    const short = normalizeScenario(bullBase * 0.55 + momentumScore * 0.30 + volumeScore * 0.15, neutralBase * 0.65 + volumeScore * 0.20, bearBase * 0.55 + riskScore * 0.30 + (100 - momentumScore) * 0.15);
    const resonanceScore = Math.round(swing.bull * 0.6 + short.bull * 0.4);
    const trigger = breakout ? Math.max(price, ma5) * 1.002 : high20Prev * 1.003;
    const support = Math.min(ma10 || price * 0.98, Math.max(low5 || price * 0.95, (ma20 || price * 0.98) * 0.985));
    const invalidation = Math.max(price * 0.88, Math.min(support * 0.985, (ma20 || price * 0.98) * 0.985));
    const resistance1 = Math.max(high20Prev, high60 * 0.98);
    const resistance2 = Math.max(high60, price * 1.12);
    const distanceToBreakout = high20Prev > 0 ? (high20Prev / price - 1) * 100 : 0;
    let judgement = '当前多空条件接近平衡，等待放量突破或缩量回踩确认。';
    if (swing.bull >= 62 && swing.bull > swing.bear) judgement = '中期趋势条件偏多。只有放量站稳关键触发位，才进入强趋势情景；冲高不放量则按震荡处理。';
    else if (swing.bear >= 60 && swing.bear > swing.bull) judgement = '趋势和资金条件偏弱，反弹优先视为修复。未重新站上 MA20 前，不宜主动假设反转。';
    else if (accumulating) judgement = '价格处于相对收敛区间，量能温和，属于低位蓄势观察结构。等待突破平台或回踩支撑后的再次转强。';
    else if (breakout) judgement = '价格已靠近或突破 20 日高点，趋势进入确认区。突破后回踩不破，后续延续条件更好。';
    const reasons = [
      `均线：MA5 ${round(ma5, 2)} / MA10 ${round(ma10, 2)} / MA20 ${round(ma20, 2)}，20日斜率 ${pct(ma20Slope5)}`,
      `动量：5日 ${pct(roc5)} / 20日 ${pct(roc20)}，RSI(14) ${round(rsi14, 1)}`,
      `量能：近5/20日量能比 ${round(volumeRatio, 2)}x，120日位置 ${round(position120 * 100, 1)}%`,
      flowAvailable ? `资金：当日主力 ${money(mainInflow1)} / 净占比 ${pct(mainRatio)}，3日 ${money(mainInflow3)}` : '资金：当前接口未返回主力资金，资金权重按中性处理'
    ];
    const risks = [];
    if (rsi14 > 74) risks.push('RSI 偏高，短线存在过热回撤风险。');
    if (position120 > 0.85) risks.push('处于120日高位区，追高后的回撤空间可能放大。');
    if (mainInflow3 < 0) risks.push('近3日主力资金累计为负，资金承接不稳。');
    if (atr > 4.5) risks.push('波动率较高，仓位和止损距离需要同步放大。');
    if (price < ma20) risks.push('价格仍在 MA20 下方，反弹需要先完成趋势修复。');
    if (!risks.length) risks.push('若大盘转弱或板块资金流出，当前多头结构可能同步失效。');
    return { price, changePct, amount, ma5, ma10, ma20, ma60, ma20Slope5, roc5, roc20, rsi14, atr, position120, volumeRatio, high20Prev, high60, low5, low10, bullishAlignment, breakout, accumulating, mainInflow1, mainInflow3, mainInflow5, mainRatio, flowAvailable, trendScore, momentumScore, capitalScore, volumeScore, riskScore, resonanceScore, swing, short, judgement, trigger, support, invalidation, resistance1, resistance2, distanceToBreakout, reasons, risks };
  }

  function svgPath(values, x, y) {
    let path = '';
    let started = false;
    values.forEach((value, index) => {
      if (!Number.isFinite(value)) return;
      path += `${started ? 'L' : 'M'}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      started = true;
    });
    return path;
  }

  function renderKlineSvg(bars, limit = 120) {
    const data = bars.slice(-Math.max(20, Number(limit) || 120));
    if (data.length < 5) return '<div class="empty-state">K线数据不足</div>';
    const width = 980;
    const height = 520;
    const left = 54;
    const right = 18;
    const top = 28;
    const priceHeight = 310;
    const gap = 22;
    const volumeHeight = 100;
    const plotWidth = width - left - right;
    const maxVolume = Math.max(...data.map((bar) => bar.volume), 1);
    const closes = data.map((bar) => bar.close);
    const ma5 = smaSeries(closes, 5);
    const ma10 = smaSeries(closes, 10);
    const ma20 = smaSeries(closes, 20);
    const ma60 = smaSeries(closes, 60);
    const allPrice = data.flatMap((bar) => [bar.high, bar.low]);
    const maValues = [...ma5, ...ma10, ...ma20, ...ma60].filter(Number.isFinite);
    let minPrice = Math.min(...allPrice, ...maValues);
    let maxPrice = Math.max(...allPrice, ...maValues);
    const pad = Math.max((maxPrice - minPrice) * 0.06, maxPrice * 0.01);
    minPrice -= pad;
    maxPrice += pad;
    const x = (index) => left + (index / Math.max(1, data.length - 1)) * plotWidth;
    const y = (value) => top + (maxPrice - value) / Math.max(0.0001, maxPrice - minPrice) * priceHeight;
    const volumeTop = top + priceHeight + gap;
    const yVolume = (value) => volumeTop + volumeHeight - (value / maxVolume) * volumeHeight;
    const candleWidth = Math.max(1.1, Math.min(8, plotWidth / data.length * 0.62));
    const grid = Array.from({ length: 5 }, (_, index) => minPrice + (maxPrice - minPrice) * index / 4);
    const gridSvg = grid.map((value) => {
      const yy = y(value);
      return `<line x1="${left}" y1="${yy.toFixed(1)}" x2="${width - right}" y2="${yy.toFixed(1)}" stroke="rgba(160,195,230,.10)" stroke-width="1"/><text x="${left - 7}" y="${(yy + 3).toFixed(1)}" text-anchor="end" fill="#68839e" font-size="10">${value.toFixed(2)}</text>`;
    }).join('');
    const candleSvg = data.map((bar, index) => {
      const xx = x(index);
      const rising = bar.close >= bar.open;
      const color = rising ? '#ff5f6d' : '#27cb91';
      const yHigh = y(bar.high);
      const yLow = y(bar.low);
      const yOpen = y(bar.open);
      const yClose = y(bar.close);
      const bodyTop = Math.min(yOpen, yClose);
      const bodyHeight = Math.max(1.2, Math.abs(yClose - yOpen));
      const volY = yVolume(bar.volume);
      return `<line x1="${xx.toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${xx.toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="${color}" stroke-width="1"/><rect x="${(xx - candleWidth / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleWidth.toFixed(1)}" height="${bodyHeight.toFixed(1)}" fill="${color}" opacity="${rising ? .95 : .9}"/><rect x="${(xx - candleWidth / 2).toFixed(1)}" y="${volY.toFixed(1)}" width="${candleWidth.toFixed(1)}" height="${(volumeTop + volumeHeight - volY).toFixed(1)}" fill="${color}" opacity=".35"/>`;
    }).join('');
    const tickIndexes = [0, Math.floor((data.length - 1) * 0.25), Math.floor((data.length - 1) * 0.5), Math.floor((data.length - 1) * 0.75), data.length - 1];
    const dateSvg = tickIndexes.map((index) => `<text x="${x(index).toFixed(1)}" y="${height - 8}" text-anchor="middle" fill="#68839e" font-size="10">${esc(data[index].date.slice(5))}</text>`).join('');
    const latest = data[data.length - 1];
    const latestY = y(latest.close);
    const latestLine = `<line x1="${left}" y1="${latestY.toFixed(1)}" x2="${width - right}" y2="${latestY.toFixed(1)}" stroke="#f4c76b" stroke-width="1" stroke-dasharray="4 5" opacity=".8"/><text x="${width - right}" y="${(latestY - 6).toFixed(1)}" text-anchor="end" fill="#f4c76b" font-size="11">${latest.close.toFixed(2)}</text>`;
    const legend = `<g font-size="11"><text x="${left}" y="16" fill="#ff9aa3">MA5</text><text x="${left + 42}" y="16" fill="#5ad1ff">MA10</text><text x="${left + 92}" y="16" fill="#a88cff">MA20</text><text x="${left + 142}" y="16" fill="#f4c76b">MA60</text></g>`;
    const maPaths = [['#ff9aa3', ma5], ['#5ad1ff', ma10], ['#a88cff', ma20], ['#f4c76b', ma60]]
      .map(([color, values]) => `<path d="${svgPath(values, x, y)}" fill="none" stroke="${color}" stroke-width="1.5" opacity=".95"/>`).join('');
    return `<svg class="kline-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="K线图"><rect x="0" y="0" width="${width}" height="${height}" rx="14" fill="#081728"/>${gridSvg}${maPaths}${candleSvg}${latestLine}<line x1="${left}" y1="${volumeTop}" x2="${width - right}" y2="${volumeTop}" stroke="rgba(160,195,230,.12)"/><text x="${left}" y="${volumeTop - 7}" fill="#68839e" font-size="10">成交量</text>${dateSvg}${legend}</svg>`;
  }

  function metric(label, value, valueClass = '') {
    return `<div class="analysis-metric"><small>${esc(label)}</small><b class="${valueClass}">${value}</b></div>`;
  }

  function scenarioRow(title, scenario) {
    return `<div class="scenario-row"><div class="scenario-row-title">${esc(title)}</div><div class="scenario-card bull"><span>偏多条件</span><strong>${scenario.bull}</strong><small>强度评分</small></div><div class="scenario-card mid"><span>震荡条件</span><strong>${scenario.neutral}</strong><small>强度评分</small></div><div class="scenario-card bear"><span>偏空条件</span><strong>${scenario.bear}</strong><small>强度评分</small></div></div>`;
  }

  function renderDetailPanel() {
    const current = detail.current;
    const container = qs('#stockAnalysis');
    if (!current || !container) return;
    const analysis = current.analysis;
    const isSector = current.type === 'sector';
    const change = current.quote ? num(current.quote.f170 || analysis.changePct) : analysis.changePct;
    const title = isSector ? `板块 · ${current.name}` : `${current.name} ${current.code}`;
    const subtitle = isSector
      ? `最新 ${analysis.price.toFixed(2)} · ${pct(change)} · 板块 K 线`
      : `最新 ${analysis.price.toFixed(2)} · ${pct(change)} · ${String(current.secid).startsWith('1.') ? '沪市' : '深市'}`;
    const metrics = isSector ? [
      ['最新点位', analysis.price.toFixed(2), tone(change)],
      ['阶段涨跌', pct(change), tone(change)],
      ['20日动量', pct(analysis.roc20), tone(analysis.roc20)],
      ['RSI(14)', analysis.rsi14.toFixed(1), analysis.rsi14 > 70 ? 'up' : analysis.rsi14 < 35 ? 'down' : ''],
      ['ATR波动', `${analysis.atr.toFixed(2)}%`, analysis.atr > 4.5 ? 'up' : ''],
      ['120日位置', `${(analysis.position120 * 100).toFixed(1)}%`, analysis.position120 > .85 ? 'up' : ''],
      ['量能比', `${analysis.volumeRatio.toFixed(2)}x`, analysis.volumeRatio > 2 ? 'up' : ''],
      ['5日收益', pct(analysis.roc5), tone(analysis.roc5)]
    ] : [
      ['最新价', analysis.price.toFixed(2), tone(change)],
      ['当日涨跌', pct(change), tone(change)],
      ['总市值', cap(current.quote?.f116), ''],
      ['市盈率', current.quote?.f162 ? num(current.quote.f162).toFixed(2) : '--', ''],
      ['换手率', current.quote?.f168 ? `${num(current.quote.f168).toFixed(2)}%` : '--', ''],
      ['量比', current.quote?.f50 ? num(current.quote.f50).toFixed(2) : '--', ''],
      ['主力当日', analysis.flowAvailable ? money(analysis.mainInflow1) : '--', tone(analysis.mainInflow1)],
      ['主力3日', analysis.flowAvailable ? money(analysis.mainInflow3) : '--', tone(analysis.mainInflow3)],
      ['RSI(14)', analysis.rsi14.toFixed(1), analysis.rsi14 > 70 ? 'up' : analysis.rsi14 < 35 ? 'down' : ''],
      ['ATR波动', `${analysis.atr.toFixed(2)}%`, analysis.atr > 4.5 ? 'up' : ''],
      ['120日位置', `${(analysis.position120 * 100).toFixed(1)}%`, analysis.position120 > .85 ? 'up' : ''],
      ['20日高点', analysis.high20Prev.toFixed(2), '']
    ];
    const metricHtml = metrics.map(([label, value, className]) => metric(label, value, className)).join('');
    const chart = renderKlineSvg(current.bars, current.limit);
    const reasons = analysis.reasons.map((item) => `<li>${esc(item)}</li>`).join('');
    const risks = analysis.risks.map((item) => `<li>${esc(item)}</li>`).join('');
    const triggerText = analysis.breakout ? `站稳 ${analysis.trigger.toFixed(2)}，回踩 ${analysis.support.toFixed(2)} 不破更佳` : `放量站上 ${analysis.trigger.toFixed(2)}，否则维持观察`;
    const resistanceText = `${analysis.resistance1.toFixed(2)} / ${analysis.resistance2.toFixed(2)}`;
    container.innerHTML = `<div class="analysis-head"><div class="analysis-title"><span class="analysis-type">${isSector ? '板块分析' : '个股分析'}</span><h3>${esc(title)}</h3><p>${esc(subtitle)}</p></div><div class="analysis-score"><strong>${analysis.resonanceScore}</strong><small>共振条件分</small></div></div><div class="kline-toolbar"><div class="kline-tabs"><button type="button" data-klt="101" class="${current.klt === 101 ? 'active' : ''}">日K</button><button type="button" data-klt="102" class="${current.klt === 102 ? 'active' : ''}">周K</button><button type="button" data-klt="103" class="${current.klt === 103 ? 'active' : ''}">月K</button></div><div class="kline-ranges">${[60, 120, 250].map((limit) => `<button type="button" data-limit="${limit}" class="${Number(current.limit) === limit ? 'active' : ''}">${limit}根</button>`).join('')}</div></div><div class="kline-chart" id="klineChart">${chart}</div><div class="analysis-metrics">${metricHtml}</div><div class="analysis-verdict"><strong>后续判断：</strong>${esc(analysis.judgement)}</div>${scenarioRow('1-5 个交易日', analysis.short)}${scenarioRow('5-20 个交易日', analysis.swing)}<div class="analysis-notes"><div><h4>关键触发 / 压力</h4><p>${esc(triggerText)}</p><p>上方压力参考：${esc(resistanceText)}</p></div><div><h4>支撑与失效</h4><p>短线支撑：${analysis.support.toFixed(2)}</p><p>结构失效：收盘跌破 ${analysis.invalidation.toFixed(2)}</p></div><div><h4>风险条件</h4><ul>${risks}</ul></div></div><div class="analysis-reasons"><h4>模型依据</h4><ul>${reasons}</ul></div><p class="analysis-disclaimer">情景评分是趋势、动量、资金和波动条件的相对强度，不是上涨概率，也不构成投资建议。后续走势仍需盘中量价和板块联动确认。</p>`;
  }

  function setLoading(message) {
    const container = qs('#stockAnalysis');
    if (container) container.innerHTML = `<div class="analysis-loading"><div class="loading-orbit"></div><h3>${esc(message)}</h3><p>正在读取实时行情与历史 K 线……</p></div>`;
  }

  function setError(message) {
    const container = qs('#stockAnalysis');
    if (container) container.innerHTML = `<div class="analysis-error"><h3>分析暂时不可用</h3><p>${esc(message)}</p><p class="search-tip">请确认股票代码正确，或稍后重试。</p></div>`;
  }

  async function analyzeStock(secid, code, name) {
    const requestId = ++detail.requestId;
    setLoading(`正在分析 ${name || code}`);
    try {
      const results = await Promise.allSettled([fetchQuote(secid), fetchKline(secid, 101, 260), fetchFlow(secid)]);
      if (requestId !== detail.requestId) return;
      const quote = results[0].status === 'fulfilled' ? results[0].value : {};
      const bars = results[1].status === 'fulfilled' ? parseBars(results[1].value) : [];
      const flows = results[2].status === 'fulfilled' ? parseFlows(results[2].value) : [];
      if (!bars.length) throw new Error('K线接口暂时没有返回数据');
      const resolvedName = quote?.f58 || name || code;
      const analysis = computeAnalysis(bars, quote, flows, {});
      detail.current = { type: 'stock', secid, code, name: resolvedName, quote, bars, flows, klt: 101, limit: 120, analysis };
      renderDetailPanel();
    } catch (error) {
      if (requestId === detail.requestId) setError(error.message || '接口请求失败');
    }
  }

  async function analyzeSector(code, name) {
    const requestId = ++detail.requestId;
    const sector = (window.__radarDashboard?.sectors || []).find((item) => item.code === code) || {};
    setLoading(`正在分析板块 ${name}`);
    try {
      const bars = parseBars(await fetchKline(`90.${code}`, 101, 220));
      if (!bars.length) throw new Error('板块 K 线暂时没有返回数据');
      const quote = { f43: bars[bars.length - 1].close, f170: bars[bars.length - 1].pct };
      const analysis = computeAnalysis(bars, quote, [], { mainInflow: sector.mainInflow, mainRatio: sector.mainRatio });
      detail.current = { type: 'sector', secid: `90.${code}`, code, name, quote, bars, flows: [], klt: 101, limit: 120, analysis };
      renderDetailPanel();
      qs('#stock-lab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      if (requestId === detail.requestId) setError(error.message || '板块 K 线请求失败');
    }
  }

  async function switchKline(klt) {
    const current = detail.current;
    if (!current || current.klt === Number(klt)) return;
    const requestId = ++detail.requestId;
    setLoading('正在切换 K 线周期');
    try {
      const bars = parseBars(await fetchKline(current.secid, Number(klt), Number(klt) === 101 ? 260 : 180));
      if (requestId !== detail.requestId) return;
      const sector = current.type === 'sector' ? (window.__radarDashboard?.sectors || []).find((item) => item.code === current.code) : null;
      const analysis = computeAnalysis(bars, current.quote || {}, current.flows || [], sector ? { mainInflow: sector.mainInflow, mainRatio: sector.mainRatio } : {});
      detail.current = { ...current, bars, klt: Number(klt), analysis };
      renderDetailPanel();
    } catch {
      renderDetailPanel();
      toast('该周期 K 线暂时不可用');
    }
  }

  function setRange(limit) {
    if (!detail.current) return;
    detail.current.limit = Number(limit) || 120;
    renderDetailPanel();
  }

  async function suggestStocks(query) {
    const url = `${API.suggest}?input=${encodeURIComponent(query)}&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=10`;
    const response = await jsonp(url);
    const rows = response?.QuotationCodeTable?.Data || [];
    return rows.filter((row) => row && row.Code && row.Name && (row.Classify === 'AStock' || String(row.SecurityTypeName || '').includes('A') || row.MktNum));
  }

  function renderSuggestions(rows) {
    const list = qs('#stockSuggestions');
    if (!list) return;
    if (!rows.length) { list.innerHTML = ''; return; }
    list.innerHTML = rows.slice(0, 8).map((row) => `<button type="button" class="suggestion-item" data-secid="${esc(row.QuoteID || inferSecid(row.Code))}" data-code="${esc(row.Code)}" data-name="${esc(row.Name)}"><strong>${esc(row.Name)}</strong><span>${esc(row.Code)} · ${esc(row.SecurityTypeName || 'A股')}</span></button>`).join('');
  }

  async function submitSearch() {
    const input = qs('#stockSearchInput');
    const query = (input?.value || '').trim();
    if (!query) return;
    renderSuggestions([]);
    if (/^\d{6}$/.test(query)) {
      try {
        const rows = await suggestStocks(query);
        if (rows.length) { await analyzeStock(rows[0].QuoteID || inferSecid(rows[0].Code), rows[0].Code, rows[0].Name); return; }
      } catch {}
      await analyzeStock(inferSecid(query), query, query);
      return;
    }
    try {
      const rows = await suggestStocks(query);
      if (!rows.length) { toast('没有找到匹配的 A 股'); return; }
      renderSuggestions(rows);
      await analyzeStock(rows[0].QuoteID || inferSecid(rows[0].Code), rows[0].Code, rows[0].Name);
    } catch { toast('股票搜索接口暂时不可用'); }
  }

  function debounce(fn, wait = 260) {
    let timer;
    return (...args) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => fn(...args), wait);
    };
  }

  function renderQuickStocks(picks = []) {
    const container = qs('#quickStocks');
    if (!container) return;
    const defaults = [
      { name: '贵州茅台', code: '600519' },
      { name: '中国电影', code: '600977' },
      { name: '登海种业', code: '002041' },
      { name: '合盛硅业', code: '603260' }
    ];
    const seen = new Set();
    const list = [...(picks || []).map((pick) => ({ name: pick.name, code: pick.code })), ...defaults].filter((item) => {
      if (!item?.code || seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    }).slice(0, 8);
    container.innerHTML = list.map((item) => `<button type="button" class="quick-stock" data-secid="${esc(inferSecid(item.code))}" data-code="${esc(item.code)}" data-name="${esc(item.name)}">${esc(item.name)}<small>${esc(item.code)}</small></button>`).join('');
  }

  function bindEvents() {
    qs('#stockSearchButton')?.addEventListener('click', submitSearch);
    qs('#stockSearchInput')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); submitSearch(); }
    });
    qs('#stockSearchInput')?.addEventListener('input', debounce(async (event) => {
      const query = event.target.value.trim();
      if (query.length < 2) { renderSuggestions([]); return; }
      try { renderSuggestions(await suggestStocks(query)); }
      catch { renderSuggestions([]); }
    }));
    qs('#stockSuggestions')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-secid]');
      if (!button) return;
      const input = qs('#stockSearchInput');
      if (input) input.value = `${button.dataset.name} ${button.dataset.code}`;
      renderSuggestions([]);
      analyzeStock(button.dataset.secid, button.dataset.code, button.dataset.name);
    });
    qs('#quickStocks')?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-secid]');
      if (button) analyzeStock(button.dataset.secid, button.dataset.code, button.dataset.name);
    });
    qs('#stockAnalysis')?.addEventListener('click', (event) => {
      const klt = event.target.closest('[data-klt]');
      if (klt) { switchKline(klt.dataset.klt); return; }
      const range = event.target.closest('[data-limit]');
      if (range) setRange(range.dataset.limit);
    });
    qs('#sectorGrid')?.addEventListener('click', (event) => {
      const card = event.target.closest('[data-sector-code]');
      if (card) analyzeSector(card.dataset.sectorCode, card.dataset.sectorName);
    });
    qs('#sectorGrid')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const card = event.target.closest('[data-sector-code]');
      if (card) { event.preventDefault(); analyzeSector(card.dataset.sectorCode, card.dataset.sectorName); }
    });
    qs('#picksGrid')?.addEventListener('click', (event) => {
      const card = event.target.closest('[data-stock-code]');
      if (!card) return;
      analyzeStock(inferSecid(card.dataset.stockCode), card.dataset.stockCode, card.dataset.stockName);
      qs('#stock-lab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  window.renderQuickStocks = renderQuickStocks;
  bindEvents();
  if (window.__radarDashboard?.picks) renderQuickStocks(window.__radarDashboard.picks);
})();
