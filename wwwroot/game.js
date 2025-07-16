// ==================== متغیرهای اصلی ====================
let connection = null; // اتصال SignalR
let localStream = null; // استریم دوربین و میکروفون کاربر
let peerConnections = {}; // لیست اتصالات WebRTC با سایر بازیکنان
let dataChannels = {}; // کانال‌های داده برای ارتباط مستقیم
let currentRoom = null; // کد اتاق فعلی
let playerName = null; // نام کاربر
let isRoomCreator = false; // آیا کاربر سازنده اتاق است
let isGameMaster = false; // آیا کاربر گرداننده بازی است
let roomSettings = {}; // تنظیمات اتاق
let players = {}; // اطلاعات بازیکنان
let reconnectAttempts = 0; // تعداد تلاش برای اتصال مجدد
let unreadMessages = 0; // تعداد پیام‌های خوانده نشده
let gamePhase = 'waiting'; // فاز فعلی بازی
let audioContext = null; // کانتکست صوتی برای پردازش صدا
let audioAnalysers = {}; // آنالایزرهای صدا برای تشخیص صحبت

// ==================== تنظیمات WebRTC ====================
// کانفیگ ICE servers برای ایران با TURN server های متعدد
const rtcConfig = {
    iceServers: [
        // STUN servers عمومی گوگل
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        
        // TURN servers رایگان برای عبور از NAT
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject', 
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ],
    iceCandidatePoolSize: 10, // تعداد کاندیدهای ICE
    bundlePolicy: 'max-bundle', // ترکیب همه media در یک connection
    rtcpMuxPolicy: 'require' // استفاده از یک پورت برای RTP و RTCP
};

// ==================== تنظیمات کیفیت ویدیو ====================
const videoQualitySettings = {
    low: {
        width: { ideal: 320, max: 480 },
        height: { ideal: 240, max: 360 },
        frameRate: { ideal: 15, max: 20 }
    },
    medium: {
        width: { ideal: 640, max: 854 },
        height: { ideal: 480, max: 640 },
        frameRate: { ideal: 24, max: 30 }
    },
    high: {
        width: { ideal: 1280, max: 1920 },
        height: { ideal: 720, max: 1080 },
        frameRate: { ideal: 30, max: 60 }
    }
};

// ==================== تابع اصلی لاگ کردن ====================
function debugLog(message, type = 'info') {
    const time = new Date().toLocaleTimeString('fa-IR');
    console.log(`[${type}] ${time}: ${message}`);
    
    // نمایش در پنل دیباگ
    const debugPanel = document.getElementById('debugLogs');
    if (debugPanel) {
        const logElement = document.createElement('div');
        logElement.className = `debug-log ${type}`;
        logElement.innerHTML = `<span style="opacity: 0.7">[${time}]</span> ${message}`;
        debugPanel.appendChild(logElement);
        
        // اسکرول به پایین
        debugPanel.scrollTop = debugPanel.scrollHeight;
        
        // حذف لاگ‌های قدیمی (بیش از 100 خط)
        if (debugPanel.children.length > 100) {
            debugPanel.removeChild(debugPanel.firstChild);
        }
    }
}

// ==================== نمایش نوتیفیکیشن ====================
function showNotification(message, type = 'info', duration = 3000) {
    const notifContainer = document.getElementById('notifications');
    const notif = document.createElement('div');
    notif.className = `notification ${type}`;
    
    // آیکون بر اساس نوع
    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };
    
    notif.innerHTML = `
        <span>${icons[type]}</span>
        <span>${message}</span>
    `;
    
    notifContainer.appendChild(notif);
    
    // حذف بعد از مدت زمان
    setTimeout(() => {
        notif.style.animation = 'fadeOut 0.5s ease forwards';
        setTimeout(() => notif.remove(), 500);
    }, duration);
}

// ==================== ایجاد اتصال SignalR ====================
async function initializeConnection() {
    try {
        debugLog('🔌 شروع اتصال به سرور SignalR...', 'info');
        
        // ساخت connection با تنظیمات کامل
        connection = new signalR.HubConnectionBuilder()
            .withUrl(`${window.location.origin}/gameHub`, {
                // تنظیمات transport
                transport: signalR.HttpTransportType.WebSockets |
                          signalR.HttpTransportType.ServerSentEvents |
                          signalR.HttpTransportType.LongPolling
            })
            .withAutomaticReconnect({
                nextRetryDelayInMilliseconds: retryContext => {
                    // استراتژی اتصال مجدد: 0s, 2s, 5s, 10s, 30s
                    if (retryContext.previousRetryCount === 0) return 0;
                    if (retryContext.previousRetryCount === 1) return 2000;
                    if (retryContext.previousRetryCount === 2) return 5000;
                    if (retryContext.previousRetryCount === 3) return 10000;
                    return 30000;
                }
            })
            .configureLogging(signalR.LogLevel.Information)
            .build();

        // ==================== Event Handlers ====================
        
        // پیام‌های چت
        connection.on("ReceiveMessage", handleReceiveMessage);
        
        // مدیریت بازیکنان
        connection.on("PlayerJoined", handlePlayerJoined);
        connection.on("PlayerLeft", handlePlayerLeft);
        connection.on("ExistingPlayers", handleExistingPlayers);
        connection.on("UpdatePlayerStatus", handlePlayerStatusUpdate);
        
        // WebRTC signaling
        connection.on("ReceiveOffer", handleReceiveOffer);
        connection.on("ReceiveAnswer", handleReceiveAnswer);
        connection.on("ReceiveIceCandidate", handleReceiveIceCandidate);
        
        // مدیریت بازی
        connection.on("GameStarted", handleGameStarted);
        connection.on("PhaseChanged", handlePhaseChanged);
        connection.on("RoleAssigned", handleRoleAssigned);
        connection.on("GameEvent", handleGameEvent);
        connection.on("TimerUpdate", handleTimerUpdate);
        
        // تنظیمات اتاق
        connection.on("RoomSettingsUpdated", handleRoomSettingsUpdate);
        connection.on("RoomCreated", handleRoomCreated);
        
        // خطاها
        connection.on("Error", handleError);

        // ==================== Connection State Events ====================
        
        // در حال اتصال مجدد
        connection.onreconnecting(error => {
            debugLog('🔄 در حال اتصال مجدد به سرور...', 'warn');
            updateConnectionStatus('در حال اتصال...', 'connecting');
            showNotification('در حال اتصال مجدد...', 'warning');
        });

        // اتصال مجدد موفق
        connection.onreconnected(connectionId => {
            debugLog(`✅ اتصال مجدد برقرار شد! ID: ${connectionId}`, 'success');
            updateConnectionStatus('متصل', 'connected');
            showNotification('اتصال مجدد برقرار شد', 'success');
            reconnectAttempts = 0;
            
            // بازگشت به اتاق
            if (currentRoom && playerName) {
                connection.invoke("RejoinRoom", currentRoom, playerName)
                    .catch(err => debugLog(`خطا در بازگشت به اتاق: ${err}`, 'error'));
            }
        });

        // قطع اتصال
        connection.onclose(error => {
            debugLog(`❌ اتصال قطع شد: ${error}`, 'error');
            updateConnectionStatus('قطع شده', 'disconnected');
            showNotification('اتصال قطع شد', 'error');
            
            // تلاش برای اتصال مجدد بعد از 5 ثانیه
            setTimeout(() => {
                if (connection.state === signalR.HubConnectionState.Disconnected) {
                    reconnectAttempts++;
                    if (reconnectAttempts < 5) {
                        initializeConnection();
                    } else {
                        showNotification('عدم امکان اتصال به سرور', 'error', 5000);
                    }
                }
            }, 5000);
        });

        // شروع اتصال
        await connection.start();
        debugLog('✅ اتصال SignalR برقرار شد!', 'success');
        updateConnectionStatus('متصل', 'connected');
        
        return true;
    } catch (err) {
        debugLog(`❌ خطا در اتصال SignalR: ${err}`, 'error');
        updateConnectionStatus('خطا', 'error');
        showNotification('خطا در اتصال به سرور', 'error');
        return false;
    }
}

