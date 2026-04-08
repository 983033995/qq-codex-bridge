# Provider Boundary

`packages/adapters/codex-desktop` 是唯一理解 Codex 桌面窗口和 CDP 自动化的模块。
`packages/orchestrator` 只能依赖 `ConversationProviderPort` 和 `DesktopDriverPort`。
