# ChatGPT Desktop AX 实测探针脚本

本文档记录 2026-04-25 对 ChatGPT Desktop AX 自动化路径的真实验证结果，供 Phase 1 实现参考。

## 验证结论速览

| 能力 | 结论 | 关键细节 |
|---|---|---|
| 消息发送 | ✅ 可行 | `AXTextArea` setValue + `AXButton desc='发送'` AXPress |
| 发送确认 | ✅ 可行 | `AXButton desc='停止生成'` 出现即确认发送成功（约 1s） |
| 文字回复读取 | ✅ 可行 | `AXStaticText.kAXDescriptionAttribute`（**非 value**） |
| 图片缓存 diff | ✅ 可行 | `DiskStorage/` 新增哈希文件，约 40s，与发送按钮恢复同步 |
| CDP 注入 | ❌ 不可行 | WKWebView 不暴露 CDP |
| XPC 对话接口 | ❌ 不可行 | `com.openai.chat-helper` 仅管生命周期 |

## 脚本 1：AX 树结构探针

编译：`swiftc ax_probe.swift -o ax_probe`

```swift
import Cocoa
import ApplicationServices

let trusted = AXIsProcessTrusted()
print("AX trusted: \(trusted)")

guard let app = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.openai.chat" }) else {
    print("ChatGPT not running"); exit(1)
}
print("ChatGPT PID: \(app.processIdentifier)")

let axApp = AXUIElementCreateApplication(app.processIdentifier)

func getAttr(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
    var v: CFTypeRef?; AXUIElementCopyAttributeValue(el, attr as CFString, &v); return v
}
func getChildren(_ el: AXUIElement) -> [AXUIElement] {
    (getAttr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}
func getRole(_ el: AXUIElement) -> String {
    (getAttr(el, kAXRoleAttribute) as? String) ?? ""
}
func findAll(_ el: AXUIElement, role: String, depth: Int = 0, max: Int = 12) -> [AXUIElement] {
    guard depth <= max else { return [] }
    var out: [AXUIElement] = []
    if getRole(el) == role { out.append(el) }
    for child in getChildren(el) { out += findAll(child, role: role, depth: depth + 1, max: max) }
    return out
}

let windows = (getAttr(axApp, kAXWindowsAttribute) as? [AXUIElement]) ?? []
print("Windows: \(windows.count)")
guard let win = windows.first else { exit(1) }
print("Title: \(getAttr(win, kAXTitleAttribute) as? String ?? "nil")")

// TextAreas
let textAreas = findAll(axApp, role: "AXTextArea", max: 10)
print("\n--- TextAreas: \(textAreas.count) ---")
for (i, ta) in textAreas.enumerated() {
    let val = getAttr(ta, kAXValueAttribute) as? String ?? ""
    let ph  = getAttr(ta, kAXPlaceholderValueAttribute) as? String ?? ""
    print("[\(i)] placeholder='\(ph)' value='\(String(val.prefix(80)))'")
}

// Buttons
let buttons = findAll(axApp, role: "AXButton", max: 10)
print("\n--- Buttons: \(buttons.count) ---")
for btn in buttons {
    let title = getAttr(btn, kAXTitleAttribute) as? String ?? ""
    let desc  = getAttr(btn, kAXDescriptionAttribute) as? String ?? ""
    if !title.isEmpty || !desc.isEmpty { print("  title='\(title)' desc='\(desc)'") }
}

// StaticTexts — 注意：回复在 description，不是 value
let sts = findAll(axApp, role: "AXStaticText", max: 14)
print("\n--- StaticTexts: \(sts.count) ---")
for st in sts {
    let d = getAttr(st, kAXDescriptionAttribute) as? String ?? ""
    let v = getAttr(st, kAXValueAttribute) as? String ?? ""
    if d.count > 8 { print("  [desc] \(String(d.prefix(150)))") }
    if v.count > 8 { print("  [val]  \(String(v.prefix(150)))") }
}
```

## 脚本 2：端到端文字问答测试

```swift
// ax_send_test.swift — 见 /tmp/ax_send_test.swift
// 实测输出：
// ✓ Composer found
// Set value result: true
// ✓ Send button found
// ✓ 'Stop generating' button appeared
// ✓ Reply complete at t=3s
// NEW TEXT: 我是 GPT-5.5 Thinking，可以帮你分析问题、写作、编程、生成创意内容。
```

关键代码片段：

```swift
// 写入 prompt
AXUIElementSetAttributeValue(composer, kAXFocusedAttribute as CFString, true as CFBoolean)
AXUIElementSetAttributeValue(composer, kAXValueAttribute as CFString, prompt as CFString)

// 发送
AXUIElementPerformAction(sendBtn, kAXPressAction as CFString)

// 等待完成：停止生成消失 + 发送按钮重现
while hasStop || !hasSend { Thread.sleep(forTimeInterval: 0.5) }

// 读取回复
for st in findAll(axApp, role: "AXStaticText") {
    let reply = AXUIElementCopyAttributeValue(st, kAXDescriptionAttribute)
}
```

## 脚本 3：图片生成 + 缓存 diff 测试

```swift
// ax_image_test.swift — 见 /tmp/ax_image_test.swift
// 实测输出：
// Baseline: 2 AX texts, 1 cache files
// ✓ Generating...
// t=39s: 2 new cache files
// ✓ Reply complete at t=39s
// New Kingfisher cache files: 2
//   37a325aab3b41977cd971733781202d6743a3cc7eeadedecf4f7d18d7ba92e8f  (2241333 bytes)
//   fb1dec08b113191c75e57a9858ec049133c36e5fd58bfdb53142b65581268e50  (2388510 bytes)
```

关键代码片段：

```swift
let cacheDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent(
        "Library/Caches/com.openai.chat/com.onevcat.Kingfisher.ImageCache"
        + "/com.onevcat.Kingfisher.ImageCache.com.openai.chat/DiskStorage"
    )

// 发送前快照
let baseline = Set(try FileManager.default.contentsOfDirectory(atPath: cacheDir.path))

// ... 发送图片 prompt，等待完成 ...

// diff
let newFiles = Set(try FileManager.default.contentsOfDirectory(atPath: cacheDir.path))
    .subtracting(baseline)
// newFiles 即本轮新增图片，按文件大小过滤 > 100KB 排除缩略图
```

## 注意事项

1. **AX 权限**：需在系统设置 > 隐私与安全 > 辅助功能 中授权调用方（Terminal / 你的 Node 进程）
2. **窗口必须可见**：`Windows: 0` 时需先 `open -a ChatGPT` 激活
3. **发送按钮本地化**：按钮 desc 为中文 `发送` / `停止生成`，如切换系统语言需适配
4. **缓存文件无扩展名**：用文件头魔数判断 MIME（PNG: `89 50 4E 47`，JPEG: `FF D8 FF`，WebP: `52 49 46 46`）
5. **图片缓存包含缩略图**：按文件大小 > 500KB 过滤可排除大多数缩略图，或按 birthtime 排序取最新 N 个