// ==================== بروزرسانی وضعیت اتصال ====================
function updateConnectionStatus(text, state) {
    const statusBadge = document.getElementById('connectionStatus');
    if (statusBadge) {
        statusBadge.textContent = text;
        statusBadge.className = `status-badge ${state}`;
    }
}

// ==================== دریافت دسترسی به دوربین و میکروفون ====================
async function getLocalStream() {
    try {
        debugLog('📷 درخواست دسترسی به دوربین و میکروفون...', 'info');
        
        // دریافت تنظیمات کیفیت
        const quality = roomSettings.videoQuality || 'medium';
        const videoEnabled = roomSettings.videoEnabled !== false;
        const audioEnabled = roomSettings.audioEnabled !== false;
        
        const constraints = {
            video: videoEnabled ? {
                ...videoQualitySettings[quality],
                facingMode: 'user', // دوربین جلو برای موبایل
                aspectRatio: { ideal: 4/3 }
            } : false,
            audio: audioEnabled ? {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                sampleRate: 48000 // کیفیت بالای صدا
            } : false
        };

        // درخواست دسترسی
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        // نمایش ویدیوی محلی
        displayLocalVideo();
        
        // راه‌اندازی audio context برای تشخیص صحبت
        if (audioEnabled) {
            setupAudioContext();
        }
        
        debugLog('✅ دوربین و میکروفون فعال شد!', 'success');
        return true;
        
    } catch (err) {
        debugLog(`❌ خطا در دسترسی به دوربین/میکروفون: ${err.message}`, 'error');
        
        // تلاش برای دریافت فقط صدا
        if (err.name === 'NotAllowedError') {
            showNotification('دسترسی به دوربین/میکروفون رد شد', 'error');
        } else if (err.name === 'NotFoundError') {
            showNotification('دوربین یا میکروفون یافت نشد', 'error');
        }
        
        // سعی در دریافت فقط صدا
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            debugLog('🎤 فقط میکروفون فعال شد', 'info');
            displayLocalVideo();
            return true;
        } catch (audioErr) {
            debugLog('❌ خطا در دسترسی به میکروفون', 'error');
            showNotification('عدم دسترسی به دوربین و میکروفون', 'error');
            return false;
        }
    }
}

// ==================== نمایش ویدیوی محلی ====================
function displayLocalVideo() {
    // ایجاد جایگاه برای کاربر محلی
    const localSeat = createPlayerSeat('local', playerName, true);
    const video = localSeat.querySelector('video');
    
    if (video && localStream) {
        video.srcObject = localStream;
        video.muted = true; // جلوگیری از اکو
        
        // اضافه کردن به لیست بازیکنان
        players['local'] = {
            id: 'local',
            name: playerName,
            isLocal: true,
            stream: localStream
        };
    }
}

// ==================== راه‌اندازی Audio Context ====================
function setupAudioContext() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // ایجاد آنالایزر برای استریم محلی
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            createAudioAnalyser('local', localStream);
        }
    }
}

// ==================== ایجاد آنالایزر صدا ====================
function createAudioAnalyser(peerId, stream) {
    if (!audioContext) return;
    
    try {
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 256;
        
        source.connect(analyser);
        audioAnalysers[peerId] = analyser;
        
        // شروع تشخیص صحبت
        detectSpeaking(peerId);
    } catch (err) {
        debugLog(`خطا در ایجاد آنالایزر صدا: ${err}`, 'error');
    }
}

// ==================== تشخیص صحبت کردن ====================
function detectSpeaking(peerId) {
    const analyser = audioAnalysers[peerId];
    if (!analyser) return;
    
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;
    
    function checkAudio() {
        analyser.getByteFrequencyData(dataArray);
        
        // محاسبه میانگین صدا
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
            sum += dataArray[i];
        }
        const average = sum / dataArray.length;
        
        // آستانه تشخیص صحبت
        const threshold = 30;
        const newSpeaking = average > threshold;
        
        // بروزرسانی UI اگر وضعیت تغییر کرد
        if (newSpeaking !== speaking) {
            speaking = newSpeaking;
            const videoContainer = document.querySelector(`#seat-${peerId} .video-container`);
            if (videoContainer) {
                if (speaking) {
                    videoContainer.classList.add('speaking');
                } else {
                    videoContainer.classList.remove('speaking');
                }
            }
        }
        
        // ادامه چک کردن
        requestAnimationFrame(checkAudio);
    }
    
    checkAudio();
}

