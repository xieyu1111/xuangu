const state = { data: null, filter: 'all', query: '' };

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const fmtPct = (value, digits = 2) => {
  const n = Number(value || 0);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(digits)}%`;
};

const fmtPrice = (value, digits = 2) => Number(value || 0).toFixed(digits);

const fmtMoney = (value) => {
  const n = Number(value || 0);
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(0)}万`;
  return `${n.toFixed(0)}元`;
};

const fmtCap = (value) => {
  const n = Number(value || 0);
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}万亿`;
  return `${(n / 1e8).toFixed(1)}亿`;
};

const toneClass = (value) => Number(value) > 0.0001 ? 'up' : Number(value) < -0.0001 ? 'down' : 'flat';
const sentimentClass = (value) => Number(value) > 0 ? 'pos' : Number(value) < 0 ? 'neg' : 'mid';

function safeUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '#';
  } catch {
    return '#';
  }
}

async function loadDashboard(forceRefresh = false) {
  const button = $('#refreshButton');
  button.classList.add('loading');
  button.disabled = true;
  if (!state.data) showLoadingState();
  try {
    const isLocalServer = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const endpoint = isLocalServer
      ? `/api/dashboard${forceRefresh ? '?refresh=true' : ''}`
      : `./data/dashboard.json?ts=${Date.now()}`;
    const response = await fetch(endpoint, { cache: 'no-store' });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      throw new Error(problem.detail || problem.title || `HTTP ${response.status}`);
    }
    state.data = await response.json();
    renderDashboard();
    if (forceRefresh) showToast(isLocalServer ? '行情、资金与新闻数据已刷新' : '已重新载入 GitHub Actions 最新快照');
  } catch (error) {
    renderError(error);
  } finally {
    button.classList.remove('loading');
    button.disabled = false;
  }
}

function showLoadingState() {
  $('#marketStrip').innerHTML = Array.from({ length: 6 }, () => '<div class="skeleton-card"></div>').join('');
  $('#sectorGrid').innerHTML = Array.from({ length: 6 }, () => '<div class="sector-card"><div class="skeleton-line" style="width:35%"></div><div class="skeleton-line" style="width:72%;height:20px"></div><div class="skeleton-line" style="width:100%;height:52px"></div><div class="skeleton-line" style="width:85%"></div></div>').join('');
  $('#picksGrid').innerHTML = '<div class="pick-card"><div class="pick-main"><div class="skeleton-line" style="width:45%;height:20px"></div><div class="skeleton-line" style="width:90%"></div><div class="skeleton-line" style="width:80%"></div><div class="skeleton-line" style="width:65%"></div></div></div><div class="pick-card"><div class="pick-main"><div class="skeleton-line" style="width:45%;height:20px"></div><div class="skeleton-line" style="width:90%"></div><div class="skeleton-line" style="width:80%"></div><div class="skeleton-line" style="width:65%"></div></div></div>';
}

function renderError(error) {
  const html = `<div class="error-state"><h2>行情数据暂时不可用</h2><p>${escapeHtml(error.message || error)}。请点击右上角刷新重试。</p></div>`;
  $('#sectorGrid').innerHTML = html;
  $('#picksGrid').innerHTML = html;
  $('#newsList').innerHTML = '<div class="error-state"><p>资讯源正在重连。</p></div>';
  $('#sessionChip').textContent = '连接失败';
  showToast('数据接口暂时不可用，请稍后刷新');
}

function renderDashboard() {
  const data = state.data;
  if (!data) return;
  $('#sessionChip').textContent = data.sessionLabel || '盘后观察';
  $('#marketDate').textContent = `数据截至 ${data.marketDate || '--'}`;
  const generated = data.generatedAt ? new Date(data.generatedAt) : new Date();
  $('#generatedAt').textContent = `生成 ${generated.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
  $('#dataNote').textContent = data.dataNote || '';
  $('#breadthSummary').textContent = `${data.breadth.summary} · 上涨 ${data.breadth.up} / 下跌 ${data.breadth.down} / 平盘 ${data.breadth.flat}`;
  renderRisk(data.risk);
  renderMarkets(data.indices || []);
  renderSectors(data.sectors || []);
  renderPicks();
  renderNews(data.news || []);
  renderStrategy(data.strategy);
  window.__radarDashboard = data;
  window.renderQuickStocks?.(data.picks || []);
  const warnings = (data.warnings || []).filter(Boolean);
  $('#warnings').innerHTML = warnings.map((w) => `<div>· ${escapeHtml(w)}</div>`).join('');
  if (warnings.length) showToast(warnings[0]);
}

