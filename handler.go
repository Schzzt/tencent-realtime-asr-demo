package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tencentcloud/tencentcloud-speech-sdk-go/asr"
	"github.com/tencentcloud/tencentcloud-speech-sdk-go/common"
)

// --- WebSocket upgrader ---

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

// --- Session registry for HTTP stop ---

var sessionRegistry = struct {
	sync.Mutex
	m map[string]*atomic.Int32
}{m: make(map[string]*atomic.Int32)}

func registerSession(voiceID string, aborted *atomic.Int32) {
	sessionRegistry.Lock()
	sessionRegistry.m[voiceID] = aborted
	sessionRegistry.Unlock()
}

func unregisterSession(voiceID string) {
	sessionRegistry.Lock()
	delete(sessionRegistry.m, voiceID)
	sessionRegistry.Unlock()
}

func AbortSession(voiceID string) bool {
	sessionRegistry.Lock()
	aborted, ok := sessionRegistry.m[voiceID]
	sessionRegistry.Unlock()
	if ok {
		aborted.Store(1)
		return true
	}
	return false
}

// --- Frontend → Backend message types ---

type StartMessage struct {
	Type               string  `json:"type"`
	EngineModelType    string  `json:"engine_model_type"`
	SpeakerDiarization int     `json:"speaker_diarization"`
	SentenceStrategy   int     `json:"sentence_strategy"`
	VoiceFormat        int     `json:"voice_format"`  // SDK 音频格式常量，0 或缺省时用 FileName 扩展名推导
	FileName           string  `json:"file_name"`     // 仅用于后端按扩展名推导 VoiceFormat
	SpeedFactor        float64 `json:"speed_factor"`  // 文件发送倍速，0=不限速（麦克风），>0=按倍速节流
	Source             string  `json:"source"`        // "mic" 或 "file"
}

// --- Backend → Frontend message types ---

type OutMessage struct {
	Type      string            `json:"type"`
	VoiceID   string            `json:"voice_id,omitempty"`
	Sentences []OutSentenceItem `json:"sentences,omitempty"`
	Code      int               `json:"code,omitempty"`
	Message   string            `json:"message,omitempty"`
}

type OutSentenceItem struct {
	SentenceId   int32  `json:"sentence_id"`
	Sentence     string `json:"sentence"`
	SentenceType int    `json:"sentence_type"`
	SpeakerId    int32  `json:"speaker_id"`
	StartTime    uint32 `json:"start_time"`
	EndTime      uint32 `json:"end_time"`
}

// --- Shared base listener for writing to frontend ---

type baseSender struct {
	frontConn *websocket.Conn
	writeMu   sync.Mutex
	closed    bool
}

func (s *baseSender) sendJSON(msg *OutMessage) {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.closed {
		return
	}
	if err := s.frontConn.WriteJSON(msg); err != nil {
		log.Printf("send to frontend error: %v", err)
	}
}

func (s *baseSender) sendEnd() {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	if s.closed {
		return
	}
	if err := s.frontConn.WriteJSON(&OutMessage{Type: "end"}); err != nil {
		log.Printf("send end to frontend error: %v", err)
	}
	s.closed = true
}

// --- Listener (implements asr.SpeakerRecognitionListener) ---

type sentenceListener struct {
	*baseSender
}

func (l *sentenceListener) OnRecognitionStart(resp *asr.SpeakerRecognitionResponse) {
	l.sendJSON(&OutMessage{Type: "start"})
}

func (l *sentenceListener) OnRecognitionSentences(resp *asr.SpeakerRecognitionResponse) {
	if resp.Sentences == nil {
		return
	}
	for i, s := range resp.Sentences.SentenceList {
		log.Printf("  [%d] sid=%d spk=%d type=%d len=%d text=%.40s",
			i, s.SentenceId, s.SpeakerId, s.SentenceType, len(s.Sentence), s.Sentence)
	}
	items := make([]OutSentenceItem, 0, len(resp.Sentences.SentenceList))
	for _, s := range resp.Sentences.SentenceList {
		items = append(items, OutSentenceItem{
			SentenceId:   s.SentenceId,
			Sentence:     s.Sentence,
			SentenceType: s.SentenceType,
			SpeakerId:    s.SpeakerId,
			StartTime:    s.StartTime,
			EndTime:      s.EndTime,
		})
	}
	l.sendJSON(&OutMessage{
		Type:      "sentences",
		Sentences: items,
	})
}

