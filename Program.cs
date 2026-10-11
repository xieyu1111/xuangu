using System.Text.Json;
using StockRadar;

if (args.Length >= 2 && string.Equals(args[0], "--snapshot", StringComparison.OrdinalIgnoreCase))
{
    await SnapshotRunner.RunAsync(args[1], CancellationToken.None);
    return;
}

var builder = WebApplication.CreateBuilder(args);
builder.WebHost.UseUrls("http://0.0.0.0:5178");
builder.Services.ConfigureHttpJsonOptions(options =>
{
    options.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
    options.SerializerOptions.DictionaryKeyPolicy = JsonNamingPolicy.CamelCase;
});
builder.Services.AddSingleton<MarketDataClient>();
builder.Services.AddSingleton<DashboardService>();

var app = builder.Build();
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = context =>
    {
        if (context.File.Name.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
            context.Context.Response.Headers.CacheControl = "no-cache";
    }
});

app.MapGet("/api/health", () => Results.Ok(new { ok = true, time = DateTime.Now, service = "A股量价雷达" }));

app.MapGet("/api/dashboard", async (bool? refresh, DashboardService service, CancellationToken ct) =>
{
    try
    {
        var payload = await service.GetAsync(refresh == true, ct);
        return Results.Ok(payload);
    }
    catch (OperationCanceledException)
    {
        return Results.StatusCode(499);
    }
    catch (Exception ex)
    {
        return Results.Problem(
            title: "行情数据生成失败",
            detail: $"公开行情接口暂时不可用：{ex.Message}",
            statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});

app.MapFallbackToFile("index.html");
app.Run();

