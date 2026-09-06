package com.boolwise.leafdashboard.eink

import android.util.Log
import android.view.View

/**
 * BOOX/Onyx 专有 E-Ink 控制器:反射探测系统类并调用整刷/局刷。
 *
 * BOOX 无公开 SDK 文档且方法签名随固件变化,策略:
 *  - Discovery:把候选类的全部方法与签名打进日志(LeafKeys tag),
 *    真机上收集后即可在此固化精确调用(M9 验收项)
 *  - Full:尝试候选类中的 full/refresh 类无参方法;全部不可用则回退 Generic
 *  - Partial:标准 setImageBitmap 已触发默认局部波形,这里仅 invalidate;
 *    真机确认快速刷新 API 后在此接入
 */
class BooxEinkController(
    private val fallback: EinkController,
) : EinkController {
    companion object {
        private const val TAG = "LeafDashboard"
        private const val DISCOVERY_TAG = "LeafKeys" // 真机采集 tag:adb logcat -s LeafKeys

        val CANDIDATE_CLASSES = listOf(
            "com.onyx.android.sdk.device.EpdController",
            "com.onyx.android.sdk.api.device.epd.EpdController",
            "com.onyx.eink.api.EinkManager",
        )
    }

    private var available = false

    override val name: String = "boox"

    override fun isAvailable(): Boolean = available

    override fun partialRefresh(view: View) {
        // 专有快速局刷 API 待真机 Discovery 后接入;当前走标准重绘
        view.postInvalidate()
    }

    override fun fullRefresh(view: View, showFrame: () -> Unit, onComplete: () -> Unit) {
        if (invokeAnyFullRefresh()) {
            Log.i(TAG, "eink full refresh via boox api")
            // 专有 API 调用为同步语义,返回即完成
            onComplete()
            return
        }
        Log.i(TAG, "boox api unavailable, falling back to generic full refresh")
        fallback.fullRefresh(view, showFrame, onComplete)
    }

    /** 反射尝试候选类中的整刷方法:任一命中返回 true */
    private fun invokeAnyFullRefresh(): Boolean {
        for (className in CANDIDATE_CLASSES) {
            try {
                val cls = Class.forName(className)
                for (method in cls.declaredMethods) {
                    val n = method.name.lowercase()
                    if (
                        n == "fullrefresh" ||
                        n == "fullrefreshwithhistogram" ||
                        n == "refreshscreen"
                    ) {
                        if (method.parameterTypes.isEmpty()) {
                            method.isAccessible = true
                            method.invoke(null)
                            Log.i(TAG, "boox full refresh via $className.${method.name}")
                            return true
                        }
                    }
                }
            } catch (e: Throwable) {
                Log.d(TAG, "boox api $className unavailable: ${e.javaClass.simpleName}")
            }
        }
        return false
    }

    /**
     * Discovery(M9 5.2):输出设备信息与候选类全部方法签名,
     * 供真机确认真正可用 API 后固化 BooxEinkController 实现。
     */
    fun logDiscovery() {
        Log.i(
            DISCOVERY_TAG,
            "device: mfr=${android.os.Build.MANUFACTURER} model=${android.os.Build.MODEL} " +
                "device=${android.os.Build.DEVICE} android=${android.os.Build.VERSION.RELEASE}",
        )
        for (className in CANDIDATE_CLASSES) {
            try {
                val cls = Class.forName(className)
                Log.i(DISCOVERY_TAG, "FOUND $className:")
                for (m in cls.declaredMethods) {
                    val params = m.parameterTypes.joinToString(",") { it.simpleName }
                    Log.i(DISCOVERY_TAG, "  ${m.name}($params): ${m.returnType.simpleName}")
                }
                available = true
            } catch (e: Throwable) {
                Log.i(DISCOVERY_TAG, "MISSING $className (${e.javaClass.simpleName})")
            }
        }
    }
}
