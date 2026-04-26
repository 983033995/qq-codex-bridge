import { execFileSync, spawnSync } from "node:child_process";

const BUNDLE_ID = "com.openai.chat";

// ── Swift runner ──────────────────────────────────────────────────────────────
// ChatGPT Desktop does NOT support AppleScript/JXA. All AX operations go
// through Swift + ApplicationServices / AX API via `swift -` stdin pipe.

function runSwift(code: string, timeoutMs = 15_000): string {
  const result = spawnSync("swift", ["-"], {
    input: code,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.error) throw new Error(`swift spawn error: ${result.error.message}`);
  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    throw new Error(`swift exit ${result.status}: ${stderr.slice(0, 400)}`);
  }
  return (result.stdout ?? "").trim();
}

// Shared Swift preamble (AX helpers + BUNDLE_ID)
const SWIFT_PREAMBLE = `
import Cocoa
import ApplicationServices

let BUNDLE_ID = "${BUNDLE_ID}"

func getAttr(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var v: CFTypeRef?
    AXUIElementCopyAttributeValue(el, attr as CFString, &v)
    return v
}
func getChildren(_ el: AXUIElement) -> [AXUIElement] {
    (getAttr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}
func getRole(_ el: AXUIElement) -> String {
    (getAttr(el, kAXRoleAttribute) as? String) ?? ""
}
func getDesc(_ el: AXUIElement) -> String {
    (getAttr(el, kAXDescriptionAttribute) as? String) ?? ""
}
func findAll(_ el: AXUIElement, role: String, depth: Int = 0, max: Int = 14) -> [AXUIElement] {
    guard depth <= max else { return [] }
    var out: [AXUIElement] = []
    if getRole(el) == role { out.append(el) }
    for child in getChildren(el) { out += findAll(child, role: role, depth: depth+1, max: max) }
    return out
}
func axApp() -> AXUIElement? {
    guard let app = NSWorkspace.shared.runningApplications
        .first(where: { $0.bundleIdentifier == BUNDLE_ID }) else { return nil }
    return AXUIElementCreateApplication(app.processIdentifier)
}
func jsonEscape(_ s: String) -> String {
    s.replacingOccurrences(of: "\\\\", with: "\\\\\\\\")
     .replacingOccurrences(of: "\\"", with: "\\\\\\"")
     .replacingOccurrences(of: "\\n", with: "\\\\n")
     .replacingOccurrences(of: "\\r", with: "\\\\r")
     .replacingOccurrences(of: "\\t", with: "\\\\t")
}
`;

// ── Public API ────────────────────────────────────────────────────────────────

export type AXTextSnapshot = string[];

export function checkAccessibility(): boolean {
  try {
    const out = runSwift(`
import ApplicationServices
print(AXIsProcessTrusted())
`);
    return out === "true";
  } catch {
    return false;
  }
}

export function healthCheck(): {
  appRunning: boolean;
  accessibility: boolean;
  frontmost: boolean;
} {
  try {
    const out = runSwift(`
import Cocoa
import ApplicationServices
let BUNDLE_ID = "${BUNDLE_ID}"
let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == BUNDLE_ID })
let running = app != nil
let trusted = AXIsProcessTrusted()
let front = app?.isActive ?? false
print("\\(running ? "true" : "false") \\(trusted ? "true" : "false") \\(front ? "true" : "false")")
`);
    const parts = out.split(" ");
    return {
      appRunning: parts[0] === "true",
      accessibility: parts[1] === "true",
      frontmost: parts[2] === "true"
    };
  } catch {
    return { appRunning: false, accessibility: false, frontmost: false };
  }
}

export function ensureAppVisible(): void {
  const code = `
${SWIFT_PREAMBLE}
guard let app = NSWorkspace.shared.runningApplications
    .first(where: { $0.bundleIdentifier == BUNDLE_ID }) else {
    print("ERROR: not running"); exit(1)
}
app.activate(options: [])
Thread.sleep(forTimeInterval: 0.8)
print("ok")
`;
  const out = runSwift(code);
  if (out.hasPrefix("ERROR")) throw new Error("ChatGPT Desktop is not running");
}

