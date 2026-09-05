# Review Findings — 2026-09-05 — android/LeafDashboard(全部源码 + 构建复跑)

## 终审(2026-09-05)—— android/ P1 修复复核 + 根 README 抽查

**最终结论:通过,无需再审。** 两处 P1 修复正确落实,根 README 与实际一致,未发现新引入问题;`clean assembleDebug --no-daemon --rerun-tasks` 全量 38 任务复跑 BUILD SUCCESSFUL(exit=0,0 警告,APK 2,353,412 字节)。

1. **P1-1(轮询泄漏)修复 ✓ 正确落实**
   - MainActivity.kt:113-116 新增 `onDestroy()` → `ioExecutor.shutdownNow()`;:184-187 `pollOnce()` I/O lambda 开头 `if (isFinishing || isDestroyed) return@execute`,:190-191 `runOnUiThread` 回调开头同款双判后不再 `scheduleNextPoll()`/Toast。轮询链在销毁后正确终止,中断中的下载任务走既有 catch → `frameNext.delete()`,无崩溃路径。
2. **P1-2(深色模式重建)修复 ✓ 正确落实**
   - AndroidManifest.xml `configChanges` 追加 `|uiMode`;APK 二进制复核 `configChanges=0x000006f0`(原 0x4f0 | uiMode 位),`screenOrientation=6` 等其余属性未动。
3. **根 README.md 抽查 ✓ 与实际一致**
   - 目录结构、`cd server && npm install && npm start`(默认 39871)、三条 curl 示例、`sips` 验证、`cd android/LeafDashboard && ./gradlew assembleDebug`、APK 产物路径、`adb install -r` 全路径、logcat 双 tag(`LeafDashboard`/`LeafKeys`)、"LRU frame 缓存"描述均与代码/文件实际一致;Milestone 进度表与已知限制(含抗锯齿灰阶的诚实说明)表述准确。
4. **新引入问题:无实质问题。** 两个极小备忘(不阻塞、无需整改):① 目录结构段漏列 `PM_BRIEF_reviewer.md`,server 段 `cd server` 重复出现一次,均无误导;② home 键转后台(非 finish)时进行中的刷新完成后仍会 reschedule 一次 5 分钟轮询——这是 P1-1 建议方案(isFinishing/isDestroyed 判定)的固有边界,非实现错误,信息屏常驻前台的实际用法下无影响,如 M2 改造时顺手可在 `onStop` 补一刀 `removeCallbacksAndMessages`。

## 结论(初审)

**通过(附 P1 修复建议)** —— P0 = 0。Milestone 0+1 要求全部落实:横屏/Immersive 真锁住(已从 APK 二进制清单复核)、原子替换无竞态、仅 INTERNET 权限、E-Ink 无动画原则、README 完整可跑。`./gradlew clean assembleDebug --no-daemon --rerun-tasks` 全量 38 任务独立复跑 **BUILD SUCCESSFUL**(exit=0,无编译警告),APK 2.35MB。存在 2 个 P1(轮询生命周期泄漏、深色主题重置),均为稳定性/显示正确性边界问题,不影响当前单设备真机验收,建议 M2 前修复。

## 实测记录(PM 验收复核)

- `./gradlew clean assembleDebug --no-daemon --rerun-tasks` → 38/38 任务全量执行,**BUILD SUCCESSFUL in 7s,exit=0**,无 Kotlin/AGP 警告;产物 `app/build/outputs/apk/debug/app-debug.apk`(2,353,140 字节)✓
- APK 二进制清单复核(aapt2 dump):
  - `uses-permission` 仅 **android.permission.INTERNET** 一条 ✓
  - `screenOrientation=6`(= `SCREEN_ORIENTATION_SENSOR_LANDSCAPE`)✓
  - `configChanges=0x4f0` = `orientation|screenSize|keyboardHidden|keyboard|navigation`(解码复核;漏 `uiMode`,见 P1-2)
  - `usesCleartextTraffic=true` ✓,`allowBackup=false` ✓
- 构建配置:compileSdk 34 / minSdk 28 / targetSdk 34 / JVM 17 / 零第三方依赖(仅平台 API),与任务书一致 ✓
- Gradle 8.9 wrapper + AGP 8.5.2 + Kotlin 1.9.24,`gradle.properties` 项目级代理配置正确规避用户级失效配置(注释清晰)✓
- 中文注释/文档、英文标识符 ✓;README 覆盖构建/安装/logcat 两个 tag/运行行为/已知限制 ✓