function renderRisk(risk) {
  const panel = $('#riskPanel');
  panel.classList.remove('positive', 'neutral', 'negative');
  panel.classList.add(risk.tone || 'neutral');
  $('#riskRing').style.setProperty('--risk', Math.max(0, Math.min(100, Number(risk.score || 0))));
  $('#riskScore').textContent = risk.score ?? '--';
  $('#riskLabel').textContent = risk.label || '--';
  $('#riskTone').textContent = `外围 ${fmtPct(risk.overseasAverage)} · A股 ${fmtPct(risk.domesticAverage)}`;
  $('#riskSummary').textContent = risk.summary || '';
  $('#positionHint').textContent = risk.positionHint || '';
}

function renderMarkets(indices) {
  const order = ['000001', '399001', '399006', 'HSI', 'NDX', 'SPX', 'DJIA', 'N225', 'KS11', 'GDAXI', 'FCHI'];
  const sorted = [...indices].sort((a, b) => {
    const ai = order.indexOf(a.code); const bi = order.indexOf(b.code);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  }).slice(0, 8);
  $('#marketStrip').innerHTML = sorted.map((index) => {
    const cls = toneClass(index.changePct);
    const bg = cls === 'up' ? 'bg-up' : cls === 'down' ? 'bg-down' : 'bg-flat';
    return `<article class="market-card">
      <span class="region">${escapeHtml(index.region)}</span>
      <span class="change ${cls} ${bg}">${fmtPct(index.changePct)}</span>
      <h3>${escapeHtml(index.name)}</h3>
      <strong>${Number(index.price || 0).toLocaleString('zh-CN', { maximumFractionDigits: 2 })}</strong>
      <small>${escapeHtml(index.status || '')}${index.turnover > 0 ? ` · 成交 ${fmtMoney(index.turnover)}` : ''}</small>
    </article>`;
  }).join('') || '<div class="empty-state">指数数据为空</div>';
}

function renderSectors(sectors) {
  $('#sectorGrid').innerHTML = sectors.map((sector, index) => {
    const cls = toneClass(sector.changePct);
    const score = Math.max(0, Math.min(100, Number(sector.score || 0)));
    return `<article class="sector-card" data-sector-code="${escapeHtml(sector.code)}" data-sector-name="${escapeHtml(sector.name)}" tabindex="0" style="animation-delay:${index * 45}ms">
      <div class="sector-top">
        <div>
          <div class="sector-rank">RANK ${String(sector.rank).padStart(2, '0')}</div>
          <h3>${escapeHtml(sector.name)}</h3>
          <div class="leader">领涨 ${escapeHtml(sector.leaderName || '--')} <span class="${toneClass(sector.leaderPct)}">${fmtPct(sector.leaderPct)}</span></div>
        </div>
        <div class="score-orb" style="--score:${score}"><b>${sector.score}</b></div>
      </div>
      <div class="sector-change">
        <strong class="${cls}">${fmtPct(sector.changePct)}</strong>
        <span>5日 ${fmtPct(sector.return5)} · 20日 ${fmtPct(sector.return20)}</span>
      </div>
      <div class="sector-metrics">
        <div><small>主力净流入</small><b class="${toneClass(sector.mainInflow)}">${fmtMoney(sector.mainInflow)}</b></div>
        <div><small>主力净占比</small><b class="${toneClass(sector.mainRatio)}">${fmtPct(sector.mainRatio)}</b></div>
        <div><small>5/20量能</small><b>${Number(sector.volumeRatio || 0).toFixed(2)}x</b></div>
      </div>
      <p class="sector-thesis">${escapeHtml(sector.thesis)}</p>
      <div class="sector-footer">
        <span class="level-pill">${escapeHtml(sector.level)}</span><span class="sector-kline-hint">点击查看 K 线</span>
        <span class="catalyst">${escapeHtml(sector.catalyst)}</span>
      </div>
    </article>`;
  }).join('') || '<div class="empty-state">暂无强势板块数据</div>';
}

