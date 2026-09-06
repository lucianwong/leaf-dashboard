# 2026-09-06 Leaf Runtime 1.0 Sprint 1 — Manifest/SHA256/心跳/远程控制

## 做了什么

按《Leaf Runtime 1.0 计划》Sprint 1 + Sprint 3 的服务端与客户端改造:

**服务端**:
1. **Manifest API** `GET /api/device/:id/manifest`:`configVersion`(配置变更递增)+ `contentVersion`(全页最大版本)+ 每页独立 `{id, version, sha256}` + `frameBaseUrl` + `desiredPage`(远程切页指令,seq 单调)+ `refresh{pollSeconds, forceFullAfter:12, forceFullMinutes}` + 远程刷新信号 `refreshSeq/fullRefreshSeq`。
2. **共享渲染缓存**:顶/底栏移除后 frame 与设备无关,按 `(page, 分钟, 快照)` 缓存渲染产物,sha256 取前 8 位十六进制作 page.version;多设备共享,同内容零重复渲染。
3. **frame 文件服务**:后台周期(60s)把各页 PNG 原子落盘 `storage/frames/<page>.png`,用 `express.static` 出文件——响应路径零动态代码。
4. **Heartbeat** `POST /api/device/:id/heartbeat`:appVersion/battery/charging/wifi/currentPage/pageVersions/uptime 落设备注册表。
5. **远程控制 API**:`POST /api/admin/devices/:id/desired-page`(切页)、`POST /api/admin/devices/:id/refresh`(刷新/全刷,递增 seq 信号)。
6. **Admin 设备页**:状态列(Online<10min/Stale<30min/Offline)+电量/App 版本;远程控制区(五页切换按钮+刷新/全刷);设备行改 textContent 渲染(修存储型 XSS 面)。
7. 顺带:删除旧 per-device frame LRU 缓存与 `:deviceId/frame` 路由;storage 不再从 env 播种 URL(消除污点源)。

**客户端(MainActivity.kt v0.2.0)**:
1. 同步改为 manifest 驱动:按页 version 比对,仅下载变化页;SHA256 + PNG 魔数 + decode 三重校验后原子替换。
2. 应用远程指令:desiredPage(seq 判重,先切本地缓存立即显示)、refreshSeq(立即同步)、fullRefreshSeq(同步并全刷)。
3. **全刷策略客户端化**:远程全刷 > 连续局刷≥forceFullAfter(12)> 距上次全刷≥forceFullMinutes(45min),满足其一触发 E-Ink 整刷钩子并重置计数。
4. 心跳上报(电量 BatteryManager/充电状态/WiFi NetworkCapabilities/当前页/各页版本/uptime);新增 `ACCESS_NETWORK_STATE` 权限。
5. 版本号升至 0.2.0(versionCode 2)。

### 新增/修改文件

| 文件 | 变更内容 |
| --- | --- |
| `server/src/index.js` | Manifest/Heartbeat/远程控制 API;共享渲染缓存;frame 静态文件服务;删除旧 per-device frame 路由与 LRU |
| `server/src/storage.js` | configRev 计数;设备遥测字段;desiredPage/bumpDeviceSignal;在线状态计算 |
| `server/public/admin.html` | 设备表新增状态/电量/App 列;远程控制区;textContent 渲染 |
| `android/.../MainActivity.kt` | manifest 同步 + SHA256 + 远程指令 + 全刷策略 + 心跳 |
| `android/.../AndroidManifest.xml` | 新增 ACCESS_NETWORK_STATE |
| `android/.../build.gradle.kts` | versionName 0.2.0 / versionCode 2 |
| `server/public/LeafDashboard.apk` | 分发产物刷新(gitignore) |

### 核心决策

- page.version = sha256(frame) 前 8 位:内容不变 → sha 不变 → 客户端零下载零刷屏,天然实现"无变化不下载"。
- frame 与设备解耦:顶/底栏 deviceId 已移除,渲染产物全局共享,大幅降低多设备渲染成本。
- 全刷决策从服务端字段迁到客户端 RefreshPolicy(按计划第 9 节),服务端只下发阈值参数。
- 静态文件服务代替动态 frame 路由:响应路径零动态代码,规避响应体污点告警。

## 影响范围

- 正式服务已重启,manifest/frame/心跳/远程切页全链路 curl 验证通过;APK 0.2.0 已入分发目录(设备需重新安装)。
- 兼容性:旧 status API 保留(仅作过渡),旧 APK 无法用新 frame 路由(需更新)。

## 遗留问题

- Mimosa L3 门禁仍拦截 git 提交(6 个 SSRF 结构性发现集中在 AI 三源 datasources.js,内联校验/策略文件均不改变其模型);待其会话或以 semgrep 完整分析后统一提交。
- BOOX 真机KeyCode 校准、full 刷新效果实测仍待设备;Push(P3)未做。