## 逐项重点核验(PM 指定)

1. **横屏/Immersive 真锁住** —— ✓ 锁定有效
   - 横屏:`sensorLandscape` 已编译进 APK(值 6,非仅代码声明);配合 `configChanges` 含 `orientation|screenSize`,旋转/翻转不重建 Activity。
   - Immersive:`applyImmersive()` 用 `IMMERSIVE_STICKY|FULLSCREEN|HIDE_NAVIGATION|LAYOUT_*` 全套 flag;`onResume()` 与 `onWindowFocusChanged(hasFocus=true)` 双入口重设,是失焦恢复(如滑出状态栏、弹窗)后重返沉浸的标准做法;主题 `Theme.Black.NoTitleBar.Fullscreen` 兜底标题栏。真机最终表现待 M0 实机确认,代码层面无遗漏。

2. **原子替换竞态** —— ✓ 无竞态
   - 单一 `newSingleThreadExecutor` 串行化全部网络 I/O;写满 `frame_next.png` → `readBytes()` 校验魔数 + `BitmapFactory.decodeByteArray` 双重校验 → 同目录 `renameTo(frameCurrent)`(同目录 rename 原子)→ 成功才 `showBitmap` 并更新 `KEY_LAST_VERSION`。失败路径(网络异常/魔数不符/decode null/rename false)均保留 `frame_current` 旧画面、不清版本号,符合"下载失败不清空当前画面"。
   - `frameNext.delete()` 置于 IOException catch 与校验失败两处,残留半截文件不会在下次误用(每次下载整体覆盖重写)。

3. **轮询生命周期** —— ✗ 存在泄漏,见 P1-1
   - Handler 侧已清理:`onPause()` 调 `handler.removeCallbacksAndMessages(null)`,无 Handler 泄漏。
   - 但 `ioExecutor`(单线程池)从未 `shutdown()`,且 `pollOnce()` 把 `runOnUiThread`(强引用 Activity)提交进池——见 P1-1。

4. **旋转/重建状态** —— ✓(该机型场景下成立,附条件)
   - `sensorLandscape` + `configChanges` 屏蔽 orientation/screenSize,显示期间不会重建,状态丢失风险在本场景不触发。首启动面板在 `onCreate` 按 `KEY_SETUP_DONE` 恢复,进程级重建(内存回收)后状态亦不丢(URL/版本号/deviceId 全部持久化)。唯一穿透场景为深色模式切换,见 P1-2。

5. **仅 INTERNET 权限** —— ✓ APK 二进制复核仅此一条;`usesCleartextTraffic` 范围与内网 HTTP 用途匹配,README 明示"勿暴露公网"。

6. **E-Ink 原则(无动画)** —— ✓ `overridePendingTransition(0,0)` 关闭过渡;单 ImageView `setImageBitmap` 直接贴图无动画;布局黑底(`Theme.Black` + `@android:color/black`)避免点亮白闪;`fitCenter` 等比显示无拉伸;无灰阶/渐变元素。

## P0 阻塞问题

(无)

## P1 应修复

1. **[MainActivity.kt:57(ioExecutor)、108-135(pollOnce)] Activity 销毁后轮询仍回调泄漏 + 单例线程池永不关闭**
   - `ioExecutor = Executors.newSingleThreadExecutor()` 从不 `shutdown()`;`pollOnce()` 在 I/O 线程完成后执行 `runOnUiThread { …; scheduleNextPoll() }`。场景:手动刷新触屏后 5 秒内退出 Activity(或系统回收)→ 网络 I/O 最长 30s(`READ_TIMEOUT_MS`)→ 期间 lambda 持有 Activity 强引用,销毁的 Activity 无法回收;完成后 `scheduleNextPoll()` 又把 `handler.postDelayed` 重新排进已失效 Activity 的 Handler,导致"僵尸轮询"再挂 5 分钟(下载完成的 `runOnUiThread` 在销毁 Activity 上是安全 no-op,但引用已泄漏)。
   - 建议:① 用 `onBackPressedDispatcher` 场景无关的判定——回调开头判 `isFinishing || isDestroyed` 则直接 return,不再 reschedule;② `onDestroy()` 中 `ioExecutor.shutdownNow()`(或改用 `lifecycleScope`,但当前零依赖架构下 `shutdownNow` 更贴合);③ `onPause` 现有 `removeCallbacksAndMessages(null)` 保留。
   - 不阻塞验收理由:信息屏 App 实际常驻前台、极少退出;真机 M0 验收不受影响,但常驻应用的内存纪律应在 M2 前补齐。

