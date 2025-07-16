using Microsoft.AspNetCore.SignalR;
using System.Collections.Concurrent;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);

// افزودن سرویس‌ها
builder.Services.AddSignalR(options =>
{
    options.EnableDetailedErrors = true;
    options.MaximumReceiveMessageSize = 1024 * 1024; // 1MB
    options.ClientTimeoutInterval = TimeSpan.FromSeconds(60);
    options.KeepAliveInterval = TimeSpan.FromSeconds(30);
});

// CORS برای اجازه ارتباط از دامنه‌های مختلف
builder.Services.AddCors(options =>
{
    options.AddPolicy("MafiaGamePolicy", policy =>
    {
        policy.AllowAnyHeader()
              .AllowAnyMethod()
              .SetIsOriginAllowed(_ => true)
              .AllowCredentials();
    });
});

var app = builder.Build();

// Middleware
app.UseCors("MafiaGamePolicy");
app.UseDefaultFiles();
app.UseStaticFiles();

// Map SignalR Hub
app.MapHub<GameHub>("/gameHub");

app.Run();

// ==================== کلاس‌های مدل ====================
public class Player
{
    public string ConnectionId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public string? Role { get; set; }
    public bool IsAlive { get; set; } = true;
    public bool IsReady { get; set; } = false;
    public DateTime JoinedAt { get; set; } = DateTime.UtcNow;
}

public class Room
{
    public string Code { get; set; } = string.Empty;
    public string CreatorId { get; set; } = string.Empty;
    public Dictionary<string, Player> Players { get; set; } = new();
    public RoomSettings Settings { get; set; } = new();
    public GameState GameState { get; set; } = new();
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public class RoomSettings
{
    public int MinPlayers { get; set; } = 4;
    public string GameTheme { get; set; } = "classic";
    public string GameMaster { get; set; } = "auto";
    public bool VideoEnabled { get; set; } = true;
    public bool AudioEnabled { get; set; } = true;
    public string VideoQuality { get; set; } = "medium";
    public Dictionary<string, int> Roles { get; set; } = new();
}

public class GameState
{
    public bool IsStarted { get; set; }
    public string Phase { get; set; } = "waiting"; // waiting, day, night, voting, defense
    public DateTime PhaseStartTime { get; set; }
    public int PhaseTimeLimit { get; set; } // seconds
    public string? GameMasterId { get; set; }
}

// ==================== SignalR Hub ====================
public class GameHub : Hub
{
    // ذخیره‌سازی اتاق‌ها و بازیکنان در حافظه
    private static readonly ConcurrentDictionary<string, Room> Rooms = new();
    private static readonly ConcurrentDictionary<string, string> ConnectionToRoom = new();
    private static readonly Random random = new();

    // ==================== اتصال و قطع اتصال ====================
    public override async Task OnConnectedAsync()
    {
        await Clients.Caller.SendAsync("Connected", Context.ConnectionId);
        Console.WriteLine($"🔌 بازیکن {Context.ConnectionId} متصل شد");
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        Console.WriteLine($"🔌 بازیکن {Context.ConnectionId} قطع شد");
        
        // پیدا کردن اتاق بازیکن
        if (ConnectionToRoom.TryGetValue(Context.ConnectionId, out var roomCode))
        {
            await HandlePlayerDisconnect(roomCode);
        }
        
        await base.OnDisconnectedAsync(exception);
    }

    // ==================== ساخت اتاق ====================
    public async Task CreateRoom(string playerName)
    {
        try
        {
            // تولید کد یکتا برای اتاق
            var roomCode = GenerateRoomCode();
            
            // ساخت اتاق جدید
            var room = new Room
            {
                Code = roomCode,
                CreatorId = Context.ConnectionId,
                Players = new Dictionary<string, Player>
                {
                    [Context.ConnectionId] = new Player
                    {
                        ConnectionId = Context.ConnectionId,
                        Name = playerName,
                        IsReady = true
                    }
                }
            };
            
            // ذخیره اتاق
            Rooms[roomCode] = room;
            ConnectionToRoom[Context.ConnectionId] = roomCode;
            
            // اضافه کردن به گروه SignalR
            await Groups.AddToGroupAsync(Context.ConnectionId, roomCode);
            
            // اطلاع به کاربر
            await Clients.Caller.SendAsync("RoomCreated", roomCode);
            
            Console.WriteLine($"✅ اتاق {roomCode} توسط {playerName} ساخته شد");
        }
        catch (Exception ex)
        {
            await Clients.Caller.SendAsync("Error", $"خطا در ساخت اتاق: {ex.Message}");
        }
    }

