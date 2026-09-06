plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.boolwise.leafdashboard"
    compileSdk = 34
    buildToolsVersion = "35.0.0"

    defaultConfig {
        applicationId = "com.boolwise.leafdashboard"
        minSdk = 28
        targetSdk = 34
        versionCode = 2
        versionName = "0.2.0"

        // 默认 Dashboard 服务端地址(可被首启动设置里保存的 URL 覆盖)。
        // 换部署环境时改这里,或在 App 首启动界面输入新地址。
        buildConfigField("String", "SERVER_URL", "\"http://192.168.3.37:39871\"")
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

// 零外部依赖:只用平台 API(HttpURLConnection / org.json / android.widget),
// 减小 APK、减少依赖面,契合 E-Ink 常驻信息屏的极简定位
dependencies {
}