// ==================== ساخت اتاق جدید ====================
async function createRoom() {
    playerName = document.getElementById('playerName').value.trim();
    
    if (!playerName) {
        showNotification('لطفا نام خود را وارد کنید', 'warning');
        return;
    }
    
    // نمایش لودینگ
    showLoading('در حال ساخت اتاق...');
    
    // اتصال به سرور
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
        const connected = await initializeConnection();
        if (!connected) {
            hideLoading();
            return;
        }
    }
    
    try {
        // ساخت اتاق
        await connection.invoke("CreateRoom", playerName);
        isRoomCreator = true;
        debugLog('✅ درخواست ساخت اتاق ارسال شد', 'success');
    } catch (err) {
        debugLog(`❌ خطا در ساخت اتاق: ${err}`, 'error');
        showNotification('خطا در ساخت اتاق', 'error');
        hideLoading();
    }
}

// ==================== مدیریت ساخت اتاق ====================
function handleRoomCreated(roomCode) {
    currentRoom = roomCode;
    debugLog(`✅ اتاق ${roomCode} ساخته شد`, 'success');
    
    // نمایش کد اتاق در صفحه تنظیمات
    document.getElementById('settingsRoomCode').textContent = roomCode;
    
    // انتقال به صفحه تنظیمات
    hideLoading();
    document.getElementById('loginScreen').classList.remove('active');
    document.getElementById('roomSettingsScreen').style.display = 'flex';
}

// ==================== کپی کد اتاق ====================
function copyRoomCode() {
    const code = document.getElementById('settingsRoomCode').textContent;
    navigator.clipboard.writeText(code).then(() => {
        showNotification('کد اتاق کپی شد', 'success');
    });
}

// ==================== ذخیره تنظیمات و ادامه ====================
async function saveSettingsAndContinue() {
    // جمع‌آوری تنظیمات
    roomSettings = {
        minPlayers: parseInt(document.getElementById('minPlayers').value),
        gameTheme: document.getElementById('gameTheme').value,
        gameMaster: document.getElementById('gameMaster').value,
        videoEnabled: document.getElementById('videoEnabled').checked,
        audioEnabled: document.getElementById('audioEnabled').checked,
        videoQuality: document.getElementById('videoQuality').value,
        roles: {
            mafia: 2,
            doctor: 1,
            detective: 1,
            sniper: document.querySelector('input[type="checkbox"]:nth-child(4)').checked ? 1 : 0
        }
    };
    
    showLoading('در حال اعمال تنظیمات...');
    
    try {
        // ارسال تنظیمات به سرور
        await connection.invoke("UpdateRoomSettings", currentRoom, roomSettings);
        
        // دریافت دوربین
        const cameraOk = await getLocalStream();
        if (!cameraOk && (roomSettings.videoEnabled || roomSettings.audioEnabled)) {
            hideLoading();
            return;
        }
        
        // انتقال به صفحه بازی
        document.getElementById('roomSettingsScreen').style.display = 'none';
        document.getElementById('gameScreen').style.display = 'block';
        document.getElementById('roomCodeDisplay').textContent = currentRoom;
        
        // نمایش دکمه شروع برای سازنده
        if (isRoomCreator) {
            document.getElementById('startGameBtn').style.display = 'block';
            document.querySelector('.debug-btn').style.display = 'block';
        }
        
        // ایجاد جایگاه‌های بازیکنان
        createPlayerSeats();
        
        hideLoading();
        showNotification('به اتاق خوش آمدید!', 'success');
        
    } catch (err) {
        debugLog(`خطا در ذخیره تنظیمات: ${err}`, 'error');
        showNotification('خطا در ذخیره تنظیمات', 'error');
        hideLoading();
    }
}

// ==================== ورود به اتاق موجود ====================
async function joinRoom() {
    playerName = document.getElementById('playerName').value.trim();
    currentRoom = document.getElementById('roomCode').value.trim();
    
    if (!playerName) {
        showNotification('لطفا نام خود را وارد کنید', 'warning');
        return;
    }
    
    if (!currentRoom) {
        showNotification('لطفا کد اتاق را وارد کنید', 'warning');
        return;
    }
    
    showLoading('در حال ورود به اتاق...');
    
    // دریافت دوربین
    const cameraOk = await getLocalStream();
    
    // اتصال به سرور
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
        const connected = await initializeConnection();
        if (!connected) {
            hideLoading();
            return;
        }
    }
    
    try {
        // ورود به اتاق
        await connection.invoke("JoinRoom", currentRoom, playerName);
        debugLog(`✅ وارد اتاق ${currentRoom} شدید`, 'success');
        
        // انتقال به صفحه بازی
        document.getElementById('loginScreen').classList.remove('active');
        document.getElementById('gameScreen').style.display = 'block';
        document.getElementById('roomCodeDisplay').textContent = currentRoom;
        
        // ایجاد جایگاه‌های بازیکنان
        createPlayerSeats();
        
        hideLoading();
        showNotification('به اتاق خوش آمدید!', 'success');
        
    } catch (err) {
        debugLog(`❌ خطا در ورود به اتاق: ${err}`, 'error');
        showNotification('خطا در ورود به اتاق', 'error');
        hideLoading();
    }
}

// ==================== ایجاد جایگاه‌های بازیکنان ====================
function createPlayerSeats() {
    const seatsContainer = document.getElementById('playersSeats');
    seatsContainer.innerHTML = '';
    
    // ایجاد 12 جایگاه
    for (let i = 0; i < 12; i++) {
        const seat = document.createElement('div');
        seat.className = 'player-seat';
        seat.id = `seat-position-${i}`;
        seatsContainer.appendChild(seat);
    }
}

