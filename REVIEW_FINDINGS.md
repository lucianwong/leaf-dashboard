# Review Findings — 2026-09-05 — android/LeafDashboard(全部源码 + 构建复跑)

## M3 审查(2026-09-05)—— BOOX SDK 接入(git diff HEAD:onyxsdk-device 1.3.5.2 + OnyxEinkController + 模式映射)

**结论:不通过(存在 P1×4,无 P0),修复量小(均为定点改动),修复后免复审,建议 PM 抽查即可。** 构建独立复跑 `clean assembleDebug --no-daemon --rerun-tasks` 38 任务 BUILD SUCCESSFUL(M3 diff 零警告,2 条警告均为 MainActivity 既有代码);SDK aar 已本地反编译验证核心行为,五项审查重点逐项结论如下。审查方法说明:反射链路结论来自对 gradle 缓存中 `onyxsdk-device-1.3.5.2.aar` 的 javap 字节码分析,非猜测。

### 五项重点逐项结论

1. **反射探测异常安全(PM 重点 1)—— 基本达标,一处防御缺口**
   - OnyxEinkController companion 的 `Class.forName` 用 `catch (t: Throwable)` ✓(覆盖 NoClassDefFoundError/ExceptionInInitializerError 等 Error);partialRefresh/fullRefresh 的调用也是 `catch (t: Throwable)` ✓。
   - 残留缺口:EinkControllerFactory.kt:31 仍是 `catch (e: Exception)`——经字节码路径推演当前不可穿透(CLASS_AVAILABLE 已拦掉类加载 Error;真正触发 EpdController/Device 类初始化的调用点都在 Throwable catch 内),但防御一致性建议改为 `catch (t: Throwable)`(P2-1)。
2. **非 BOOX 设备影响(PM 重点 2)—— 不崩溃,但全刷静默失效(见 P1-1)**
   - 字节码证据:BaseDevice.invalidate(view, mode) = `view.invalidate()`;BaseDevice.refreshScreen(view, mode) = **空方法(no-op)**;Device.detectDevice() 按 Build.HARDWARE/ro.board.platform 匹配(rk3288/rk312x/rk3368/msm8953/sdm660/bengal/msmnile/lito/volcano/freescale/imx7/rk30board),不命中 → `new BaseDevice()`。
   - 即非 BOOX 设备上:局刷退化为标准 view.invalidate()(画面正常重绘,不坏);**全刷为 no-op 且不抛异常**——OnyxEinkController 的"调用不抛异常"探活判据对该场景完全失效,degrade 永不触发,Generic 白黑闪兜底永远轮不到,消残影静默消失且零日志零遥测。
3. **http maven 供应链(PM 重点 3)—— allowInsecureProtocol 范围合规,CI 暴露面真实(见 P1-4)**
   - allowInsecureProtocol 仅出现在 app/build.gradle.kts 的 BOOX 仓库声明,未全局放开 ✓;依赖版本固定 1.3.5.2 ✓。
   - 但 ci.yml:64 在 GitHub Actions(公网)上 `./gradlew assembleDebug` 经 http 明文拉取该 aar,无校验和固定 → MITM/DNS 劫持可投毒,恶意代码直接进 APK 分发到设备。
4. **invalidate/refreshScreen 线程要求(PM 重点 4)—— 主线程要求成立,当前全部调用点合规**
   - 局刷链 EpdController.invalidate → BaseDevice.invalidate → `view.invalidate()`,View.invalidate 要求创建线程(主线程);全刷子类实现走 EPD 服务但约定同。当前接入点全部主线程:pollOnce 的 `runOnUiThread` 回调、Command `device.full_refresh` 的 `runOnUiThread { performEinkFullRefresh }`、switchPage/showCachedFrame(UI 回调)✓ 无违规。建议在 OnyxEinkController KDoc 固化"必须主线程"约定(P2-3)。
5. **refresh 策略接入 vs 0.5.x Command/safe-mode(PM 重点 5)—— 执行链路完好,能力协商脱节(见 P1-3)**
   - safe-mode heartbeat-only 分支不触碰任何 eink 方法 ✓;Command 幂等/台账/ACK 逻辑未动,device.full_refresh 的 `performEinkFullRefresh(0L)` 经 onyx 成功路径同步 onComplete(metrics 固化 + fullRefreshInFlight 复位恰好一次;catch 后 generic fallback 复用同一 onComplete,不重复)✓;page.switch/device.refresh/sync.restart 线程切换正确 ✓。
   - 脱节点:能力协商字段与 Onyx 控制器未接上 + server 白名单丢字段,详见 P1-3。

### P0 阻塞问题

(无)

### P1 应修复(M3 范围)

