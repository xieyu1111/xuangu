using System.Text;
using System.Text.Json;

namespace StockRadar;

public static class SnapshotRunner
{
    public static async Task RunAsync(string outputPath, CancellationToken ct)
    {
        var fullPath = Path.GetFullPath(outputPath);
        var directory = Path.GetDirectoryName(fullPath) ?? Directory.GetCurrentDirectory();
        Directory.CreateDirectory(directory);

        DashboardPayload payload;
        try
        {
            var service = new DashboardService(new MarketDataClient(), directory);
            payload = await service.BuildSnapshotAsync(ct);
        }
        catch (Exception ex)
        {
            if (File.Exists(fullPath))
            {
                Console.Error.WriteLine($"Snapshot update failed; keeping the existing file. {ex.Message}");
                return;
            }
            throw;
        }

        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web)
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            WriteIndented = false
        };
        var json = JsonSerializer.Serialize(payload, options);
        var tempPath = fullPath + ".tmp";
        await File.WriteAllTextAsync(tempPath, json, new UTF8Encoding(false), ct);
        File.Move(tempPath, fullPath, true);
        Console.WriteLine($"Snapshot written: {fullPath}");
        Console.WriteLine($"Market date: {payload.MarketDate}; sectors: {payload.Sectors.Count}; picks: {payload.Picks.Count}");
    }
}

