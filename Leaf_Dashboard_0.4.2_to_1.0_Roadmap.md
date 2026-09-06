# Leaf Dashboard 下一步版本计划与方案

仓库：`lucianwong/leaf-dashboard`  
当前阶段：Leaf Runtime 1.1 静态代码基本收口  
下一阶段主线：**硬件验证收口 → 设备控制平面**

---

## 1. 版本路线

| 版本 | 定位 | 核心目标 |
|---|---|---|
| **0.4.2** | Hardware Validation RC | BOOX 真机、Boot、自恢复、48h soak 收口 |
| **0.5.0** | Device Control Plane | Command + ACK + Pairing + Device Token |
| **0.6.0** | Diagnostics & Release | 设备详情、事件日志、APK Release |
| **0.7.0** | Actions & Push | Todo / Agent 操作、Push 加速 |
| **1.0.0** | Production | 长期无人值守运行 |

原则：

> 不再优先新增 Dashboard 页面，先把 Leaf5+ 做成稳定、可信、可远程控制的设备终端。

---

# 2. 0.4.2 — Hardware Validation RC

目标：

> **证明 Leaf5+ 可以作为无人值守 E-Ink Endpoint 长期运行。**

### 2.1 工程收尾

1. GitHub Actions Android Job 使用完整 Git 历史：

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
```

2. 确保 `versionCode` 在本地和 CI 中一致。
3. Admin 显示 `appVersion + buildCommit`。
4. 发布 APK 的 `buildCommit` 必须指向最终提交。

### 2.2 真机验收

| 项目 | 验收 |
|---|---|
| Cold Boot | 开机后无人操作自动进入 Dashboard |
| APK Replace | 覆盖安装后自动恢复 |
| Offline | 断网继续显示最后 Frame |
| Recovery | 网络恢复自动追平 |
| Server Down | Server 重启后设备自行恢复 |
| Remote Page | 后台切页可靠 |
| Remote Refresh | 强制重拉可靠 |
| Remote Full | Full 完成后才确认 |
| Physical Key | Leaf5+ 实体键稳定切页 |
| Safe Mode | 可进入、可心跳、可自动退出 |
| Metrics | `attempt = success + fail` |
| Soak | 连续 48h 无人工救活 |

### 2.3 BOOX Discovery

真机采集：

```bash
adb logcat -s LeafKeys LeafDashboard
```

重点寻找：

```text
FOUND com.onyx...
methodName(parameter...): ReturnType
```

确认真实 BOOX / Onyx：

```text
Partial Refresh
Full Refresh
Refresh Mode
Waveform
```

### 2.4 BOOX Controller 收口

当前：

```text
Partial → Android invalidate
Full → BOOX reflection guess → Generic fallback
```

目标：

```text
Partial → BOOX Native API
Full → BOOX Native API
Fallback → GenericEinkController
```

建议 Heartbeat 增加：

```json
{
  "appVersion": "0.4.2",
  "buildCommit": "...",
  "einkController": "boox",
  "booxPartialAvailable": true,
  "booxFullAvailable": true,
  "partialRefreshTotal": 183,
  "partialSinceFull": 7,
  "fullRefreshCount": 16,
  "syncAttemptCount": 585,
  "syncSuccessCount": 579,
  "syncFailCount": 6,
  "safeMode": false
}
```

通过后：

> **Leaf Runtime 1.1 标记 Stable。**

---

# 3. 0.5.0 — Device Control Plane

目标：

> **把远程控制统一成可靠命令，并让每台 Leaf 拥有可信设备身份。**

现有：

```text
desiredPage
refreshSeq
fullRefreshSeq
```

0.5.0 统一为：

```text
Admin
  │
  ▼
Command Service
  ├── Device Auth
  ├── Command Store
  ▼
Manifest
  ▼
BOOX Leaf5+
  ├── Receive
  ├── Execute
  └── ACK
```

---

# 4. M10 — Command V1

### 4.1 数据结构

```json
{
  "commands": [
    {
      "id": "cmd_01K...",
      "seq": 18,
      "type": "page.switch",
      "payload": {
        "page": "ai"
      },
      "createdAt": 1788690000000,
      "expiresAt": 1788690600000
    }
  ]
}
```

### 4.2 第一批命令

| Command | 行为 |
|---|---|
| `page.switch` | HOME / CALENDAR / AI / SYSTEM |
| `device.refresh` | 强制重拉当前 Frame |
| `device.full_refresh` | 真 Full，完成后 ACK |
| `sync.restart` | 重新开始完整同步 |

暂不加入：

```text
todo.complete
agent.run
agent.retry
focus.start
```

这些留到 0.7.0。

---

# 5. Command 状态机

```text
PENDING
   ↓
SENT
   ↓
RECEIVED
   ↓