    // ==================== ورود به اتاق ====================
    public async Task JoinRoom(string roomCode, string playerName)
    {
        try
        {
            // بررسی وجود اتاق
            if (!Rooms.TryGetValue(roomCode.ToUpper(), out var room))
            {
                await Clients.Caller.SendAsync("Error", "اتاق یافت نشد");
                return;
            }
            
            // بررسی ظرفیت اتاق
            if (room.Players.Count >= 12)
            {
                await Clients.Caller.SendAsync("Error", "اتاق پر است");
                return;
            }
            
            // بررسی نام تکراری
            if (room.Players.Values.Any(p => p.Name == playerName))
            {
                await Clients.Caller.SendAsync("Error", "این نام قبلا استفاده شده");
                return;
            }
            
            // اضافه کردن بازیکن
            var player = new Player
            {
                ConnectionId = Context.ConnectionId,
                Name = playerName
            };
            
            room.Players[Context.ConnectionId] = player;
            ConnectionToRoom[Context.ConnectionId] = roomCode;
            
            // اضافه به گروه
            await Groups.AddToGroupAsync(Context.ConnectionId, roomCode);
            
            // ارسال لیست بازیکنان موجود به کاربر جدید
            var existingPlayers = room.Players.Values
                .Where(p => p.ConnectionId != Context.ConnectionId)
                .Select(p => new { p.ConnectionId, p.Name, p.IsReady })
                .ToList();
            
            await Clients.Caller.SendAsync("ExistingPlayers", existingPlayers);
            
            // اطلاع به سایر بازیکنان
            await Clients.OthersInGroup(roomCode).SendAsync("PlayerJoined", 
                Context.ConnectionId, playerName);
            
            Console.WriteLine($"👤 {playerName} وارد اتاق {roomCode} شد");
        }
        catch (Exception ex)
        {
            await Clients.Caller.SendAsync("Error", $"خطا در ورود به اتاق: {ex.Message}");
        }
    }