// ==================== ایجاد جایگاه برای بازیکن ====================
function createPlayerSeat(playerId, playerName, isLocal = false) {
    // پیدا کردن اولین جایگاه خالی
    let seatElement = null;
    
    if (isLocal) {
        // کاربر محلی همیشه در پایین (جایگاه 6)
        seatElement = document.getElementById('seat-position-6');
    } else {
        // پیدا کردن جایگاه خالی برای سایر بازیکنان
        for (let i = 0; i < 12; i++) {
            if (i === 6) continue; // جایگاه محلی
            const seat = document.getElementById(`seat-position-${i}`);
            if (seat && !seat.hasChildNodes()) {
                seatElement = seat;
                break;
            }
        }
    }
    
    if (!seatElement) {
        debugLog('❌ جایگاه خالی یافت نشد', 'error');
        return null;
    }
    
    // اضافه کردن محتوا
    seatElement.id = `seat-${playerId}`;
    seatElement.innerHTML = `
        <div class="video-container ${isLocal ? 'local' : ''}" onclick="toggleVideoSize('${playerId}')">
            <video id="video-${playerId}" autoplay ${isLocal ? 'muted' : ''} playsinline></video>
            <div class="connection-status ${isLocal ? 'connected' : 'connecting'}"></div>
            ${!isLocal ? '<div class="player-role" style="display: none;"></div>' : ''}
        </div>
        <div class="player-info">
            <span>${playerName}</span>
        </div>
    `;
    
    return seatElement;
}

// ==================== مدیریت بازیکنان موجود ====================
function handleExistingPlayers(existingPlayers) {
    debugLog(`👥 ${existingPlayers.length} بازیکن در اتاق هستند`, 'info');
    
    // بروزرسانی تعداد بازیکنان
    updatePlayersCount(existingPlayers.length + 1);
    
    // اضافه کردن بازیکنان موجود
    existingPlayers.forEach((player, index) => {
        if (player.connectionId !== connection.connectionId) {
            // اضافه کردن به UI
            addPlayerToTable(player.connectionId, player.name);
            
            // ذخیره اطلاعات بازیکن
            players[player.connectionId] = {
                id: player.connectionId,
                name: player.name,
                isReady: player.isReady || false
            };
            
            // ایجاد peer connection با تاخیر
            setTimeout(() => {
                createPeerConnection(player.connectionId, true);
            }, 100 * index); // تاخیر 100ms بین هر اتصال
        }
    });
}

// ==================== اضافه کردن بازیکن به میز ====================
function addPlayerToTable(playerId, playerName) {
    if (document.getElementById(`seat-${playerId}`)) return;
    
    const seat = createPlayerSeat(playerId, playerName, false);
    if (seat) {
        debugLog(`✅ ${playerName} به میز اضافه شد`, 'success');
    }
}

// ==================== ورود بازیکن جدید ====================
async function handlePlayerJoined(playerId, playerName) {
    if (playerId === connection.connectionId) return;
    
    debugLog(`👤 ${playerName} وارد اتاق شد`, 'info');
    showNotification(`${playerName} وارد شد`, 'info');
    
    // اضافه کردن به UI
    addPlayerToTable(playerId, playerName);
    
    // ذخیره اطلاعات
    players[playerId] = {
        id: playerId,
        name: playerName,
        isReady: false
    };
    
    // بروزرسانی تعداد
    updatePlayersCount(Object.keys(players).length);
}

// ==================== خروج بازیکن ====================
function handlePlayerLeft(playerId) {
    const player = players[playerId];
    if (player) {
        debugLog(`👋 ${player.name} از اتاق خارج شد`, 'info');
        showNotification(`${player.name} خارج شد`, 'warning');
    }
    
    // بستن peer connection
    if (peerConnections[playerId]) {
        peerConnections[playerId].close();
        delete peerConnections[playerId];
    }
    
    // حذف از audio analysers
    delete audioAnalysers[playerId];
    
    // حذف از UI
    const seat = document.getElementById(`seat-${playerId}`);
    if (seat) {
        seat.innerHTML = '';
        seat.id = `seat-position-${Array.from(seat.parentNode.children).indexOf(seat)}`;
    }
    
    // حذف از لیست
    delete players[playerId];
    
    // بروزرسانی تعداد
    updatePlayersCount(Object.keys(players).length);
    
    // بروزرسانی لیست گاد
    if (isGameMaster) {
        updateGodPlayersList();
    }
}

// ==================== بروزرسانی تعداد بازیکنان ====================
function updatePlayersCount(count) {
    document.getElementById('onlinePlayersCount').textContent = count;
    
    // بروزرسانی دکمه شروع
    if (isRoomCreator) {
        const minPlayers = roomSettings.minPlayers || 4;
        const startBtn = document.getElementById('startGameBtn');
        const readyCount = document.querySelector('.player-ready-count');
        
        if (readyCount) {
            readyCount.textContent = `(${count}/${minPlayers})`;
        }
        
        // فعال/غیرفعال کردن دکمه
        if (startBtn) {
            startBtn.disabled = count < minPlayers;
            if (count < minPlayers) {
                startBtn.style.opacity = '0.5';
                startBtn.style.cursor = 'not-allowed';
            } else {
                startBtn.style.opacity = '1';
                startBtn.style.cursor = 'pointer';
            }
        }
    }
}

