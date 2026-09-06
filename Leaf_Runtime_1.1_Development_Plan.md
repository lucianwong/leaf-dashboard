# Leaf Runtime 1.1 — Production Device 开发计划

仓库：`lucianwong/leaf-dashboard`  
阶段目标：从「可用 Dashboard」进入「可长期无人值守运行的 E-Ink 设备终端」

---

# 1. 当前状态

现有核心功能已经完成：

## 01 HOME
- Clock
- Weather
- Todo

## 02 CALENDAR
- Calendar
- Todo

## 03 AI
- AI Usage
  - Codex
  - Z.ai / GLM
  - Kimi
- Agent Status

## 04 SYSTEM
- Server Status
- Agent Status
- Device / Runtime 信息基础

Runtime 1.0 已具备：

- Manifest API
- per-page version / SHA256
- Frame Cache
- 原子 Frame 更新
- Offline fallback
- Heartbeat
- Remote Page
- Remote Refresh
- Remote Full Refresh
- 四页模型
- Admin Device 控制
- 数据源缓存
- SSRF 基础防护
- Docker
- CI

当前阶段原则：

> 不再优先新增 Dashboard Widget，先把 Leaf5+ 做成长期稳定、可自恢复、可远程管理的设备终端。

---

# 2. Leaf Runtime 1.1 总目标

目标能力：

- 开机自动恢复 Dashboard
- APK 升级后自动恢复
- App 崩溃后可恢复
- 网络中断不影响当前画面
- Server 中断后自动追上
- 真正适配 BOOX Partial / Full Refresh
- 远程命令有 ACK
- 设备有独立身份与 Token
- 后台可查看设备运行状态与错误
- APK 版本可管理
- 为后续 ESP32-S3 / 其他 E-Ink 设备复用统一设备模型

整体演进：

```text
Leaf Runtime 1.0
        ↓
M7  48h Stability Baseline
        ↓
M8  Boot / Crash Recovery
        ↓
M9  BOOX E-Ink Controller
        ↓
M10 Reliable Command + ACK
        ↓
M11 Pairing + Device Token
        ↓
M12 Diagnostics
        ↓
M13 Release / APK Update
        ↓
M14 Actions + Push
        ↓
Leaf Dashboard 1.0
```

---

# 3. M7 — 48 小时稳定性基线

优先级：P0

在继续扩展 Runtime 前，先用当前版本在真实 Leaf5+ 连续运行 48 小时。

## 3.1 需要记录

```text
App crash 次数
App restart 次数
Manifest sync 次数
Manifest failed 次数
Frame download 次数
Frame download failed 次数
Partial refresh 次数
Full refresh 次数
Wi-Fi disconnect 次数
Wi-Fi recover 次数
Server unavailable 次数
最大连续 uptime
电量变化
缓存大小
最后成功同步时间
```

## 3.2 故障注入

至少完成：

```text
Wi-Fi 断开 30 分钟
Wi-Fi 恢复
Dashboard Server 停止 30 分钟
Dashboard Server 重启
路由器重启
App 切后台
App 回前台
Leaf 锁屏 / 唤醒
Leaf 整机重启
Frame 404
Frame 500
Manifest 500
错误 PNG
错误 SHA256
```

## 3.3 验收

> 48 小时内无需人工救活 Dashboard。

---

# 4. M8 — Boot / Crash Recovery

优先级：P0

目标：

```text
Leaf 开机
↓
Android Boot Completed
↓
LeafDashboard 自动启动
↓
读取 lastPage
↓
立即显示本地 Frame
↓
后台同步
```

## 4.1 BootReceiver

Android 增加：

```text
boot/
├── BootReceiver.kt
└── StartupManager.kt
```

Manifest：

```xml
<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED" />
```

监听：

```text
BOOT_COMPLETED
MY_PACKAGE_REPLACED
```

可根据 BOOX 实机情况研究：

```text
LOCKED_BOOT_COMPLETED
```

## 4.2 启动原则

启动时禁止等待网络。

```text
Activity Start
↓
读取 SharedPreferences
↓
读取 lastPage
↓
读取 filesDir/frames/frame_<page>.png
↓
立即显示
↓
后台启动 sync
```

## 4.3 APK 更新恢复

监听：

```text
MY_PACKAGE_REPLACED
```

目标：

> APK 覆盖安装完成后，LeafDashboard 自动恢复运行。

## 4.4 Crash Guard

建议增加本地 Runtime State：

```json
{
  "lastStartAt": 1788681234,
  "lastCleanExit": false,
  "recentCrashCount": 1
}
```

如果：

```text
5 分钟内连续崩溃 >= 3 次
```

进入 Safe Mode：

- 只展示最后缓存 Frame
- 暂停复杂同步
- 保留最小 Heartbeat
- 后台显示设备处于 `safe_mode`