2. **[AndroidManifest.xml:15(configChanges)] `configChanges` 漏 `uiMode`:深色模式切换会重建 Activity 并白屏闪现(违背 E-Ink 无闪原则)**
   - 二进制复核 `configChanges=0x4f0` = `orientation|screenSize|keyboardHidden|keyboard|navigation`,不含 `uiMode`。系统深色/浅色模式切换(daily schedule 或手动)→ Activity 重建 → `frameView` 短暂黑底空白 → `showCachedFrame()` 重解码 PNG。虽不丢数据,但 E-Ink 屏上表现为一次无意义全屏重绘/闪烁,且与已屏蔽的其他配置变更不对称。
   - 建议:一行修复——`configChanges` 追加 `|uiMode`(与信息屏定位一致);同时确认未硬编码 `values-night` 资源(当前无 res/color 资源,无额外影响)。

## P2 建议

1. **[MainActivity.kt:194-208(checkAndUpdate)] version 写入与画面更新非原子:decode 成功但后续失败时状态不一致**
   - 顺序为 `downloadFrame() → putInt(KEY_LAST_VERSION)`,而画面更新(`runOnUiThread { showBitmap }`)在 `downloadFrame` 内部更早执行。极端时序:bitmap 已上屏 → `putInt` 前进程被杀 → 重启后 `KEY_LAST_VERSION` 仍为旧值 → 多下载一次(画面无错,仅冗余)。当前服务端 version 每分钟必变,该窗口无害;M2 做严格 version diff 时建议把"版本号提交"与"文件替换"视为一个事务(如先 rename 后写版本,或版本号写进 frame 同目录 meta 文件一并原子替换)。

2. **[MainActivity.kt:140-155(onSaveClicked)] URL 校验过于宽松**
   - `input.startsWith("http")` 可放过 `httpx://`、`http://` 空主机名等;`URL(url)` 解析失败要等到第一次轮询才以 `Failed` 呈现。建议:`startsWith("http://")||startsWith("https://")` + `URL(input).host.isNotBlank()` 即可,无需引依赖。

3. **[MainActivity.kt:237-245(httpGetJson)] 非 2xx 响应的 `errorStream` 未读取/未关闭**
   - 服务端 4xx/5xx 时 `conn.inputStream` 抛 IOException,`errorStream` 未消费;HttpURLConnection 属于 keep-alive 连接池,未读完的 errorStream 可能导致底层 socket 不可复用(每次错误新建连接)。内网单客户端影响极小;规范做法是失败时 `conn.errorStream?.close()`。

4. **[MainActivity.kt:157-176(scheduleNextPoll/pollOnce)] 首启动"保存并连接"前轮询已具备,但设置面板常驻期间不轮询:符合预期,仅需知晓**
   - `onCreate` 中未 `setup_done` 时不 `scheduleNextPoll()`,直到 `saveSetup` → `pollOnce()` 才启动,行为正确;此处仅提示:`pollOnce()` 开头 `removeCallbacksAndMessages(null)` 兼具防抖功能(连续触屏不会叠加并发刷新),设计合理,建议加注释固化,避免后续重构误删。

5. **[app/build.gradle.kts:21(SERVER_URL)] 内网 IP 硬编码在 BuildConfig**
   - `http://192.168.3.37:39871` 换网段需重新构建;已有首启动 UI 兜底,可接受。后续可考虑 M5 Admin 下发配置。

## 正面确认(符合计划、无需改动)

- 任务书 Task-A 逐条对照:单 Activity ✓ / sensorLandscape ✓ / Immersive ✓ / fitCenter ✓ / BuildConfig SERVER_URL + 首启动可跳过 ✓ / 5 分钟轮询 + version diff 下载 ✓ / frame_next → 魔数校验 → 原子 rename ✓ / 失败保持画面 + Toast/日志 ✓ / 触屏手动刷新 ✓ / onKeyDown/onKeyUp 全量日志(tag `LeafKeys`,含 repeatCount) ✓ / 仅 INTERNET + cleartext ✓ / android/README 完整 ✓
- 零第三方依赖(HttpURLConnection / org.json / 平台 View),APK 仅 2.35MB,契合 E-Ink 常驻极简定位 ✓
- `allowBackup=false` 防止缓存帧经 adb backup 外泄,安全细节到位 ✓
- 无"暂时不要"清单内的过度设计(无页面切换、无 BOOX SDK 适配、无数据库)✓