// ==================== ایجاد Peer Connection ====================
async function createPeerConnection(peerId, createOffer = false) {
    debugLog(`🔧 ایجاد peer connection با ${peerId}`, 'info');
    
    // بستن اتصال قبلی اگر وجود دارد
    if (peerConnections[peerId]) {
        peerConnections[peerId].close();
        delete peerConnections[peerId];
    }
    
    try {
        // ایجاد peer connection جدید
        const pc = new RTCPeerConnection(rtcConfig);
        peerConnections[peerId] = pc;
        
        // ایجاد data channel برای ارتباطات سریع
        const dataChannel = pc.createDataChannel('gameData', {
            ordered: true,
            maxRetransmits: 3
        });
        
        dataChannel.onopen = () => {
            debugLog(`📡 Data channel با ${peerId} باز شد`, 'success');
            dataChannels[peerId] = dataChannel;
        };
        
        dataChannel.onmessage = (event) => {
            handleDataChannelMessage(peerId, event.data);
        };
        
        dataChannel.onerror = (error) => {
            debugLog(`❌ خطای data channel: ${error}`, 'error');
        };
        
        // دریافت data channel از طرف مقابل
        pc.ondatachannel = (event) => {
            const channel = event.channel;
            channel.onopen = () => {
                dataChannels[peerId] = channel;
            };
            channel.onmessage = (event) => {
                handleDataChannelMessage(peerId, event.data);
            };
        };
        
        // اضافه کردن tracks محلی
        if (localStream) {
            localStream.getTracks().forEach(track => {
                pc.addTrack(track, localStream);
                debugLog(`📤 ${track.kind} track اضافه شد به ${peerId}`, 'info');
            });
        }
        
        // دریافت tracks از طرف مقابل
        pc.ontrack = (event) => {
            debugLog(`📥 دریافت ${event.track.kind} track از ${peerId}`, 'success');
            
            const video = document.getElementById(`video-${peerId}`);
            if (video && event.streams[0]) {
                video.srcObject = event.streams[0];
                
                // ایجاد audio analyser
                if (event.track.kind === 'audio') {
                    createAudioAnalyser(peerId, event.streams[0]);
                }
                
                // ذخیره stream
                if (players[peerId]) {
                    players[peerId].stream = event.streams[0];
                }
            }
        };
        
        // مدیریت ICE candidates
        pc.onicecandidate = (event) => {
            if (event.candidate) {
                // ارسال ICE candidate به طرف مقابل
                if (connection.state === signalR.HubConnectionState.Connected) {
                    connection.invoke("SendIceCandidate", currentRoom, peerId, 
                        JSON.stringify(event.candidate))
                        .catch(err => debugLog(`خطا در ارسال ICE: ${err}`, 'error'));
                }
            }
        };
        
        // وضعیت اتصال
        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            debugLog(`📡 وضعیت اتصال با ${peerId}: ${state}`, 
                state === 'connected' ? 'success' : 'info');
            
            // بروزرسانی UI
            updatePeerConnectionStatus(peerId, state);
            
            // مدیریت خطا
            if (state === 'failed') {
                debugLog(`❌ اتصال با ${peerId} شکست خورد، تلاش مجدد...`, 'error');
                setTimeout(() => {
                    createPeerConnection(peerId, true);
                }, 3000);
            }
        };
        
        // وضعیت ICE
        pc.oniceconnectionstatechange = () => {
            const state = pc.iceConnectionState;
            debugLog(`🧊 وضعیت ICE با ${peerId}: ${state}`, 'info');
            
            if (state === 'disconnected' || state === 'failed') {
                // تلاش برای restart
                setTimeout(() => {
                    if (pc.iceConnectionState === 'disconnected' || 
                        pc.iceConnectionState === 'failed') {
                        restartIce(peerId);
                    }
                }, 2000);
            }
        };
        
        // gathering state
        pc.onicegatheringstatechange = () => {
            debugLog(`🧊 Gathering state ${peerId}: ${pc.iceGatheringState}`, 'info');
        };
        
        // اگر باید offer بسازیم
        if (createOffer) {
            // صبر کنیم تا connection آماده شود
            setTimeout(async () => {
                try {
                    const offer = await pc.createOffer({
                        offerToReceiveVideo: true,
                        offerToReceiveAudio: true
                    });
                    
                    await pc.setLocalDescription(offer);
                    
                    // ارسال offer
                    await connection.invoke("SendOffer", currentRoom, peerId, 
                        JSON.stringify(offer));
                    
                    debugLog(`📤 Offer ارسال شد به ${peerId}`, 'success');
                } catch (err) {
                    debugLog(`❌ خطا در ایجاد offer: ${err}`, 'error');
                }
            }, 100);
        }
        
        return pc;
        
    } catch (err) {
        debugLog(`❌ خطا در ایجاد peer connection: ${err}`, 'error');
        return null;
    }
}

// ==================== restart ICE ====================
async function restartIce(peerId) {
    const pc = peerConnections[peerId];
    if (!pc) return;
    
    try {
        debugLog(`🔄 Restart ICE برای ${peerId}`, 'info');
        
        // ایجاد offer جدید با restart flag
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        
        // ارسال offer جدید
        await connection.invoke("SendOffer", currentRoom, peerId, 
            JSON.stringify(offer));
            
    } catch (err) {
        debugLog(`❌ خطا در restart ICE: ${err}`, 'error');
    }
}

// ==================== بروزرسانی وضعیت peer ====================
function updatePeerConnectionStatus(peerId, state) {
    const statusDot = document.querySelector(`#seat-${peerId} .connection-status`);
    if (statusDot) {
        statusDot.className = 'connection-status';
        
        switch(state) {
            case 'connected':
                statusDot.classList.add('connected');
                break;
            case 'connecting':
            case 'new':
                statusDot.classList.add('connecting');
                break;
            case 'disconnected':
            case 'failed':
            case 'closed':
                // حالت پیش‌فرض (قرمز)
                break;
        }
    }
}

// ==================== دریافت Offer ====================
async function handleReceiveOffer(fromId, offerJson) {
    debugLog(`📥 دریافت offer از ${fromId}`, 'info');
    
    try {
        // ایجاد یا دریافت peer connection
        let pc = peerConnections[fromId];
        if (!pc) {
            pc = await createPeerConnection(fromId, false);
            if (!pc) return;
        }
        
        // تنظیم remote description
        const offer = JSON.parse(offerJson);
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        
        // ایجاد answer
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        
        // ارسال answer
        await connection.invoke("SendAnswer", currentRoom, fromId, 
            JSON.stringify(answer));
            
        debugLog(`📤 Answer ارسال شد به ${fromId}`, 'success');
        
    } catch (err) {
        debugLog(`❌ خطا در پردازش offer: ${err}`, 'error');
    }
}

// ==================== دریافت Answer ====================
async function handleReceiveAnswer(fromId, answerJson) {
    debugLog(`📥 دریافت answer از ${fromId}`, 'info');
    
    try {
        const pc = peerConnections[fromId];
        if (!pc) {
            debugLog(`⚠️ Peer connection برای ${fromId} یافت نشد`, 'warn');
            return;
        }
        
        const answer = JSON.parse(answerJson);
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        
        debugLog(`✅ Answer از ${fromId} اعمال شد`, 'success');
        
    } catch (err) {
        debugLog(`❌ خطا در پردازش answer: ${err}`, 'error');
    }
}

// ==================== دریافت ICE Candidate ====================
async function handleReceiveIceCandidate(fromId, candidateJson) {
    try {
        const pc = peerConnections[fromId];
        if (!pc) return;
        
        const candidate = JSON.parse(candidateJson);
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
        
        debugLog(`🧊 ICE candidate از ${fromId} اضافه شد`, 'info');
        
    } catch (err) {
        debugLog(`⚠️ خطا در ICE candidate: ${err}`, 'warn');
    }
}

