# LeafDashboard(Android 客户端)

BOOX Leaf5+ E-Ink 信息屏客户端:全屏显示服务端渲染的 1680×1264 PNG Frame。

零第三方依赖(纯平台 API),单 Activity,传统 View,无 Compose。

## 前置要求

- JDK 17+
- Android SDK(compileSdk 34,build-tools 35.0.0),`ANDROID_HOME` 指向 SDK 目录
- 首次构建需联网下载 Gradle 8.9 发行版与 AGP/Kotlin 依赖(代理配置见 `gradle.properties` 注释)

## 构建

```bash
cd android/LeafDashboard
./gradlew assembleDebug
# 产物:app/build/outputs/apk/debug/app-debug.apk
```

服务端默认地址配置在 `app/build.gradle.kts` 的 `buildConfigField("String", "SERVER_URL", ...)`,
改后重新构建即可;也可不改代码,在 App 首启动设置界面输入。

## 安装与调试

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk   # 安装/覆盖安装
adb shell am start -n com.boolwise.leafdashboard/.MainActivity  # 启动

adb logcat -s LeafDashboard   # 应用主日志(轮询/下载/刷新)
adb logcat -s LeafKeys        # 实体按键日志(翻页键 KeyCode 采集)
```

抓按键日志后按翻页键,每一行输出 `keyCode / action / repeatCount`。

## 运行行为

- **首启动**:显示简易设置面板,可输入服务端地址保存,或点"跳过"使用内置默认;之后不再出现
- **轮询**:每 5 分钟拉取 `GET /api/device/{deviceId}/status`,`version` 变化才下载 frame;
  deviceId 为首启动随机生成的 UUID(保存在 SharedPreferences)
- **下载**:先写 `frame_next.png`,校验非空且 PNG 魔数(`89 50 4E 47`)后原子 rename 为
  `frame_current.png` 再显示;解码失败/网络失败均不清空当前画面
- **手动刷新**:触屏任意处触发一次刷新
- **离线**:无网时继续显示 `frame_current.png` 缓存(首装无缓存则保持黑屏)
- **屏幕**:横屏锁定(sensorLandscape)+ Immersive Sticky 全屏;常亮(`FLAG_KEEP_SCREEN_ON`)
- **按键**:`onKeyDown`/`onKeyUp` 全量写日志(tag `LeafKeys`),供 Milestone 0 采集 BOOX 翻页键

## 已知限制(M2/M3 处理)

- 刷新策略固定 partial,full refresh(消残影)在 M3 做
- 无 version diff 完整逻辑(断网恢复后的补偿下载),M2 完善
- 明文 HTTP 仅限内网使用,勿暴露公网(服务端同样无鉴权)
