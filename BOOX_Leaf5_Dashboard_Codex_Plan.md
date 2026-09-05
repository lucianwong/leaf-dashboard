# BOOX Leaf5+ E-Ink Dashboard — Codex 项目记录

## 1. 项目目标

把 BOOX Leaf5+ 安卓墨水屏改造成一个低功耗、常驻、可远程配置的信息 Dashboard。

设备已知参数：
- 型号：BOOX Leaf5+
- 屏幕：7.0 英寸黑白墨水屏
- 分辨率：1680 × 1264
- PPI：300
- CPU：高通八核 2.0GHz
- 内存：4GB LPDDR4X
- 存储：64GB
- 网络：2.4GHz / 5GHz Wi‑Fi
- 蓝牙：BT 5.0
- 电池：2000mAh
- 触控：手触 + 笔触
- 物理键：翻页键
- Type‑C：支持 OTG

## 2. 总体设计原则

不要把设备当普通 Android 平板长期跑复杂动态网页。

优先采用：
服务端渲染静态 Frame → Android 客户端下载 → 全屏显示。

目标：
- 降低 WebView 重绘
- 降低残影
- 降低功耗
- 降低设备端复杂度
- 服务端集中控制布局与数据
- 后续方便扩展到 ESP32、Web、其他 E-Ink 设备

## 3. 推荐架构

```text
Data Sources
├─ Weather
├─ Calendar
├─ Todo
├─ AI Usage
├─ Server Status
├─ Agent Status
└─ Custom APIs
        │
        ▼
Dashboard Server
├─ Device API
├─ Widget API
├─ Layout Config
├─ Frame Renderer
└─ Admin Web
        │
        ▼
PNG Frame
1680 × 1264
        │
        ▼
LeafDashboard.apk
├─ Pairing
├─ Version polling
├─ Frame download
├─ Cache / Offline
├─ Fullscreen display
├─ Page switching
└─ E-Ink refresh strategy
```

## 4. Android 客户端 MVP

项目暂定名：

`LeafDashboard`

首版只实现以下功能。

### 4.1 设备配对

首次启动显示：
- Device Code
- Server 地址
- Pairing 状态

服务端确认后保存：
- deviceId
- deviceToken

### 4.2 状态检查

客户端定时调用：

`GET /api/device/{deviceId}/status`

示例：

```json
{
  "version": 139,
  "updatedAt": "2026-09-04T22:55:00+08:00",
  "refresh": "partial",
  "page": "home"
}
```

如果版本号未变化：
- 不下载图片
- 不刷新屏幕

如果版本变化：
- 下载新 Frame
- 更新本地缓存
- 刷新屏幕

### 4.3 Frame 下载

接口：

`GET /api/device/{deviceId}/frame`

默认横屏尺寸：

`1680 × 1264`

格式优先：
- PNG

后续可考虑：
- WebP
- 1-bit / 4-bit grayscale

### 4.4 全屏显示

客户端尽量保持极简：
- 单 Activity
- 单 ImageView / 自定义 View
- Immersive Fullscreen
- 隐藏状态栏与导航栏
- 禁止动画
- 禁止复杂过渡

### 4.5 本地缓存

必须支持：
- 无网情况下显示最后一张有效 Frame
- 下载失败不清空当前画面
- 新 Frame 完整下载后再替换旧 Frame

建议：
`frame_current.png`
`frame_next.png`

下载完成校验成功后原子替换。

## 5. E-Ink 刷新策略

普通内容变化：
- partial / fast refresh

周期性消残影：
- full refresh

初始建议：
- 状态检查：5 分钟
- 普通更新：数据变化才刷新
- 全刷：30~60 分钟一次
- 连续局刷达到一定次数后强制全刷

服务端 status 可返回：

```json
{
  "refresh": "partial"
}
```

或：

```json
{
  "refresh": "full"
}
```

Android 端后续研究 BOOX SDK / 系统 E-Ink 刷新 API。

如果 BOOX 专有接口不可用：
先保证标准 Android 显示链路可以工作，再逐步做设备特化。

## 6. 物理按键

Leaf5+ 有实体翻页键，必须利用。

建议：
- 上键：Previous Page
- 下键：Next Page

页面示例：

1. Home
2. Calendar
3. AI
4. Servers
5. Agents

切页优先使用本地已有 Frame，避免每次按键都等待网络。

## 7. 触控

