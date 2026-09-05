# PM 任务书 — 执行体(leaf-executor)

你是本项目(BOOX Leaf5+ E-Ink Dashboard)的**执行体**,负责写代码并真实验证。
PM 会通过 herdr prompt 向你下达分批任务;有架构级/阻塞问题用 intercom 升级:

```
intercom({ action: "ask", to: "01a07175", message: "问题描述 + 你的建议选项" })
```

## 项目背景(摘自 BOOX_Leaf5_Dashboard_Codex_Plan.md,先完整读一遍)

- 目标:BOOX Leaf5+(7" 1680×1264 300PPI 黑白墨水屏,Android)做常驻信息屏
- 架构:**服务端渲染 1680×1264 PNG → APK 下载 → 全屏显示**,不做客户端动态 UI
- 当前阶段:Milestone 0 + 1,先跑通 `Server PNG → Wi-Fi → APK → E-Ink 全屏显示`

## 硬性约束

1. **禁止 git commit / push**,代码留在工作区,由 PM 验收后统一提交
2. 注释/文档用中文,标识符用英文;结论先行
3. 每个任务必须**真实运行验证**(起服务、curl、gradle 构建),报告真实输出,不要"应该可以"
4. 本机 macOS(BSD 用户态);Node 需联网时加 `NODE_USE_ENV_PROXY=1`;npm 装包如失败检查代理
5. 不做计划"暂时不要"清单里的事(Admin、拖拽布局、全量 Widget、复杂数据库)
6. E-Ink 设计原则:黑白高对比、避免大面积灰、无渐变、无动画、大字号大留白

## PM 技术选型(已定,不要更换;如遇阻可升级申请)

- server:Node.js ≥20 + Express;PNG 渲染用 `@napi-rs/canvas`(失败则 fallback `sharp`+SVG)
- Android:Kotlin、单 Activity、传统 View(不用 Compose)、minSdk 28、targetSdk 34、ViewBinding 可选
- 仓库布局:`server/` + `android/LeafDashboard/` + 根 `README.md`

## 任务清单

### Task-S:服务端(先做)

创建 `server/`:

1. `package.json`(ESM 或 CJS 皆可,标明 scripts: `start` / `dev`)
2. `src/index.js`:Express 服务,端口读 `PORT` 环境变量(默认 3300)
   - `GET /healthz` → `{ ok: true }`
   - `GET /api/device/:deviceId/status` → `{ version, updatedAt, refresh, page }`
     - `version`:整数,随每次 frame 内容变化递增(时间驱动即可,如每分钟变化)
     - `refresh`:固定 `"partial"`(M3 再做 full 策略)
   - `GET /api/device/:deviceId/frame?page=home` → `image/png`,1680×1264
     - 渲染测试 Dashboard:大号时钟(HH:MM)+ 日期星期 + 分区框线 + 设备名/版本角标
     - 黑底白字或白底黑字二选一(推荐白底黑字),纯黑白两色,无灰阶渐变
     - 字体:系统可用字体;中文缺失时用内置字体文件或回退英文,需在代码注释说明
   - frame 渲染结果缓存(同 version 不重复渲染)
3. `Dockerfile`(node:22-alpine,非 root,HEALTHCHECK /healthz)
4. `README.md`(server 启动、接口示例 curl、Docker 构建)

**验收(PM 会跑)**:`npm install && npm start` 后 curl 三个接口;下载 PNG 用 `sips -g pixelWidth -g pixelHeight` 验证 1680×1264。

### Task-A:Android 客户端(服务端验收后做)

创建 `android/LeafDashboard/`(Gradle Kotlin DSL;无 Android Studio 手工生成也可,但必须 `./gradlew assembleDebug` 通过):

1. 单 Activity `MainActivity`:
   - 横屏锁定 `sensorLandscape`;Immersive Fullscreen(隐藏状态栏/导航栏,无过渡动画)
   - 全屏 `ImageView`,图片按 `fitCenter` 或精确 1680×1264 显示
2. 配置:默认 Server URL 放 `BuildConfig`(`SERVER_URL`),并支持首启动简易设置(输入 URL 保存 SharedPreferences;能跳过用默认)
3. 轮询+下载(简化版,先不做 version diff 全逻辑):
   - 每 5 分钟拉 status;version 变化才下载 frame
   - 下载到 `frame_next.png`,校验非空 PNG 魔数后原子 rename 成 `frame_current.png`
   - 无网/失败:保持当前画面不动,Toast/日志提示
4. 手动刷新:触控屏幕任意处即触发一次刷新
5. 按键记录:`onKeyDown`/`onKeyUp` 把所有 keyCode/action 写日志(tag `LeafKeys`),为 Milestone 0 记录 BOOX 翻页键 KeyCode
6. 权限最小化:仅 `INTERNET`;明文 HTTP 允许(`usesCleartextTraffic`,内网 server)
7. `android/README.md`:构建命令、adb 安装/调试、取按键日志方法

**验收(PM 会跑)**:`./gradlew assembleDebug` 成功产出 APK;列出 APK 路径。

## 汇报格式

每完成一个 Task,回复:

1. 改动文件清单(路径)
2. 你实际执行的验证命令 + 关键输出
3. 已知限制/后续建议

完成后等 PM 下一步指令,不要自行开始下一 Task。
