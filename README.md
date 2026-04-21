# tencent-realtime-asr-demo — 实时语音识别体验

使用麦克风实时录音识别，支持话者分离（区分多个说话人），适用于实时会议场景。

## 前置依赖

- Go 1.18+
- 腾讯云账号（AppID、SecretID、SecretKey）

## 快速开始

```bash
# 1. 首次使用：创建配置文件
make setup

# 2. 编辑 config.json，填入腾讯云密钥
#    密钥获取: https://console.cloud.tencent.com/cam/capi

# 3. 编译并启动（自动打开浏览器）
make run

# 或者不自动打开浏览器
make run-silent
```

### config.json 格式

```json
{
  "port": 8080,
  "appid": "YOUR_APPID",
  "secret_id": "YOUR_SECRET_ID",
  "secret_key": "YOUR_SECRET_KEY"
}
```

## 目录结构

```
tencent-realtime-asr-demo/
├── main.go              # 入口：HTTP 路由 + 自动打开浏览器
├── handler.go           # WebSocket 处理 + SDK 桥接
├── config.go            # 配置读取
├── config.json.example  # 配置模板（占位符）
├── config.json          # 实际配置（.gitignore，不提交）
├── Makefile             # 构建脚本
├── .gitignore           # 忽略密钥和二进制
└── static/              # 前端页面
    ├── index.html
    ├── app.js
    └── style.css
```

## 密钥安全

- `config.json` 已加入 `.gitignore`，**不会被提交到 Git**
- 仓库只包含 `config.json.example`（占位符）
- 每个开发者需要自行创建 `config.json` 并填入自己的密钥

## 功能说明

- **麦克风录音**：点击"开始识别"，实时录音并识别
- **文件识别**：上传本地音频文件识别（支持 wav、mp3、m4a 等常见格式）
- **句子模式**：使用 `16k_zh_en_speaker` 引擎 + `SpeakerRecognizer` SDK，每次返回全量句子列表
- **话者分离**：开启后区分不同说话人，以聊天气泡形式展示；关闭后以字幕形式展示
- **分句策略**：语义单句（每句独立）或段落（同一人连续发言聚合）
- **WAV 导出**：识别结束后可导出录音为 WAV 文件