export function snapshotReplyTexts(): AXTextSnapshot {
  const code = `
${SWIFT_PREAMBLE}
guard let ax = axApp() else { print("[]"); exit(0) }
let sts = findAll(ax, role: "AXStaticText")
var result: [String] = []
for st in sts {
    let d = getDesc(st)
    if d.count > 8 { result.append("\\"\\(jsonEscape(d))\\"") }
}
print("[\\(result.joined(separator: ","))]")
`;
  try {
    const raw = runSwift(code);
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

export function diffTexts(before: AXTextSnapshot, after: AXTextSnapshot): string[] {
  const beforeSet = new Set(before);
  return after.filter((t) => !beforeSet.has(t));
}

// send prompt, wait for reply, collect new text — all in one Swift process
// Output format (stdout):
//   Line 1: status line  "confirmed|not_confirmed completed|not_completed <elapsedMs>"
//   Line 2+: JSON array of new AXStaticText descriptions (the reply)
export type SendAndWaitResult = {
  confirmed: boolean;
  completed: boolean;
  elapsedMs: number;
  replyTexts: string[];
};

export function sendMessage(
  prompt: string,
  opts: {
    attachmentPaths?: string[];
    confirmTimeoutMs?: number;
    completionTimeoutMs?: number;
  } = {}
): SendAndWaitResult {
  const confirmTimeout = Math.round((opts.confirmTimeoutMs ?? 8_000) / 1000);
  const completionTimeout = Math.round((opts.completionTimeoutMs ?? 120_000) / 1000);
  const swiftPrompt = prompt
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
  const swiftAttachmentPaths = `[${(opts.attachmentPaths ?? [])
    .map((path) => `"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
    .join(",")}]`;

  const code = `
${SWIFT_PREAMBLE}
import Foundation
import CoreGraphics

let prompt = "${swiftPrompt}"
let attachmentPaths: [String] = ${swiftAttachmentPaths}
let confirmSecs = ${confirmTimeout}
let completeSecs = ${completionTimeout}
let sendButtonPolls = attachmentPaths.isEmpty ? 40 : 120

guard let ax = axApp() else {
    print("not_confirmed not_completed 0")
    print("[]")
    exit(0)
}

// activate (use empty options — activateIgnoringOtherApps is deprecated/no-op on macOS 14+)
if let nsApp = NSWorkspace.shared.runningApplications
    .first(where: { $0.bundleIdentifier == BUNDLE_ID }) {
    nsApp.activate(options: [])
    Thread.sleep(forTimeInterval: 0.8)
}

// collect AX static text nodes — returns ordered array (preserves duplicates)
func collectTextNodes() -> [String] {
    var out: [String] = []
    for st in findAll(ax, role: "AXStaticText") {
        // try kAXValueAttribute first (richer), fall back to kAXDescriptionAttribute
        var v: CFTypeRef?
        AXUIElementCopyAttributeValue(st, kAXValueAttribute as CFString, &v)
        if let s = v as? String, !s.isEmpty { out.append(s); continue }
        AXUIElementCopyAttributeValue(st, kAXDescriptionAttribute as CFString, &v)
        if let s = v as? String, !s.isEmpty { out.append(s) }
    }
    return out
}
let beforeNodes = collectTextNodes()
let beforeCount = beforeNodes.count

func currentComposer() -> AXUIElement? {
    findAll(ax, role: "AXTextArea").first
}
func pasteAttachmentFiles(_ paths: [String]) -> Bool {
    if paths.isEmpty { return true }
    var urls: [NSURL] = []
    for path in paths {
        guard FileManager.default.fileExists(atPath: path) else { return false }
        urls.append(NSURL(fileURLWithPath: path))
    }
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    guard pasteboard.writeObjects(urls) else { return false }

    let src = CGEventSource(stateID: .hidSystemState)
    let down = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: true)!
    let up = CGEvent(keyboardEventSource: src, virtualKey: 0x09, keyDown: false)!
    down.flags = .maskCommand
    up.flags = .maskCommand
    down.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 0.05)
    up.post(tap: .cghidEventTap)
    Thread.sleep(forTimeInterval: 2.0)
    return true
}
func isEnabled(_ el: AXUIElement) -> Bool {
    (getAttr(el, kAXEnabledAttribute) as? Bool) ?? true
}

// set composer and optional attachments
guard let initialComposer = currentComposer() else {
    print("not_confirmed not_completed 0")
    print("[]")
    exit(1)
}
AXUIElementSetAttributeValue(initialComposer, kAXFocusedAttribute as CFString, true as CFBoolean)
Thread.sleep(forTimeInterval: 0.3)
guard pasteAttachmentFiles(attachmentPaths) else {
    print("not_confirmed not_completed 0")
    print("[]")
    exit(0)
}
Thread.sleep(forTimeInterval: 0.3)
guard let composer = currentComposer() else {
    print("not_confirmed not_completed 0")
    print("[]")
    exit(1)
}
AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, true as CFBoolean)
AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, prompt as CFString)
Thread.sleep(forTimeInterval: 0.3)

