# MCP Channel Format Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each bot channel's message formatting rules discoverable by default via MCP tool descriptions plus a dedicated `get_channel_format_guide` tool.

**Architecture:** A static shared guide module in `apps/mcp-server` is imported by the MCP server. Tool descriptions embed summaries; `list_push_targets` enriches each target; a new read-only tool returns full guides (optionally filtered by channel or target alias).

**Tech Stack:** TypeScript, Zod, `@modelcontextprotocol/sdk`, Vitest

## Global Constraints

- Default `push_message.format` remains `plain` (do not silently switch per channel).
- No HTTP public API in this change.
- QQ proactive push remains unsupported; guide must document that.
- Keep Chinese summaries concise; capabilities/tips can be Chinese to match product docs.

---

## File Map

| File | Responsibility |
|---|---|
| `apps/mcp-server/src/channel-format-guide.ts` | Static guides + helpers (`getGuide`, `listGuides`, `enrichTargets`) |
| `apps/mcp-server/src/server.ts` | Register new tool; enrich descriptions & list targets |
| `tests/unit/channel-format-guide.test.ts` | Guide module tests |
| `tests/unit/mcp-push-server.test.ts` | MCP tool exposure & guide/list enrichment |
| `docs/PRODUCT-SPEC-v0.2.md` / `CHANGELOG.md` / `README.md` | Document the new tool |

---

### Task 1: Channel format guide module (TDD)

**Files:**
- Create: `apps/mcp-server/src/channel-format-guide.ts`
- Create: `tests/unit/channel-format-guide.test.ts`

- [x] Write failing tests for feishu/weixin/qq guides and `enrichTargets`
- [x] Implement `CHANNEL_FORMAT_GUIDES`, `getChannelFormatGuide`, `listChannelFormatGuides`, `enrichPushTargetsWithFormatGuide`
- [x] Run `npx vitest run tests/unit/channel-format-guide.test.ts` — pass

### Task 2: Wire MCP server

**Files:**
- Modify: `apps/mcp-server/src/server.ts`
- Modify: `tests/unit/mcp-push-server.test.ts`

- [x] Extend MCP tests for new tool name and list enrichment
- [x] Update `push_message` / `push_task_report` / `list_push_targets` descriptions
- [x] Register `get_channel_format_guide` with optional `channel` / `target`
- [x] Run `npx vitest run tests/unit/mcp-push-server.test.ts` — pass

### Task 3: Docs

**Files:**
- Modify: `docs/PRODUCT-SPEC-v0.2.md`, `CHANGELOG.md`, `README.md` (MCP tool table if present)

- [x] Document `get_channel_format_guide` and recommended formats
- [x] Run full related unit tests once more
