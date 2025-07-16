// ===== تنظیمات اولیه =====
let connection = null;
let localStream = null;
let peerConnections = {};
let currentRoom = null;
let currentUsername = null;
let myRole = null;
let isAlive = true;

// WebRTC Config
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// ===== توابع اصلی =====

// شروع بازی
async function joinGame() {
    console.log("🎮 Starting join game process...");
    
    const username = document.getElementById('username').value.trim();
    const roomCode = document.getElementById('roomCode').value.trim();
    
    if (!username || !roomCode) {
        alert('❌ لطفا نام کاربری و کد اتاق را وارد کنید');
        return;
    }
    
    currentRoom = roomCode;
    currentUsername = username;
    
    console.log("📝 Room:", roomCode, "Username:", username);
    
    try {
        // 1. اتصال به SignalR
        await connectToHub();
        console.log("✅ SignalR connected!");
        
        // 2. دسترسی به دوربین
        await setupCamera();
        
        // 3. ورود به اتاق
        console.log("🚪 Joining room...");
        await connection.invoke("JoinRoom", roomCode, username);
        console.log("✅ JoinRoom invoked successfully!");
        
        // 4. تغییر صفحه
        document.getElementById('loginScreen').classList.remove('active');
        document.getElementById('gameScreen').classList.add('active');
        document.getElementById('roomInfo').textContent = `اتاق: ${roomCode}`;
        
    } catch (error) {
        console.error("❌ Error in joinGame:", error);
        alert('خطا در اتصال به بازی: ' + error.message);
    }
}

// اتصال به SignalR Hub
async function connectToHub() {
    console.log("🔌 Connecting to SignalR hub...");
    
    connection = new signalR.HubConnectionBuilder()
        .withUrl("/gameHub")
        .configureLogging(signalR.LogLevel.Information)
        .withAutomaticReconnect()
        .build();
    
    // تنظیم Event Handlers
    setupSignalRHandlers();
    
    // شروع اتصال
    try {
        await connection.start();
        console.log("✅ SignalR connection established!");
        console.log("📍 Connection ID:", connection.connectionId);
    } catch (err) {
        console.error("❌ SignalR connection failed:", err);
        throw err;
    }
    
    // مدیریت قطع اتصال
    connection.onclose(async () => {
        console.log("🔴 SignalR disconnected!");
        alert('اتصال قطع شد! در حال تلاش مجدد...');
    });
}

// تنظیم handlers برای SignalR
function setupSignalRHandlers() {
    console.log("📡 Setting up SignalR handlers...");
    
    // بازیکن جدید
    connection.on("PlayerJoined", (player) => {
        console.log("👤 Player joined:", player);
        handlePlayerJoined(player);
    });
    
    // آپدیت اتاق
    connection.on("RoomUpdate", (players) => {
        console.log("🔄 Room update:", players);
        updatePlayersList(players);
    });
    
    // پیام چت
    connection.on("ReceiveMessage", (username, message) => {
        console.log("💬 Message:", username, message);
        addChatMessage(username, message);
    });
    
    // WebRTC Signaling
    connection.on("ReceiveOffer", handleOffer);
    connection.on("ReceiveAnswer", handleAnswer);
    connection.on("ReceiveIceCandidate", handleIceCandidate);
    
    // بازی
    connection.on("GameStarted", handleGameStart);
    connection.on("PhaseChanged", handlePhaseChange);
}

// دسترسی به دوربین
async function setupCamera() {
    console.log("📹 Setting up camera...");
    
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        
        const localVideo = document.getElementById('localVideo');
        if (localVideo) {
            localVideo.srcObject = localStream;
            console.log("✅ Camera setup complete!");
        }
    } catch (err) {
        console.error("❌ Camera access denied:", err);
        // ادامه بدون دوربین
        localStream = null;
    }
}

// ===== مدیریت بازیکنان =====

// بازیکن جدید وارد شد
async function handlePlayerJoined(player) {
    if (player.connectionId === connection.connectionId) {
        console.log("👤 That's me, skipping...");
        return;
    }
    
    console.log("🤝 Setting up peer connection for:", player.username);
    
    try {
        // ساخت peer connection
        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[player.connectionId] = pc;
        
        // اضافه کردن local stream
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }
        
        // دریافت remote stream
        pc.ontrack = (event) => {
            console.log("📺 Received remote stream from:", player.username);
            addVideoElement(player.connectionId, player.username, event.streams[0]);
        };
        
        // ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                connection.invoke("SendIceCandidate", currentRoom, player.connectionId, event.candidate);
            }
        };
        
        // ساخت offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await connection.invoke("SendOffer", currentRoom, player.connectionId, offer);
        
        console.log("✅ Offer sent to:", player.username);
        
    } catch (error) {
        console.error("❌ Error in handlePlayerJoined:", error);
    }
}