// click send
var sendBtn: AXUIElement? = nil
for _ in 0..<sendButtonPolls {
    if let candidate = findAll(ax, role: "AXButton").first(where: { getDesc($0) == "发送" && isEnabled($0) }) {
        sendBtn = candidate
        break
    }
    Thread.sleep(forTimeInterval: 0.25)
}
guard let btn = sendBtn else {
    print("not_confirmed not_completed 0")
    print("[]")
    exit(1)
}
AXUIElementPerformAction(btn, kAXPressAction as CFString)
let t0 = Date()

// wait for stop-generating (confirmed)
var confirmed = false
let stopLabel = "停止生成"
for _ in 0..<(confirmSecs * 4) {
    Thread.sleep(forTimeInterval: 0.25)
    if findAll(ax, role: "AXButton").contains(where: { getDesc($0) == stopLabel }) {
        confirmed = true; break
    }
}

guard confirmed else {
    let ms = Int(Date().timeIntervalSince(t0) * 1000)
    print("not_confirmed not_completed \\(ms)")
    print("[]")
    exit(0)
}

// wait for stop-generating to disappear AND stay gone for 1.5s (handles Thinking model gaps)
var completed = false
var goneStreak = 0
for _ in 0..<(completeSecs * 4) {
    Thread.sleep(forTimeInterval: 0.25)
    let hasStop = findAll(ax, role: "AXButton").contains(where: { getDesc($0) == stopLabel })
    if hasStop {
        goneStreak = 0
    } else {
        goneStreak += 1
        if goneStreak >= 6 { // 6 * 0.25s = 1.5s gone → truly finished
            completed = true; break
        }
    }
}
// extra settle time for AX tree to finalize
if completed { Thread.sleep(forTimeInterval: 0.5) }

// collect new texts: nodes appended after beforeCount (index-based, handles repeated text)
let afterNodes = collectTextNodes()
var newTexts: [String] = []
// primary: nodes that appeared after the snapshot position
if afterNodes.count > beforeCount {
    for t in afterNodes[beforeCount...] {
        if !t.isEmpty && t != prompt && !t.hasPrefix(prompt) {
            newTexts.append(t)
        }
    }
}
// fallback: if no new nodes by position, use Set diff (e.g. ChatGPT rewrote existing nodes)
if newTexts.isEmpty {
    let beforeSet = Set(beforeNodes)
    for t in afterNodes {
        if !beforeSet.contains(t) && !t.isEmpty && t != prompt && !t.hasPrefix(prompt) {
            newTexts.append(t)
        }
    }
}
let jsonItems = newTexts.map { "\\"\\(jsonEscape($0))\\"" }
let jsonArr = "[\\(jsonItems.joined(separator: ","))]"

let elapsed = Int(Date().timeIntervalSince(t0) * 1000)
print("\\(confirmed ? "confirmed" : "not_confirmed") \\(completed ? "completed" : "not_completed") \\(elapsed)")
print(jsonArr)
`;

  const t0 = Date.now();
  try {
    const out = runSwift(code, (confirmTimeout + completionTimeout + 10) * 1000);
    const lines = out.split("\n");
    const statusLine = lines[0] ?? "";
    const jsonLine = lines.slice(1).join("\n").trim();
    const parts = statusLine.split(" ");
    let replyTexts: string[] = [];
    try { replyTexts = JSON.parse(jsonLine) as string[]; } catch {}
    return {
      confirmed: parts[0] === "confirmed",
      completed: parts[1] === "completed",
      elapsedMs: parseInt(parts[2] ?? "0", 10) || Date.now() - t0,
      replyTexts
    };
  } catch (err) {
    throw new Error(`sendMessage swift error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function clickNewChat(): void {
  const code = `
${SWIFT_PREAMBLE}
guard let ax = axApp() else { exit(1) }
let btn = findAll(ax, role: "AXButton").first { getDesc($0) == "新聊天" }
if let b = btn { AXUIElementPerformAction(b, kAXPressAction as CFString) }
Thread.sleep(forTimeInterval: 0.6)
print("ok")
`;
  runSwift(code);
}

export function getCurrentWindowTitle(): string | null {
  const code = `
${SWIFT_PREAMBLE}
guard let ax = axApp() else { print(""); exit(0) }
let title = (getAttr(ax, kAXFocusedWindowAttribute) as AXUIElement?)
    .flatMap { getAttr($0, kAXTitleAttribute) as? String }
    ?? (getAttr(ax, kAXWindowsAttribute) as? [AXUIElement])?.first
        .flatMap { getAttr($0, kAXTitleAttribute) as? String }
    ?? ""
print(title)
`;
  try {
    const r = runSwift(code);
    return r.length > 0 ? r : null;
  } catch {
    return null;
  }
}

