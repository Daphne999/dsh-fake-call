# Changelog

## 0.1.0 — 2026-11-04

首个版本。

- 来电页 /fake-call：响铃、接听、挂断、计时
- 本机 TTS（Windows SAPI）出声，零 API key，带 md5 缓存
- 通话对话走 DSH 会话，oneLine() 保证口语短句
- ake_call 工具：让 agent 主动振铃
- 业务内核 lib/call.js 与宿主解耦，	est/smoke.mjs 8 项全过（含真实合成 wav）