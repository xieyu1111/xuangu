using System.Globalization;
using System.Text.Json;

namespace StockRadar;

public sealed class DashboardService
{
    private readonly MarketDataClient _client;
    private readonly string _contentRoot;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly JsonSerializerOptions _jsonOptions;
    private DashboardPayload? _cache;
    private DateTime _cacheAt;

    public DashboardService(MarketDataClient client, IWebHostEnvironment env)
        : this(client, env.ContentRootPath)
    {
    }

    public DashboardService(MarketDataClient client, string contentRoot)
    {
        _client = client;
        _contentRoot = contentRoot;
        _jsonOptions = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false
        };
    }

    public Task<DashboardPayload> BuildSnapshotAsync(CancellationToken ct) => BuildAsync(ct);

    public async Task<DashboardPayload> GetAsync(bool refresh, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            if (!refresh && _cache is not null && DateTime.Now - _cacheAt < TimeSpan.FromMinutes(8))
                return _cache;

            try
            {
                var built = await BuildAsync(ct);
                _cache = built;
                _cacheAt = DateTime.Now;
                await SaveLastGoodAsync(built, ct);
                return built;
            }
            catch (Exception) when (_cache is not null)
            {
                var stale = _cache with
                {
                    Warnings = _cache.Warnings.Concat(["实时刷新失败，当前展示最近一次成功快照。"]).ToArray()
                };
                return stale;
            }
            catch (Exception)
            {
                var lastGood = await LoadLastGoodAsync(ct);
                if (lastGood is not null)
                {
                    _cache = lastGood;
                    _cacheAt = DateTime.Now.AddMinutes(-9);
                    return lastGood with { Warnings = lastGood.Warnings.Concat(["实时接口暂不可用，当前展示本地缓存快照。"]).ToArray() };
                }
                throw;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<DashboardPayload> BuildAsync(CancellationToken ct)
    {
        var indicesTask = _client.FetchIndicesAsync(ct);
        var sectorsTask = _client.FetchSectorsAsync(ct);
        var newsTask = _client.FetchNewsAsync(ct);
        await Task.WhenAll(indicesTask, sectorsTask, newsTask);

        var indices = indicesTask.Result;
        var allSectors = sectorsTask.Result;
        var rawNews = newsTask.Result;
        var warnings = new List<string>();

        var breadth = BuildBreadth(allSectors);
        var analyzedNews = AnalyzeNews(rawNews);
        var newsSentiment = rawNews.Count == 0 ? 0 : rawNews.Average(n => Math.Clamp(n.Score, -3, 3));
        var risk = BuildRisk(indices, breadth, newsSentiment);

        var sectorCandidates = allSectors
            .Where(s => !s.Name.StartsWith("其他", StringComparison.Ordinal))
            .Where(s => s.UpCount + s.DownCount >= 4)
            .Where(s => s.MarketCap >= 30_000_000_000)
            .Where(s => s.ChangePct > -3.5 && s.ChangePct < 8.8)
            .ToList();

        if (sectorCandidates.Count < 10) sectorCandidates = allSectors.Where(s => s.UpCount + s.DownCount >= 3).ToList();

        var prefetchSectors = sectorCandidates
            .OrderByDescending(BasicSectorScore)
            .Take(18)
            .ToList();

        await ParallelForEachAsync(prefetchSectors, 6, async sector =>
        {
            try
            {
                var bars = await _client.FetchKlinesAsync($"90.{sector.Code}", ct);
                sector.Bars.AddRange(bars);
            }
            catch
            {
                // 单个板块历史数据失败时继续使用实时截面指标。
            }
        });

        foreach (var sector in prefetchSectors)
        {
            ApplySectorHistory(sector, analyzedNews);
        }

        var rankedSectors = prefetchSectors
            .OrderByDescending(s => s.SectorScore)
            .ThenByDescending(s => s.MainInflow)
            .Take(6)
            .ToList();

        if (rankedSectors.Count == 0) throw new InvalidOperationException("没有可用于分析的行业板块数据。");

        var sectorRank = rankedSectors.Select((s, i) => new { s.Code, Rank = i + 1 }).ToDictionary(x => x.Code, x => x.Rank);
        var stockLists = await Task.WhenAll(rankedSectors.Select(s => _client.FetchSectorStocksAsync(s.Code, s.Name, ct)));
        var shortlist = stockLists
            .SelectMany((list, i) =>
            {
                var sector = rankedSectors[i];
                return list.OrderByDescending(x => x.PreliminaryScore).Take(5).Select(x =>
                {
                    x.SectorCode = sector.Code;
                    x.SectorName = sector.Name;
                    return x;
                });
            })
            .GroupBy(s => s.Code)
            .Select(g => g.OrderByDescending(x => x.PreliminaryScore).First())
            .OrderByDescending(s => s.PreliminaryScore)
            .Take(24)
            .ToList();

        await ParallelForEachAsync(shortlist, 5, async stock =>
        {
            try
            {
                var secid = $"{stock.Market}.{stock.Code}";
                var barsTask = _client.FetchKlinesAsync(secid, ct);
                var flowsTask = _client.FetchFlowsAsync(secid, ct);
                await Task.WhenAll(barsTask, flowsTask);
                stock.Bars = barsTask.Result;
                stock.Flows = flowsTask.Result;
                AnalyzeStock(stock, rankedSectors.First(s => s.Code == stock.SectorCode), sectorRank[stock.SectorCode]);
            }
            catch (Exception)
            {
                // 单只股票接口异常不应中断整份每日快照，保留其他候选继续生成。
                stock.Bars.Clear();
                stock.Flows.Clear();
            }
        });

        var enriched = shortlist
            .Where(s => s.Bars.Count >= 25)
            .GroupBy(s => s.Code)
            .Select(g => g.OrderByDescending(x => x.FinalScore).First())
            .OrderByDescending(s => s.FinalScore)
            .ToList();

        if (enriched.Count < 4)
        {
            warnings.Add("历史K线覆盖不足，部分候选仅使用实时行情评分。");
            enriched = shortlist.OrderByDescending(s => s.PreliminaryScore).Take(8).ToList();
            if (enriched.All(s => s.FinalScore <= 0))
            {
                foreach (var stock in enriched)
                {
                    stock.FinalScore = Math.Round(Math.Clamp(stock.PreliminaryScore, 1, 99), 0);
                    stock.Metrics.TriggerPrice = stock.Price * 1.018;
                    stock.Metrics.SupportPrice = stock.Price * 0.975;
                    stock.Metrics.InvalidationPrice = stock.Price * 0.95;
                    stock.Role = "趋势跟随";
                    stock.RoleKey = "trend";
                }
            }
        }

        var selected = SelectPicks(enriched, rankedSectors);
        if (selected.Count == 0) throw new InvalidOperationException("资金、量价与板块条件未形成有效共振，暂无可展示候选。");

        UpdateRolesAndCopy(selected, rankedSectors);

        var marketDate = selected
            .SelectMany(s => s.Bars.Select(b => b.Date))
            .DefaultIfEmpty(DateTime.Today)
            .Max()
            .ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        var sessionLabel = SessionLabel(DateTime.Now);
        var sectorViews = rankedSectors.Select((sector, index) => ToSectorView(sector, index + 1, analyzedNews)).ToList();
        var pickViews = selected.Select((stock, index) => ToPickView(stock, index + 1)).ToList();
        var newsViews = analyzedNews.Take(10).ToList();

        var indexAverage = indices.Count == 0 ? 0 : indices.Where(i => i.Region != "A股").DefaultIfEmpty(indices[0]).Average(i => i.ChangePct);
        var domesticAverage = indices.Where(i => i.Region == "A股").DefaultIfEmpty().Average(i => i?.ChangePct ?? 0);
        risk = risk with { OverseasAverage = Math.Round(indexAverage, 2), DomesticAverage = Math.Round(domesticAverage, 2) };

        var strategy = BuildStrategy(risk, breadth, sectorViews, pickViews);
        var note = sessionLabel.Contains("盘后", StringComparison.Ordinal)
            ? "使用最近交易日收盘量价与资金流推演下一交易日；竞价弱转强、开盘30分钟承接和板块联动必须同时确认。"
            : "使用盘中实时截面与近期日线结构；盘中信号变化较快，触发价未满足时保持观察。";

        if (pickViews.Any(p => p.ChangePct > 7.5))
            warnings.Add("部分候选最近交易日涨幅较大，页面已提高追高风险提示。");

        return new DashboardPayload(
            DateTime.Now,
            sessionLabel,
            marketDate,
            note,
            risk,
            breadth,
            indices,
            sectorViews,
            pickViews,
            newsViews,
            strategy,
            warnings.Distinct().ToArray());
    }

    private static IReadOnlyList<StockRaw> SelectPicks(IReadOnlyList<StockRaw> pool, IReadOnlyList<SectorRaw> sectors)
    {
        var result = new List<StockRaw>();
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var liquid = pool.Where(s => s.MainInflow > 0 || s.Metrics.MainFlow3d > 0 || s.Metrics.IsAccumulating).ToList();
        var nonExtended = liquid.Where(s => s.ChangePct < 9.3).ToList();
        if (nonExtended.Count >= 4) liquid = nonExtended;
        if (liquid.Count < 4) liquid = pool.ToList();

        void Add(IEnumerable<StockRaw> source, int count, string? forceRole = null)
        {
            foreach (var stock in source)
            {
                if (result.Count >= 6 || count <= 0) break;
                if (!used.Add(stock.Code)) continue;
                if (!string.IsNullOrWhiteSpace(forceRole)) stock.RoleKey = forceRole;
                result.Add(stock);
                count--;
            }
        }

        var leaderPool = liquid
            .Where(s => s.RoleKey is "leader" or "trend")
            .OrderByDescending(s => s.FinalScore + (s.RoleKey == "leader" ? 5 : 0));
        Add(leaderPool, 3);

        var accumulationPool = liquid
            .Where(s => s.RoleKey == "accumulation" || (s.Metrics.Position120 < 0.68 && s.ChangePct < 8 && s.Metrics.MainFlow3d >= 0))
            .OrderByDescending(s => s.FinalScore
                + (s.RoleKey == "accumulation" ? 12 : 0)
                + (1 - Math.Abs(s.Metrics.Position120 - 0.45)) * 10
                + (s.Metrics.VolumeRatio5To20 is >= 0.75 and <= 1.6 ? 6 : 0));
        Add(accumulationPool, 2, "accumulation");

        Add(liquid.OrderByDescending(s => s.FinalScore), 6 - result.Count);
        return result.OrderByDescending(s => s.FinalScore).ToList();
    }

    private static void UpdateRolesAndCopy(IReadOnlyList<StockRaw> picks, IReadOnlyList<SectorRaw> sectors)
    {
        foreach (var (stock, index) in picks.Select((s, i) => (s, i)))
        {
            var sector = sectors.FirstOrDefault(s => s.Code == stock.SectorCode);
            var role = stock.RoleKey switch
            {
                "leader" => "板块龙头",
                "accumulation" => "低位蓄势",
                "trend" => "趋势共振",
                _ => "资金观察"
            };
            stock.Role = role;
            stock.Thesis = stock.RoleKey switch
            {
                "leader" => $"板块强度靠前，量价与主力资金形成共振；只做承接确认，不在急拉末端追高。",
                "accumulation" => $"位置相对不高、波动收敛，近3日主力资金转正；等待放量突破平台后再提高关注等级。",
                "trend" => $"均线结构修复，资金未明显背离；沿关键均线跟踪，跌破结构位则取消观察。",
                _ => $"实时资金转强，但历史结构确认度一般，仅作为盘中异动观察。"
            };
            if (sector is not null)
                stock.Reasons.Insert(0, $"板块共振：{sector.Name} 强度分 {Math.Round(sector.SectorScore)}，板块涨幅 {sector.ChangePct:F2}%");
            if (!string.IsNullOrWhiteSpace(stock.Risks.FirstOrDefault()))
                stock.Risks.Insert(0, "候选仅为条件筛选，不等同于确定上涨或主力承诺。");
            stock.Reasons = stock.Reasons.Distinct().Take(6).ToList();
            stock.Risks = stock.Risks.Distinct().Take(4).ToList();
        }
    }

    private static void ApplySectorHistory(SectorRaw sector, IReadOnlyList<NewsView> news)
    {
        if (sector.Bars.Count >= 6)
        {
            var closes = sector.Bars.Select(b => b.Close).ToList();
            var last = closes[^1];
            sector.Return5 = closes.Count >= 6 && closes[^6] != 0 ? (last / closes[^6] - 1) * 100 : 0;
            sector.Return20 = closes.Count >= 21 && closes[^21] != 0 ? (last / closes[^21] - 1) * 100 : 0;
            var vols = sector.Bars.Select(b => b.Volume).ToList();
            var v5 = vols.TakeLast(5).DefaultIfEmpty(0).Average();
            var v20 = vols.Skip(Math.Max(0, vols.Count - 25)).Take(20).DefaultIfEmpty(0).Average();
            sector.VolumeRatio5To20 = v20 > 0 ? v5 / v20 : 1;
        }

        var positiveTags = news.Where(n => n.Sentiment > 0).SelectMany(n => n.Tags).GroupBy(t => t).ToDictionary(g => g.Key, g => g.Count());
        var negativeTags = news.Where(n => n.Sentiment < 0).SelectMany(n => n.Tags).GroupBy(t => t).ToDictionary(g => g.Key, g => g.Count());
        var boost = 0.0;
        foreach (var pair in positiveTags)
        {
            if (SectorMatchesTag(sector.Name, pair.Key)) boost += Math.Min(6, pair.Value * 1.35);
        }
        foreach (var pair in negativeTags)
        {
            if (SectorMatchesTag(sector.Name, pair.Key)) boost -= Math.Min(7, pair.Value * 1.55);
        }
        sector.CatalystBoost = Math.Clamp(boost, -10, 15);
        sector.SectorScore = Math.Clamp(BasicSectorScore(sector) + sector.CatalystBoost, 0, 100);
    }

    private static double BasicSectorScore(SectorRaw s)
    {
        var up = s.UpCount;
        var down = s.DownCount;
        var breadthScore = up + down > 0 ? (double)up / (up + down) * 100 : 50;
        var changeScore = Scale(s.ChangePct, -2.5, 6.5);
        var flowScore = Scale(s.MainRatio, -5, 18);
        var momentum5 = Scale(s.Return5, -5, 14);
        var momentum20 = Scale(s.Return20, -10, 28);
        var volumeScore = Scale(s.VolumeRatio5To20, 0.6, 2.4);
        var intradayVolume = Scale(s.VolumeRatio, 0.55, 2.2);
        var leaderScore = Scale(s.LeaderPct, -2, 10);
        return Math.Clamp(
            changeScore * 0.27 +
            flowScore * 0.20 +
            breadthScore * 0.13 +
            momentum5 * 0.13 +
            momentum20 * 0.08 +
            volumeScore * 0.07 +
            intradayVolume * 0.05 +
            leaderScore * 0.07,
            0, 100);
    }

    private static void AnalyzeStock(StockRaw stock, SectorRaw sector, int sectorRank)
    {
        var bars = stock.Bars;
        var closes = bars.Select(b => b.Close).ToList();
        var highs = bars.Select(b => b.High).ToList();
        var lows = bars.Select(b => b.Low).ToList();
        var volumes = bars.Select(b => b.Volume).ToList();
        var close = stock.Price > 0 ? stock.Price : closes[^1];

        var metrics = stock.Metrics;
        metrics.Ma5 = AverageLast(closes, 5);
        metrics.Ma10 = AverageLast(closes, 10);
        metrics.Ma20 = AverageLast(closes, 20);
        metrics.Ma60 = AverageLast(closes, 60);
        metrics.Ma20Slope5 = closes.Count >= 25 && metrics.Ma20 > 0
            ? (metrics.Ma20 / Average(closes.Skip(closes.Count - 25).Take(20)) - 1) * 100
            : 0;
        metrics.Return5 = closes.Count >= 6 && closes[^6] > 0 ? (close / closes[^6] - 1) * 100 : 0;
        metrics.Return20 = closes.Count >= 21 && closes[^21] > 0 ? (close / closes[^21] - 1) * 100 : 0;
        metrics.Rsi14 = Rsi(closes, 14);
        metrics.AtrPct = AtrPercent(bars, 14, close);
        var high120 = highs.TakeLast(Math.Min(120, highs.Count)).Max();
        var low120 = lows.TakeLast(Math.Min(120, lows.Count)).Min();
        metrics.Position120 = high120 > low120 ? Math.Clamp((close - low120) / (high120 - low120), 0, 1) : 0.5;
        var v5 = volumes.TakeLast(5).DefaultIfEmpty(0).Average();
        var v20 = volumes.Skip(Math.Max(0, volumes.Count - 25)).Take(20).DefaultIfEmpty(0).Average();
        metrics.VolumeRatio5To20 = v20 > 0 ? v5 / v20 : 1;
        metrics.High20 = highs.Count >= 21 ? highs.TakeLast(21).Take(20).Max() : highs.DefaultIfEmpty(close).Max();
        metrics.Low10 = lows.TakeLast(Math.Min(10, lows.Count)).DefaultIfEmpty(close).Min();
        metrics.DistanceToBreakout = metrics.High20 > 0 ? (metrics.High20 / close - 1) * 100 : 0;
        metrics.IsBreakout = close >= metrics.High20 * 0.995;
        metrics.IsBullAlignment = metrics.Ma5 > 0 && metrics.Ma10 > 0 && metrics.Ma20 > 0 && close >= metrics.Ma5 && metrics.Ma5 >= metrics.Ma10 && metrics.Ma10 >= metrics.Ma20 && metrics.Ma20Slope5 > -0.3;
        var low5 = lows.TakeLast(5).DefaultIfEmpty(close).Min();
        metrics.IsAccumulating = metrics.Position120 is >= 0.16 and <= 0.72
            && close >= metrics.Ma20 * 0.96
            && close <= metrics.Ma20 * 1.065
            && metrics.VolumeRatio5To20 is >= 0.55 and <= 1.7
            && metrics.Rsi14 is >= 40 and <= 69
            && metrics.Ma20Slope5 > -2.5
            && stock.ChangePct is >= -3 and <= 6.5;

        metrics.MainFlow3d = stock.Flows.TakeLast(3).Sum(f => f.MainInflow);
        metrics.MainFlow5d = stock.Flows.TakeLast(5).Sum(f => f.MainInflow);
        metrics.TriggerPrice = metrics.IsBreakout ? Math.Max(close, metrics.Ma5) * 1.002 : metrics.High20 * 1.003;
        metrics.SupportPrice = metrics.Ma10 > 0 && low5 > 0 ? Math.Min(metrics.Ma10, Math.Max(low5, metrics.Ma10 * 0.985)) : close * 0.975;
        metrics.InvalidationPrice = Math.Max(close * 0.88, Math.Min(metrics.SupportPrice * 0.985, metrics.Ma20 * 0.985));

        var flow3Pct = stock.MarketCap > 0 ? metrics.MainFlow3d / stock.MarketCap * 100 : 0;
        var structureScore = metrics.IsBreakout ? 100 : metrics.IsAccumulating ? 88 : metrics.IsBullAlignment ? 78 : close >= metrics.Ma20 ? 62 : 35;
        var positionScore = metrics.Position120 switch
        {
            >= 0.30 and <= 0.68 => 100,
            >= 0.18 and < 0.30 => 76,
            > 0.68 and <= 0.82 => 68,
            > 0.82 => 38,
            _ => 55
        };
        var volumeHealth = metrics.VolumeRatio5To20 switch
        {
            >= 1.0 and <= 2.5 => 100,
            >= 0.65 and < 1.0 => 76,
            > 2.5 and <= 4.0 => 70,
            _ => 50
        };
        var mainRatioScore = Scale(stock.MainRatio, -4, 16);
        var flow3Score = Scale(flow3Pct, -0.7, 1.7);
        var momentumScore = Scale(metrics.Return20, -8, 28);
        var todayScore = Scale(stock.ChangePct, -3, 8);
        var capScore = Scale(Math.Log10(Math.Max(1, stock.MarketCap / 1_000_000_000)), 0.5, 1.9);

        var score = sector.SectorScore * 0.25
            + todayScore * 0.10
            + mainRatioScore * 0.14
            + flow3Score * 0.10
            + momentumScore * 0.08
            + volumeHealth * 0.08
            + structureScore * 0.14
            + positionScore * 0.07
            + capScore * 0.04;

        if (stock.ChangePct > 9.2) score -= 7;
        if (metrics.VolumeRatio5To20 > 4.0) score -= 4;
        if (stock.Turnover > 28) score -= 3;
        stock.FinalScore = Math.Round(Math.Clamp(score, 1, 99), 0);

        var leaderScore = stock.ChangePct * 2.2 + stock.MainRatio * 1.5 + Math.Log10(Math.Max(1, stock.MarketCap)) * 4 + sector.SectorScore * 0.35;
        stock.RoleKey = leaderScore >= 68 && sectorRank <= 3 && stock.ChangePct >= 1.0
            ? "leader"
            : metrics.IsAccumulating && metrics.MainFlow3d >= 0
                ? "accumulation"
                : metrics.IsBullAlignment
                    ? "trend"
                    : "watch";

        stock.Reasons =
        [
            $"主力资金：当日净流入 {Money(stock.MainInflow)}，3日 {Money(metrics.MainFlow3d)}",
            metrics.IsAccumulating
                ? $"蓄势结构：120日分位 {metrics.Position120 * 100:F0}%，量能比 {metrics.VolumeRatio5To20:F2}，波动收敛"
                : metrics.IsBreakout
                    ? $"突破结构：已靠近/站上20日高点 {metrics.High20:F2}，量能比 {metrics.VolumeRatio5To20:F2}"
                    : $"均线结构：MA20斜率 {metrics.Ma20Slope5:F2}%，20日区间位置 {metrics.Position120 * 100:F0}%",
            $"量价状态：换手 {stock.Turnover:F2}%，量比 {stock.VolumeRatio:F2}，近5/20日量能比 {metrics.VolumeRatio5To20:F2}",
            $"趋势质量：20日收益 {metrics.Return20:F2}%，RSI(14) {metrics.Rsi14:F1}，ATR {metrics.AtrPct:F2}%"
        ];

        stock.Risks = [];
        if (stock.ChangePct > 7.5) stock.Risks.Add("单日涨幅偏大，次日易出现高开兑现或分歧回落。");
        if (stock.MainRatio < 0) stock.Risks.Add("当日主力净占比为负，资金承接不稳。");
        if (metrics.MainFlow3d < 0) stock.Risks.Add("近3日主力资金累计为负，需等待再度转正。");
        if (metrics.Position120 > 0.82) stock.Risks.Add("120日分位偏高，不适合作为低吸标的。");
        if (stock.Turnover > 22) stock.Risks.Add("换手率过高，筹码分歧较大。");
        if (stock.MarketCap < 10_000_000_000) stock.Risks.Add("流通规模偏小，波动和滑点风险较高。");
        if (stock.Risks.Count == 0) stock.Risks.Add("大盘转弱或板块资金流出时，个股结构可能同步失效。");
    }

    private static SectorView ToSectorView(SectorRaw s, int rank, IReadOnlyList<NewsView> news)
    {
        var level = s.SectorScore >= 76 ? "核心主线" : s.SectorScore >= 67 ? "强势轮动" : s.SectorScore >= 58 ? "观察扩散" : "弱修复";
        var thesis = $"{s.Name}强度分 {s.SectorScore:F0}，当日 {s.ChangePct:F2}%，5日 {s.Return5:F2}%，主力净流入 {Money(s.MainInflow)}。";
        var catalystTag = news.Where(n => n.Sentiment > 0).SelectMany(n => n.Tags).FirstOrDefault(t => SectorMatchesTag(s.Name, t));
        var catalyst = string.IsNullOrWhiteSpace(catalystTag) ? "暂无明确消息催化，以量价和资金为主" : $"消息催化：{catalystTag} 偏多";
        var reasons = new List<string>
        {
            $"资金：主力净占比 {s.MainRatio:F2}%，净流入 {Money(s.MainInflow)}",
            $"广度：上涨 {s.UpCount} 家 / 下跌 {s.DownCount} 家，领涨 {s.LeaderName} {s.LeaderPct:F2}%",
            $"量能：近5/20日量比 {s.VolumeRatio5To20:F2}，当日换手 {s.Turnover:F2}%"
        };
        var risks = new List<string>();
        if (s.ChangePct > 5) risks.Add("单日涨幅较大，次日分歧概率上升。");
        if (s.MainRatio < 0) risks.Add("板块主力净占比为负。");
        if (s.Return20 > 22) risks.Add("20日累计涨幅偏高，注意兑现压力。");
        if (s.UpCount + s.DownCount < 6) risks.Add("板块容量偏小，持续性需要额外验证。");
        if (risks.Count == 0) risks.Add("若指数风险偏好下降，强势板块也可能出现补跌。");
        return new SectorView(rank, s.Code, s.Name, (int)Math.Round(s.SectorScore), Math.Round(s.ChangePct, 2),
            Math.Round(s.Return5, 2), Math.Round(s.Return20, 2), s.MainInflow, Math.Round(s.MainRatio, 2),
            Math.Round(s.Turnover, 2), Math.Round(s.VolumeRatio5To20, 2), s.UpCount, s.DownCount, s.LeaderName,
            s.LeaderCode, Math.Round(s.LeaderPct, 2), level, thesis, catalyst, reasons, risks);
    }

    private static PickView ToPickView(StockRaw s, int rank)
    {
        var m = s.Metrics;
        var triggerText = m.IsBreakout
            ? $"站稳 {m.TriggerPrice:F2}，回踩 {m.SupportPrice:F2} 不破更佳"
            : $"放量突破 {m.TriggerPrice:F2} 后再观察";
        var supportText = $"短线支撑 {m.SupportPrice:F2}";
        var invalidationText = $"收盘跌破 {m.InvalidationPrice:F2} 视为结构失效";
        var spark = s.Bars.TakeLast(20).Select(b => Math.Round(b.Close, 3)).ToList();
        return new PickView(
            rank, s.Code, s.Name, s.Market == 1 ? "沪市" : "深市", s.SectorCode, s.SectorName, s.Role, s.RoleKey,
            (int)Math.Round(s.FinalScore), Math.Round(s.Price, 2), Math.Round(s.ChangePct, 2), s.MainInflow,
            Math.Round(s.MainRatio, 2), s.Metrics.MainFlow3d, s.Metrics.MainFlow5d, Math.Round(s.Turnover, 2),
            Math.Round(s.VolumeRatio, 2), s.MarketCap, Math.Round(s.Pe, 2), Math.Round(m.Position120 * 100, 1),
            Math.Round(m.DistanceToBreakout, 2), Math.Round(m.AtrPct, 2), Math.Round(m.TriggerPrice, 2),
            Math.Round(m.SupportPrice, 2), Math.Round(m.InvalidationPrice, 2), triggerText, supportText,
            invalidationText, s.Thesis, s.Reasons, s.Risks, spark);
    }

    private static BreadthSnapshot BuildBreadth(IReadOnlyList<SectorRaw> sectors)
    {
        var up = sectors.Sum(s => s.UpCount);
        var down = sectors.Sum(s => s.DownCount);
        var flat = sectors.Sum(s => s.FlatCount);
        var ratio = up + down > 0 ? (double)up / (up + down) : 0.5;
        var summary = ratio >= 0.62 ? "个股广度偏强，风险偏好回升" : ratio >= 0.48 ? "涨跌接近平衡，主线轮动为主" : "下跌家数占优，需控制追涨";
        var themes = sectors
            .OrderByDescending(s => s.ChangePct)
            .Where(s => s.UpCount + s.DownCount >= 4 && s.MarketCap >= 30_000_000_000)
            .Take(5)
            .Select(s => s.Name)
            .ToList();
        return new BreadthSnapshot(up, down, flat, Math.Round(ratio * 100, 1), summary, themes);
    }

    private static RiskSnapshot BuildRisk(IReadOnlyList<IndexQuote> indices, BreadthSnapshot breadth, double newsSentiment)
    {
        var overseas = indices.Where(i => i.Region != "A股").DefaultIfEmpty().Average(i => i?.ChangePct ?? 0);
        var domestic = indices.Where(i => i.Region == "A股").DefaultIfEmpty().Average(i => i?.ChangePct ?? 0);
        var score = 50 + overseas * 13 + domestic * 11 + (breadth.AdvanceRatio - 50) * 0.45 + newsSentiment * 3.0;
        score = Math.Clamp(score, 0, 100);
        var label = score >= 68 ? "积极" : score >= 48 ? "中性" : "谨慎";
        var tone = score >= 68 ? "positive" : score >= 48 ? "neutral" : "negative";
        var summary = label switch
        {
            "积极" => "外围偏暖且A股广度改善，可聚焦强主线的低位补涨与龙头回踩。",
            "中性" => "外围与A股信号分化，优先做板块龙头的分歧承接，避免追高一致性。",
            _ => "风险偏好偏弱，先控制仓位，只参与资金持续净流入且有明确支撑的标的。"
        };
        var position = label switch
        {
            "积极" => "总仓位参考 50%-70%，单票不超过 15%，分两批确认。",
            "中性" => "总仓位参考 30%-50%，单票不超过 10%，触发条件未满足不追。",
            _ => "总仓位参考 0%-30%，以防守和观察为主，等待指数止跌与板块资金回流。"
        };
        return new RiskSnapshot((int)Math.Round(score), label, tone, summary, Math.Round(overseas, 2), Math.Round(domestic, 2), position);
    }

    private static StrategyView BuildStrategy(RiskSnapshot risk, BreadthSnapshot breadth, IReadOnlyList<SectorView> sectors, IReadOnlyList<PickView> picks)
    {
        var hot = sectors.Take(3).Select(s => s.Name).ToList();
        var environment = $"风险温度 {risk.Score}/100（{risk.Label}）。{breadth.Summary}。当前优先观察：{string.Join("、", hot)}。";
        return new StrategyView(
            environment,
            [
                risk.PositionHint,
                "首仓只用计划仓位的 1/3-1/2，确认放量突破或回踩承接后再加。",
                "若大盘分时跌破前低、板块主力净流入转负，先减仓而不是补仓。"
            ],
            [
                "板块强度、当日主力净流入、上涨家数占比三项不能同时偏弱。",
                "个股必须同时观察：20日结构、近5/20日量能比、当日主力净占比、120日位置。",
                "同等条件下优先成交额充足、流动性好的行业龙一或龙二，回避纯情绪小票。"
            ],
            [
                "只在触发价附近执行，不因盘中拉升临时追单。",
                "回踩支撑不破且量能收缩，可视为二次确认；放量跌破防守位则逻辑失效。",
                "次日冲高不放量或板块同步走弱，优先兑现半数，剩余仓位用移动止盈跟踪。"
            ],
            [
                "不做ST、退市风险、连续亏损和高位加速末端的股票。",
                "不把单日主力净流入等同于主力承诺，资金数据存在回流与对倒噪声。",
                "重大政策、财报、监管和突发消息需要重新评估，历史量价不能覆盖事件风险。"
            ],
            "本页面是基于公开行情、资金流与新闻关键词的量化观察工具，仅用于研究，不构成投资建议、收益承诺或买卖指令。股市有风险，决策需独立判断。"
        );
    }

    private static IReadOnlyList<NewsView> AnalyzeNews(IReadOnlyList<NewsRaw> raw)
    {
        return raw
            .Select(n =>
            {
                var sentiment = Math.Clamp(Math.Sign(n.Score) * Math.Min(2, Math.Abs(n.Score)), -2, 2);
                if (n.Score >= 5) sentiment = 2;
                var label = sentiment >= 2 ? "强利好" : sentiment == 1 ? "偏多" : sentiment == 0 ? "中性" : sentiment == -1 ? "偏空" : "强利空";
                return new NewsView(n.Time.ToString("MM-dd HH:mm", CultureInfo.InvariantCulture), n.Title, n.Summary, n.Url,
                    sentiment, label, n.Tags);
            })
            .OrderByDescending(n => Math.Abs(n.Sentiment) * 4 + (n.Time.StartsWith(DateTime.Now.ToString("MM-dd"), StringComparison.Ordinal) ? 2 : 0))
            .ThenByDescending(n => n.Time)
            .Take(12)
            .ToList();
    }

    private static bool SectorMatchesTag(string sectorName, string tag)
    {
        var map = new Dictionary<string, string[]>
        {
            ["AI算力"] = ["通信", "软件", "计算机", "电子", "半导体", "互联网", "消费电子", "算力"],
            ["半导体"] = ["半导体", "电子", "元件", "光学", "芯片"],
            ["机器人"] = ["机器人", "自动化", "通用设备", "专用设备", "机械"],
            ["新能源"] = ["风电", "光伏", "储能", "电池", "电源", "电力设备", "新能源", "汽车零部件"],
            ["医药生物"] = ["医药", "医疗", "生物", "中药", "化学制药", "医疗服务"],
            ["贵金属有色"] = ["黄金", "有色", "金属", "小金属", "稀土", "铜", "铝"],
            ["煤炭能源"] = ["煤炭", "焦炭", "石油", "燃气", "电力", "能源"],
            ["军工航天"] = ["军工", "航天", "航空", "船舶", "卫星", "兵装"],
            ["汽车"] = ["汽车", "整车", "零部件", "智能驾驶"],
            ["消费"] = ["食品", "饮料", "白酒", "家电", "旅游", "酒店", "零售", "纺织", "服装"],
            ["金融地产"] = ["银行", "证券", "保险", "地产", "房地产", "金融"],
            ["农业"] = ["农业", "林业", "种植", "养殖", "饲料", "农产品"],
            ["通信"] = ["通信", "通信设备", "光模块", "5G"]
        };
        return map.TryGetValue(tag, out var keys) && keys.Any(k => sectorName.Contains(k, StringComparison.OrdinalIgnoreCase));
    }

    private static string SessionLabel(DateTime now)
    {
        if (now.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) return "周末复盘";
        var minutes = now.Hour * 60 + now.Minute;
        if (minutes < 9 * 60 + 20) return "盘前推演";
        if (minutes <= 11 * 60 + 30 || minutes is >= 13 * 60 and <= 15 * 60) return "盘中跟踪";
        return "盘后推演";
    }

    private static string Money(double value)
    {
        var abs = Math.Abs(value);
        if (abs >= 100_000_000) return $"{value / 100_000_000:F2}亿";
        if (abs >= 10_000) return $"{value / 10_000:F0}万";
        return $"{value:F0}元";
    }

    private static double Rsi(IReadOnlyList<double> closes, int period)
    {
        if (closes.Count <= period) return 50;
        double gain = 0, loss = 0;
        for (var i = closes.Count - period; i < closes.Count; i++)
        {
            var change = closes[i] - closes[i - 1];
            if (change >= 0) gain += change; else loss -= change;
        }
        if (loss == 0) return 100;
        var rs = gain / loss;
        return 100 - 100 / (1 + rs);
    }

    private static double AtrPercent(IReadOnlyList<DailyBar> bars, int period, double close)
    {
        if (bars.Count < 2 || close <= 0) return 0;
        var trs = new List<double>();
        for (var i = Math.Max(1, bars.Count - period); i < bars.Count; i++)
        {
            var tr = Math.Max(bars[i].High - bars[i].Low,
                Math.Max(Math.Abs(bars[i].High - bars[i - 1].Close), Math.Abs(bars[i].Low - bars[i - 1].Close)));
            trs.Add(tr);
        }
        return trs.Count == 0 ? 0 : trs.Average() / close * 100;
    }

    private static double AverageLast(IReadOnlyList<double> values, int count) => values.Count == 0 ? 0 : values.TakeLast(Math.Min(count, values.Count)).Average();
    private static double Average(IEnumerable<double> values) { var list = values.ToList(); return list.Count == 0 ? 0 : list.Average(); }
    private static double Scale(double value, double low, double high) => high <= low ? 50 : Math.Clamp((value - low) / (high - low) * 100, 0, 100);

    private static async Task ParallelForEachAsync<T>(IEnumerable<T> source, int maxParallel, Func<T, Task> action)
    {
        using var semaphore = new SemaphoreSlim(maxParallel, maxParallel);
        var tasks = source.Select(async item =>
        {
            await semaphore.WaitAsync();
            try { await action(item); }
            finally { semaphore.Release(); }
        });
        await Task.WhenAll(tasks);
    }

    private async Task SaveLastGoodAsync(DashboardPayload payload, CancellationToken ct)
    {
        try
        {
            var dir = Path.Combine(_contentRoot, "data");
            Directory.CreateDirectory(dir);
            var json = JsonSerializer.Serialize(payload, _jsonOptions);
            await File.WriteAllTextAsync(Path.Combine(dir, "last-good.json"), json, new System.Text.UTF8Encoding(false), ct);
        }
        catch
        {
            // 缓存失败不能影响页面返回。
        }
    }

    private async Task<DashboardPayload?> LoadLastGoodAsync(CancellationToken ct)
    {
        try
        {
            var path = Path.Combine(_contentRoot, "data", "last-good.json");
            if (!File.Exists(path)) return null;
            var json = await File.ReadAllTextAsync(path, ct);
            return JsonSerializer.Deserialize<DashboardPayload>(json, _jsonOptions);
        }
        catch
        {
            return null;
        }
    }
}





