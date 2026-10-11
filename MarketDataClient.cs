using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace StockRadar;

public sealed class MarketDataClient
{
    private const string PushBase = "http://push2.eastmoney.com";
    private const string HistoryBase = "http://push2his.eastmoney.com";
    private readonly HttpClient _http;

    public MarketDataClient()
    {
        var handler = new SocketsHttpHandler
        {
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            ConnectTimeout = TimeSpan.FromSeconds(8)
        };
        _http = new HttpClient(handler) { Timeout = TimeSpan.FromSeconds(24) };
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("Mozilla/5.0 (Windows NT 10.0; Win64; x64) QuantRadar/1.0");
        _http.DefaultRequestHeaders.Referrer = new Uri("http://quote.eastmoney.com/");
    }

    public async Task<IReadOnlyList<SectorRaw>> FetchSectorsAsync(CancellationToken ct)
    {
        const string fields = "f2,f3,f6,f8,f10,f12,f14,f20,f62,f66,f69,f72,f75,f104,f105,f106,f128,f136,f140,f184";
        var url = $"{PushBase}/api/qt/clist/get?pn=1&pz=600&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2&fields={fields}";
        using var doc = await GetJsonAsync(url, ct);
        var list = EnumerateDiff(doc.RootElement).Select(e => new SectorRaw
        {
            Code = GetString(e, "f12"),
            Name = GetString(e, "f14"),
            Price = GetDouble(e, "f2"),
            ChangePct = GetDouble(e, "f3"),
            Turnover = GetDouble(e, "f8"),
            VolumeRatio = GetDouble(e, "f10"),
            MarketCap = GetDouble(e, "f20"),
            MainInflow = GetDouble(e, "f62"),
            MainRatio = NormalizeRatio(GetDouble(e, "f184")),
            SuperInflow = GetDouble(e, "f66"),
            BigInflow = GetDouble(e, "f72"),
            UpCount = GetInt(e, "f104"),
            DownCount = GetInt(e, "f105"),
            FlatCount = GetInt(e, "f106"),
            LeaderName = GetString(e, "f128"),
            LeaderCode = GetString(e, "f140"),
            LeaderPct = GetDouble(e, "f136")
        })
        .Where(s => !string.IsNullOrWhiteSpace(s.Code) && !string.IsNullOrWhiteSpace(s.Name))
        .ToList();

        var deduped = list
            .GroupBy(s => NormalizeSectorName(s.Name))
            .Select(g => g.OrderByDescending(x => x.UpCount + x.DownCount).ThenByDescending(x => x.MarketCap).First())
            .Where(s => !string.IsNullOrWhiteSpace(s.Name))
            .Select(s => { s.Name = NormalizeSectorName(s.Name); return s; })
            .ToList();

        return deduped;
    }

    public async Task<IReadOnlyList<IndexQuote>> FetchIndicesAsync(CancellationToken ct)
    {
        const string secids = "1.000001,0.399001,0.399006,100.HSI,100.NDX,100.SPX,100.DJIA,100.N225,100.KS11,100.GDAXI,100.FCHI";
        const string fields = "f12,f14,f2,f3,f6";
        var url = $"{PushBase}/api/qt/ulist.np/get?fltt=2&invt=2&fields={fields}&secids={secids}";
        using var doc = await GetJsonAsync(url, ct);
        return EnumerateDiff(doc.RootElement).Select(e =>
        {
            var pct = GetDouble(e, "f3");
            var region = GetIndexRegion(GetString(e, "f12"));
            return new IndexQuote(
                GetString(e, "f12"),
                GetString(e, "f14"),
                region,
                GetDouble(e, "f2"),
                pct,
                GetDouble(e, "f6"),
                pct >= 0.8 ? "强势" : pct >= 0.1 ? "微涨" : pct > -0.5 ? "震荡" : "承压");
        }).ToList();
    }