仅做低频、大按钮交互，不做复杂 App UI。

首批可以支持：
- Home
- Refresh
- Previous / Next
- Todo Done
- Focus Start
- Agent Action

所有交互应：
- 大点击区
- 高对比度
- 无动画
- 少层级

## 8. 服务端

建议：
- Node.js / Next.js
- Docker 部署

模块：

```text
server/
├─ api/
│  ├─ devices
│  ├─ status
│  ├─ frame
│  ├─ widgets
│  └─ actions
├─ renderer/
├─ widgets/
├─ layouts/
├─ storage/
└─ admin/
```

## 9. Frame Renderer

Renderer 输入：

```json
{
  "device": {
    "width": 1680,
    "height": 1264,
    "orientation": "landscape"
  },
  "layout": "home",
  "widgets": {}
}
```

输出：

`1680 × 1264 PNG`

设计要求：
- 黑白优先
- 高对比度
- 避免大面积灰色
- 尽量不用渐变
- 不使用动画
- 文字字号适配 7 英寸 300PPI
- 大块留白
- 清晰分隔线

## 10. 首版 Widgets

第一阶段只做：

- Clock
- Weather
- Calendar
- Todo
- Server Status
- AI Usage

后续：
- Agent Status
- mem0
- ESP32 AI Pet
- Notifications
- Home Assistant
- Custom API
- RSS
- GitHub / CI
- NAS 状态

## 11. Admin Web

后续管理后台支持：

### Devices
- Online / Offline
- Device Name
- Resolution
- Orientation
- Last Seen
- Current Version
- Current Page

### Display
- Landscape / Portrait
- Refresh Interval
- Full Refresh Interval
- Brightness（若 Android API 可控）
- Sleep Schedule

### Widgets
- 开关
- 顺序
- 配置
- 数据源

### Layout
- Widget 网格布局
- 保存配置
- Preview
- Publish

## 12. 多终端长期架构

最终希望统一成：

```text
                 Personal Backend
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      BOOX Leaf5+   ESP32-S3       Web
      E-Ink Board    AI Pet       Admin
```

可继续连接：
- mem0
- Agent 状态
- Server / NAS / VPS
- AI Usage
- Todo / Calendar
- 自定义 API

## 13. 实施顺序

### Milestone 0 — 设备验证
确认：
- Android 版本
- APK 侧载方式
- 横屏锁定
- 全屏显示
- 实体按键 KeyCode
- BOOX 刷新 API 可用性

### Milestone 1 — 最小闭环
完成：
- Android APK
- 固定 Server URL
- 下载 1680×1264 PNG
- 全屏显示
- 本地缓存
- 手动刷新

验收：
设备可以稳定显示服务端生成的一张 Dashboard。

### Milestone 2 — 自动更新
完成：
- deviceId
- status/version API
- 定时轮询
- 版本变化更新
- 网络异常恢复

### Milestone 3 — E-Ink 优化
完成：
- partial refresh
- full refresh
- 残影策略
- 刷新次数控制
- BOOX 专有 API 适配

### Milestone 4 — 多页面
完成：
- 物理翻页键
- 多 Page
- 本地 Frame 缓存
- 页面切换

### Milestone 5 — Admin
完成：
- Device 管理
- Widget 开关
- Refresh 配置
- Layout 配置
- Preview / Publish

### Milestone 6 — 统一个人终端
接入：
- ESP32-S3 AI Pet
- mem0
- Agent
- Server
- AI Usage
- 其他设备

## 14. Codex 当前任务

当前不要一次完成整个系统。

先建立项目骨架并完成 Milestone 0 + Milestone 1。

优先目标：

1. 创建 `LeafDashboard` Android 项目
2. 锁定横屏 1680×1264
3. 实现 Immersive Fullscreen
4. 从配置 URL 下载 PNG
5. 下载成功后全屏显示
6. 本地缓存最后有效图片
7. 网络异常时继续显示缓存
8. 增加手动 Refresh
9. 记录实体翻页键 KeyCode
10. 建立最小 Node/Docker server，返回测试 PNG
11. 提供 README，包括构建、安装、ADB 调试方法

暂时不要：
- 做复杂 Admin
- 做拖拽布局
- 做全部 Widget
- 做复杂数据库
- 提前过度设计

先保证：

`Server PNG → Wi‑Fi → Leaf5+ APK → E-Ink 全屏显示`

这条链路稳定跑通。