// ==================== پیام‌های Data Channel ====================
function handleDataChannelMessage(peerId, message) {
    try {
        const data = JSON.parse(message);
        
        switch(data.type) {
            case 'ping':
                // پاسخ به ping
                if (dataChannels[peerId]) {
                    dataChannels[peerId].send(JSON.stringify({
                        type: 'pong',
                        timestamp: Date.now()
                    }));
                }
                break;
                
            case 'playerState':
                // بروزرسانی وضعیت بازیکن
                if (players[peerId]) {
                    players[peerId] = { ...players[peerId], ...data.state };
                }
                break;
        }
    } catch (err) {
        debugLog(`خطا در پردازش data channel: ${err}`, 'error');
    }
}

// ==================== شروع بازی ====================
async function startGame() {
    if (!connection || connection.state !== signalR.HubConnectionState.Connected) {
        showNotification('اتصال قطع است!', 'error');
        return;
    }
    
    const playerCount = Object.keys(players).length;
    const minPlayers = roomSettings.minPlayers || 4;
    
    if (playerCount < minPlayers) {
        showNotification(`حداقل ${minPlayers} بازیکن نیاز است`, 'warning');
        return;
    }
    
    debugLog('🎮 درخواست شروع بازی...', 'info');
    showLoading('در حال شروع بازی...');
    
    try {
        await connection.invoke("StartGame", currentRoom);
        debugLog('✅ درخواست شروع بازی ارسال شد', 'success');
    } catch (err) {
        debugLog(`❌ خطا در شروع بازی: ${err}`, 'error');
        showNotification('خطا در شروع بازی', 'error');
    } finally {
        hideLoading();
    }
}

// ==================== مدیریت شروع بازی ====================
function handleGameStarted(gameData) {
    debugLog('🎮 بازی شروع شد!', 'success');
    showNotification('بازی شروع شد!', 'success');
    
    // مخفی کردن دکمه شروع
    document.getElementById('startGameBtn').style.display = 'none';
    
    // نمایش نقش بازیکن
    if (gameData.role) {
        showNotification(`نقش شما: ${gameData.role}`, 'info', 5000);
        
        // نمایش نقش در UI
        const roleElement = document.querySelector(`#seat-local .player-role`);
        if (roleElement) {
            roleElement.textContent = getRoleEmoji(gameData.role);
            roleElement.style.display = 'flex';
        }
    }
    
    // اگر گرداننده بازی هستیم
    if (gameData.isGameMaster) {
        isGameMaster = true;
        document.querySelector('.god-btn').style.display = 'block';
        showNotification('شما گرداننده بازی هستید', 'info');
        updateGodPlayersList();
    }
    
    gamePhase = 'started';
}

// ==================== دریافت emoji نقش ====================
function getRoleEmoji(role) {
    const emojis = {
        'مافیا': '🔫',
        'شهروند': '👤',
        'دکتر': '💊',
        'کارآگاه': '🔍',
        'تک‌تیرانداز': '🎯'
    };
    return emojis[role] || '👤';
}

// ==================== تغییر فاز بازی ====================
function handlePhaseChanged(phase, duration) {
    debugLog(`🌙 فاز بازی: ${phase}`, 'info');
    gamePhase = phase;
    
    const phaseDisplay = document.getElementById('gamePhase');
    const phaseIcon = phaseDisplay.querySelector('.phase-icon');
    const phaseText = phaseDisplay.querySelector('.phase-text');
    
    // تنظیم آیکون و متن
    switch(phase) {
        case 'day':
            phaseIcon.textContent = '☀️';
            phaseText.textContent = 'روز';
            break;
        case 'night':
            phaseIcon.textContent = '🌙';
            phaseText.textContent = 'شب';
            break;
        case 'voting':
            phaseIcon.textContent = '🗳️';
            phaseText.textContent = 'رای‌گیری';
            break;
        case 'defense':
            phaseIcon.textContent = '🛡️';
            phaseText.textContent = 'دفاع';
            break;
    }
    
    // شروع تایمر اگر duration دارد
    if (duration) {
        startTimer(duration);
    }
    
    // مدیریت ویدیوها بر اساس فاز
    if (isGameMaster && roomSettings.gameMaster === 'auto') {
        manageVideosForPhase(phase);
    }
}

// ==================== مدیریت ویدیوها برای فازها ====================
function manageVideosForPhase(phase) {
    // این تابع برای حالت ربات گرداننده
    switch(phase) {
        case 'night':
            // خاموش کردن همه ویدیوها در شب
            Object.keys(players).forEach(playerId => {
                if (playerId !== 'local') {
                    togglePlayerVideo(playerId, false);
                }
            });
            break;
            
        case 'day':
            // روشن کردن همه ویدیوها در روز
            Object.keys(players).forEach(playerId => {
                togglePlayerVideo(playerId, true);
            });
            break;
    }
}