func (l *sentenceListener) OnSentenceEnd(resp *asr.SpeakerRecognitionResponse) {
	l.sendJSON(&OutMessage{
		Type:    "end",
		Code:    resp.Code,
		Message: resp.Message,
	})
}

func (l *sentenceListener) OnFail(resp *asr.SpeakerRecognitionResponse, err error) {
	l.sendJSON(&OutMessage{
		Type:    "error",
		Code:    resp.Code,
		Message: fmt.Sprintf("%s: %v", resp.Message, err),
	})
}

const sdkChunkSize = 6400

// --- Voice format mapping ---

var extToVoiceFormat = map[string]int{
	".pcm":   asr.AudioFormatPCM,
	".wav":   asr.AudioFormatWav,
	".mp3":   asr.AudioFormatMp3,
	".m4a":   asr.AudioFormatM4A,
	".aac":   asr.AudioFormatAAC,
	".opus":  asr.AudioFormatOpus,
	".ogg":   asr.AudioFormatOpus,
	".silk":  asr.AudioFormatSilk,
	".speex": asr.AudioFormatSpeex,
}

func resolveVoiceFormat(startMsg *StartMessage) int {
	if startMsg.VoiceFormat > 0 {
		return startMsg.VoiceFormat
	}
	ext := strings.ToLower(filepath.Ext(startMsg.FileName))
	if vf, ok := extToVoiceFormat[ext]; ok {
		return vf
	}
	return asr.AudioFormatPCM
}

// --- Audio rate control (for file upload mode) ---

// pcmMultiplier 返回压缩格式每字节等价的 PCM 字节数（用于估算音频时长）
func pcmMultiplier(voiceFormat int) int {
	switch voiceFormat {
	case asr.AudioFormatSpeex, asr.AudioFormatSilk, asr.AudioFormatOpus:
		return 10
	case asr.AudioFormatMp3:
		return 8
	case asr.AudioFormatM4A, asr.AudioFormatAAC:
		return 8
	default:
		return 1
	}
}

// audioDurationMs 按 16kHz 16bit 单声道估算 PCM 时长（32 bytes/ms）
func audioDurationMs(pcmBytes int) int {
	return pcmBytes / 32
}

// --- Main handler ---

