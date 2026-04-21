// ===== DOM Elements =====
const elEngineModel = document.getElementById('engineModel');
const elSpeakerDiarization = document.getElementById('speakerDiarization');
const elDiarizationLabel = document.getElementById('diarizationLabel');
const elSentenceStrategy = document.getElementById('sentenceStrategy');
const elBtnStart = document.getElementById('btnStart');
const elBtnStop = document.getElementById('btnStop');
const elResultMeta = document.getElementById('resultMeta');
const elVoiceIdDisplay = document.getElementById('voiceIdDisplay');
const elBtnCopyVoiceId = document.getElementById('btnCopyVoiceId');
const elBtnExportWav = document.getElementById('btnExportWav');
const elStatusDot = document.getElementById('statusDot');
const elStatusText = document.getElementById('statusText');
const elResultArea = document.getElementById('resultArea');
const elResultPlaceholder = document.getElementById('resultPlaceholder');
const elLogArea = document.getElementById('logArea');
const elBtnClearLog = document.getElementById('btnClearLog');
const elMicStatus = document.getElementById('micStatus');
const elMicTimer = document.getElementById('micTimer');
const elMicElapsed = document.getElementById('micElapsed');

// Input mode tabs
const elTabMic = document.getElementById('tabMic');
const elTabFile = document.getElementById('tabFile');
const elPanelMic = document.getElementById('panelMic');
const elPanelFile = document.getElementById('panelFile');

// File upload
const elAudioFile = document.getElementById('audioFile');
const elFileInfo = document.getElementById('fileInfo');
const elAudioMeta = document.getElementById('audioMeta');
const elMetaFormat = document.getElementById('metaFormat');
const elMetaSampleRate = document.getElementById('metaSampleRate');
const elMetaDuration = document.getElementById('metaDuration');
const elSpeedControl = document.getElementById('speedControl');
const elSpeedSlider = document.getElementById('speedSlider');
const elSpeedValue = document.getElementById('speedValue');

// ===== Speaker Diarization Toggle =====
elSpeakerDiarization.addEventListener('change', () => {
    elDiarizationLabel.textContent = elSpeakerDiarization.checked ? '开启' : '关闭';
});

// ===== Log Area =====
elBtnClearLog.addEventListener('click', () => { elLogArea.innerHTML = ''; });

function appendLog(msg) {
    const now = new Date();
    const ts = [now.getHours(), now.getMinutes(), now.getSeconds()]
        .map(n => String(n).padStart(2, '0')).join(':')
        + '.' + String(now.getMilliseconds()).padStart(3, '0');
    const typeClass = 'log-type-' + (msg.type || 'unknown');
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `<span class="log-time">${ts}</span><span class="${typeClass}">${JSON.stringify(msg)}</span>`;
    elLogArea.appendChild(entry);
    elLogArea.scrollTop = elLogArea.scrollHeight;
}

// ===== State =====
let ws = null;
let sending = false;
let stoppingByUser = false;
let currentVoiceId = null;
let audioChunks = [];
let sessionId = 0;

let micStream = null;
let micAudioContext = null;
let micWorklet = null;
let micTimerInterval = null;
let micStartTime = 0;

// Input mode (mic / file)
let inputMode = 'mic';
let selectedFile = null;

// 文件扩展名 → SDK VoiceFormat 常量
const EXT_FORMAT_MAP = {
    'pcm': 1, 'wav': 12, 'mp3': 8, 'm4a': 14,
    'aac': 16, 'opus': 10, 'ogg': 10, 'silk': 6, 'speex': 4
};
// 不同格式的默认发送倍速：PCM/WAV 实时速度 1x，压缩格式解压快可提速
const DEFAULT_SPEED = {
    'pcm': 1.0, 'wav': 1.0,
    'mp3': 2.0, 'm4a': 2.0, 'aac': 2.0,
    'opus': 3.0, 'ogg': 3.0, 'silk': 3.0, 'speex': 3.0
};
const MAX_SPEED = 3.0;

const SPEAKER_COLORS = ['#4a7dff', '#52c41a', '#faad14', '#ff4d4f', '#9254de', '#13c2c2'];