1. **[OnyxEinkController.kt:46-56 探活判据 / SDK BaseDevice.refreshScreen no-op] 全刷静默失效:非 BOOX 设备及平台字符串不匹配的设备上 GC 全刷不执行、不报错、遥测恒报 true**
   - 反编译实链:detectDevice() 不命中平台 → BaseDevice → refreshScreen 为空方法 → `EpdController.refreshScreen(view, GC)` 返回成功 → onComplete() 照常回调 → metrics 记 full 完成、`onyxFullAvailable=true`。Generic 白黑闪兜底与 degrade 路径永远不触发。Leaf5+ 为高通平台,其 `ro.board.platform` 字符串是否在 SDK 列表内未经真机确认——若不在,M3"真全刷"目标在目标机型上静默落空。
   - 建议:探活改为能力探测——选中 onyx 前检查 `Device.currentDeviceIndex()`/`Device.currentDevice().javaClass.simpleName` 是否为已知设备类(反射读静态字段即可),BaseDevice 视为不可用直接走 Generic;真机 M0 用 Discovery 日志(`adb logcat -s LeafKeys` 已有机制)确认 detectDevice 命中类后再把 GC 路径视为已验证。
2. **[onyxsdk-device aar manifest → merged APK] 权限膨胀:带入 CHANGE_WIFI_STATE/BLUETOOTH/DUMP 三个无用权限**
   - 实测 `aapt2 dump permissions`:APK 现含 INTERNET/ACCESS_NETWORK_STATE/RECEIVE_BOOT_COMPLETED(项目自有,合理)+ **CHANGE_WIFI_STATE、BLUETOOTH、DUMP**(SDK 带入;aar manifest 明文声明,DUMP 为 signature 级保护权限)。违背 M0 确立的权限最小化基线,审计/上架均会被质疑。
   - 建议:manifest 已有 tools 命名空间,三行 `tools:node="remove"` 逐个移除即可。
3. **[MainActivity.kt:923-925 + server/src/index.js:296-346] capabilities 协商与新控制器脱节**
   - 两处断链:① `eink-native-v1` 仅在 `booxFullAvailable==true` 时上报,而选中 OnyxEinkController 后 BooxEinkController 从未构造——onyx GC 真实可用时 eink-native-v1 永远缺失,服务端/Command 路由无法据此选择专有刷新;② Android 心跳上报的 `capabilities` 数组(含 onyxPartial/FullAvailable)不在 server 心跳白名单字段内,被静默丢弃,Admin 无从感知。
   - 建议:① 判定改为 `booxFullAvailable || onyxFullAvailable`;② server 白名单增加 capabilities 字段(或 Android 侧改用既有布尔字段表达)。
4. **[ci.yml:64 + app/build.gradle.kts:66-69] CI 公网经 http 明文拉取构建依赖,无校验和固定(供应链)**
   - 仓库无 `gradle/verification-metadata.xml`;GitHub Actions 上 MITM/DNS 劫持可向构建注入恶意 aar 并随 APK 分发到设备。本机构建(固定版本 + Surge 代理)风险较低,CI 是主要暴露面。
   - 建议(二选一):① `./gradlew --write-verification-metadata sha256` 生成 verification-metadata.xml 入库,CI 自动校验;② 更彻底:vendor 化——把 onyxsdk-device-1.3.5.2.aar(~200KB)提交进仓库 `app/libs/` 用 `files(...)` 引入,删除 http 仓库声明与 allowInsecureProtocol,供应链面归零(SDK 无版本升级诉求时最推荐)。

### P2 建议

1. **[EinkControllerFactory.kt:31] `catch (e: Exception)` → `catch (t: Throwable)`**:与两级控制器探活的 Throwable 风格对齐,杜绝 Error 类穿透显示链路的可能(当前推演不可穿透,纯防御)。
2. **[settings.gradle.kts:11-13] 注释与 PREFER_PROJECT 语义相反**:注释称"未命中的依赖仍回退到 settings 里的镜像",实际 PREFER_PROJECT 下 settings 仓库被忽略——目前其他依赖能解析靠的是 app 模块补的 aliyun 镜像(行为正确,注释误导),建议改写注释避免后人误删镜像声明。
3. **[OnyxEinkController.kt] KDoc 固化"必须主线程调用"约定**:invalidate 链含 view.invalidate()(主线程要求),当前调用点全部合规,加注释防止后续误用。
4. **[传递依赖知晓项]** 依赖树实测 onyxsdk-device 带入 fastjson2(2.0.48.android8)与 kotlin-stdlib 1.8(升至 1.9.24);SDK 硬依赖无法避免,APK 增量与序列化库攻击面记入台账即可;`android.useAndroidX=true` 仅为 androidx.annotation 打开,注释已说明 ✓。
5. **[tools:replace="android:allowBackup"]** 用途正当(SDK manifest allowBackup=true 与项目 false 冲突)✓,修复 P1-2 时保留即可。

### 正面确认

- 模式映射(partial→GU / full→GC)与任务书一致,UpdateMode 枚举实测存在 GU/GC ✓
- degrade 单向降级 + fallback 包装,局刷对非 BOOX 设备等效标准重绘(不会坏画面)✓
- `tools:replace`/`tools:remove` 命名空间引入规范;versionName 0.5.2 递进 ✓
- 心跳 einkController/einkAvailable 字段为既有白名单,onyx 选中后如实上报 "onyx" ✓
- M3 diff 零编译警告;既有 MainActivity 两条警告(186/612)不属本 diff,留待后续清理

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