func HandleWebSocket(w http.ResponseWriter, r *http.Request, cfg *Config) {
	frontConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("upgrade error: %v", err)
		return
	}
	defer frontConn.Close()

	// 1. Read start config
	_, msgData, err := frontConn.ReadMessage()
	if err != nil {
		log.Printf("read start message error: %v", err)
		return
	}

	var startMsg StartMessage
	if err := json.Unmarshal(msgData, &startMsg); err != nil {
		log.Printf("parse start message error: %v", err)
		sendError(frontConn, -1, "invalid start message")
		return
	}
	if startMsg.Type != "start" {
		sendError(frontConn, -1, "first message must be type=start")
		return
	}

	engineModel := startMsg.EngineModelType
	if engineModel == "" {
		engineModel = "16k_zh_en_speaker"
	}

	// 判断来源：麦克风固定 PCM，文件走扩展名推导
	source := startMsg.Source
	if source == "" {
		source = "mic"
	}
	var voiceFormat int
	if source == "file" {
		voiceFormat = resolveVoiceFormat(&startMsg)
	} else {
		voiceFormat = asr.AudioFormatPCM
	}

	// 限速参数（仅文件模式生效）
	speedFactor := startMsg.SpeedFactor
	if speedFactor < 0 {
		speedFactor = 1.0
	}
	if speedFactor > 3.0 {
		speedFactor = 3.0
	}

	log.Printf("using credential appid=%s", cfg.AppID)

	// 2. Create SpeakerRecognizer (sentence mode)
	sender := &baseSender{frontConn: frontConn}
	credential := common.NewCredential(cfg.SecretID, cfg.SecretKey)
	listener := &sentenceListener{baseSender: sender}

	rec := asr.NewSpeakerRecognizer(cfg.AppID, credential, engineModel, listener)
	rec.VoiceFormat = voiceFormat
	rec.SpeakerDiarization = startMsg.SpeakerDiarization
	sentenceStrategy := startMsg.SentenceStrategy
	if sentenceStrategy < 0 || sentenceStrategy > 1 {
		sentenceStrategy = 0
	}
	rec.SentenceStrategy = sentenceStrategy

	// 3. Start
	log.Printf("starting recognizer: source=%s engine=%s format=%d speed=%.1f speaker_diarization=%d sentence_strategy=%d",
		source, engineModel, voiceFormat, speedFactor, startMsg.SpeakerDiarization, sentenceStrategy)
	if err := rec.Start(); err != nil {
		log.Printf("recognizer start error: %v", err)
		sendError(frontConn, -1, fmt.Sprintf("recognizer start failed: %v", err))
		return
	}
	voiceID := rec.VoiceID
	log.Printf("recognizer started, voiceID=%s", voiceID)

	var aborted atomic.Int32
	registerSession(voiceID, &aborted)
	defer unregisterSession(voiceID)

	sender.sendJSON(&OutMessage{
		Type:    "voice_id",
		VoiceID: voiceID,
	})

	// 4. Reader goroutine
	dataChan := make(chan []byte, 256)
	readerDone := make(chan struct{})
	var allAudioData []byte

	go func() {
		defer close(readerDone)
		totalBytes := 0
		chunkCount := 0
		eofReceived := false
		for {
			msgType, data, err := frontConn.ReadMessage()
			if err != nil {
				log.Printf("read from frontend error: %v", err)
				aborted.Store(1)
				if !eofReceived {
					close(dataChan)
				}
				return
			}

			if msgType == websocket.TextMessage {
				var ctrl struct {
					Type string `json:"type"`
				}
				if json.Unmarshal(data, &ctrl) == nil {
					switch ctrl.Type {
					case "eof":
						log.Printf("received eof from frontend, total %d chunks, %d bytes",
							chunkCount, totalBytes)
						if !eofReceived {
							close(dataChan)
							eofReceived = true
						}
						continue
					case "stop", "abort":
						log.Printf("received %s from frontend, total %d chunks, %d bytes",
							ctrl.Type, chunkCount, totalBytes)
						aborted.Store(1)
						if !eofReceived {
							close(dataChan)
						}
						return
					}
				}
				log.Printf("received unknown text message: %s", string(data))
				continue
			}

			if eofReceived {
				continue
			}
			chunkCount++
			totalBytes += len(data)
			allAudioData = append(allAudioData, data...)
			dataChan <- data
		}
	}()

	// 5. Send loop
	mult := pcmMultiplier(voiceFormat)
	totalSent := 0
	buf := make([]byte, 0, sdkChunkSize*2)