// ==================== تایمر بازی ====================
let gameTimer = null;
function startTimer(seconds) {
    clearInterval(gameTimer);
    
    const timerElement = document.getElementById('gameTimer');
    const timerValue = timerElement.querySelector('.timer-value');
    timerElement.style.display = 'block';
    
    let remaining = seconds;
    
    function updateTimer() {
        const minutes = Math.floor(remaining / 60);
        const secs = remaining % 60;
        timerValue.textContent = `${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        
        if (remaining <= 10) {
            timerElement.classList.add('warning');
        } else {
            timerElement.classList.remove('warning');
        }
        
        if (remaining <= 0) {
            clearInterval(gameTimer);
            timerElement.style.display = 'none';
        }
        
        remaining--;
    }
    
    updateTimer();
    gameTimer = setInterval(updateTimer, 1000);
}

// ==================== رویدادهای بازی ====================
function handleGameEvent(event) {
    debugLog(`🎮 رویداد: ${event.message}`, 'info');
    
    const eventsContainer = document.getElementById('gameEvents');
    const eventElement = document.createElement('div');
    eventElement.className = 'game-event';
    eventElement.innerHTML = `
        <span class="event-icon">${event.icon || '📢'}</span>
        <span class="event-message">${event.message}</span>
    `;
    
    eventsContainer.appendChild(eventElement);
    
    // حذف بعد از 5 ثانیه
    setTimeout(() => {
        eventElement.style.animation = 'fadeOut 0.5s ease forwards';
        setTimeout(() => eventElement.remove(), 500);
    }, 5000);
}

// ==================== مدیریت چت ====================
function toggleChat() {
    const chatPanel = document.getElementById('chatPanel');
    chatPanel.classList.toggle('collapsed');
    
    if (!chatPanel.classList.contains('collapsed')) {
        // ریست پیام‌های خوانده نشده
        unreadMessages = 0;
        updateUnreadBadge();
        
        // فوکوس روی input
        document.getElementById('messageInput').focus();
    }
}

function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    
    if (!message) return;
    
    if (connection?.state === signalR.HubConnectionState.Connected) {
        connection.invoke("SendMessage", currentRoom, message)
            .catch(err => debugLog(`خطا در ارسال پیام: ${err}`, 'error'));
        input.value = '';
    }
}

function handleReceiveMessage(sender, message, timestamp) {
    const messagesDiv = document.getElementById('messages');
    const messageElement = document.createElement('div');
    messageElement.className = 'message';
    
    const time = new Date(timestamp).toLocaleTimeString('fa-IR', {
        hour: '2-digit',
        minute: '2-digit'
    });
    
    messageElement.innerHTML = `
        <div class="message-sender">${sender}</div>
        <div class="message-text">${message}</div>
        <div class="message-time">${time}</div>
    `;
    
    messagesDiv.appendChild(messageElement);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
    
    // افزایش پیام خوانده نشده اگر پنل بسته است
    const chatPanel = document.getElementById('chatPanel');
    if (chatPanel.classList.contains('collapsed')) {
        unreadMessages++;
        updateUnreadBadge();
        
        // نمایش نوتیفیکیشن
        if (sender !== playerName) {
            showNotification(`${sender}: ${message}`, 'info', 2000);
        }
    }
}

function updateUnreadBadge() {
    const badge = document.getElementById('unreadCount');
    if (unreadMessages > 0) {
        badge.textContent = unreadMessages > 99 ? '99+' : unreadMessages;
        badge.style.display = 'flex';
    } else {
        badge.style.display = 'none';
    }
}

// ==================== پنل مدیریت گاد ====================
function toggleGodPanel() {
    const panel = document.getElementById('godPanel');
    panel.classList.toggle('collapsed');
    
    if (!panel.classList.contains('collapsed')) {
        updateGodPlayersList();
    }
}

function updateGodPlayersList() {
    const listContainer = document.getElementById('godPlayersList');
    listContainer.innerHTML = '';
    
    Object.values(players).forEach(player => {
        const playerItem = document.createElement('div');
        playerItem.className = 'god-player-item';
        playerItem.innerHTML = `
            <span>${player.name}</span>
            <div class="god-player-controls">
                <button class="god-player-btn" onclick="togglePlayerAudio('${player.id}')" title="میکروفون">
                    🎤
                </button>
                <button class="god-player-btn" onclick="togglePlayerVideo('${player.id}')" title="دوربین">
                    📹
                </button>
                <button class="god-player-btn" onclick="kickPlayer('${player.id}')" title="اخراج">
                    ❌
                </button>
            </div>
        `;
        listContainer.appendChild(playerItem);
    });
}

// کنترل‌های گاد
function godStartDay() {
    if (connection?.state === signalR.HubConnectionState.Connected) {
        connection.invoke("ChangePhase", currentRoom, "day");
    }
}

function godStartNight() {
    if (connection?.state === signalR.HubConnectionState.Connected) {
        connection.invoke("ChangePhase", currentRoom, "night");
    }
}

function godStartVoting() {
    if (connection?.state === signalR.HubConnectionState.Connected) {
        connection.invoke("ChangePhase", currentRoom, "voting");
    }
}

function godPauseGame() {
    if (connection?.state === signalR.HubConnectionState.Connected) {
        connection.invoke("PauseGame", currentRoom);
    }
}

function godSetTimer() {
    const minutes = parseInt(document.getElementById('godTimerMinutes').value);
    if (connection?.state === signalR.HubConnectionState.Connected) {
        connection.invoke("SetTimer", currentRoom, minutes * 60);
    }
}

function godLogEvent() {
    const text = document.getElementById('godEventText').value.trim();
    if (text && connection?.state === signalR.HubConnectionState.Connected) {
        connection.invoke("LogGameEvent", currentRoom, text);
        document.getElementById('godEventText').value = '';
    }
}

function togglePlayerAudio(playerId) {
    // کنترل صدای بازیکن
    const video = document.getElementById(`video-${playerId}`);
    if (video) {
        video.muted = !video.muted;
        showNotification(video.muted ? 'صدا قطع شد' : 'صدا وصل شد', 'info');
    }
}

function togglePlayerVideo(playerId, enabled) {
    // کنترل ویدیوی بازیکن
    const video = document.getElementById(`video-${playerId}`);
    if (video) {
        if (enabled !== undefined) {
            video.style.display = enabled ? 'block' : 'none';
        } else {
            video.style.display = video.style.display === 'none' ? 'block' : 'none';
        }
    }
}

function kickPlayer(playerId) {
    if (confirm('آیا از اخراج این بازیکن مطمئن هستید؟')) {
        if (connection?.state === signalR.HubConnectionState.Connected) {
            connection.invoke("KickPlayer", currentRoom, playerId);
        }
    }
}

// ==================== بزرگنمایی ویدیو ====================
function toggleVideoSize(playerId) {
    const video = document.getElementById(`video-${playerId}`);
    if (!video || !video.srcObject) return;
    
    const enlargedDiv = document.getElementById('enlargedVideo');
    const enlargedVideo = document.getElementById('enlargedVideoElement');
    const playerNameSpan = document.getElementById('enlargedPlayerName');
    
    enlargedVideo.srcObject = video.srcObject;
    playerNameSpan.textContent = players[playerId]?.name || 'بازیکن';
    enlargedDiv.style.display = 'flex';
}

function closeEnlargedVideo() {
    document.getElementById('enlargedVideo').style.display = 'none';
}

// ==================== تنظیمات سریع ====================
function toggleSettings() {
    const settings = document.getElementById('quickSettings');
    settings.style.display = settings.style.display === 'none' ? 'block' : 'none';
}

function toggleMuteAll() {
    const muteAll = document.getElementById('muteAll').checked;
    Object.keys(players).forEach(playerId => {
        if (playerId !== 'local') {
            const video = document.getElementById(`video-${playerId}`);
            if (video) video.muted = muteAll;
        }
    });
}

function toggleHideVideos() {
    const hideVideos = document.getElementById('hideVideos').checked;
    Object.keys(players).forEach(playerId => {
        const video = document.getElementById(`video-${playerId}`);
        if (video) video.style.display = hideVideos ? 'none' : 'block';
    });
}

function changeVideoQuality() {
    const quality = document.getElementById('quickVideoQuality').value;
    // TODO: اعمال تغییر کیفیت به stream
    showNotification(`کیفیت ویدیو تغییر یافت به ${quality}`, 'info');
}

// ==================== پنل دیباگ ====================
function toggleDebugPanel() {
    const panel = document.getElementById('debugPanel');
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
}

function switchDebugTab(tab) {
    // تغییر تب فعال
    document.querySelectorAll('.debug-tab').forEach(t => t.classList.remove('active'));
    event.target.classList.add('active');
    
    const content = document.getElementById('debugContent');
    
    switch(tab) {
        case 'logs':
            content.innerHTML = '<div id="debugLogs" class="debug-logs"></div>';
            break;
            
        case 'connections':
            showConnectionsDebug();
            break;
            
        case 'stats':
            showStatsDebug();
            break;
    }
}

function showConnectionsDebug() {
    const content = document.getElementById('debugContent');
    let html = '<div class="debug-connections">';
    
    // SignalR
    html += `<h4>SignalR Connection:</h4>`;
    html += `<p>State: ${connection?.state || 'Not initialized'}</p>`;
    html += `<p>Connection ID: ${connection?.connectionId || 'N/A'}</p>`;
    
    // Peer Connections
    html += `<h4>Peer Connections:</h4>`;
    Object.entries(peerConnections).forEach(([id, pc]) => {
        html += `<div class="peer-info">`;
        html += `<strong>${players[id]?.name || id}:</strong><br>`;
        html += `Connection: ${pc.connectionState}<br>`;
        html += `ICE: ${pc.iceConnectionState}<br>`;
        html += `Gathering: ${pc.iceGatheringState}`;
        html += `</div>`;
    });
    
    html += '</div>';
    content.innerHTML = html;
}

function showStatsDebug() {
    const content = document.getElementById('debugContent');
    let html = '<div class="debug-stats">';
    
    html += `<p>Players: ${Object.keys(players).length}</p>`;
    html += `<p>Active Connections: ${Object.keys(peerConnections).length}</p>`;
    html += `<p>Data Channels: ${Object.keys(dataChannels).length}</p>`;
    html += `<p>Game Phase: ${gamePhase}</p>`;
    html += `<p>Is Room Creator: ${isRoomCreator}</p>`;
    html += `<p>Is Game Master: ${isGameMaster}</p>`;
    
    html += '</div>';
    content.innerHTML = html;
}

function clearDebugLogs() {
    const logs = document.getElementById('debugLogs');
    if (logs) logs.innerHTML = '';
}

function debugConnections() {
    debugLog("=== وضعیت اتصالات ===", 'info');
    debugLog(`SignalR: ${connection?.state || 'قطع'}`, 'info');
    
    Object.entries(peerConnections).forEach(([id, pc]) => {
        const name = players[id]?.name || id;
        debugLog(`${name}: ${pc.connectionState} | ICE: ${pc.iceConnectionState}`, 'info');
    });
}

function forceReconnectAll() {
    debugLog('🔄 تلاش مجدد برای همه اتصالات...', 'warn');
    
    Object.keys(peerConnections).forEach(peerId => {
        createPeerConnection(peerId, true);
    });
}

function testConnection() {
    debugLog('🧪 تست اتصال...', 'info');
    
    // ping به همه peers
    Object.entries(dataChannels).forEach(([id, channel]) => {
        if (channel.readyState === 'open') {
            channel.send(JSON.stringify({
                type: 'ping',
                timestamp: Date.now()
            }));
            debugLog(`Ping ارسال شد به ${players[id]?.name || id}`, 'info');
        }
    });
}

// ==================== خروج از بازی ====================
function leaveGame() {
    if (confirm('آیا از خروج از بازی مطمئن هستید؟')) {
        // قطع همه اتصالات
        Object.values(peerConnections).forEach(pc => pc.close());
        
        // قطع stream محلی
        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
        }
        
        // قطع SignalR
        if (connection) {
            connection.stop();
        }
        
        // بازگشت به صفحه ورود
        window.location.reload();
    }
}

// ==================== مدیریت لودینگ ====================
function showLoading(text) {
    const overlay = document.getElementById('loadingOverlay');
    const loadingText = document.getElementById('loadingText');
    
    loadingText.textContent = text;
    overlay.style.display = 'flex';
}

function hideLoading() {
    document.getElementById('loadingOverlay').style.display = 'none';
}

// ==================== مدیریت خطاها ====================
function handleError(error) {
    debugLog(`❌ خطا: ${error}`, 'error');
    showNotification(error, 'error', 5000);
}

function handleRoomSettingsUpdate(settings) {
    roomSettings = settings;
    debugLog('⚙️ تنظیمات اتاق بروزرسانی شد', 'info');
}

function handlePlayerStatusUpdate(playerId, status) {
    if (players[playerId]) {
        players[playerId].status = status;
        // TODO: بروزرسانی UI
    }
}

function handleRoleAssigned(role) {
    debugLog(`🎭 نقش شما: ${role}`, 'info');
    showNotification(`نقش شما: ${role}`, 'info', 5000);
}

function handleTimerUpdate(seconds) {
    // تایمر از سرور
    startTimer(seconds);
}

// ==================== Event Listeners ====================
document.addEventListener('DOMContentLoaded', () => {
    // چت input
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
        messageInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendMessage();
            }
        });
    }
    
    // ESC برای بستن پنل‌ها
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            // بستن ویدیو بزرگ
            const enlargedVideo = document.getElementById('enlargedVideo');
            if (enlargedVideo.style.display !== 'none') {
                closeEnlargedVideo();
                return;
            }
            
            // بستن تنظیمات
            const settings = document.getElementById('quickSettings');
            if (settings.style.display !== 'none') {
                toggleSettings();
                return;
            }
        }
    });
    
    // ج
