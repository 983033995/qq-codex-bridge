# qq-codex-bridge

QQ 到 Codex 桌面端的会话桥接原型。

## 运行门槛

这个项目不要求所有用户都先安装本地语音识别引擎。

语音转文字建议按 3 层能力使用：

1. 基础模式，零额外安装  
   默认优先使用 QQ 事件里自带的 `asr_refer_text`。  
   这意味着即使你不配置任何第三方 STT，也能获得基础语音转写能力。

2. 增强模式，云端 STT  
   可选配置：
   - `volcengine-flash`
   - `openai-compatible`
   
   适合希望提升语音转写稳定性和质量的用户。

3. 高级模式，本地离线 STT  
   可选配置：
   - `local-whisper-cpp`
   
   适合重视隐私、离线能力或不想依赖云端接口的用户。  
   这一模式需要用户自行安装 `whisper.cpp` 和模型文件，因此不作为默认前提。

## STT 配置

### 1. 默认零配置模式

不设置任何 `QQBOT_STT_*` 变量时，项目仍可运行：

- 普通文本消息正常桥接
- 语音消息优先使用 QQ 平台回调中的 `asr_refer_text`
- 没有 `asr_refer_text` 时，才会退回到“附件占位”形式

### 2. 火山引擎 STT

```env
QQBOT_STT_ENABLED=true
QQBOT_STT_PROVIDER=volcengine-flash
QQBOT_STT_MODEL=bigmodel
QQBOT_STT_APP_ID=你的AppID
QQBOT_STT_ACCESS_KEY=你的AccessKey
QQBOT_STT_RESOURCE_ID=volc.bigasr.auc_turbo
QQBOT_STT_ENDPOINT=https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash
```

### 3. OpenAI 兼容 STT

```env
QQBOT_STT_ENABLED=true
QQBOT_STT_PROVIDER=openai-compatible
QQBOT_STT_BASE_URL=https://api.openai.com/v1
QQBOT_STT_API_KEY=你的APIKey
QQBOT_STT_MODEL=whisper-1
```

### 4. 本地离线 whisper.cpp

```env
QQBOT_STT_ENABLED=true
QQBOT_STT_PROVIDER=local-whisper-cpp
QQBOT_STT_BINARY_PATH=/usr/local/bin/whisper-cli
QQBOT_STT_MODEL_PATH=/absolute/path/to/ggml-large-v3.bin
QQBOT_STT_LANGUAGE=zh
```

说明：

- `local-whisper-cpp` 需要额外安装 `whisper.cpp`
- 它是可选增强能力，不是项目默认依赖
- 如果未安装，本项目仍可通过 QQ 自带 ASR 或云端 STT 工作

## STT 日志

当前 bridge 会输出这些 STT 相关日志，便于排查：

- `qq stt started`
- `qq stt completed`
- `qq stt produced no transcript`
- `qq stt fallback used`
- `qq stt failed`

日志中会包含：

- provider
- file
- extension
- durationMs
- transcriptPreview

## Commands

- `npm run dev`
- `npm run check`
- `npm test`

## Skills

仓库内已补充可复用的 Codex 技能说明：

- [skills/qq-codex-thread-management/SKILL.md](/Volumes/13759427003/AI/qq-codex-bridge/skills/qq-codex-thread-management/SKILL.md)
- [skills/qq-codex-runtime/SKILL.md](/Volumes/13759427003/AI/qq-codex-bridge/skills/qq-codex-runtime/SKILL.md)
- [skills/qq-codex-media/SKILL.md](/Volumes/13759427003/AI/qq-codex-bridge/skills/qq-codex-media/SKILL.md)

当前这些技能覆盖的是本项目已经落地的能力：

- QQ 私聊里的真实 Codex 线程查看、切换、新建、fork
- bridge 运行时启动、QQ gateway、CDP 9229、SQLite 绑定与消息链路排障
- QQ 与 Codex 之间的富媒体双向桥接

官方 `openclaw-qqbot` 中的能力目前是部分对齐状态：

- `qqbot-media` 已有对应的 `qq-codex-media`
- `qqbot-channel`、`qqbot-remind`、`qqbot-upgrade` 还没有完成对齐，因为对应的频道 API、提醒和热更新能力尚未完整实现