export type ChatgptThread = {
  index: number;
  title: string;
  windowTitle: string | null;
};

export function listRecentChats(maxCount = 20): ChatgptThread[] {
  const limitLiteral = String(maxCount);
  const code = `
${SWIFT_PREAMBLE}
import Foundation

guard let ax = axApp() else { print("[]"); exit(0) }

let allBtns = findAll(ax, role: "AXButton")

let uiLabels: Set<String> = ["新聊天", "New chat", "ChatGPT", "ChatGPT Auto", "发送", "停止生成",
                               "Search", "搜索", "Explore GPTs", "探索 GPTs", "设置", "Settings",
                               "分享", "移至新窗口", "附件", "使用应用", "选项", "录制会议", "听写",
                               "切换边栏", "项目", "使用 Windsurf、 选项卡"]
func btnLabel(_ el: AXUIElement) -> String {
    // ChatGPT Desktop sidebar buttons expose title via kAXDescriptionAttribute (kAXTitleAttribute is empty)
    var v: CFTypeRef?
    AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &v)
    if let s = v as? String, !s.isEmpty { return s }
    AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &v)
    if let s = v as? String, !s.isEmpty { return s }
    return ""
}
var chatBtns: [String] = []
var seen = Set<String>()
for btn in allBtns {
    let label = btnLabel(btn)
    if label.count >= 2 && !uiLabels.contains(label) && !seen.contains(label) {
        chatBtns.append(label)
        seen.insert(label)
    }
}

let limited = Array(chatBtns.prefix(${limitLiteral}))
let jsonItems = limited.enumerated().map { (i, title) in
    "\\"\\(jsonEscape(title))\\""
}
print("[\\(jsonItems.joined(separator: ","))]")
`;
  try {
    const raw = runSwift(code, 12_000);
    const titles = JSON.parse(raw) as string[];
    return titles.map((title, i) => ({ index: i + 1, title, windowTitle: null }));
  } catch {
    return [];
  }
}

export function clickChatByTitle(title: string): boolean {
  const escaped = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const code = `
${SWIFT_PREAMBLE}
import CoreGraphics

guard let nsApp = NSWorkspace.shared.runningApplications
    .first(where: { $0.bundleIdentifier == BUNDLE_ID }) else { print("not_found"); exit(0) }
nsApp.activate(options: [])
Thread.sleep(forTimeInterval: 0.8)
guard let ax = axApp() else { print("not_found"); exit(0) }
let target = "${escaped}"
func btnLabel2(_ el: AXUIElement) -> String {
    var v: CFTypeRef?
    AXUIElementCopyAttributeValue(el, kAXDescriptionAttribute as CFString, &v)
    if let s = v as? String, !s.isEmpty { return s }
    AXUIElementCopyAttributeValue(el, kAXTitleAttribute as CFString, &v)
    if let s = v as? String, !s.isEmpty { return s }
    return ""
}
func getFrame(_ el: AXUIElement) -> CGRect? {
    var posVal: CFTypeRef?; var sizeVal: CFTypeRef?
    AXUIElementCopyAttributeValue(el, kAXPositionAttribute as CFString, &posVal)
    AXUIElementCopyAttributeValue(el, kAXSizeAttribute as CFString, &sizeVal)
    guard let pv = posVal as! AXValue?, let sv = sizeVal as! AXValue? else { return nil }
    var pos = CGPoint.zero; var size = CGSize.zero
    AXValueGetValue(pv, .cgPoint, &pos); AXValueGetValue(sv, .cgSize, &size)
    return CGRect(origin: pos, size: size)
}
func mouseClick(_ pt: CGPoint) {
    let dn = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)!
    let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp,   mouseCursorPosition: pt, mouseButton: .left)!
    dn.post(tap: .cghidEventTap); Thread.sleep(forTimeInterval: 0.05); up.post(tap: .cghidEventTap)
}
let allBtns = findAll(ax, role: "AXButton")
if let btn = allBtns.first(where: { btnLabel2($0) == target }),
   let frame = getFrame(btn) {
    let center = CGPoint(x: frame.midX, y: frame.midY)
    mouseClick(center)
    Thread.sleep(forTimeInterval: 0.8)
    print("ok")
} else {
    print("not_found")
}
`;
  try {
    return runSwift(code, 8_000).trim() === "ok";
  } catch {
    return false;
  }
}

// String extension used in ensureAppVisible
declare global {
  interface String {
    hasPrefix(prefix: string): boolean;
  }
}
String.prototype.hasPrefix = function (prefix: string): boolean {
  return this.startsWith(prefix);
};