    // ==================== بازگشت به اتاق ====================
    public async Task RejoinRoom(string roomCode, string playerName)
    {
        try
        {
            if (Rooms.TryGetValue(roomCode, out var room))
            {
                // بروزرسانی connection id
                var oldPlayer = room.Players.Values.FirstOrDefault(p => p.Name == playerName);
                if (oldPlayer != null)
                {
                    room.Players.Remove(oldPlayer.ConnectionId);
                    oldPlayer.ConnectionId = Context.ConnectionId;
                    room.Players[Context.ConnectionId] = oldPlayer;
                    ConnectionToRoom[Context.ConnectionId] = roomCode;
                    
                    await Groups.AddToGroupAsync(Context.ConnectionId, roomCode);
                    await Clients.Caller.SendAsync("RejoinedRoom", room);
                    
                    Console.WriteLine($"🔄 {playerName} دوباره به اتاق {roomCode} پیوست");
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"خطا در بازگشت به اتاق: {ex.Message}");
        }
    }

    // ==================== بروزرسانی تنظیمات ====================
    public async Task UpdateRoomSettings(string roomCode, RoomSettings settings)
    {
        try
        {
            if (Rooms.TryGetValue(roomCode, out var room))
            {
                // فقط سازنده اتاق می‌تواند تنظیمات را تغییر دهد
                if (room.CreatorId != Context.ConnectionId)
                {
                    await Clients.Caller.SendAsync("Error", "فقط سازنده اتاق می‌تواند تنظیمات را تغییر دهد");
                    return;
                }
                
                room.Settings = settings;
                await Clients.Group(roomCode).SendAsync("RoomSettingsUpdated", settings);
                
                Console.WriteLine($"⚙️ تنظیمات اتاق {roomCode} بروزرسانی شد");
            }
        }
        catch (Exception ex)
        {
            await Clients.Caller.SendAsync("Error", $"خطا در بروزرسانی تنظیمات: {ex.Message}");
        }
    }

    // ==================== ارسال پیام چت ====================
    public async Task SendMessage(string roomCode, string message)
    {
        try
        {
            if (Rooms.TryGetValue(roomCode, out var room) && 
                room.Players.TryGetValue(Context.ConnectionId, out var player))
            {
                await Clients.Group(roomCode).SendAsync("ReceiveMessage", 
                    player.Name, message, DateTime.UtcNow);
                
                Console.WriteLine($"💬 {player.Name}: {message}");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"خطا در ارسال پیام: {ex.Message}");
        }
    }

    // ==================== WebRTC Signaling ====================
    public async Task SendOffer(string roomCode, string targetConnectionId, string offer)
    {
        await Clients.Client(targetConnectionId).SendAsync("ReceiveOffer", 
            Context.ConnectionId, offer);
    }

    public async Task SendAnswer(string roomCode, string targetConnectionId, string answer)
    {
        await Clients.Client(targetConnectionId).SendAsync("ReceiveAnswer", 
            Context.ConnectionId, answer);
    }

    public async Task SendIceCandidate(string roomCode, string targetConnectionId, string candidate)
    {
        await Clients.Client(targetConnectionId).SendAsync("ReceiveIceCandidate", 
            Context.ConnectionId, candidate);
    }

    // ==================== شروع بازی ====================
    public async Task StartGame(string roomCode)
    {
        try
        {
            if (!Rooms.TryGetValue(roomCode, out var room))
                return;
            
            // بررسی حداقل بازیکن
            if (room.Players.Count < room.Settings.MinPlayers)
            {
                await Clients.Caller.SendAsync("Error", 
                    $"حداقل {room.Settings.MinPlayers} بازیکن نیاز است");
                return;
            }
            
            // تعیین نقش‌ها
            AssignRoles(room);
            
            // تعیین گرداننده بازی
            if (room.Settings.GameMaster == "player")
            {
                // انتخاب تصادفی یک بازیکن به عنوان گرداننده
                var gameMaster = room.Players.Values.ElementAt(random.Next(room.Players.Count));
                room.GameState.GameMasterId = gameMaster.ConnectionId;
            }
            
            // بروزرسانی وضعیت بازی
            room.GameState.IsStarted = true;
            room.GameState.Phase = "night";
            room.GameState.PhaseStartTime = DateTime.UtcNow;
            
            // ارسال اطلاعات به بازیکنان
            foreach (var player in room.Players.Values)
            {
                var gameData = new
                {
                    role = player.Role,
                    isGameMaster = player.ConnectionId == room.GameState.GameMasterId
                };
                
                await Clients.Client(player.ConnectionId).SendAsync("GameStarted", gameData);
            }
            
            // شروع فاز شب
            await Clients.Group(roomCode).SendAsync("PhaseChanged", "night", 180); // 3 دقیقه
            
            Console.WriteLine($"🎮 بازی در اتاق {roomCode} شروع شد");
        }
        catch (Exception ex)
        {
            await Clients.Caller.SendAsync("Error", $"خطا در شروع بازی: {ex.Message}");
        }
    }

    // ==================== تعیین نقش‌ها ====================
    private void AssignRoles(Room room)
    {
        var players = room.Players.Values.ToList();
        var roles = new List<string>();
        
        // اضافه کردن نقش‌ها بر اساس تنظیمات
        var roleSettings = room.Settings.Roles;
        
        // مافیا
        var mafiaCount = Math.Max(1, players.Count / 3); // یک سوم بازیکنان
        for (int i = 0; i < mafiaCount; i++)
            roles.Add("مافیا");
        
        // نقش‌های ویژه
        if (players.Count >= 6)
        {
            roles.Add("دکتر");
            roles.Add("کارآگاه");
        }
        
        if (players.Count >= 8 && roleSettings.GetValueOrDefault("sniper", 0) > 0)
        {
            roles.Add("تک‌تیرانداز");
        }
        
        // مابقی شهروند
        while (roles.Count < players.Count)
        {
            roles.Add("شهروند");
        }
        
        // تصادفی‌سازی و تخصیص
        roles = roles.OrderBy(x => random.Next()).ToList();
        
        for (int i = 0; i < players.Count; i++)
        {
            players[i].Role = roles[i];
        }
    }

    // ==================== تغییر فاز بازی ====================
    public async Task ChangePhase(string roomCode, string phase)
    {
        try
        {
            if (Rooms.TryGetValue(roomCode, out var room))
            {
                room.GameState.Phase = phase;
                room.GameState.PhaseStartTime = DateTime.UtcNow;
                
                // تعیین زمان هر فاز
                int duration = phase switch
                {
                    "day" => 300,      // 5 دقیقه
                    "night" => 180,    // 3 دقیقه
                    "voting" => 120,   // 2 دقیقه
                    "defense" => 60,   // 1 دقیقه
                    _ => 0
                };
                
                await Clients.Group(roomCode).SendAsync("PhaseChanged", phase, duration);
                
                Console.WriteLine($"🌙 فاز بازی در اتاق {roomCode} تغییر کرد به: {phase}");
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"خطا در تغییر فاز: {ex.Message}");
        }
    }

    // ==================== ثبت رویداد بازی ====================
    public async Task LogGameEvent(string roomCode, string eventText)
    {
        try
        {
            if (Rooms.TryGetValue(roomCode, out var room))
            {
                var gameEvent = new
                {
                    message = eventText,
                    icon = "📢",
                    timestamp = DateTime.UtcNow
                };
                
                await Clients.Group(roomCode).SendAsync("GameEvent", gameEvent);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"خطا در ثبت رویداد: {ex.Message}");
        }
    }

    // ==================== اخراج بازیکن ====================
    public async Task KickPlayer(string roomCode, string playerId)
    {
        try
        {
            if (Rooms.TryGetValue(roomCode, out var room))
            {
                // فقط گرداننده یا سازنده می‌تواند اخراج کند
                if (Context.ConnectionId != room.CreatorId && 
                    Context.ConnectionId != room.GameState.GameMasterId)
                {
                    await Clients.Caller.SendAsync("Error", "شما اجازه اخراج ندارید");
                    return;
                }
                
                if (room.Players.TryGetValue(playerId, out var player))
                {
                    // حذف از اتاق
                    room.Players.Remove(playerId);
                    ConnectionToRoom.Remove(playerId, out _);
                    await Groups.RemoveFromGroupAsync(playerId, roomCode);
                    
                    // اطلاع به همه
                    await Clients.Group(roomCode).SendAsync("PlayerLeft", playerId);
                    await Clients.Client(playerId).SendAsync("Kicked", "شما از بازی اخراج شدید");
                    
                    Console.WriteLine($"❌ {player.Name} از اتاق {roomCode} اخراج شد");
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"خطا در اخراج بازیکن: {ex.Message}");
        }
    }

    // ==================== توابع کمکی ====================
    private string GenerateRoomCode()
    {
        const string chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        var code = new char[6];
        
        for (int i = 0; i < code.Length; i++)
        {
            code[i] = chars[random.Next(chars.Length)];
        }
        
        var roomCode = new string(code);
        
        // بررسی یکتا بودن
        while (Rooms.ContainsKey(roomCode))
        {
            roomCode = GenerateRoomCode();
        }
        
        return roomCode;
    }

    private async Task HandlePlayerDisconnect(string roomCode)
    {
        try
        {
            if (Rooms.TryGetValue(roomCode, out var room))
            {
                if (room.Players.TryGetValue(Context.ConnectionId, out var player))
                {
                    // در حالت بازی، بازیکن را نگه می‌داریم (برای reconnect)
                    if (room.GameState.IsStarted)
                    {
                        await Clients.OthersInGroup(roomCode).SendAsync("UpdatePlayerStatus", 
                            Context.ConnectionId, "disconnected");
                    }
                    else
                    {
                        // حذف بازیکن اگر بازی شروع نشده
                        room.Players.Remove(Context.ConnectionId);
                        ConnectionToRoom.Remove(Context.ConnectionId, out _);
                        
                        await Clients.OthersInGroup(roomCode).SendAsync("PlayerLeft", 
                            Context.ConnectionId);
                        
                        // حذف اتاق اگر خالی شد
                        if (room.Players.Count == 0)
                        {
                            Rooms.Remove(roomCode, out _);
                            Console.WriteLine($"🗑️ اتاق {roomCode} حذف شد");
                        }
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine($"خطا در مدیریت قطع اتصال: {ex.Message}");
        }
    }
}