---

# 5. M9 — BOOX E-Ink Controller

优先级：P0

当前白 → 黑 → Frame 只能作为 fallback。

正式目标：

```text
EinkController
├── GenericEinkController
└── BooxEinkController
```

## 5.1 接口

```kotlin
interface EinkController {
    fun isAvailable(): Boolean
    fun partialRefresh(view: View)
    fun fullRefresh(view: View)
    fun setMode(mode: EinkMode)
}
```

EinkMode：

```text
NORMAL
PARTIAL
FAST
FULL
```

## 5.2 BOOX Discovery

先增加诊断输出：

```text
Build.MANUFACTURER
Build.MODEL
Build.DEVICE
Android Version
BOOX OS Version
Available Onyx Classes
EpdController Methods
Method parameter types
Return types
```

目标是在 Leaf5+ 真机上确认真正可用 API。

## 5.3 刷新策略

```text
Frame 内容无变化 → NONE
普通数据变化 → PARTIAL
实体键切页 → PARTIAL
连续 Partial 达阈值 → FULL
Full 周期到期 → FULL
Admin Remote Full → FULL
```

## 5.4 Refresh Metrics

Heartbeat 增加：

```json
{
  "einkController": "boox",
  "einkMode": "partial",
  "partialRefreshCount": 8,
  "fullRefreshCount": 2,
  "lastFullRefreshAt": 1788681234
}
```

## 5.5 Fallback

```text
BooxEinkController
↓ unavailable / error
GenericEinkController
↓
WHITE → BLACK → FRAME
```

---

# 6. M10 — Reliable Command + ACK

优先级：P1

现有：

```text
desiredPage
refreshSeq
fullRefreshSeq
```

下一阶段升级为统一 Command 模型。

## 6.1 Command 数据结构

```json
{
  "commands": [
    {
      "id": "cmd_1028",
      "type": "page.switch",
      "payload": {
        "page": "ai"
      },
      "createdAt": 1788681000
    }
  ]
}
```

## 6.2 Command 类型

第一版：

```text
page.switch
device.refresh
device.full_refresh
sync.restart
```

后续：

```text
todo.complete
focus.start
agent.run
agent.retry
agent.stop
```

## 6.3 ACK

```http
POST /api/v1/devices/{deviceId}/commands/{commandId}/ack
```

成功：

```json
{
  "status": "success",
  "result": {
    "page": "ai"
  }
}
```

失败：

```json
{
  "status": "failed",
  "error": "frame_not_available"
}
```

---

# 7. M11 — Device Pairing + Token

优先级：P1

## 7.1 Pairing 流程

```text
Leaf 首启动
↓
生成 Device ID
↓
向 Server 请求 Pair Code
↓
屏幕显示 6 位 Pair Code
↓
Admin 确认
↓
Server 签发 Device Token
↓
Leaf 本地安全保存
```

## 7.2 本地配置

```json
{
  "server": "https://dashboard.example.com",
  "deviceId": "leaf5-office",
  "deviceToken": "..."
}
```

## 7.3 请求认证

```http
Authorization: Bearer DEVICE_TOKEN
```

权限：

```text
/device/* → Device Token
/admin/*  → Admin Session / Admin Token
```

---

# 8. M12 — Diagnostics / Telemetry

优先级：P1

Heartbeat 扩展：

```json
{
  "appVersion": "0.4.0",
  "androidVersion": "13",
  "deviceModel": "Leaf5+",
  "battery": 78,
  "charging": true,
  "wifi": true,
  "currentPage": "home",
  "lastSyncAt": 1788681000,
  "lastSyncStatus": "success",
  "frameCacheBytes": 524821,
  "einkController": "boox",
  "partialRefreshCount": 8,
  "fullRefreshCount": 2,
  "uptime": 192820,
  "safeMode": false,
  "lastError": null
}
```

Admin Device Detail：

```text
Device
Runtime
Network
Sync
Display
E-Ink
Cache
Errors
Commands
```

最近事件保留 20～50 条。

---

# 9. M13 — Release / APK Update

优先级：P2

```http
GET /api/app/latest
```

示例：

```json
{
  "versionCode": 8,
  "versionName": "0.4.0",
  "url": "/download/LeafDashboard-0.4.0.apk",
  "sha256": "..."
}
```

第一阶段不做静默安装：

```text
检测新版本
↓
Admin 提示
↓
设备下载
↓
人工确认安装
↓
MY_PACKAGE_REPLACED 自动恢复
```

---

# 10. M14 — Actions

优先级：P2

首批：

```text
Todo Complete
AI Usage Refresh
Agent Run
Agent Retry
Agent Stop
Focus Start
```

统一 Action API：

```http
POST /api/actions
```

