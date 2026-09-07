pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    // PREFER_PROJECT:全局 init script(~/.gradle/init.d 阿里云镜像)会在
    // settingsEvaluated 后 clear 本文件的仓库列表;且 PREFER_PROJECT 模式下
    // 项目声明仓库后 settings 仓库被完全忽略(非逐依赖回退),因此其余运行时
    // 依赖的镜像兜底(google/mavenCentral 的 aliyun 镜像)声明在 app 模块
    repositoriesMode.set(RepositoriesMode.PREFER_PROJECT)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "LeafDashboard"
include(":app")
