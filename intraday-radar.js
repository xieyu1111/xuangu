(() => {
  const qs = (selector) => document.querySelector(selector);
  const api = window.__radarApi;
  if (!api) return;

  const CLIST = 'https://push2.eastmoney.com/api/qt/clist/get';
  const SECTOR_FIELDS = 'f2,f3,f6,f8,f10,f12,f14,f20,f62,f104,f105,f106,f128,f140,f136,f184';
  const STOCK_FIELDS = 'f2,f3,f5,f6,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f22,f24,f25,f62,f66,f69,f72,f75,f78,f81,f84,f87,f184';
  const state = { loading: false, timer: null, countdown: 60, lastUpdated: null, results: [], statusText: '等待扫描' };

  const n = (value) => api.num(value);
  const p = (value, digits = 2) => api.pct(value, digits);
  const money = (value) => api.money(value);
  const tone = (value) => n(value) > 0.0001 ? 'up' : n(value) < -0.0001 ? 'down' : 'flat';
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  function marketState() {
    const now = new Date();
    const day = now.getDay();
    const minutes = now.getHours() * 60 + now.getMinutes();
    const weekday = day >= 1 && day <= 5;
    const morning = minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30;
    const afternoon = minutes >= 13 * 60 && minutes <= 15 * 60;
    const open = weekday && (morning || afternoon);
    let label = '非交易时段';
    if (open) label = morning ? '早盘交易中' : '午盘交易中';
    else if (weekday && minutes < 9 * 60 + 30) label = '盘前等待';
    else if (weekday && minutes > 11 * 60 + 30 && minutes < 13 * 60) label = '午间休市';
    else if (weekday && minutes > 15 * 60) label = '今日已收盘';
    return { open, label };
  }

  function listUrl(fs, fid, pz, fields) {
    return `${CLIST}?pn=1&pz=${pz}&po=1&np=1&fltt=2&invt=2&fid=${fid}&fs=${fs}&fields=${fields}`;
  }

  async function fetchList(fs, fid, pz, fields) {
    const response = await api.requestJson(listUrl(fs, fid, pz, fields));
    return Array.isArray(response?.data?.diff) ? response.data.diff : [];
  }

  function sectorPreliminary(row) {
    const change = n(row.f3);
    const mainRatio = n(row.f184);
    const up = n(row.f104);
    const down = n(row.f105);
    const breadth = up + down > 0 ? up / (up + down) * 100 : 50;
    const volumeRatio = n(row.f10);
    return clamp(change * 16 + clamp(mainRatio, -5, 18) * 2.2 + breadth * 0.45 + clamp(volumeRatio, 0.5, 3) * 7, 0, 100);
  }

  function sectorCandidates(rows) {
    return rows
      .map((row) => ({
        code: String(row.f12 || ''),
        name: String(row.f14 || ''),
        price: n(row.f2),
        changePct: n(row.f3),
        amount: n(row.f6),
        turnover: n(row.f8),
        volumeRatio: n(row.f10),
        marketCap: n(row.f20),
        mainInflow: n(row.f62),
        mainRatio: n(row.f184),
        upCount: n(row.f104),
        downCount: n(row.f105),
        flatCount: n(row.f106),
        leaderName: String(row.f128 || ''),
        leaderCode: String(row.f140 || ''),
        leaderPct: n(row.f136)
      }))
      .filter((sector) => sector.code && sector.name && !sector.name.startsWith('其他'))
      .filter((sector) => sector.upCount + sector.downCount >= 4 && sector.marketCap >= 30_000_000_000)
      .filter((sector) => sector.changePct >= 0.8 && sector.changePct <= 7.5)
      .map((sector) => ({ ...sector, preliminary: sectorPreliminary({ f3: sector.changePct, f184: sector.mainRatio, f104: sector.upCount, f105: sector.downCount, f10: sector.volumeRatio }) }))
      .sort((a, b) => b.preliminary - a.preliminary)
      .slice(0, 6);
  }

  function stockCandidate(row) {
    const code = String(row.f12 || '');
    const name = String(row.f14 || '');
    const price = n(row.f2);
    const changePct = n(row.f3);
    const amount = n(row.f6);
    const turnover = n(row.f8);
    const volumeRatio = n(row.f10);
    const marketCap = n(row.f20);
    const mainInflow = n(row.f62);
    const mainRatio = n(row.f184);
    const prelim = clamp(changePct * 11 + clamp(mainRatio, -5, 18) * 2.6 + clamp(volumeRatio, 0.5, 4) * 8 + clamp(amount / 1e8, 1, 40) * 0.25, 0, 100);
    return { code, name, price, changePct, amount, turnover, volumeRatio, marketCap, mainInflow, mainRatio, prelim };
  }

  function candidatesFrom(rows) {
    return rows.map(stockCandidate)
      .filter((stock) => stock.code && stock.name)
      .filter((stock) => !/ST|退|N |C /.test(stock.name))
      .filter((stock) => stock.price >= 2 && stock.marketCap >= 4_000_000_000 && stock.amount >= 80_000_000)
      .filter((stock) => stock.changePct >= 0.5 && stock.changePct <= 8.6)
      .sort((a, b) => b.prelim - a.prelim);
  }

  function priorStats(bars) {
    const completed = bars.slice(0, -1);
    const last5 = completed.slice(-5);
    const priorUpDays = last5.filter((bar) => bar.pct >= 1).length;
    const base = completed.length >= 6 ? completed[completed.length - 6].close : (completed[0]?.close || 0);
    const last = completed[completed.length - 1]?.close || 0;
    const prior5Return = base > 0 && last > 0 ? (last / base - 1) * 100 : 0;
    return { priorUpDays, prior5Return };
  }

  async function analyzeStockForRadar(stock) {
    const secid = api.inferSecid(stock.code);
    if (!secid) throw new Error('无法识别股票市场');
    const payload = await api.fetchSinaKline(secid, 101, 40);
    const bars = api.parseBars(payload);
    if (bars.length < 20) throw new Error('K线不足');
    const analysis = api.computeAnalysis(bars, { f43: stock.price, f170: stock.changePct, f168: stock.turnover, f50: stock.volumeRatio }, [], { mainInflow: stock.mainInflow, mainRatio: stock.mainRatio });
    const stats = priorStats(bars);
    const riskPct = stock.price > 0 ? (stock.price - analysis.invalidation) / stock.price * 100 : 0;
    const upside1 = stock.price > 0 ? (analysis.resistance1 / stock.price - 1) * 100 : 0;
    const rr = riskPct > 0 ? upside1 / riskPct : 0;
    const rrBonus = rr >= 2 ? 15 : rr >= 1.3 ? 8 : 0;
    const buyScore = clamp(analysis.resonanceScore * 0.42 + stock.prelim * 0.18 + clamp(stock.mainRatio, 0, 15) * 1.1 + rrBonus - (stock.changePct > 8 ? 15 : 0) - (analysis.position120 > 0.9 ? 8 : 0), 0, 100);
    const entryHigh = stock.price * 1.01;
    const entryLow = Math.min(entryHigh, Math.max(analysis.support, stock.price * 0.965));
    const role = analysis.breakout && stock.changePct >= 2 ? '板块领涨' : analysis.accumulating ? '低位蓄势' : analysis.bullishAlignment ? '趋势共振' : '盘中异动';
    return { ...stock, analysis, priorUpDays: stats.priorUpDays, prior5Return: stats.prior5Return, riskPct, upside1, rr, buyScore, entryLow, entryHigh, stop: analysis.invalidation, target1: analysis.resistance1, target2: analysis.resistance2, role };
  }

  async function fetchSectorStocks(sector) {
    const [byPct, byFlow] = await Promise.all([
      fetchList(`b:${sector.code}`, 'f3', 60, STOCK_FIELDS),
      fetchList(`b:${sector.code}`, 'f62', 60, STOCK_FIELDS)
    ]);
    const map = new Map();
    [...byPct, ...byFlow].forEach((row) => {
      const code = String(row.f12 || '');
      if (code && !map.has(code)) map.set(code, row);
    });
    const candidates = candidatesFrom(Array.from(map.values())).slice(0, 4);
    const analyzed = await Promise.allSettled(candidates.map((stock) => analyzeStockForRadar(stock)));
    return analyzed.filter((item) => item.status === 'fulfilled').map((item) => item.value);
  }

  async function analyzeSector(sector) {
    const stocks = await fetchSectorStocks(sector);
    if (!stocks.length) return null;
    const avgPriorUpDays = stocks.reduce((sum, stock) => sum + stock.priorUpDays, 0) / stocks.length;
    const avgPrior5Return = stocks.reduce((sum, stock) => sum + stock.prior5Return, 0) / stocks.length;
    const avgResonance = stocks.reduce((sum, stock) => sum + stock.analysis.resonanceScore, 0) / stocks.length;
    const breadth = sector.upCount + sector.downCount > 0 ? sector.upCount / (sector.upCount + sector.downCount) * 100 : 50;
    const firstMoveScore = clamp(sector.changePct * 14 + clamp(sector.mainRatio, 0, 15) * 1.6 + breadth * 0.22 + (avgPriorUpDays <= 1 ? 22 : avgPriorUpDays <= 2 ? 10 : 0) + (avgPrior5Return < 3 ? 18 : avgPrior5Return < 6 ? 8 : 0) + (sector.volumeRatio > 1.2 ? 12 : 0) + avgResonance * 0.15, 0, 100);
    const firstMove = avgPriorUpDays <= 1 && sector.changePct >= 1.0;
    const buyStocks = stocks.filter((stock) => stock.buyScore >= 50 && stock.rr >= 1).sort((a, b) => b.buyScore - a.buyScore).slice(0, 3);
    return { sector, firstMove, firstMoveScore, avgPriorUpDays, avgPrior5Return, stocks: (buyStocks.length ? buyStocks : stocks.sort((a, b) => b.buyScore - a.buyScore).slice(0, 2)) };
  }

  async function mapLimit(items, limit, worker) {
    const results = new Array(items.length);
    let cursor = 0;
    async function run() {
      while (cursor < items.length) {
        const index = cursor++;
        results[index] = await worker(items[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return results;
  }

  async function scan() {
    if (state.loading) return;
    state.loading = true;
    state.statusText = '正在扫描板块首次异动……';
    renderStatus();
    try {
      const rows = await fetchList('m:90+t:2', 'f3', 100, SECTOR_FIELDS);
      const candidates = sectorCandidates(rows);
      const analyzed = await mapLimit(candidates, 3, async (sector) => {
        try { return await analyzeSector(sector); }
        catch { return null; }
      });
      state.results = analyzed.filter(Boolean).filter((item) => item.firstMove && item.firstMoveScore >= 58 && item.stocks.length).sort((a, b) => b.firstMoveScore - a.firstMoveScore).slice(0, 4);
      state.lastUpdated = new Date();
      state.statusText = state.results.length ? `发现 ${state.results.length} 个近几日首次异动方向` : '当前未发现符合条件的首次异动方向';
    } catch (error) {
      state.statusText = `扫描失败：${error.message || '行情接口不可用'}`;
    } finally {
      state.loading = false;
      state.countdown = 60;
      render();
      renderStatus();
    }
  }

  function stockRow(stock) {
    return `<div class="intraday-stock" data-secid="${api.inferSecid(stock.code)}" data-code="${stock.code}" data-name="${stock.name}" title="点击查看完整K线分析">
      <div class="intraday-stock-head"><strong>${stock.name}</strong><span>${stock.code}</span><b class="${tone(stock.changePct)}">${p(stock.changePct)}</b></div>
      <div class="intraday-plan">
        <div><small>买入观察</small><b>${stock.entryLow.toFixed(2)} - ${stock.entryHigh.toFixed(2)}</b></div>
        <div><small>止损位</small><b class="down">${stock.stop.toFixed(2)}</b></div>
        <div><small>目标位</small><b class="up">${stock.target1.toFixed(2)} / ${stock.target2.toFixed(2)}</b></div>
      </div>
      <div class="intraday-stock-foot"><span class="role-pill">${stock.role}</span><span>买入评分 ${Math.round(stock.buyScore)}</span><span>盈亏比 ${stock.rr.toFixed(2)}</span><span>后续 ${stock.analysis.swing.bull}/${stock.analysis.swing.neutral}/${stock.analysis.swing.bear}</span></div>
    </div>`;
  }

  function sectorCard(item, index) {
    const sector = item.sector;
    const firstMoveLabel = item.firstMove ? '近几日首次异动' : '盘中强势';
    return `<article class="intraday-card" style="animation-delay:${index * 45}ms">
      <div class="intraday-card-head">
        <div><span class="intraday-badge">${firstMoveLabel}</span><h3>${sector.name}</h3><p>领涨 ${sector.leaderName || '--'} <span class="${tone(sector.leaderPct)}">${p(sector.leaderPct)}</span></p></div>
        <div class="intraday-score"><strong>${Math.round(item.firstMoveScore)}</strong><small>首次异动分</small></div>
      </div>
      <div class="intraday-sector-metrics">
        <div><small>今日涨幅</small><b class="${tone(sector.changePct)}">${p(sector.changePct)}</b></div>
        <div><small>主力净流入</small><b class="${tone(sector.mainInflow)}">${money(sector.mainInflow)}</b></div>
        <div><small>主力净占比</small><b class="${tone(sector.mainRatio)}">${p(sector.mainRatio)}</b></div>
        <div><small>上涨/下跌</small><b>${sector.upCount}/${sector.downCount}</b></div>
        <div><small>量比</small><b>${sector.volumeRatio.toFixed(2)}</b></div>
        <div><small>前期异动</small><b>${item.avgPriorUpDays.toFixed(1)} 次</b></div>
      </div>
      <div class="intraday-reasons"><span>前5日平均 ${p(item.avgPrior5Return)}</span><span>${item.avgPriorUpDays <= 1 ? '近5日首次放量走强' : '连续异动次数偏多'}</span><span>板块资金 ${sector.mainRatio >= 0 ? '净流入' : '净流出'}</span></div>
      <div class="intraday-stock-list">${item.stocks.map(stockRow).join('')}</div>
    </article>`;
  }

  function render() {
    const grid = qs('#intradayGrid');
    if (!grid) return;
    if (!state.results.length) {
      grid.innerHTML = '<div class="intraday-empty"><h3>暂未发现符合条件的首次异动板块</h3><p>系统会继续每 60 秒扫描一次；盘中放量拉升或主力资金转强后会进入这里。</p></div>';
      return;
    }
    grid.innerHTML = state.results.map(sectorCard).join('');
  }

  function renderStatus() {
    const status = qs('#intradayStatus');
    if (!status) return;
    const market = marketState();
    const time = state.lastUpdated ? state.lastUpdated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '--';
    const countdown = market.open ? ` · ${state.countdown}s 后刷新` : '';
    status.innerHTML = `<span class="live-dot ${market.open ? '' : 'paused'}"></span><strong>${state.statusText}</strong><small>${market.label} · 上次更新 ${time}${countdown}</small>`;
  }

  function startTimer() {
    if (state.timer) window.clearInterval(state.timer);
    state.timer = window.setInterval(() => {
      const market = marketState();
      if (market.open) {
        state.countdown -= 1;
        if (state.countdown <= 0 && !state.loading) {
          state.countdown = 60;
          scan();
        }
      } else {
        state.countdown = 60;
      }
      renderStatus();
    }, 1000);
  }

  qs('#intradayRefresh')?.addEventListener('click', () => scan());
  qs('#intradayGrid')?.addEventListener('click', (event) => {
    const card = event.target.closest('[data-secid]');
    if (!card || !window.__radarAnalyzeStock) return;
    window.__radarAnalyzeStock(card.dataset.secid, card.dataset.code, card.dataset.name);
    qs('#stock-lab')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && marketState().open && (!state.lastUpdated || Date.now() - state.lastUpdated.getTime() > 60000)) scan();
  });

  renderStatus();
  scan();
  startTimer();
})();