SUCCEEDED
```

异常：

```text
FAILED
EXPIRED
```

Admin 示例：

```text
FULL REFRESH

18:42:01  Sent
18:42:02  Received
18:42:02  Executing
18:42:03  Success
```

---

# 6. Command API

### Admin 创建

```http
POST /api/admin/devices/{deviceId}/commands
```

```json
{
  "type": "device.full_refresh"
}
```

返回：

```json
{
  "id": "cmd_01K...",
  "seq": 18,
  "status": "pending"
}
```

### Manifest 下发

```http
GET /api/device/{deviceId}/manifest
```

增加：

```json
{
  "commands": [
    {
      "id": "cmd_01K...",
      "seq": 18,
      "type": "device.full_refresh",
      "payload": {}
    }
  ]
}
```

### ACK

```http
POST /api/device/{deviceId}/commands/{commandId}/ack
```

收到：

```json
{
  "status": "received"
}
```

成功：

```json
{
  "status": "succeeded",
  "result": {
    "refresh": "full"
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

# 7. Command 可靠性模型

采用：

> **At-least-once delivery + idempotent execution**

典型问题：

```text
Leaf 执行成功
↓
ACK 丢包
↓
Server 再次下发
```

为避免重复执行，引入本地：

```text
CommandLedger
```

保存最近约 100 条：

```json
{
  "cmd_01": {
    "status": "succeeded",
    "completedAt": 1788690000
  }
}
```

同一 Command ID 再到达：

```text
已执行
↓
不重复执行
↓
重发之前 ACK
```

---

# 8. Android 0.5.0 模块拆分

建议逐步拆分：

```text
device/
    DeviceIdentity.kt
    DeviceCredentialStore.kt

api/
    DeviceApiClient.kt

command/
    Command.kt
    CommandProcessor.kt
    CommandExecutor.kt
    CommandLedger.kt

sync/
    ManifestSync.kt
    FrameRepository.kt

eink/
    EinkController.kt
    BooxEinkController.kt
    GenericEinkController.kt

runtime/
    RuntimeMetrics.kt
    SafeModeManager.kt

ui/
    MainActivity.kt
```

原则：

> 不为了架构漂亮重写现有稳定代码。

第一轮只优先抽：

```text
DeviceApiClient
CommandProcessor
CommandLedger
```

---

# 9. M11 — Pairing V1

当前 `deviceId = UUID` 只能区分设备，不能认证设备。

Pairing 流程：

```text
Leaf 首次启动
↓
POST /api/pairing/request
↓
Server 创建 pairing
↓
返回 6 位 Pair Code
↓
Leaf 显示：

PAIR DEVICE
482 916

↓
Admin Approve
↓
Server 签发 Device Token
↓
Leaf 保存 Token
↓
进入 HOME
```

Pairing 返回：

```json
{
  "pairingId": "pair_01K...",
  "code": "482916",
  "pollToken": "random-secret...",
  "expiresAt": 1788690600
}
```

审批以后，只有持有 `pollToken` 的设备可以获取最终 Device Token。

---

# 10. Device Token

建议：

```text
32 bytes random
↓
base64url
```

Server 不保存明文，只存：

```text
SHA256(deviceToken)
```

设备请求：

```http
Authorization: Bearer DEVICE_TOKEN
```

同时要求 Token 对应的 Device ID 必须等于 URL 中的 Device ID。

---

# 11. Android Token 存储

继续零第三方依赖：

```text
Android Keystore
+
AES/GCM
```

封装：

```text
DeviceCredentialStore
```

持久化：

```json
{
  "deviceId": "...",
  "encryptedDeviceToken": "...",
  "server": "..."
}
```

继续保留：

```xml
android:allowBackup="false"
```

---

# 12. Server Auth Boundary

```text
/api/pairing/*
→ 未配对设备
→ Rate Limit

/api/device/*
→ Device Token

/api/admin/*
→ Admin Auth
```

Frame：

```text
/api/device/frame/*
```

也建议要求 Device Token。

---

# 13. 兼容升级

不能直接让 0.4.x 设备失联。

增加：

```env
DEVICE_AUTH_MODE=optional
```

阶段一：

```text
0.4.x → legacy allowed
0.5.0 → token auth
```

当 Leaf 已完成 Pairing 后：

```env
DEVICE_AUTH_MODE=required
```

再关闭 legacy。

---

# 14. Capability Negotiation

Heartbeat 增加：

```json
{
  "capabilities": [
    "commands-v1",
    "pairing-v1",
    "eink-native-v1"
  ]
}
```

Server 根据能力选择控制方式：

```text
旧 0.4.x
→ desiredPage / refreshSeq / fullRefreshSeq

0.5.0
→ commands-v1
```

待旧客户端淘汰后再删除 legacy 字段。

---

# 15. 0.5.0 Admin

设备列表建议：

```text
Leaf Office
ONLINE

BOOX Leaf5+
0.5.0 · 8ab9231

HOME
Battery 81%
Last Sync 32s
```

Device Detail：

| 区域 | 内容 |
|---|---|
| Device | 名称、ID、型号、版本、Build |
| Runtime | uptime、safeMode、crash |
| Sync | success/fail、lastError |
| E-Ink | Controller、Partial、Full |
| Commands | 最近 Command 状态 |
| Security | paired、token createdAt |
| Control | Page / Refresh / Full |

Command History：

```text
21:06 FULL REFRESH       SUCCESS
21:03 PAGE → AI          SUCCESS
20:58 REFRESH            SUCCESS
```

---

# 16. Server 数据模型

暂时继续 JSON / Persistent Storage，不引入 PostgreSQL。

增加：

```text
devices
commands
pairings
```

Command：

```json
{
  "id": "cmd_01K",
  "deviceId": "...",
  "seq": 18,
  "type": "device.full_refresh",
  "payload": {},
  "status": "succeeded",
  "createdAt": 1788690000,
  "sentAt": 1788690001,
  "receivedAt": 1788690002,
  "completedAt": 1788690003,
  "expiresAt": 1788690600,
  "error": null
}
```

Device：

```json
{
  "deviceId": "...",
  "name": "Leaf Office",
  "tokenHash": "...",
  "pairedAt": 1788690000,
  "revokedAt": null,
  "capabilities": []
}
```

Pairing：

```json
{
  "id": "...",
  "deviceId": "...",
  "codeHash": "...",
  "pollTokenHash": "...",
  "status": "pending",
  "expiresAt": 1788690600
}
```

---

# 17. 0.5.0 开发顺序

| Sprint | 内容 | Gate |
|---|---|---|
| A | Command Store + API | Server 单测通过 |
| B | Android CommandProcessor + Ledger | 重发不重复执行 |
| C | Admin Command UI | Sent→Received→Success |
| D | Pairing Server | Pair code / expire / approve |
| E | Android Pairing + CredentialStore | 重启后 Token 存活 |
| F | Device Auth | Manifest/Heartbeat/Frame 鉴权 |
| G | Migration | 0.4.x 与 0.5.0 同时工作 |
| H | 24h Control soak | 远程命令无静默丢失 |

---

# 18. 0.5.0 验收

```text
Leaf 重置 App Data
↓
启动
↓
PAIR DEVICE
482916
↓
Admin Approve
↓
Leaf 自动进入 HOME
↓
Admin → AI
↓
Sent
Received
Success
↓
Leaf 切 AI
↓
Admin → Full Refresh
↓
Sent
Received
Executing
Success
↓
断网
↓
设备继续显示缓存
↓
Admin 下发 HOME
↓
Command Pending
↓
网络恢复
↓
Leaf 收命令
执行 HOME
ACK Success
```

关键标准：

> **设备离线期间命令不能消失，网络恢复后必须继续执行。**

---

# 19. 0.5.0 明确不做

```text
WebSocket
MQTT
FCM Push
Todo Complete
Agent Run
Agent Retry
mem0
ESP32-S3
复杂日志平台
OTA 静默安装
多用户
多租户
云数据库
```

0.5.0 只做好：

> **Reliable Command + Trusted Device**

---

# 20. 后续版本

## 0.6.0 — Diagnostics & Release

```text
Device Detail
Recent Events
Runtime Diagnostics
APK Latest API
APK SHA256
Release 管理
版本提醒
```

## 0.7.0 — Actions & Push

```text
Todo Complete
AI Usage Refresh
Agent Run
Agent Retry
Agent Stop
Focus Start
Push 加速
```

Push 只做：

```text
update available
```

Polling 始终保留作为兜底。

---

# 21. 总路线

```text
0.4.x
Reliable Display Endpoint
        ↓
0.5.x
Reliable Device Control Plane
        ↓
0.6 / 0.7
Personal Action Platform
        ↓
1.0
Production Personal Device Platform
```

当前推荐：

```text
0.4.2
Leaf5+ 硬件链收口
↓
0.5.0
Command V1 + Pairing + Device Token
↓
0.6.0
Diagnostics + Release
↓
0.7.0
Actions + Push
↓
1.0.0
Production
```

---

# 22. 当前下一步

```text
1. 完成 0.4.2 真机验证
2. 获取 BOOX Discovery 日志
3. 固化 BooxEinkController
4. 完成 48h soak
5. 标记 Runtime 1.1 Stable
6. 开始 0.5.0 Sprint A — Command Store + API
```

核心方向：

> **先把 Leaf5+ 做成可靠设备，再把它升级成可信、可远程控制的设备平台。**
