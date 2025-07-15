// تنظیمات
const APP_URL = window.location.origin;
let connection = null;
let localStream = null;
let peerConnections = {};
let currentRoom = null;
let myRole = null;
let isAlive = true;

// WebRTC Config - استفاده از STUN رایگان گوگل
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ]
};

// اتصال به SignalR
async function connectToHub() {
    connection = new signalR.HubConnectionBuilder()
        .withUrl("/gameHub")
        .build();
    
    // Event Listeners
    connection.on("PlayerJoined", handlePlayerJoined);
    connection.on("RoomUpdate", handleRoomUpdate);
    connection.on("ReceiveMessage", handleMessage);
    connection.on("ReceiveOffer", handleOffer);
    connection.on("ReceiveAnswer", handleAnswer);
    connection.on("ReceiveIceCandidate", handleIceCandidate);
    connection.on("GameStarted", handleGameStart);
    connection.on("PhaseChanged", handlePhaseChange);
    
    await connection.start();
}

// ورود به بازی
async function joinGame() {
    const username = document.getElementById('username').value;
    const roomCode = document.getElementById('roomCode').value;
    
    if (!username || !roomCode) {
        alert('نام کاربری و کد اتاق را وارد کنید');
        return;
    }
    
    currentRoom = roomCode;
    
    // اتصال به SignalR
    await connectToHub();
    
    // درخواست دسترسی به دوربین
    try {
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });
        document.getElementById('localVideo').srcObject = localStream;
    } catch (err) {
        console.error('دسترسی به دوربین داده نشد:', err);
        // ادامه بدون ویدیو
    }
    
    // ورود به اتاق
    await connection.invoke("JoinRoom", roomCode, username);
    
    // تغییر صفحه
    document.getElementById('loginScreen').classList.remove('active');
    document.getElementById('gameScreen').classList.add('active');
    document.getElementById('roomInfo').textContent = `اتاق: ${roomCode}`;
}

// ساخت اتاق جدید
function createRoom() {
    const roomCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    document.getElementById('roomCode').value = roomCode;
    alert(`کد اتاق: ${roomCode}`);
}

// مدیریت بازیکن جدید
async function handlePlayerJoined(player) {
    if (player.connectionId === connection.connectionId) return;
    
    // ساخت peer connection
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[player.connectionId] = pc;
    
    // اضافه کردن stream محلی
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }
    
    // دریافت stream دیگران
    pc.ontrack = (event) => {
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
}

// اضافه کردن ویدیو
function addVideoElement(connectionId, username, stream) {
    const container = document.createElement('div');
    container.className = 'video-container';
    container.id = `video-${connectionId}`;
    
    const video = document.createElement('video');
    video.autoplay = true;
    video.srcObject = stream;
    
    const label = document.createElement('div');
    label.className = 'video-label';
    label.textContent = username;
    
    container.appendChild(video);
    container.appendChild(label);
    document.getElementById('videoGrid').appendChild(container);
}

// WebRTC Handlers
async function handleOffer(senderId, offer) {
    const pc = new RTCPeerConnection(rtcConfig);
    peerConnections[senderId] = pc;
    
    if (localStream) {
        localStream.getTracks().forEach(track => {
            pc.addTrack(track, localStream);
        });
    }
    
    pc.ontrack = (event) => {
        // ویدیو قبلاً اضافه شده
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
}

async function handleAnswer(senderId, answer) {
    const pc = peerConnections[senderId];
    await pc.setRemoteDescription(answer);
}

async function handleIceCandidate(senderId, candidate) {
    const pc = peerConnections[senderId];
    await pc.addIceCandidate(candidate);
}

// چت
function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    
    if (message && isAlive) {
        connection.invoke("SendMessage", currentRoom, message);
        input.value = '';
    }
}

function handleMessage(username, message) {
    const messagesDiv = document.getElementById('messages');
    const messageEl = document.createElement('div');
    messageEl.className = 'message';
    messageEl.innerHTML = `<span class="username">${username}:</span> ${message}`;
    messagesDiv.appendChild(messageEl);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// مدیریت بازی
function handleGameStart(roles) {
    myRole = roles[connection.connectionId];
    document.getElementById('roleInfo').textContent = `نقش: ${translateRole(myRole)}`;
    document.getElementById('startBtn').style.display = 'none';
}

function handlePhaseChange(phase) {
    document.getElementById('phaseInfo').textContent = `فاز: ${translatePhase(phase)}`;
    
    if (phase === 'Night' && !isAlive) {
        // مرده‌ها نمی‌تونن حرف بزنن
        document.getElementById('messageInput').disabled = true;
    }
}

// ترجمه
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
        'Waiting': 'انتظار',
        'Night': '🌙 شب',
        'Day': '☀️ روز',
        'Voting': '🗳️ رای‌گیری'
    };
    return phases[phase] || phase;
}

// Event Listeners
document.getElementById('messageInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});
