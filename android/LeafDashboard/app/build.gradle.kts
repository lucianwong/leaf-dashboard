plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 构建元信息:每次 git 提交构建,versionCode 自动 +1,版本号永不失更新
val buildCommit =
    providers
        .exec {
            commandLine("git", "rev-parse", "--short", "HEAD")
            isIgnoreExitValue = true
        }.standardOutput.asText
        .get()
        .trim()
        .ifEmpty { "dev" }
val buildNumber =
    providers
        .exec {
            commandLine("git", "rev-list", "--count", "HEAD")
            isIgnoreExitValue = true
        }.standardOutput.asText
        .get()
        .trim()
        .ifEmpty { "0" }
        .toIntOrNull() ?: 0

android {
    namespace = "com.boolwise.leafdashboard"
    compileSdk = 34
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.boolwise.leafdashboard"
        minSdk = 28
        targetSdk = 34
        versionCode = buildNumber + 100 // 保留人工干预空间,基线 100 起
        versionName = "0.5.3"

        // 默认 Dashboard 服务端地址(可被首启动设置里保存的 URL 覆盖)。
        // 换部署环境时改这里,或在 App 首启动界面输入新地址。
        buildConfigField("String", "SERVER_URL", "\"http://192.168.3.37:39871\"")
        // 构建 commit 短哈希:48h soak 期间 Admin/心跳可辨识设备装的到底是哪一版
        buildConfigField("String", "BUILD_COMMIT", "\"$buildCommit\"")
    }

    buildFeatures {
        buildConfig = true
        viewBinding = false // 传统 View,直接 findViewById,不需要 ViewBinding
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// 仓库:onyx SDK 已 vendor 化(app/libs,供应链面归零,无 http 仓库声明);
// PREFER_PROJECT 模式下项目仓库完全取代 settings 仓库(全局 init script 会 clear
// settings 仓库),故保留 aliyun 镜像兜底其余运行时依赖(kotlin-stdlib/fastjson2 等)
repositories {
    maven { url = uri("https://maven.aliyun.com/repository/google") }
    maven { url = uri("https://maven.aliyun.com/repository/public") }
}

// 依赖策略:平台 API 为主;唯一三方依赖是 BOOX 官方 E-Ink SDK(M3 真局刷/全刷),
// 本地 vendor 化引入(供应链安全:不经 http 仓库拉取);其他业务逻辑仍坚持零依赖
// 注:files() 引入 aar 的 POM 传递依赖不生效,fastjson2/androidx.annotation 需显式声明
dependencies {
    implementation(files("libs/onyxsdk-device-1.3.5.2.aar"))
    implementation("com.alibaba.fastjson2:fastjson2:2.0.48.android8")
    implementation("androidx.annotation:annotation:1.0.0")
}