let sentenceMap = {};
let speakerOrderMap = {};
let speakerOrderCounter = 0;
let lastConfirmedBubbleEl = null;
let pendingSpanMap = {};

// ===== Input Mode Tabs =====
function switchMode(mode) {
    inputMode = mode;
    elTabMic.classList.toggle('active', mode === 'mic');
    elTabFile.classList.toggle('active', mode === 'file');
    elPanelMic.style.display = mode === 'mic' ? '' : 'none';
    elPanelFile.style.display = mode === 'file' ? '' : 'none';
    if (mode === 'file') {
        elBtnStart.disabled = !selectedFile;
    } else {
        elBtnStart.disabled = false;
    }
}
elTabMic.addEventListener('click', () => switchMode('mic'));
elTabFile.addEventListener('click', () => switchMode('file'));

// ===== File Selection =====
elAudioFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    selectedFile = file;
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    elFileInfo.textContent = `${file.name} (${sizeMB}MB)`;
    elFileInfo.classList.add('has-file');
    elBtnStart.disabled = false;
    parseAudioMeta(file);
});

// Speed slider
elSpeedSlider.addEventListener('input', () => {
    elSpeedValue.textContent = parseFloat(elSpeedSlider.value).toFixed(1) + 'x';
});

// ===== Audio Meta Parsing =====
function getFileExt(filename) {
    const parts = filename.split('.');
    return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : '';
}

