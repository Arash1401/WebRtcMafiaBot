// متغیرهای اصلی
let connection = null;
let localStream = null;
let peerConnections = {};
let currentRoom = null;
let playerName = null;
let isReconnecting = false;
let unreadMessages = 0;

// تنظیمات ICE
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10
};

// سیستم لاگ در صفحه
function debugLog(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    console.log(`[${type}] ${message}`);
    
    const debugPanel = document.getElementById('debugLogs');
    if (debugPanel) {
        const logElement = document.createElement('div');
        logElement.className = `debug-log ${type}`;
        logElement.textContent = `[${time}] ${message}`;
        debugPanel.appendChild(logElement);
        debugPanel.scrollTop = debugPanel.scrollHeight;
    }
}

// ایجاد اتصال SignalR
async function initializeConnection() {
    try {
        debugLog('🔌 شروع اتصال SignalR...', 'info');
        
        connection = new signalR.HubConnectionBuilder()
            .withUrl(`${window.location.origin}/gameHub`)
            .withAutomaticReconnect([0, 1000, 2000, 5000, 10000])
            .configureLogging(signalR.LogLevel.Information)
            .build();

        // Event handlers
        connection.on("ReceiveMessage", handleReceiveMessage);
        connection.on("PlayerJoined", handlePlayerJoined);
        connection.on("PlayerLeft", handlePlayerLeft);
        connection.on("ReceiveOffer", handleOffer);
        connection.on("ReceiveAnswer", handleAnswer);
        connection.on("ReceiveIceCandidate", handleIceCandidate);
        connection.on("GameStarted", handleGameStarted);
        connection.on("PhaseChanged", handlePhaseChanged);
        connection.on("ExistingPlayers", handleExistingPlayers);

        // Connection events
        connection.onreconnecting(() => {
            debugLog('🔄 در حال اتصال مجدد...', 'warn');
            updateStatus("در حال اتصال...", "#FF9800");
            isReconnecting = true;
        });

        connection.onreconnected(() => {
            debugLog('✅ اتصال مجدد برقرار شد!', 'success');
            updateStatus("متصل", "#4CAF50");
            isReconnecting = false;
            
            if (currentRoom && playerName) {
                connection.invoke("JoinRoom", currentRoom, playerName);
            }
        });

        connection.onclose(() => {
            debugLog('❌ اتصال قطع شد!', 'error');
            updateStatus("قطع شده", "#ff5252");
            isReconnecting = false;
            
            setTimeout(() => {
                if (!connection || connection.state === signalR.HubConnectionState.Disconnected) {
                    initializeConnection();
                }
            }, 3000);
        });

        await connection.start();
        debugLog('✅ اتصال SignalR برقرار شد!', 'success');
        updateStatus("متصل", "#4CAF50");
        return true;
    } catch (err) {
        debugLog(`❌ خطای اتصال: ${err}`, 'error');
        updateStatus("خطا", "#ff5252");
        return false;
    }
}

// بروزرسانی وضعیت
function updateStatus(text, color) {
    const statusBadge = document.getElementById('connectionStatus');
    if (statusBadge) {
        statusBadge.textContent = text;
        statusBadge.style.background = color;
    }
}

// دسترسی به دوربین
async function getLocalStream() {
    try {
        debugLog('📷 درخواست دسترسی به دوربین...', 'info');
        
        const constraints = {
            video: {
                width: { ideal: 640, max: 1280 },
                height: { ideal: 480, max: 720 },
                facingMode: 'user'
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        };

        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        const localVideo = document.getElementById('localVideo');
        if (localVideo) {
            localVideo.srcObject = localStream;
            localVideo.muted = true;
        }
        
        debugLog('✅ دوربین فعال شد!', 'success');
        return true;
    } catch (err) {
        debugLog(`❌ خطای دوربین: ${err.message}`, 'error');
        
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            debugLog('🎤 فقط میکروفون فعال شد', 'info');
            return true;
        } catch (audioErr) {
            debugLog('❌ خطای میکروفون!', 'error');
            alert('دسترسی به دوربین/میکروفون رد شد!');
            return false;
        }
    }
}

// ورود به بازی
async function joinGame() {
    playerName = document.getElementById('playerName').value.trim();
    currentRoom = document.getElementById('roomCode').value.trim();

    if (!playerName || !currentRoom) {
        alert('نام و کد اتاق را وارد کنید!');
        return;
    }

    // نمایش کد اتاق
    document.getElementById('roomCodeDisplay').textContent = currentRoom;

    // دوربین
    const cameraOk = await getLocalStream();
    if (!cameraOk) return;

    // SignalR
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
        const connected = await initializeConnection();
        if (!connected) {
            alert('خطا در اتصال به سرور!');
            return;
        }
    }

    try {
        await connection.invoke("JoinRoom", currentRoom, playerName);
        debugLog(`✅ وارد اتاق ${currentRoom} شدید`, 'success');
        
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('gameScreen').style.display = 'block';
    } catch (err) {
        debugLog(`❌ خطای ورود: ${err}`, 'error');
        alert('خطا در ورود به اتاق!');
    }
}

