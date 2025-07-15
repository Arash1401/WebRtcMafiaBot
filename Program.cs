using Microsoft.AspNetCore.SignalR;
using Telegram.Bot;
using Telegram.Bot.Types;
using Telegram.Bot.Types.Enums;
using Telegram.Bot.Types.ReplyMarkups;

var builder = WebApplication.CreateBuilder(args);

// Services
builder.Services.AddSignalR();
builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowAll", policy =>
    {
        policy.AllowAnyOrigin()
              .AllowAnyMethod()
              .AllowAnyHeader();
    });
});

// Bot Token از Environment Variable
var botToken = Environment.GetEnvironmentVariable("TELEGRAM_BOT_TOKEN");
if (string.IsNullOrEmpty(botToken))
{
    var botToken ="7583651902:AAEdGhbNr9QjeNNYhvApa4jlphfDDu2C-fs";
}

Console.WriteLine($"✅ Bot token loaded: {botToken.Substring(0, 10)}...");

builder.Services.AddSingleton<ITelegramBotClient>(new TelegramBotClient(botToken));
builder.Services.AddHostedService<MafiaBotService>();

var app = builder.Build();

// Middleware
app.UseCors("AllowAll");
app.UseStaticFiles();
app.UseRouting();

app.MapHub<GameHub>("/gameHub");

// Port از Railway (پیش‌فرض 8080)
var port = Environment.GetEnvironmentVariable("PORT") ?? "8080";
Console.WriteLine($"🚀 Starting server on port {port}");
app.Run($"http://0.0.0.0:{port}");

// GameHub - مدیریت WebRTC و بازی
public class GameHub : Hub
{
    private static Dictionary<string, GameRoom> _rooms = new();
    
    public async Task JoinRoom(string roomId, string username)
    {
        if (!_rooms.ContainsKey(roomId))
            _rooms[roomId] = new GameRoom();
            
        var room = _rooms[roomId];
        var player = new Player 
        { 
            ConnectionId = Context.ConnectionId,
            Username = username
        };
        
        room.Players.Add(player);
        await Groups.AddToGroupAsync(Context.ConnectionId, roomId);
        
        // اطلاع به بقیه
        await Clients.Group(roomId).SendAsync("PlayerJoined", player);
        
        // ارسال لیست بازیکنان فعلی
        await Clients.Caller.SendAsync("RoomUpdate", room.Players);
    }
    
    // WebRTC Signaling
    public async Task SendOffer(string roomId, string targetId, object offer)
    {
        await Clients.Client(targetId).SendAsync("ReceiveOffer", Context.ConnectionId, offer);
    }
    
    public async Task SendAnswer(string roomId, string targetId, object answer)
    {
        await Clients.Client(targetId).SendAsync("ReceiveAnswer", Context.ConnectionId, answer);
    }
    
    public async Task SendIceCandidate(string roomId, string targetId, object candidate)
    {
        await Clients.Client(targetId).SendAsync("ReceiveIceCandidate", Context.ConnectionId, candidate);
    }
    
    // Chat
    public async Task SendMessage(string roomId, string message)
    {
        var room = _rooms[roomId];
        var player = room.Players.FirstOrDefault(p => p.ConnectionId == Context.ConnectionId);
        
        if (player != null && player.CanSpeak)
        {
            await Clients.Group(roomId).SendAsync("ReceiveMessage", player.Username, message);
        }
    }
    
    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        foreach (var room in _rooms.Values)
        {
            room.Players.RemoveAll(p => p.ConnectionId == Context.ConnectionId);
        }
        await base.OnDisconnectedAsync(exception);
    }
}

// کلاس‌های کمکی
public class GameRoom
{
    public List<Player> Players { get; set; } = new();
    public GamePhase Phase { get; set; } = GamePhase.Waiting;
    public List<string> DeadPlayers { get; set; } = new();
}

public class Player
{
    public string ConnectionId { get; set; } = "";
    public string Username { get; set; } = "";
    public Role Role { get; set; } = Role.None;
    public bool IsAlive { get; set; } = true;
    public bool CanSpeak { get; set; } = true;
}

public enum GamePhase { Waiting, Night, Day, Voting }
public enum Role { None, Mafia, Citizen, Doctor, Detective }

// Bot Service
public class MafiaBotService : BackgroundService
{
    private readonly ITelegramBotClient _bot;
    private static Dictionary<long, string> _activeGames = new();
    
    public MafiaBotService(ITelegramBotClient bot)
    {
        _bot = bot;
    }
    
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            var me = await _bot.GetMeAsync(stoppingToken);
            Console.WriteLine($"✅ Bot @{me.Username} started successfully!");
            
            _bot.StartReceiving(HandleUpdate, HandleError, cancellationToken: stoppingToken);
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (Exception ex)
        {
            Console.WriteLine($"❌ Failed to start bot: {ex.Message}");
            throw;
        }
    }
    
    private async Task HandleUpdate(ITelegramBotClient bot, Update update, CancellationToken ct)
    {
        if (update.Type == UpdateType.Message && update.Message?.Text != null)
        {
            var message = update.Message;
            var chatId = message.Chat.Id;
            
            Console.WriteLine($"📩 Received: {message.Text} from {message.From?.Username}");
            
            if (message.Text == "/start")
            {
                // APP_URL از Environment Variable
                var appUrl = Environment.GetEnvironmentVariable("APP_URL");
                if (string.IsNullOrEmpty(appUrl))
                {
                    await bot.SendTextMessageAsync(
                        chatId,
                        "⚠️ بازی هنوز آماده نیست! لطفاً بعداً امتحان کنید.",
                        cancellationToken: ct
                    );
                    Console.WriteLine("❌ APP_URL not configured!");
                    return;
                }
                
                var gameUrl = $"{appUrl}/index.html";
                var keyboard = new InlineKeyboardMarkup(new[]
                {
                    new[] { InlineKeyboardButton.WithWebApp("🎮 شروع بازی", new WebAppInfo { Url = gameUrl }) }
                });
                
                await bot.SendTextMessageAsync(
                    chatId,
                    "🎭 *بازی مافیا با ویدیو چت*\n\n" +
                    "برای شروع بازی روی دکمه زیر کلیک کنید:",
                    parseMode: ParseMode.Markdown,
                    replyMarkup: keyboard,
                    cancellationToken: ct
                );
                
                Console.WriteLine($"✅ Sent game link to {message.From?.Username}");
            }
        }
    }
    
    private Task HandleError(ITelegramBotClient bot, Exception ex, CancellationToken ct)
    {
        Console.WriteLine($"❌ Telegram Error: {ex.Message}");
        return Task.CompletedTask;
    }
}