function formatDuration(seconds) {
    if (!seconds || !isFinite(seconds)) return '—';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 10);
    return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${ms}`;
}

async function parseAudioMeta(file) {
    const ext = getFileExt(file.name);
    elMetaFormat.textContent = ext.toUpperCase();
    // 根据格式设默认倍速
    const defaultSpeed = Math.min(DEFAULT_SPEED[ext] || 1.0, MAX_SPEED);
    elSpeedSlider.value = defaultSpeed;
    elSpeedValue.textContent = defaultSpeed.toFixed(1) + 'x';
    elAudioMeta.style.display = '';
    elSpeedControl.style.display = '';

    if (ext === 'pcm') {
        elMetaSampleRate.textContent = '16000 Hz (假设)';
        const durationSec = file.size / (16000 * 2 * 1);
        elMetaDuration.textContent = formatDuration(durationSec) + ' (估算)';
    } else if (ext === 'wav') {
        try {
            const headerBuf = await file.slice(0, 44).arrayBuffer();
            const view = new DataView(headerBuf);
            const sampleRate = view.getUint32(24, true);
            const bitsPerSample = view.getUint16(34, true);
            const numChannels = view.getUint16(22, true);
            const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
            const dataSize = file.size - 44;
            const durationSec = dataSize / byteRate;
            elMetaSampleRate.textContent = sampleRate + ' Hz, ' + bitsPerSample + 'bit, ' + numChannels + 'ch';
            elMetaDuration.textContent = formatDuration(durationSec);
        } catch {
            elMetaSampleRate.textContent = '解析失败';
            elMetaDuration.textContent = '—';
        }
    } else {
        elMetaSampleRate.textContent = '—';
        elMetaDuration.textContent = '解析中...';
        try {
            const url = URL.createObjectURL(file);
            const audio = new Audio();
            audio.preload = 'metadata';
            audio.src = url;
            await new Promise((resolve, reject) => {
                audio.onloadedmetadata = resolve;
                audio.onerror = reject;
                setTimeout(reject, 5000);
            });
            elMetaDuration.textContent = formatDuration(audio.duration);
            URL.revokeObjectURL(url);
        } catch {
            elMetaDuration.textContent = '无法解析';
        }
    }
}

// ===== Copy & Toast =====
function showToast(message, isError) {
    const toast = document.createElement('div');
    toast.className = 'copy-toast' + (isError ? ' copy-toast-error' : '');
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.classList.add('visible'); });
    setTimeout(() => {
        toast.classList.remove('visible');
        setTimeout(() => toast.remove(), 300);
    }, 1500);
}

function handleCopyClick(btn, textEl) {
    const text = textEl.textContent.trim();
    if (!text || text === '—') { showToast('暂无内容可复制', true); return; }
    navigator.clipboard.writeText(text).then(() => {
        btn.textContent = '✅';
        showToast('已复制到剪贴板');
        setTimeout(() => { btn.textContent = '📋'; }, 1500);
    }).catch(() => showToast('复制失败', true));
}

elBtnCopyVoiceId.addEventListener('click', () => handleCopyClick(elBtnCopyVoiceId, elVoiceIdDisplay));

// ===== WAV Export =====
function buildWavBlob(pcmChunks) {
    let totalLen = 0;
    for (const c of pcmChunks) totalLen += c.byteLength;
    const buf = new ArrayBuffer(44 + totalLen);
    const view = new DataView(buf);
    const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
    const sampleRate = 16000, bitsPerSample = 16, numChannels = 1;
    const byteRate = sampleRate * numChannels * bitsPerSample / 8;
    const blockAlign = numChannels * bitsPerSample / 8;
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + totalLen, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    writeStr(36, 'data');
    view.setUint32(40, totalLen, true);
    let offset = 44;
    for (const chunk of pcmChunks) {
        const src = new Uint8Array(chunk instanceof ArrayBuffer ? chunk : chunk.buffer || chunk);
        new Uint8Array(buf, offset).set(src);
        offset += src.byteLength;
    }
    return new Blob([buf], { type: 'audio/wav' });
}

elBtnExportWav.addEventListener('click', () => {
    if (audioChunks.length === 0) { showToast('暂无音频数据', true); return; }
    const blob = buildWavBlob(audioChunks);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (currentVoiceId || 'audio') + '.wav';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('WAV 已导出');
});

// ===== Helpers =====
function formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = String(Math.floor(totalSec / 60)).padStart(2, '0');
    const sec = String(totalSec % 60).padStart(2, '0');
    return `${min}:${sec}`;
}

function formatTimeRange(startMs, endMs) {
    return `${formatTime(startMs)} - ${formatTime(endMs)}`;
}

function setStatus(state, text) {
    elStatusDot.className = 'status-dot ' + state;
    elStatusText.textContent = text;
}

// ===== Render: Subtitle (no diarization) =====
// 每个 sentence_id 对应一个独立气泡：
// - 中间态（sentence_type===0）：实时更新该气泡文本，末尾加 "..." 表示未定
// - 稳态（sentence_type===1）：去掉 "..." 并定格，下一个 sentence_id 自动创建新气泡
function renderSubtitle(sentence) {
    const id = 'subtitle-' + sentence.sentence_id;
    const isInterim = sentence.sentence_type === 0;
    let entry = sentenceMap[id];

    if (!entry) {
        const el = document.createElement('div');
        el.className = 'subtitle-item subtitle-interim';
        el.id = id;
        const timeSpan = document.createElement('span');
        timeSpan.className = 'subtitle-time';
        el.appendChild(timeSpan);
        const textSpan = document.createElement('span');
        textSpan.className = 'subtitle-text';
        el.appendChild(textSpan);
        elResultArea.appendChild(el);
        entry = { el: el };
        sentenceMap[id] = entry;
    }

    const el = entry.el;
    el.querySelector('.subtitle-time').textContent = formatTimeRange(sentence.start_time, sentence.end_time);
    const textSpan = el.querySelector('.subtitle-text');
    if (isInterim) {
        textSpan.textContent = sentence.sentence + ' ...';
        textSpan.className = 'subtitle-text interim';
    } else {
        textSpan.textContent = sentence.sentence;
        textSpan.className = 'subtitle-text';
        el.className = 'subtitle-item'; // 去掉 interim 类名，定格
    }
    elResultArea.scrollTop = elResultArea.scrollHeight;
}

// ===== Render: Speaker Bubble =====
function renderBubble(sentence) {
    const id = 'sent-' + sentence.sentence_id;
    const speakerId = sentence.speaker_id;
    const isUnknown = speakerId < 0;
    const isInterim = sentence.sentence_type === 0;

    if (isUnknown) {
        const pendingText = sentence.sentence + (isInterim ? ' ...' : '');
        let pending = pendingSpanMap[id];
        if (pending) {
            pending.spanEl.textContent = pendingText;
            elResultArea.scrollTop = elResultArea.scrollHeight;
            return;
        }
        if (lastConfirmedBubbleEl) {
            const body = lastConfirmedBubbleEl.querySelector('.bubble-body');
            const span = document.createElement('span');
            span.className = 'pending-text';
            span.dataset.sentenceId = id;
            span.textContent = pendingText;
            body.appendChild(span);
            pendingSpanMap[id] = { hostEl: lastConfirmedBubbleEl, spanEl: span };
        } else {
            renderFallbackPendingBubble(id, pendingText, isInterim);
        }
        elResultArea.scrollTop = elResultArea.scrollHeight;
        return;
    }

    if (pendingSpanMap[id]) {
        pendingSpanMap[id].spanEl.remove();
        delete pendingSpanMap[id];
    }

    let entry = sentenceMap[id];
    let insertBefore = null;
    if (entry && entry.speakerId !== speakerId) {
        insertBefore = entry.el.nextSibling;
        entry.el.remove();
        entry = null;
        delete sentenceMap[id];
    }

    if (!entry) {
        if (!(speakerId in speakerOrderMap)) {
            speakerOrderMap[speakerId] = speakerOrderCounter++;
        }
        const orderIdx = speakerOrderMap[speakerId];
        const side = orderIdx % 2 === 0 ? 'left' : 'right';
        const colorIdx = orderIdx % SPEAKER_COLORS.length;

        const el = document.createElement('div');
        el.id = id;
        el.className = `bubble-row speaker-${side} speaker-${colorIdx}`;
        const wrapper = document.createElement('div');
        wrapper.className = 'bubble-wrapper';
        const header = document.createElement('div');
        header.className = 'bubble-header';
        const badge = document.createElement('span');
        badge.className = `speaker-badge speaker-color-${colorIdx}`;
        const nameSpan = document.createElement('span');
        nameSpan.className = 'speaker-name';
        nameSpan.textContent = `说话人 ${speakerId}`;
        const timeSpan = document.createElement('span');
        timeSpan.className = 'bubble-time';
        header.appendChild(badge);
        header.appendChild(nameSpan);
        header.appendChild(timeSpan);
        const body = document.createElement('div');
        body.className = 'bubble-body';
        wrapper.appendChild(header);
        wrapper.appendChild(body);
        el.appendChild(wrapper);

        if (insertBefore) elResultArea.insertBefore(el, insertBefore);
        else elResultArea.appendChild(el);
        entry = { el: el, speakerId: speakerId };
        sentenceMap[id] = entry;
    }

    const el = entry.el;
    const timeSpan = el.querySelector('.bubble-time');
    const body = el.querySelector('.bubble-body');
    timeSpan.textContent = formatTimeRange(sentence.start_time, sentence.end_time);
    body.querySelectorAll('.pending-text').forEach(s => s.remove());
    Array.from(body.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).forEach(n => n.remove());
    const textNode = document.createTextNode(sentence.sentence + (isInterim ? ' ...' : ''));
    body.insertBefore(textNode, body.firstChild);
    body.className = 'bubble-body' + (isInterim ? ' interim' : '');
    entry.speakerId = speakerId;
    lastConfirmedBubbleEl = el;
    elResultArea.scrollTop = elResultArea.scrollHeight;
}

function renderFallbackPendingBubble(id, text, isInterim) {
    let entry = sentenceMap[id];
    if (!entry) {
        const el = document.createElement('div');
        el.id = id;
        el.className = 'bubble-row speaker-left speaker-unknown';
        const wrapper = document.createElement('div');
        wrapper.className = 'bubble-wrapper';
        const header = document.createElement('div');
        header.className = 'bubble-header';
        const badge = document.createElement('span');
        badge.className = 'speaker-badge speaker-color-unknown';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'speaker-name';
        nameSpan.textContent = '说话人不确定';
        const timeSpan = document.createElement('span');
        timeSpan.className = 'bubble-time';
        header.appendChild(badge);
        header.appendChild(nameSpan);
        header.appendChild(timeSpan);
        const body = document.createElement('div');
        body.className = 'bubble-body';
        wrapper.appendChild(header);
        wrapper.appendChild(body);
        el.appendChild(wrapper);
        elResultArea.appendChild(el);
        entry = { el: el, speakerId: -1 };
        sentenceMap[id] = entry;
    }
    const body = entry.el.querySelector('.bubble-body');
    body.textContent = text;
    body.className = 'bubble-body' + (isInterim ? ' interim' : '');
}

// ===== Start Recognition =====
elBtnStart.addEventListener('click', () => {
    if (inputMode === 'file' && !selectedFile) return;
    startRecognition();
});

async function startRecognition() {
    elResultArea.innerHTML = '';
    elLogArea.innerHTML = '';
    sentenceMap = {};
    speakerOrderMap = {};
    speakerOrderCounter = 0;
    lastConfirmedBubbleEl = null;
    pendingSpanMap = {};
    audioChunks = [];
    elBtnExportWav.disabled = true;
    elResultPlaceholder?.remove();
    elResultMeta.style.display = 'flex';
    elVoiceIdDisplay.textContent = '—';
    setStatus('connecting', '连接中...');

    elBtnStart.disabled = true;
    elBtnStop.disabled = false;
    sending = true;

    const currentSession = ++sessionId;
    const useSpeaker = elSpeakerDiarization.checked;

    // 构造 start 消息
    let voiceFormat = 0, fileName = '', speedFactor = 0;
    if (inputMode === 'file') {
        const ext = getFileExt(selectedFile.name);
        voiceFormat = EXT_FORMAT_MAP[ext] || 0;
        fileName = selectedFile.name;
        speedFactor = Math.min(parseFloat(elSpeedSlider.value) || 1.0, MAX_SPEED);
    }

    const startPayload = {
        type: 'start',
        engine_model_type: elEngineModel.value,
        speaker_diarization: useSpeaker ? 1 : 0,
        sentence_strategy: parseInt(elSentenceStrategy.value),
        source: inputMode,
        voice_format: voiceFormat,
        file_name: fileName,
        speed_factor: speedFactor
    };

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        if (currentSession !== sessionId) return;
        ws.send(JSON.stringify(startPayload));
        if (inputMode === 'file') {
            sendAudioFile(selectedFile);
        } else {
            startMicCapture();
        }
    };

    ws.onmessage = (event) => {
        if (currentSession !== sessionId) return;
        const msg = JSON.parse(event.data);
        if (msg.type !== 'sentences') {
            console.log('[ws] type=' + msg.type, msg);
        }
        appendLog(msg);
        handleServerMessage(msg, useSpeaker);
    };

    ws.onerror = (err) => {
        if (currentSession !== sessionId) return;
        console.error('WebSocket error:', err);
        setStatus('error', '连接错误');
        stopMicCapture();
        resetControls();
    };

    ws.onclose = () => {
        if (currentSession !== sessionId) return;
        stopMicCapture();
        if (sending) setStatus('error', '连接意外断开');
        else if (stoppingByUser) setStatus('done', '已停止');
        if (audioChunks.length > 0) elBtnExportWav.disabled = false;
        ws = null;
        resetControls();
    };
}

function handleServerMessage(msg, useSpeaker) {
    switch (msg.type) {
        case 'voice_id':
            if (msg.voice_id) {
                currentVoiceId = msg.voice_id;
                elVoiceIdDisplay.textContent = msg.voice_id;
            }
            break;

        case 'start':
            setStatus('running', '识别中...');
            break;

        case 'sentences':
            if (msg.sentences) {
                msg.sentences.forEach(s => {
                    if (useSpeaker) renderBubble(s);
                    else renderSubtitle(s);
                });
            }
            break;

        case 'end':
            setStatus('done', '识别完成');
            sending = false;
            if (audioChunks.length > 0) elBtnExportWav.disabled = false;
            resetControls();
            if (ws) { ws.close(); ws = null; }
            break;

        case 'error':
            setStatus('error', `错误: ${msg.message}`);
            sending = false;
            stopMicCapture();
            if (ws) { ws.close(); ws = null; }
            resetControls();
            break;
    }
}

// ===== Stop =====
elBtnStop.addEventListener('click', () => stopRecognition());

function stopRecognition() {
    sending = false;
    stoppingByUser = true;
    stopMicCapture();
    setStatus('running', '停止中...');
    elBtnStop.disabled = true;

    if (currentVoiceId) {
        fetch(`/api/stop?voice_id=${encodeURIComponent(currentVoiceId)}`)
            .then(r => r.json())
            .catch(err => console.error('[stop] error:', err));
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'stop' })); } catch (e) {}
    }

    const stopSession = sessionId;
    setTimeout(() => {
        if (sessionId !== stopSession) return;
        if (ws) {
            try { ws.close(); } catch (e) {}
            ws = null;
            setStatus('done', '已停止（超时）');
            resetControls();
        }
    }, 5000);
}

function resetControls() {
    sending = false;
    stoppingByUser = false;
    currentVoiceId = null;
    if (inputMode === 'file') {
        elBtnStart.disabled = !selectedFile;
    } else {
        elBtnStart.disabled = false;
    }
    elBtnStop.disabled = true;
}

// ===== Send Audio File =====
// 按 16KB 切片发送，后端会缓冲成 6400 字节块并按 speed_factor 限流
const UPLOAD_CHUNK_SIZE = 16000;
async function sendAudioFile(file) {
    const buffer = await file.arrayBuffer();
    const totalBytes = buffer.byteLength;
    let offset = 0;
    const ext = getFileExt(file.name);
    const isPcm = (ext === 'pcm');
    while (offset < totalBytes && sending && ws && ws.readyState === WebSocket.OPEN) {
        const end = Math.min(offset + UPLOAD_CHUNK_SIZE, totalBytes);
        const chunk = buffer.slice(offset, end);
        // 仅 PCM 数据可直接拼成 WAV 导出；压缩格式跳过
        if (isPcm) audioChunks.push(chunk.slice(0));
        ws.send(chunk);
        offset = end;
        await new Promise(r => setTimeout(r, 0));
    }
    if (ws && ws.readyState === WebSocket.OPEN && sending) {
        ws.send(JSON.stringify({ type: 'eof' }));
    }
}

// ===== Microphone Capture =====
async function startMicCapture() {
    try {
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true }
        });
    } catch (err) {
        console.error('getUserMedia error:', err);
        setStatus('error', '无法获取麦克风权限');
        elMicStatus.textContent = '无法获取麦克风: ' + err.message;
        resetControls();
        return;
    }

    micAudioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = micAudioContext.createMediaStreamSource(micStream);
    const processor = micAudioContext.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
        if (!sending || !ws || ws.readyState !== WebSocket.OPEN) return;
        const float32 = e.inputBuffer.getChannelData(0);
        const int16 = new Int16Array(float32.length);
        for (let i = 0; i < float32.length; i++) {
            let s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        ws.send(int16.buffer);
        audioChunks.push(int16.buffer.slice(0));
    };

    source.connect(processor);
    processor.connect(micAudioContext.destination);
    micWorklet = { source, processor };

    micStartTime = Date.now();
    elMicStatus.style.display = 'none';
    elMicTimer.style.display = '';
    micTimerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - micStartTime) / 1000);
        const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const ss = String(elapsed % 60).padStart(2, '0');
        elMicElapsed.textContent = `${mm}:${ss}`;
    }, 200);
}

function stopMicCapture() {
    if (micWorklet) {
        micWorklet.processor.disconnect();
        micWorklet.source.disconnect();
        micWorklet = null;
    }
    if (micAudioContext) {
        micAudioContext.close().catch(() => {});
        micAudioContext = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }
    if (micTimerInterval) {
        clearInterval(micTimerInterval);
        micTimerInterval = null;
    }
    elMicTimer.style.display = 'none';
    elMicStatus.style.display = '';
    elMicStatus.textContent = '点击下方按钮开始录音';
    elMicElapsed.textContent = '00:00';
}