// هندل بازیکنان موجود
function handleExistingPlayers(players) {
    debugLog(`👥 ${players.length} بازیکن در اتاق`, 'info');
    
    players.forEach((player, index) => {
        if (player.connectionId !== connection.connectionId) {
            addPlayerToTable(player.connectionId, player.name);
            
            setTimeout(() => {
                createPeerConnection(player.connectionId, true);
            }, 500 * index);
        }
    });
}

// اضافه کردن بازیکن به میز
function addPlayerToTable(playerId, playerName) {
    const playersCircle = document.getElementById('playersCircle');
    
    if (document.getElementById(`seat-${playerId}`)) return;
    
    const playerSeat = document.createElement('div');
    playerSeat.className = 'player-seat';
    playerSeat.id = `seat-${playerId}`;
    
    // محاسبه موقعیت دور میز
    const existingPlayers = playersCircle.querySelectorAll('.player-seat').length;
    const angle = (existingPlayers * 360 / 8) - 90; // حداکثر 8 بازیکن
    const radius = 40; // درصد
    
    const x = 50 + radius * Math.cos(angle * Math.PI / 180);
    const y = 50 + radius * Math.sin(angle * Math.PI / 180);
    
    playerSeat.style.left = `${x}%`;
    playerSeat.style.top = `${y}%`;
    playerSeat.style.transform = 'translate(-50%, -50%)';
    
    playerSeat.innerHTML = `
        <div class="video-circle" onclick="toggleVideoSize(this)">
            <video id="video-${playerId}" autoplay playsinline></video>
            <div class="status-dot" id="status-${playerId}"></div>
        </div>
        <span class="player-name">${playerName}</span>
    `;
    
    playersCircle.appendChild(playerSeat);
    debugLog(`✅ ${playerName} به میز اضافه شد`, 'success');
}

// ورود بازیکن جدید
async function handlePlayerJoined(playerId, playerName) {
    if (playerId === connection.connectionId) return;
    
    debugLog(`👤 ${playerName} وارد شد`, 'info');
    addPlayerToTable(playerId, playerName);
}

// خروج بازیکن
function handlePlayerLeft(playerId) {
    debugLog(`👋 بازیکن ${playerId} خارج شد`, 'info');
    
    if (peerConnections[playerId]) {
        peerConnections[playerId].close();
        delete peerConnections[playerId];
    }
    
    const seat = document.getElementById(`seat-${playerId}`);
    if (seat) seat.remove();
}

// ایجاد Peer Connection
async function createPeerConnection(peerId, isInitiator = false) {
    debugLog(`🔧 ایجاد اتصال با ${peerId}`, 'info');
    
    if (peerConnections[peerId]) {
        peerConnections[peerId].close();
        delete peerConnections[peerId];
    }

    try {
        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[peerId] = pc;

        // اضافه کردن tracks
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
            });
        }

        // دریافت stream
        pc.ontrack = (event) => {
            debugLog(`📹 دریافت ${event.track.kind} از ${peerId}`, 'success');
            
            const video = document.getElementById(`video-${peerId}`);
            if (video && event.streams[0]) {
                video.srcObject = event.streams[0];
            }
        };

        // ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate && connection.state === signalR.HubConnectionState.Connected) {
                connection.invoke("SendIceCandidate", currentRoom, peerId, 
                    JSON.stringify(event.candidate));
            }
        };

        // Connection state
        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            debugLog(`📡 ${peerId}: ${state}`, state === 'connected' ? 'success' : 'info');
            updatePeerStatus(peerId, state);
            
            if (state === 'failed') {
                setTimeout(() => createPeerConnection(peerId, true), 3000);
            }
        };

        // Create offer
        if (isInitiator) {
            setTimeout(async () => {
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    
                    await connection.invoke("SendOffer", currentRoom, peerId, 
                        JSON.stringify(offer));
                    debugLog(`📤 Offer ارسال شد به ${peerId}`, 'info');
                } catch (err) {
                    debugLog(`❌ خطای Offer: ${err}`, 'error');
                }
            }, 1000);
        }

        return pc;
    } catch (err) {
        debugLog(`❌ خطای ایجاد PC: ${err}`, 'error');
    }
}

// دریافت Offer
async function handleOffer(fromId, offer) {
    debugLog(`📥 Offer از ${fromId}`, 'info');
    
    try {
        let pc = peerConnections[fromId];
        if (!pc) {
            pc = await createPeerConnection(fromId, false);
        }
        
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(offer)));
        
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        await connection.invoke("SendAnswer", currentRoom, fromId, 
            JSON.stringify(answer));
        debugLog(`✅ Answer ارسال شد به ${fromId}`, 'success');
    } catch (err) {
        debugLog(`❌ خطای Offer: ${err}`, 'error');
    }
}