    public async Task<IReadOnlyList<StockRaw>> FetchSectorStocksAsync(string sectorCode, string sectorName, CancellationToken ct)
    {
        const string fields = "f2,f3,f5,f6,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f22,f24,f25,f62,f66,f69,f72,f75,f78,f81,f84,f87,f184";
        var byPercentUrl = $"{PushBase}/api/qt/clist/get?pn=1&pz=80&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:{sectorCode}&fields={fields}";
        var byFlowUrl = $"{PushBase}/api/qt/clist/get?pn=1&pz=80&po=1&np=1&fltt=2&invt=2&fid=f62&fs=b:{sectorCode}&fields={fields}";

        var docs = await Task.WhenAll(GetJsonAsync(byPercentUrl, ct), GetJsonAsync(byFlowUrl, ct));
        using var d1 = docs[0];
        using var d2 = docs[1];

        var rows = EnumerateDiff(d1.RootElement)
            .Concat(EnumerateDiff(d2.RootElement))
            .Select(e => new StockRaw
            {
                Code = GetString(e, "f12"),
                Market = GetInt(e, "f13"),
                Name = GetString(e, "f14"),
                Price = GetDouble(e, "f2"),
                ChangePct = GetDouble(e, "f3"),
                Turnover = GetDouble(e, "f8"),
                VolumeRatio = GetDouble(e, "f10"),
                Amount = GetDouble(e, "f6"),
                MarketCap = GetDouble(e, "f20"),
                FloatMarketCap = GetDouble(e, "f21"),
                Return60 = GetDouble(e, "f24"),
                ReturnYtd = GetDouble(e, "f25"),
                MainInflow = GetDouble(e, "f62"),
                MainRatio = NormalizeRatio(GetDouble(e, "f184")),
                SuperInflow = GetDouble(e, "f66"),
                SuperRatio = NormalizeRatio(GetDouble(e, "f69")),
                BigInflow = GetDouble(e, "f72"),
                BigRatio = NormalizeRatio(GetDouble(e, "f75")),
                Pe = GetDouble(e, "f9"),
                SectorCode = sectorCode,
                SectorName = sectorName
            })
            .Where(s => !string.IsNullOrWhiteSpace(s.Code))
            .GroupBy(s => s.Code)
            .Select(g => g.OrderByDescending(x => x.Amount).First())
            .Where(IsEligibleStock)
            .ToList();

        foreach (var row in rows)
        {
            row.PreliminaryScore = PreliminaryStockScore(row);
        }

        return rows.OrderByDescending(s => s.PreliminaryScore).Take(32).ToList();
    }

