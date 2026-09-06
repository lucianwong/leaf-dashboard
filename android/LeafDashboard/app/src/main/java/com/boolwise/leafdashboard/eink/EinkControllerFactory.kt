package com.boolwise.leafdashboard.eink

import android.util.Log

/** 控制器选择:优先 BOOX 专有,不可用回退标准 Android 实现 */
object EinkControllerFactory {
    fun create(): EinkController {
        val generic = GenericEinkController()
        return try {
            val boox = BooxEinkController(generic)
            boox.logDiscovery() // M9 Discovery:真机收集 Onyx API 方法签名
            if (boox.isAvailable()) {
                Log.i("LeafDashboard", "eink controller: boox")
                boox
            } else {
                Log.i("LeafDashboard", "eink controller: generic")
                generic
            }
        } catch (e: Exception) {
            Log.w("LeafDashboard", "boox controller init failed: ${e.message}")
            generic
        }
    }
}