// آپدیت لیست بازیکنان
function updatePlayersList(players) {
    console.log("📋 Updating players list:", players.length, "players");
    
    const playersDiv = document.getElementById('players');
    if (!playersDiv) return;
    
    playersDiv.innerHTML = '<h4>بازیکنان:</h4>';
    
    players.forEach(player => {
        const playerDiv = document.createElement('div');
        playerDiv.className = 'player-item';
        playerDiv.textContent = player.username;
        playerDiv.id = 'player-' + player.connectionId;
        playersDiv.appendChild(playerDiv);
    });
}

// ===== ویدیو =====

// اضافه کردن ویدیو
function addVideoElement(connectionId, username, stream) {
    console.log("🎥 Adding video for:", username);
    
    // چک کن قبلا اضافه نشده باشه
    if (document.getElementById(`video-${connectionId}`)) {
        console.log("Video already exists for:", username);
        return;
    }
    
    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = `video-${connectionId}`;
    
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    
    const label = document.createElement('div');
    label.className = 'video-label';
    label.textContent = username;
    
    container.appendChild(video);
    container.appendChild(label);
    
    const videoGrid = document.getElementById('videoGrid');
    if (videoGrid) {
        videoGrid.appendChild(container);
    }
}

// ===== WebRTC Handlers =====

async function handleOffer(senderId, offer) {
    console.log("📨 Received offer from:", senderId);
    
    try {
        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[senderId] = pc;
        
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }
        
        pc.ontrack = (event) => {
            console.log("📺 Received track in offer handler");
            // ویدیو در handlePlayerJoined اضافه میشه
        };
        
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                connection.invoke("SendIceCandidate", currentRoom, senderId, event.candidate);
            }
        };
        
        await pc.setRemoteDescription(offer);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await connection.invoke("SendAnswer", currentRoom, senderId, answer);
        
        console.log("✅ Answer sent!");
        
    } catch (error) {
        console.error("❌ Error in handleOffer:", error);
    }
}

async function handleAnswer(senderId, answer) {
    console.log("📨 Received answer from:", senderId);
    
    try {
        const pc = peerConnections[senderId];
        if (pc) {
            await pc.setRemoteDescription(answer);
            console.log("✅ Answer processed!");
        }
    } catch (error) {
        console.error("❌ Error in handleAnswer:", error);
    }
}

async function handleIceCandidate(senderId, candidate) {
    console.log("🧊 Received ICE candidate from:", senderId);
    
    try {
        const pc = peerConnections[senderId];
        if (pc) {
            await pc.addIceCandidate(candidate);
        }
    } catch (error) {
        console.error("❌ Error in handleIceCandidate:", error);
    }
}

// ===== چت =====

function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    
    if (message && connection && isAlive) {
        console.log("📤 Sending message:", message);
        connection.invoke("SendMessage", currentRoom, message)
            .catch(err => console.error("❌ Failed to send message:", err));
        input.value = '';
    }
}

function addChatMessage(username, message) {
    const messagesDiv = document.getElementById('messages');
    if (!messagesDiv) return;
    
    const messageEl = document.createElement('div');
    messageEl.className = 'message';
    messageEl.innerHTML = `<span class="username">${username}:</span> ${message}`;
    messagesDiv.appendChild(messageEl);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// ===== مدیریت بازی =====

function createRoom() {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    document.getElementById('roomCode').value = roomCode;
    alert(`کد اتاق شما: ${roomCode}`);
}

function handleGameStart(roles) {
    console.log("🎮 Game started! Roles:", roles);
    myRole = roles[connection.connectionId];
    
    const roleInfo = document.getElementById('roleInfo');
    if (roleInfo) {
        roleInfo.textContent = `نقش شما: ${translateRole(myRole)}`;
    }
    
    const startBtn = document.getElementById('startBtn');
    if (startBtn) {
        startBtn.style.display = 'none';
    }
}

function handlePhaseChange(phase) {
    console.log("🔄 Phase changed to:", phase);
    
    const phaseInfo = document.getElementById('phaseInfo');
    if (phaseInfo) {
        phaseInfo.textContent = `فاز: ${translatePhase(phase)}`;
    }
    
    if (phase === 'Night' && !isAlive) {
        const input = document.getElementById('messageInput');
        if (input) input.disabled = true;
    }
}

// ===== توابع کمکی =====

function translateRole(role) {
    const roles = {
        'Mafia': '🔫 مافیا',
        'Citizen': '👥 شهروند',
        'Doctor': '👨‍⚕️ دکتر',
        'Detective': '🕵️ کارآگاه'
    };
    return roles[role] || role;
}

function translatePhase(phase) {
    const phases = {
        'Waiting': '⏳ انتظار',
        'Night': '🌙 شب',
        'Day': '☀️ روز',
        'Voting': '🗳️ رای‌گیری'
    };
    return phases[phase] || phase;
}

// ===== Event Listeners =====

// Enter key برای چت
document.addEventListener('DOMContentLoaded', () => {
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });
    }
    
    console.log("✅ game.js loaded successfully!");
});

// Log version
console.log("🎮 Mafia Game v1.0 - Ready!");