    public async Task<List<DailyBar>> FetchKlinesAsync(string secid, CancellationToken ct)
    {
        const string fields1 = "f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13";
        const string fields2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";
        var url = $"{HistoryBase}/api/qt/stock/kline/get?secid={secid}&klt=101&fqt=1&lmt=140&end=20500101&iscca=1&fields1={fields1}&fields2={fields2}";
        using var doc = await GetJsonAsync(url, ct);
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            return [];

        if (!data.TryGetProperty("klines", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return [];

        var bars = new List<DailyBar>();
        foreach (var item in arr.EnumerateArray())
        {
            var text = item.GetString();
            if (string.IsNullOrWhiteSpace(text)) continue;
            var p = text.Split(',');
            if (p.Length < 11) continue;
            if (!DateTime.TryParseExact(p[0], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)) continue;
            bars.Add(new DailyBar(
                date,
                Parse(p[1]), Parse(p[2]), Parse(p[3]), Parse(p[4]),
                Parse(p[5]), Parse(p[6]), Parse(p[8]), Parse(p[10])));
        }
        return bars;
    }

    public async Task<List<FlowBar>> FetchFlowsAsync(string secid, CancellationToken ct)
    {
        const string fields1 = "f1,f2,f3,f7";
        const string fields2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63";
        var url = $"{HistoryBase}/api/qt/stock/fflow/daykline/get?lmt=15&klt=101&secid={secid}&fields1={fields1}&fields2={fields2}";
        using var doc = await GetJsonAsync(url, ct);
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            return [];
        if (!data.TryGetProperty("klines", out var arr) || arr.ValueKind != JsonValueKind.Array)
            return [];

        var flows = new List<FlowBar>();
        foreach (var item in arr.EnumerateArray())
        {
            var text = item.GetString();
            if (string.IsNullOrWhiteSpace(text)) continue;
            var p = text.Split(',');
            if (p.Length < 6) continue;
            if (!DateTime.TryParseExact(p[0], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var date)) continue;
            flows.Add(new FlowBar(date, Parse(p[1]), Parse(p[2]), Parse(p[3]), Parse(p[4]), Parse(p[5])));
        }
        return flows;
    }

    public async Task<IReadOnlyList<NewsRaw>> FetchNewsAsync(CancellationToken ct)
    {
        const string url = "http://newsapi.eastmoney.com/kuaixun/v1/getlist_102_ajaxResult_60_1_.html";
        var text = await GetStringAsync(url, ct);
        var start = text.IndexOf('{');
        var end = text.LastIndexOf('}');
        if (start < 0 || end <= start) return [];

        using var doc = JsonDocument.Parse(text[start..(end + 1)]);
        if (!doc.RootElement.TryGetProperty("LivesList", out var list) || list.ValueKind != JsonValueKind.Array)
            return [];

        var result = new List<NewsRaw>();
        foreach (var item in list.EnumerateArray())
        {
            var title = GetString(item, "title").Trim();
            var summary = GetString(item, "digest").Trim();
            if (string.IsNullOrWhiteSpace(title)) continue;
            var content = title + " " + summary;
            var timeText = GetString(item, "showtime");
            DateTime.TryParseExact(timeText, "yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture, DateTimeStyles.None, out var time);
            var score = ScoreNews(content);
            var tags = DetectNewsTags(content);
            var link = GetString(item, "url_m");
            if (string.IsNullOrWhiteSpace(link)) link = GetString(item, "url_w");
            result.Add(new NewsRaw(time, title, summary, link, score, tags));
        }
        return result;
    }

    private async Task<JsonDocument> GetJsonAsync(string url, CancellationToken ct)
    {
        Exception? last = null;
        for (var i = 0; i < 4; i++)
        {
            try
            {
                using var response = await _http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, ct);
                response.EnsureSuccessStatusCode();
                await using var stream = await response.Content.ReadAsStreamAsync(ct);
                return await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException or JsonException)
            {
                last = ex;
                if (ct.IsCancellationRequested) break;
                await Task.Delay(220 * (i + 1), ct);
            }
        }
        throw new InvalidOperationException($"行情接口请求失败: {url}", last);
    }

    private async Task<string> GetStringAsync(string url, CancellationToken ct)
    {
        Exception? last = null;
        for (var i = 0; i < 4; i++)
        {
            try
            {
                using var response = await _http.GetAsync(url, ct);
                response.EnsureSuccessStatusCode();
                return await response.Content.ReadAsStringAsync(ct);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or IOException)
            {
                last = ex;
                if (ct.IsCancellationRequested) break;
                await Task.Delay(220 * (i + 1), ct);
            }
        }
        throw new InvalidOperationException($"资讯接口请求失败: {url}", last);
    }

    private static IEnumerable<JsonElement> EnumerateDiff(JsonElement root)
    {
        if (!root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
            yield break;
        if (!data.TryGetProperty("diff", out var diff) || diff.ValueKind != JsonValueKind.Array)
            yield break;
        foreach (var item in diff.EnumerateArray())
            yield return item;
    }

    private static bool IsEligibleStock(StockRaw s)
    {
        if (s.Name.Contains("ST", StringComparison.OrdinalIgnoreCase) || s.Name.Contains('退')) return false;
        if (s.Price <= 1.5 || s.MarketCap < 4_000_000_000 || s.Amount < 80_000_000) return false;
        if (s.ChangePct > 19.5 || s.ChangePct < -7.5) return false;
        if (s.Code.StartsWith("92", StringComparison.Ordinal)) return false; // 北交所小市值票与主板逻辑差异较大
        return true;
    }

    private static double PreliminaryStockScore(StockRaw s)
    {
        var pctScore = Scale(s.ChangePct, -4, 8);
        var flowScore = Scale(s.MainRatio, -4, 16);
        var volumeScore = Scale(s.VolumeRatio, 0.65, 2.8);
        var capScore = Scale(Math.Log10(Math.Max(1, s.MarketCap / 1_000_000_000)), 0.5, 1.8);
        var turnoverScore = s.Turnover is >= 0.7 and <= 22 ? 85 : 55;
        return pctScore * 0.28 + flowScore * 0.29 + volumeScore * 0.16 + capScore * 0.13 + turnoverScore * 0.14;
    }

    private static string NormalizeSectorName(string name)
    {
        var trimmed = name.Trim();
        return Regex.Replace(trimmed, "[ⅠⅡⅢ]+$", "").Replace("Ⅱ", "", StringComparison.Ordinal).Replace("Ⅲ", "", StringComparison.Ordinal);
    }

    private static double NormalizeRatio(double value)
    {
        // 部分接口返回小数比例，部分接口返回百分数。
        return value;
    }

    private static string GetIndexRegion(string code) => code switch
    {
        "000001" or "399001" or "399006" => "A股",
        "HSI" => "港股",
        "NDX" or "SPX" or "DJIA" => "美股",
        "N225" or "KS11" => "亚太",
        "GDAXI" or "FCHI" => "欧洲",
        _ => "全球"
    };

    private static int ScoreNews(string content)
    {
        var score = 0;
        score += CountWeighted(content, new (string, int)[]
        {
            ("超预期", 3), ("大幅增长", 3), ("预增", 3), ("涨停", 3), ("利好", 3), ("突破", 2),
            ("创新高", 2), ("回购", 2), ("增持", 2), ("中标", 2), ("签约", 2), ("获批", 2),
            ("量产", 2), ("涨价", 2), ("降息", 2), ("补贴", 2), ("扭亏", 2), ("回暖", 1),
            ("增长", 1), ("上涨", 1), ("放量", 1), ("订单", 1), ("合作", 1), ("扩产", 1)
        });
        score -= CountWeighted(content, new (string, int)[]
        {
            ("暴跌", 3), ("制裁", 3), ("违约", 3), ("调查", 3), ("退市", 3), ("亏损", 3),
            ("下调", 2), ("减持", 2), ("风险", 2), ("加息", 2), ("冲突", 2), ("停产", 2),
            ("停产", 2), ("召回", 2), ("处罚", 2), ("下滑", 2), ("承压", 1), ("下跌", 1),
            ("质量问题", 2), ("通胀", 1), ("不确定", 1), ("放缓", 1)
        });
        return Math.Clamp(score, -6, 6);
    }

    private static int CountWeighted(string content, IReadOnlyList<(string Term, int Weight)> terms)
    {
        return terms.Sum(t => content.Contains(t.Term, StringComparison.OrdinalIgnoreCase) ? t.Weight : 0);
    }

    private static List<string> DetectNewsTags(string content)
    {
        var tags = new List<string>();
        AddTag(tags, content, "AI算力", "人工智能", "算力", "大模型", "AI", "服务器", "数据中心");
        AddTag(tags, content, "半导体", "芯片", "半导体", "光刻", "存储", "晶圆", "先进封装");
        AddTag(tags, content, "机器人", "机器人", "人形", "减速器", "伺服", "自动化");
        AddTag(tags, content, "新能源", "风电", "光伏", "储能", "锂电", "电池", "充电桩", "新能源");
        AddTag(tags, content, "医药生物", "医药", "医疗", "创新药", "疫苗", "生物", "医保");
        AddTag(tags, content, "贵金属有色", "黄金", "白银", "铜", "铝", "稀土", "有色金属", "金属");
        AddTag(tags, content, "煤炭能源", "煤炭", "焦炭", "原油", "石油", "天然气", "能源");
        AddTag(tags, content, "军工航天", "军工", "航天", "卫星", "导弹", "航空", "低空");
        AddTag(tags, content, "汽车", "汽车", "新能源车", "智能驾驶", "零部件", "整车");
        AddTag(tags, content, "消费", "消费", "白酒", "食品", "家电", "旅游", "零售");
        AddTag(tags, content, "金融地产", "银行", "券商", "保险", "地产", "房地产", "利率");
        AddTag(tags, content, "农业", "农业", "粮食", "种业", "生猪", "大米", "小麦");
        AddTag(tags, content, "通信", "通信", "5G", "6G", "卫星互联网", "光模块");
        return tags;
    }

    private static void AddTag(List<string> tags, string content, string tag, params string[] keys)
    {
        if (keys.Any(k => content.Contains(k, StringComparison.OrdinalIgnoreCase))) tags.Add(tag);
    }

    private static double Parse(string text)
    {
        if (string.IsNullOrWhiteSpace(text) || text == "-") return 0;
        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value) ? value : 0;
    }

    private static string GetString(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value)) return "";
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? "",
            JsonValueKind.Number => value.ToString(),
            _ => ""
        };
    }

    private static double GetDouble(JsonElement element, string property)
    {
        if (!element.TryGetProperty(property, out var value)) return 0;
        return value.ValueKind switch
        {
            JsonValueKind.Number => value.GetDouble(),
            JsonValueKind.String => Parse(value.GetString() ?? ""),
            _ => 0
        };
    }

    private static int GetInt(JsonElement element, string property) => (int)Math.Round(GetDouble(element, property));

    private static double Scale(double value, double low, double high)
    {
        if (high <= low) return 50;
        return Math.Clamp((value - low) / (high - low) * 100, 0, 100);
    }
}




