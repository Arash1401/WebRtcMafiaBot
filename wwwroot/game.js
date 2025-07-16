// اتصال SignalR
let connection = null;
let localStream = null;
let peerConnections = {};
let remoteStreams = {};
let currentRoom = null;
let playerName = null;

// تنظیمات ICE Servers با TURN سرور
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

// شروع اتصال
async function initializeConnection() {
    try {
        connection = new signalR.HubConnectionBuilder()
            .withUrl(`${window.location.origin}/gameHub`)
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

        await connection.start();
        console.log("✅ SignalR Connected!");
        
        return true;
    } catch (err) {
        console.error("❌ SignalR Connection Error:", err);
        return false;
    }
}

// دریافت دسترسی به دوربین - بهینه شده برای موبایل
async function getLocalStream() {
    try {
        // تنظیمات بهینه برای موبایل و دسکتاپ
        const constraints = {
            video: {
                width: { ideal: 640, max: 1280 },
                height: { ideal: 480, max: 720 },
                facingMode: 'user', // دوربین جلو برای موبایل
                frameRate: { ideal: 30, max: 30 }
            },
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true
            }
        };

        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // نمایش ویدیو محلی
        const localVideo = document.getElementById('localVideo');
        if (localVideo) {
            localVideo.srcObject = localStream;
            localVideo.muted = true; // جلوگیری از اکو
            
            // اطمینان از پخش ویدیو در موبایل
            localVideo.setAttribute('playsinline', '');
            localVideo.setAttribute('autoplay', '');
            
            try {
                await localVideo.play();
            } catch (e) {
                console.log("⚠️ Autoplay blocked, user needs to interact");
            }
        }
        
        console.log("✅ Camera access granted!");
        return true;
    } catch (err) {
        console.error("❌ Camera access error:", err);
        alert('خطا در دسترسی به دوربین: ' + err.message);
        return false;
    }
}

// ورود به بازی
async function joinGame() {
    playerName = document.getElementById('playerName').value.trim();
    currentRoom = document.getElementById('roomCode').value.trim();

    if (!playerName || !currentRoom) {
        alert('لطفا نام و کد اتاق را وارد کنید!');
        return;
    }

    // ابتدا اتصال SignalR
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
        const connected = await initializeConnection();
        if (!connected) {
            alert('خطا در اتصال به سرور!');
            return;
        }
    }

    // سپس دوربین
    const cameraOk = await getLocalStream();
    if (!cameraOk) {
        return;
    }

    // ورود به اتاق
    try {
        await connection.invoke("JoinRoom", currentRoom, playerName);
        console.log(`✅ Joined room: ${currentRoom}`);
        
        // نمایش صفحه بازی
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('gameScreen').style.display = 'block';
        
        // نمایش دکمه شروع بازی
        document.getElementById('startGameBtn').style.display = 'block';
    } catch (err) {
        console.error("❌ Join room error:", err);
        alert('خطا در ورود به اتاق: ' + err.toString());
    }
}

// هندل کردن ورود بازیکن جدید
async function handlePlayerJoined(playerId, playerName) {
    console.log(`👤 Player joined: ${playerName} (${playerId})`);
    
    if (!playerId || playerId === connection.connectionId) {
        return;
    }

    // اضافه کردن کادر ویدیو برای بازیکن جدید
    createVideoElement(playerId, playerName);
    
    // شروع peer connection با تاخیر کوتاه
    setTimeout(() => {
        createPeerConnection(playerId, true);
    }, 1000);
}

// ایجاد المان ویدیو برای بازیکن
function createVideoElement(playerId, playerName) {
    // بررسی وجود قبلی
    if (document.getElementById(`video-${playerId}`)) {
        return;
    }

    const videoContainer = document.createElement('div');
    videoContainer.className = 'video-container';
    videoContainer.id = `container-${playerId}`;

    const video = document.createElement('video');
    video.id = `video-${playerId}`;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false;
    video.onclick = () => toggleFullscreen(video);

    const nameLabel = document.createElement('div');
    nameLabel.className = 'player-name';
    nameLabel.textContent = playerName;

    videoContainer.appendChild(video);
    videoContainer.appendChild(nameLabel);
    
    document.getElementById('remoteVideos').appendChild(videoContainer);
    console.log(`✅ Video element created for ${playerName}`);
}