function renderPicks() {
  const data = state.data;
  if (!data) return;
  const query = state.query.trim().toLowerCase();
  const picks = (data.picks || []).filter((pick) => {
    const matchesFilter = state.filter === 'all' || pick.roleKey === state.filter;
    const haystack = `${pick.code} ${pick.name} ${pick.sectorName} ${pick.role}`.toLowerCase();
    return matchesFilter && (!query || haystack.includes(query));
  });
  $('#picksEmpty').hidden = picks.length > 0;
  $('#picksGrid').innerHTML = picks.map((pick, index) => pickCard(pick, index)).join('');
}

function pickCard(pick, index) {
  const cls = toneClass(pick.changePct);
  const roleClass = pick.roleKey === 'accumulation' ? 'accumulation' : pick.roleKey === 'trend' ? 'trend' : '';
  const score = Math.max(0, Math.min(100, Number(pick.score || 0)));
  const reasons = (pick.reasons || []).slice(0, 4).map((item) => `<p>${escapeHtml(item)}</p>`).join('');
  const risks = (pick.risks || []).slice(0, 2).map((item) => escapeHtml(item)).join('；');
  return `<article class="pick-card" data-stock-code="${escapeHtml(pick.code)}" data-stock-name="${escapeHtml(pick.name)}" data-role="${escapeHtml(pick.roleKey)}" style="animation-delay:${index * 55}ms">
    <div class="pick-main">
      <div class="pick-head">
        <div class="pick-id">
          <span class="pick-badge">#${String(pick.rank).padStart(2, '0')}</span>
          <div><h3>${escapeHtml(pick.name)}</h3><p>${escapeHtml(pick.code)} · ${escapeHtml(pick.market)}</p></div>
        </div>
        <div class="pick-score"><strong>${score}</strong><small>共振指数</small></div>
      </div>
      <div class="pick-meta">
        <span class="role-pill ${roleClass}">${escapeHtml(pick.role)}</span>
        <span class="sector-pill">${escapeHtml(pick.sectorName)}</span>
        <span class="tag-pill">市值 ${fmtCap(pick.marketCap)}</span>
      </div>
      <div class="pick-quote">
        <div><small>最新价</small><b>${fmtPrice(pick.price)}</b></div>
        <div><small>当日涨跌</small><b class="${cls}">${fmtPct(pick.changePct)}</b></div>
        <div><small>3日主力</small><b class="${toneClass(pick.mainFlow3d)}">${fmtMoney(pick.mainFlow3d)}</b></div>
      </div>
      <div class="spark-wrap">
        ${sparkline(pick.spark || [], pick.changePct, index)}
        <div class="pick-reasons">
          <p>主力当日 ${fmtMoney(pick.mainInflow)} / 净占比 ${fmtPct(pick.mainRatio)}</p>
          <p>120日位置 ${Number(pick.position120 || 0).toFixed(0)}% / 5/20量能 ${Number(pick.volumeRatio || 0).toFixed(2)}x</p>
          <p>${pick.distanceToBreakout <= 0 ? `已破前高 ${Math.abs(Number(pick.distanceToBreakout || 0)).toFixed(2)}%` : `距前高 ${fmtPct(pick.distanceToBreakout)}`} / ATR ${Number(pick.atrPct || 0).toFixed(2)}%</p>
        </div>
      </div>
      <div class="pick-reasons">${reasons}</div>
      <div class="trade-plan">
        <div><span>观察触发</span><b>${escapeHtml(pick.triggerText)}</b></div>
        <div><span>短线支撑</span><b>${escapeHtml(pick.supportText)}</b></div>
        <div><span>结构失效</span><b>${escapeHtml(pick.invalidationText)}</b></div>
      </div>
      <p class="pick-risks"><span>风险：</span>${risks || '大盘转弱时需降低关注等级'}</p><span class="pick-kline-hint">点击卡片查看 K 线分析</span>
    </div>
  </article>`;
}