架构：

```text
Leaf
 ↓
Action API
 ↓
Personal Backend
 ├─ Todo
 ├─ Agent
 ├─ Memory
 └─ Other Services
```

---

# 11. Push

Push 放在 Actions / Reliable Command 之后。

Polling 继续保留作为可靠兜底：

```text
5 min Polling
```

Push 只作为加速信号：

```text
Agent Finished
↓
Server Push
↓
Leaf 收到 update available
↓
GET Manifest
```

禁止 Push 直接发送 Frame 或承载核心业务状态。

---

# 12. 推荐开发 Sprint

## Sprint A — Device Survival

```text
BootReceiver
MY_PACKAGE_REPLACED
启动恢复缓存
Crash Guard
Safe Mode
Startup Metrics
Crash Metrics
```

验收：

> Leaf5+ 整机重启后，无需触碰设备即可自动恢复 Dashboard。

## Sprint B — BOOX E-Ink

```text
EinkController
GenericEinkController
BooxEinkController
BOOX API Discovery
Partial Refresh
Full Refresh
Refresh Metrics
Fallback
```

验收：

> 能在 Leaf5+ 真机证明 Partial / Full 走正确 BOOX 刷新路径，而非仅靠白黑帧模拟。

## Sprint C — Reliable Device Control

```text
Command Model
Command Queue
Command ACK
Retry
Timeout
Admin Command Status
```

## Sprint D — Device Identity

```text
Pair Code
Pairing API
Device Token
Device Auth
Admin Auth
Token Rotate
```

## Sprint E — Diagnostics / Release

```text
Heartbeat 扩展
Recent Events
Device Detail
APK Latest API
APK SHA256
Version Notice
```

---

# 13. 当前 Codex 下一轮任务

先完成 M7 + M8：

1. 为 48 小时测试补充必要 Runtime Metrics。
2. 实现 BootReceiver。
3. 实现 MY_PACKAGE_REPLACED 自动恢复。
4. 启动时始终先显示本地缓存。
5. 增加 Crash Guard。
6. 增加 Safe Mode。
7. Heartbeat 增加 startup / crash / safeMode 状态。

第二优先级 M9：

8. 抽象 `EinkController`。
9. 实现 `GenericEinkController`。
10. 增加 `BooxEinkController`。
11. 增加 BOOX API discovery 日志。
12. Leaf5+ 真机收集 Onyx API 方法签名。
13. 接入真正 Partial Refresh。
14. 接入真正 Full Refresh。
15. 保留 Generic fallback。
16. Heartbeat 增加 E-Ink Metrics。

当前禁止：

- 新增 Dashboard 页面
- 新增大量 Widget
- 引入动画
- 复杂 Layout Builder
- ESP32 全面接入
- 多租户
- 大规模数据库重构

---

# 14. 建议版本规划

```text
0.3.0  Leaf Runtime 1.0 Stable
0.4.0  Boot + Crash Recovery + BOOX E-Ink
0.5.0  Reliable Command + ACK + Pairing
0.6.0  Diagnostics + Release
0.7.0  Actions + Push
1.0.0  Leaf Dashboard Production
```

---

# 15. 1.0.0 验收标准

## Device

```text
✓ 开机自启
✓ APK 更新后恢复
✓ App 异常可恢复
✓ 断网不黑屏
✓ Server 故障自动恢复
✓ 本地缓存可靠
```

## E-Ink

```text
✓ BOOX Partial Refresh
✓ BOOX Full Refresh
✓ Full 策略可配置
✓ 残影可控
✓ Fallback 可用
```

## Remote

```text
✓ Pairing
✓ Device Token
✓ Command ACK
✓ Remote Page
✓ Remote Refresh
✓ Remote Full
```

## Admin

```text
✓ Online / Offline
✓ Battery
✓ Current Page
✓ App Version
✓ Sync Status
✓ E-Ink Metrics
✓ Recent Errors
✓ Remote Commands
```

## Reliability

```text
✓ 48h 无人工干预
✓ 后续 7 天 soak test
✓ 无持续内存增长
✓ 无僵尸轮询
✓ 无缓存丢失
✓ 无远程命令静默丢失
```

---

# 16. 最终方向

Leaf5+ 不再只是 Dashboard 页面，而是统一设备平台中的 E-Ink Endpoint。

```text
                    Personal Backend
                           │
              ┌────────────┼────────────┐
              ▼            ▼            ▼
         BOOX Leaf5+    ESP32-S3       Web
         E-Ink Client    AI Terminal    Admin
              │            │
              └──── Device / Action API ────┘
```

当前开发重点：

> **先把 Leaf5+ 做成一个稳定、自恢复、可鉴权、可诊断、可远程控制的生产级终端，再复用同一模型扩展其他设备。**