// ایجاد Peer Connection
async function createPeerConnection(peerId, isInitiator = false) {
    if (peerConnections[peerId]) {
        console.log(`⚠️ Peer connection already exists for ${peerId}`);
        return;
    }

    try {
        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[peerId] = pc;

        // اضافه کردن local stream
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
                console.log(`✅ Added ${track.kind} track to peer ${peerId}`);
            });
        }

        // دریافت remote stream
        pc.ontrack = (event) => {
            console.log(`📹 Received ${event.track.kind} track from ${peerId}`);
            
            if (!remoteStreams[peerId]) {
                remoteStreams[peerId] = new MediaStream();
            }
            
            remoteStreams[peerId].addTrack(event.track);
            
            const remoteVideo = document.getElementById(`video-${peerId}`);
            if (remoteVideo && remoteVideo.srcObject !== remoteStreams[peerId]) {
                remoteVideo.srcObject = remoteStreams[peerId];
                
                // اطمینان از پخش در موبایل
                remoteVideo.play().catch(e => {
                    console.error('❌ Video play error:', e);
                });
            }
        };

        // ارسال ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                console.log(`🧊 Sending ICE candidate to ${peerId}`);
                connection.invoke("SendIceCandidate", currentRoom, peerId, 
                    JSON.stringify(event.candidate));
            }
        };

        // مانیتور وضعیت اتصال
        pc.onconnectionstatechange = () => {
            console.log(`📡 Connection state for ${peerId}: ${pc.connectionState}`);
            updateConnectionStatus(peerId, pc.connectionState);
        };

        pc.oniceconnectionstatechange = () => {
            console.log(`🧊 ICE state for ${peerId}: ${pc.iceConnectionState}`);
        };

        // اگر initiator هستیم، offer بفرستیم
        if (isInitiator) {
            console.log(`📤 Creating offer for ${peerId}`);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            await connection.invoke("SendOffer", currentRoom, peerId, 
                JSON.stringify(offer));
        }

        return pc;
    } catch (err) {
        console.error(`❌ Error creating peer connection for ${peerId}:`, err);
    }
}

// دریافت Offer
async function handleOffer(fromId, offer) {
    console.log(`📥 Received offer from ${fromId}`);
    
    try {
        // ایجاد peer connection اگر وجود ندارد
        if (!peerConnections[fromId]) {
            await createPeerConnection(fromId, false);
        }
        
        const pc = peerConnections[fromId];
        if (!pc) return;

        // تنظیم remote description
        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(offer)));
        
        // ایجاد و ارسال answer
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        await connection.invoke("SendAnswer", currentRoom, fromId, 
            JSON.stringify(answer));
        
        console.log(`✅ Answer sent to ${fromId}`);
    } catch (err) {
        console.error(`❌ Error handling offer from ${fromId}:`, err);
    }
}

// دریافت Answer
async function handleAnswer(fromId, answer) {
    console.log(`📥 Received answer from ${fromId}`);
    
    try {
        const pc = peerConnections[fromId];
        if (!pc) {
            console.error(`❌ No peer connection for ${fromId}`);
            return;
        }

        await pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(answer)));
        console.log(`✅ Answer processed from ${fromId}`);
    } catch (err) {
        console.error(`❌ Error handling answer from ${fromId}:`, err);
    }
}

// دریافت ICE Candidate
async function handleIceCandidate(fromId, candidate) {
    try {
        const pc = peerConnections[fromId];
        if (!pc) {
            console.error(`❌ No peer connection for ${fromId}`);
            return;
        }

        await pc.addIceCandidate(new RTCIceCandidate(JSON.parse(candidate)));
        console.log(`✅ ICE candidate added from ${fromId}`);
    } catch (err) {
        console.error(`❌ Error handling ICE candidate from ${fromId}:`, err);
    }
}