function sparkline(values, changePct, index) {
  const points = (values || []).map(Number).filter(Number.isFinite);
  if (points.length < 2) return '<svg class="sparkline" viewBox="0 0 160 54" aria-hidden="true"></svg>';
  const width = 160, height = 54, pad = 4;
  const min = Math.min(...points), max = Math.max(...points), range = max - min || 1;
  const coords = points.map((value, i) => {
    const x = pad + (i / (points.length - 1)) * (width - pad * 2);
    const y = height - pad - ((value - min) / range) * (height - pad * 2);
    return [x, y];
  });
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${line} L${width - pad},${height - pad} L${pad},${height - pad} Z`;
  const rising = Number(changePct) >= 0;
  const gradientId = `sparkFill${index}`;
  return `<svg class="sparkline" viewBox="0 0 160 54" preserveAspectRatio="none" aria-hidden="true">
    <defs><linearGradient id="${gradientId}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${rising ? '#ff5f6d' : '#27cb91'}"/><stop offset="1" stop-color="${rising ? '#ff5f6d' : '#27cb91'}" stop-opacity="0"/></linearGradient></defs>
    <path class="area" d="${area}" fill="url(#${gradientId})"></path>
    <path class="${rising ? '' : 'down'}" d="${line}"></path>
  </svg>`;
}

function renderNews(news) {
  $('#newsList').innerHTML = news.map((item) => {
    const tags = (item.tags || []).slice(0, 3).map((tag) => `<span>#${escapeHtml(tag)}</span>`).join(' ');
    return `<a class="news-card" href="${safeUrl(item.url)}" target="_blank" rel="noopener noreferrer">
      <span class="news-time">${escapeHtml(item.time)}</span>
      <div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.summary || '点击查看详情')}</p>
        ${tags ? `<div class="news-tags">${tags}</div>` : ''}
      </div>
      <span class="sentiment ${sentimentClass(item.sentiment)}">${escapeHtml(item.sentimentLabel)}</span>
    </a>`;
  }).join('') || '<div class="empty-state">暂无快讯数据</div>';
}

function renderStrategy(strategy) {
  if (!strategy) return;
  const block = (title, items) => `<div class="strategy-block"><h3>${escapeHtml(title)}</h3><ul>${(items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`;
  $('#strategyCard').innerHTML = `
    <div class="strategy-env">${escapeHtml(strategy.marketEnvironment)}</div>
    ${block('仓位管理', strategy.positionRules)}
    ${block('选股原则', strategy.selectionRules)}
    ${block('执行纪律', strategy.executionRules)}
    ${block('回避清单', strategy.avoidRules)}
    <p class="disclaimer">${escapeHtml(strategy.disclaimer)}</p>`;
  $('#footerDisclaimer').textContent = strategy.disclaimer;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove('show'), 3200);
}

$('#refreshButton').addEventListener('click', () => loadDashboard(true));
$('#pickSearch').addEventListener('input', (event) => {
  state.query = event.target.value || '';
  renderPicks();
});
$$('#pickFilters button').forEach((button) => {
  button.addEventListener('click', () => {
    $$('#pickFilters button').forEach((item) => item.classList.remove('active'));
    button.classList.add('active');
    state.filter = button.dataset.filter || 'all';
    renderPicks();
  });
});

window.__radarShowToast = showToast;

loadDashboard(false);




