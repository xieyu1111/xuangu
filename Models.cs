using System.Text.Json.Serialization;

namespace StockRadar;

public sealed record DashboardPayload(
    DateTime GeneratedAt,
    string SessionLabel,
    string MarketDate,
    string DataNote,
    RiskSnapshot Risk,
    BreadthSnapshot Breadth,
    IReadOnlyList<IndexQuote> Indices,
    IReadOnlyList<SectorView> Sectors,
    IReadOnlyList<PickView> Picks,
    IReadOnlyList<NewsView> News,
    StrategyView Strategy,
    IReadOnlyList<string> Warnings);

public sealed record RiskSnapshot(
    int Score,
    string Label,
    string Tone,
    string Summary,
    double OverseasAverage,
    double DomesticAverage,
    string PositionHint);

public sealed record BreadthSnapshot(
    int Up,
    int Down,
    int Flat,
    double AdvanceRatio,
    string Summary,
    IReadOnlyList<string> Themes);

public sealed record IndexQuote(
    string Code,
    string Name,
    string Region,
    double Price,
    double ChangePct,
    double Turnover,
    string Status);

public sealed record SectorView(
    int Rank,
    string Code,
    string Name,
    int Score,
    double ChangePct,
    double Return5,
    double Return20,
    double MainInflow,
    double MainRatio,
    double Turnover,
    double VolumeRatio,
    int UpCount,
    int DownCount,
    string LeaderName,
    string LeaderCode,
    double LeaderPct,
    string Level,
    string Thesis,
    string Catalyst,
    IReadOnlyList<string> Reasons,
    IReadOnlyList<string> Risks);

public sealed record PickView(
    int Rank,
    string Code,
    string Name,
    string Market,
    string SectorCode,
    string SectorName,
    string Role,
    string RoleKey,
    int Score,
    double Price,
    double ChangePct,
    double MainInflow,
    double MainRatio,
    double MainFlow3d,
    double MainFlow5d,
    double Turnover,
    double VolumeRatio,
    double MarketCap,
    double Pe,
    double Position120,
    double DistanceToBreakout,
    double AtrPct,
    double TriggerPrice,
    double SupportPrice,
    double InvalidationPrice,
    string TriggerText,
    string SupportText,
    string InvalidationText,
    string Thesis,
    IReadOnlyList<string> Reasons,
    IReadOnlyList<string> Risks,
    IReadOnlyList<double> Spark);

public sealed record NewsView(
    string Time,
    string Title,
    string Summary,
    string Url,
    int Sentiment,
    string SentimentLabel,
    IReadOnlyList<string> Tags);

public sealed record StrategyView(
    string MarketEnvironment,
    IReadOnlyList<string> PositionRules,
    IReadOnlyList<string> SelectionRules,
    IReadOnlyList<string> ExecutionRules,
    IReadOnlyList<string> AvoidRules,
    string Disclaimer);

public sealed class SectorRaw
{
    public string Code { get; set; } = "";
    public string Name { get; set; } = "";
    public double Price { get; set; }
    public double ChangePct { get; set; }
    public double Turnover { get; set; }
    public double VolumeRatio { get; set; }
    public double MarketCap { get; set; }
    public double MainInflow { get; set; }
    public double MainRatio { get; set; }
    public double SuperInflow { get; set; }
    public double BigInflow { get; set; }
    public int UpCount { get; set; }
    public int DownCount { get; set; }
    public int FlatCount { get; set; }
    public string LeaderName { get; set; } = "";
    public string LeaderCode { get; set; } = "";
    public double LeaderPct { get; set; }
    public List<DailyBar> Bars { get; } = [];
    public double Return5 { get; set; }
    public double Return20 { get; set; }
    public double VolumeRatio5To20 { get; set; } = 1;
    public double SectorScore { get; set; }
    public double CatalystBoost { get; set; }
}

public sealed class StockRaw
{
    public string Code { get; set; } = "";
    public int Market { get; set; }
    public string Name { get; set; } = "";
    public double Price { get; set; }
    public double ChangePct { get; set; }
    public double Turnover { get; set; }
    public double VolumeRatio { get; set; }
    public double Amount { get; set; }
    public double MarketCap { get; set; }
    public double FloatMarketCap { get; set; }
    public double Return60 { get; set; }
    public double ReturnYtd { get; set; }
    public double MainInflow { get; set; }
    public double MainRatio { get; set; }
    public double SuperInflow { get; set; }
    public double SuperRatio { get; set; }
    public double BigInflow { get; set; }
    public double BigRatio { get; set; }
    public double Pe { get; set; }
    public string SectorCode { get; set; } = "";
    public string SectorName { get; set; } = "";
    public List<DailyBar> Bars { get; set; } = [];
    public List<FlowBar> Flows { get; set; } = [];
    public StockMetrics Metrics { get; set; } = new();
    public double PreliminaryScore { get; set; }
    public double FinalScore { get; set; }
    public string Role { get; set; } = "趋势跟随";
    public string RoleKey { get; set; } = "trend";
    public string Thesis { get; set; } = "";
    public List<string> Reasons { get; set; } = [];
    public List<string> Risks { get; set; } = [];
}

public sealed record DailyBar(
    DateTime Date,
    double Open,
    double Close,
    double High,
    double Low,
    double Volume,
    double Amount,
    double Pct,
    double Turnover);

public sealed record FlowBar(
    DateTime Date,
    double MainInflow,
    double SmallInflow,
    double MediumInflow,
    double LargeInflow,
    double SuperInflow);

public sealed class StockMetrics
{
    public double Ma5 { get; set; }
    public double Ma10 { get; set; }
    public double Ma20 { get; set; }
    public double Ma60 { get; set; }
    public double Ma20Slope5 { get; set; }
    public double Return5 { get; set; }
    public double Return20 { get; set; }
    public double Rsi14 { get; set; }
    public double AtrPct { get; set; }
    public double Position120 { get; set; }
    public double VolumeRatio5To20 { get; set; } = 1;
    public double High20 { get; set; }
    public double Low10 { get; set; }
    public double DistanceToBreakout { get; set; }
    public bool IsBreakout { get; set; }
    public bool IsAccumulating { get; set; }
    public bool IsBullAlignment { get; set; }
    public double MainFlow3d { get; set; }
    public double MainFlow5d { get; set; }
    public double TriggerPrice { get; set; }
    public double SupportPrice { get; set; }
    public double InvalidationPrice { get; set; }
}

public sealed record NewsRaw(
    DateTime Time,
    string Title,
    string Summary,
    string Url,
    int Score,
    List<string> Tags);