// دریافت Answer
async function handleAnswer(fromId, answer) {
    debugLog(`📥 Answer از ${fromId}`, 'info');
    
    try {
        const pc = peerConnections[fromId];
        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(answer)));
            debugLog(`✅ Answer تنظیم شد برای ${fromId}`, 'success');
        }
    } catch (err) {
        debugLog(`❌ خطای Answer: ${err}`, 'error');
    }
}

// دریافت ICE Candidate
async function handleIceCandidate(fromId, candidate) {
    try {
        const pc = peerConnections[fromId];
        if (pc) {
            await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(candidate)));
        }
    } catch (err) {
        debugLog(`⚠️ ICE error: ${err}`, 'warn');
    }
}

// بروزرسانی وضعیت peer
function updatePeerStatus(peerId, state) {
    const statusDot = document.getElementById(`status-${peerId}`);
    if (statusDot) {
        statusDot.className = 'status-dot ' + state;
    }
}

// شروع بازی
async function startGame() {
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
        alert('اتصال قطع است!');
        return;
    }
    
    debugLog('🎮 درخواست شروع بازی...', 'info');
    
    try {
        await connection.invoke("StartGame", currentRoom);
        document.getElementById('startGameBtn').style.display = 'none';
        debugLog('✅ درخواست شروع بازی ارسال شد', 'success');
    } catch (err) {
        debugLog(`❌ خطای شروع بازی: ${err}`, 'error');
        alert('خطا در شروع بازی!');
    }
}

// هندلرهای بازی
function handleGameStarted(roles) {
    debugLog('🎮 بازی شروع شد!', 'success');
    document.getElementById('gamePhase').textContent = 'بازی شروع شد!';
    
    if (roles[connection.connectionId]) {
        alert(`نقش شما: ${roles[connection.connectionId]}`);
    }
}

function handlePhaseChanged(phase) {
    debugLog(`🌙 فاز: ${phase}`, 'info');
    document.getElementById('gamePhase').textContent = `فاز: ${phase}`;
}

// چت
function toggleChat() {
    const chatPanel = document.getElementById('chatPanel');
    chatPanel.classList.toggle('collapsed');
    
    if (!chatPanel.classList.contains('collapsed')) {
        unreadMessages = 0;
        updateUnreadBadge();
    }
}

function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    
    if (message && connection?.state === signalR.HubConnectionState.Connected) {
        connection.invoke("SendMessage", currentRoom, message);
        input.value = '';
    }
}

function handleReceiveMessage(sender, message) {
    const messagesDiv = document.getElementById('messages');
    const messageElement = document.createElement('div');
    messageElement.className = 'message';
    messageElement.innerHTML = `<strong>${sender}:</strong> ${message}`;
    messagesDiv.appendChild(messageElement);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // اگر چت بسته است، unread اضافه کن
    const chatPanel = document.getElementById('chatPanel');
    if (chatPanel.classList.contains('collapsed')) {
        unreadMessages++;
        updateUnreadBadge();
    }
}

function updateUnreadBadge() {
    const badge = document.getElementById('unreadCount');
    if (unreadMessages > 0) {
        badge.textContent = unreadMessages;
        badge.style.display = 'block';
    } else {
        badge.style.display = 'none';
    }
}

// تغییر اندازه ویدیو
function toggleVideoSize(videoCircle) {
    const video = videoCircle.querySelector('video');
    const enlargedDiv = document.getElementById('enlargedVideo');
    const enlargedVideo = document.getElementById('enlargedVideoElement');
    
    if (video.srcObject) {
        enlargedVideo.srcObject = video.srcObject;
        enlargedDiv.style.display = 'flex';
    }
}

function closeEnlargedVideo() {
    document.getElementById('enlargedVideo').style.display = 'none';
}

// پنل دیباگ
function toggleDebugPanel() {
    const panel = document.getElementById('debugPanel');
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

function clearDebugLogs() {
    document.getElementById('debugLogs').innerHTML = '';
}

function debugConnections() {
    debugLog("=== وضعیت اتصالات ===", 'info');
    debugLog(`SignalR: ${connection?.state || 'قطع'}`, 'info');
    
    Object.entries(peerConnections).forEach(([id, pc]) => {
        debugLog(`${id}: ${pc.connectionState} | ICE: ${pc.iceConnectionState}`, 'info');
    });
}

function retryAllConnections() {
    debugLog('🔄 تلاش مجدد برای همه اتصالات...', 'warn');
    
    Object.keys(peerConnections).forEach(peerId => {
        const pc = peerConnections[peerId];
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            createPeerConnection(peerId, true);
        }
    });
}

// Full screen toggle
function toggleFullscreen() {
    if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
    } else {
        document.exitFullscreen();
    }
}

// Event listeners
document.addEventListener('DOMContentLoaded', () => {
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') sendMessage();
        });
    }
});

// Expose for debugging
window.debugConnections = debugConnections;
window.retryAllConnections = retryAllConnections;