sendLoop:
	for {
		data, ok := <-dataChan
		if !ok {
			break sendLoop
		}
		buf = append(buf, data...)

	drainLoop:
		for {
			select {
			case data, ok := <-dataChan:
				if !ok {
					break drainLoop
				}
				buf = append(buf, data...)
			default:
				break drainLoop
			}
		}

		for len(buf) >= sdkChunkSize {
			if aborted.Load() != 0 {
				break sendLoop
			}

			chunk := buf[:sdkChunkSize]
			if err := rec.Write(chunk); err != nil {
				log.Printf("recognizer write error: %v", err)
				break sendLoop
			}
			totalSent += sdkChunkSize
			buf = buf[sdkChunkSize:]

			// 文件模式下按倍速限流，避免一次性把几十秒音频塞进 SDK
			if speedFactor > 0 {
				pcmEquiv := sdkChunkSize * mult
				durationMs := audioDurationMs(pcmEquiv)
				if durationMs > 0 {
					sleepMs := float64(durationMs) / speedFactor
					remaining := time.Duration(sleepMs) * time.Millisecond
					const tick = 50 * time.Millisecond
					for remaining > 0 {
						if aborted.Load() != 0 {
							break sendLoop
						}
						if remaining > tick {
							time.Sleep(tick)
							remaining -= tick
						} else {
							time.Sleep(remaining)
							remaining = 0
						}
					}
				}
			}
		}
	}

	if len(buf) > 0 && aborted.Load() == 0 {
		if err := rec.Write(buf); err != nil {
			log.Printf("recognizer write remaining error: %v", err)
		} else {
			totalSent += len(buf)
		}
	}

	log.Printf("send loop done, total %d bytes sent to SDK", totalSent)

	// 6. Stop
	if aborted.Load() != 0 {
		log.Printf("user aborted, sending end to frontend immediately")
		sender.sendEnd()
		go func() {
			log.Printf("calling recognizer.Stop() (background, aborted)...")
			if err := rec.Stop(); err != nil {
				log.Printf("recognizer stop error: %v", err)
			}
			log.Printf("recognizer stopped (background)")
		}()
	} else {
		log.Printf("calling recognizer.Stop()...")
		if err := rec.Stop(); err != nil {
			log.Printf("recognizer stop error: %v", err)
		}
		log.Printf("recognizer stopped")
		sender.sendEnd()
	}

	frontConn.Close()
	<-readerDone

	// 7. Save audio as WAV for debugging (仅 PCM 数据有效；压缩格式不存)
	if len(allAudioData) > 0 && voiceFormat == asr.AudioFormatPCM {
		wavPath := filepath.Join("recordings", voiceID+".wav")
		if err := saveWav(wavPath, allAudioData); err != nil {
			log.Printf("save wav error: %v", err)
		} else {
			durationSec := float64(len(allAudioData)) / 32000.0
			log.Printf("saved %s (%.1fs, %d bytes)", wavPath, durationSec, len(allAudioData))
		}
	}
}

func sendError(conn *websocket.Conn, code int, message string) {
	conn.WriteJSON(&OutMessage{
		Type:    "error",
		Code:    code,
		Message: message,
	})
}

// saveWav writes raw PCM data as a 16kHz 16bit mono WAV file.
func saveWav(filePath string, pcmData []byte) error {
	if err := os.MkdirAll(filepath.Dir(filePath), 0755); err != nil {
		return fmt.Errorf("mkdir: %w", err)
	}
	f, err := os.Create(filePath)
	if err != nil {
		return fmt.Errorf("create: %w", err)
	}
	defer f.Close()

	dataLen := uint32(len(pcmData))
	sampleRate := uint32(16000)
	bitsPerSample := uint16(16)
	numChannels := uint16(1)
	byteRate := sampleRate * uint32(numChannels) * uint32(bitsPerSample) / 8
	blockAlign := numChannels * bitsPerSample / 8

	f.Write([]byte("RIFF"))
	binary.Write(f, binary.LittleEndian, uint32(36+dataLen))
	f.Write([]byte("WAVE"))
	f.Write([]byte("fmt "))
	binary.Write(f, binary.LittleEndian, uint32(16))
	binary.Write(f, binary.LittleEndian, uint16(1))
	binary.Write(f, binary.LittleEndian, numChannels)
	binary.Write(f, binary.LittleEndian, sampleRate)
	binary.Write(f, binary.LittleEndian, byteRate)
	binary.Write(f, binary.LittleEndian, blockAlign)
	binary.Write(f, binary.LittleEndian, bitsPerSample)
	f.Write([]byte("data"))
	binary.Write(f, binary.LittleEndian, dataLen)
	_, err = f.Write(pcmData)
	return err
}