// هندل خروج بازیکن
function handlePlayerLeft(playerId) {
    console.log(`👋 Player left: ${playerId}`);
    
    // بستن peer connection
    if (peerConnections[playerId]) {
        peerConnections[playerId].close();
        delete peerConnections[playerId];
    }
    
    // حذف stream
    delete remoteStreams[playerId];
    
    // حذف المان ویدیو
    const container = document.getElementById(`container-${playerId}`);
    if (container) {
        container.remove();
    }
}

// ارسال پیام
function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    
    if (message && connection && currentRoom) {
        connection.invoke("SendMessage", currentRoom, message)
            .catch(err => console.error('❌ Send message error:', err));
        input.value = '';
    }
}

// دریافت پیام
function handleReceiveMessage(sender, message) {
    const messagesDiv = document.getElementById('messages');
    const messageElement = document.createElement('div');
    messageElement.className = 'message';
    messageElement.innerHTML = `<strong>${sender}:</strong> ${message}`;
    messagesDiv.appendChild(messageElement);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// شروع بازی
function startGame() {
    if (!connection || !currentRoom) {
        alert('❌ ابتدا وارد اتاق شوید!');
        return;
    }
    
    console.log("🎮 Starting game...");
    connection.invoke("StartGame", currentRoom)
        .then(() => {
            console.log("✅ Game start requested!");
            document.getElementById('startGameBtn').style.display = 'none';
        })
        .catch(err => {
            console.error("❌ Failed to start game:", err);
            alert('خطا در شروع بازی: ' + err.toString());
        });
}

// هندل شروع بازی
function handleGameStarted(roles) {
    console.log("🎮 Game started! Roles:", roles);
    document.getElementById('gamePhase').textContent = 'بازی شروع شد!';
    // نمایش نقش بازیکن
    if (roles[connection.connectionId]) {
        alert(`نقش شما: ${roles[connection.connectionId]}`);
    }
}

// هندل تغییر فاز
function handlePhaseChanged(phase) {
    console.log(`🌙 Phase changed to: ${phase}`);
    document.getElementById('gamePhase').textContent = `فاز: ${phase}`;
}

// Fullscreen toggle
function toggleFullscreen(video) {
    if (!document.fullscreenElement) {
        video.requestFullscreen().catch(err => {
            console.error(`Error attempting to enable fullscreen: ${err.message}`);
        });
    } else {
        document.exitFullscreen();
    }
}

// نمایش وضعیت اتصال
function updateConnectionStatus(peerId, state) {
    const container = document.getElementById(`container-${peerId}`);
    if (container) {
        const statusBadge = container.querySelector('.connection-status') || 
            document.createElement('div');
        statusBadge.className = 'connection-status';
        statusBadge.textContent = state;
        
        // رنگ بندی بر اساس وضعیت
        switch(state) {
            case 'connected':
                statusBadge.style.backgroundColor = '#4CAF50';
                break;
            case 'connecting':
                statusBadge.style.backgroundColor = '#FF9800';
                break;
            case 'failed':
            case 'disconnected':
                statusBadge.style.backgroundColor = '#F44336';
                break;
        }
        
        if (!container.querySelector('.connection-status')) {
            container.appendChild(statusBadge);
        }
    }
}

// Debug connections
function debugConnections() {
    console.log("🔍 Debug Info:");
    console.log("Local Stream:", localStream);
    console.log("Peer Connections:", Object.keys(peerConnections));
    console.log("Remote Streams:", Object.keys(remoteStreams));
    
    Object.entries(peerConnections).forEach(([peerId, pc]) => {
        console.log(`Peer ${peerId}:`, {
            connectionState: pc.connectionState,
            iceConnectionState: pc.iceConnectionState,
            signalingState: pc.signalingState
        });
    });
}

// کلید Enter برای ارسال پیام
document.addEventListener('DOMContentLoaded', () => {
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                sendMessage();
            }
        });
    }
});

// Expose debug function
window.debugConnections = debugConnections;
