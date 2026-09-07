package com.boolwise.leafdashboard.eink

import android.util.Log

/** 控制器选择:ONYX 官方 SDK 优先 → BOOX 反射兜底 → 标准 Android 实现 */
object EinkControllerFactory {
    fun create(): EinkController {
        val generic = GenericEinkController()
        return try {
            val onyx = OnyxEinkController(generic)
            if (onyx.isAvailable()) {
                // 命中的设备类名输出到日志(真机确认用,如 onyx device: SDMDevice)
                Log.i("LeafDashboard", "onyx device: ${OnyxEinkController.DEVICE_NAME}")
                Log.i("LeafDashboard", "eink controller: onyx")
                onyx
            } else {
                if (OnyxEinkController.DEVICE_NAME != null) {
                    // 平台未命中(BaseDevice):专有全刷为 no-op,回退反射/generic
                    Log.i(
                        "LeafDashboard",
                        "onyx device: ${OnyxEinkController.DEVICE_NAME} (unavailable, no-op device)",
                    )
                }
                // onyx 类不可用(理论上不会发生:SDK 随 APK 打包)→ 反射方案兜底
                val boox = BooxEinkController(generic)
                boox.logDiscovery() // M9 Discovery:真机收集 Onyx API 方法签名
                if (boox.isAvailable()) {
                    Log.i("LeafDashboard", "eink controller: boox")
                    boox
                } else {
                    Log.i("LeafDashboard", "eink controller: generic")
                    generic
                }
            }
        } catch (t: Throwable) {
            Log.w("LeafDashboard", "eink controller init failed: ${t.message}")
            generic
        }
    }
}
