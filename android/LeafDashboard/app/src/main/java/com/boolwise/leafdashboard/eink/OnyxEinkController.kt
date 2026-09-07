package com.boolwise.leafdashboard.eink

import android.util.Log
import android.view.View
import com.onyx.android.sdk.api.device.epd.EpdController
import com.onyx.android.sdk.api.device.epd.UpdateMode

/**
 * ONYX 官方 SDK(onyxsdk-device)E-Ink 控制器(M3)。
 *
 *  - 局刷:[EpdController.invalidate] + [UpdateMode.GU](16 灰局刷)
 *  - 全刷:[EpdController.refreshScreen] + [UpdateMode.GC](黑闪清残影)
 *
 * 探活约定(P1-1 能力探测):SDK 类打进 APK 后 Class.forName 在任何设备都成功,
 * 不能作为可用判据;SDK 的 Device.detectDevice() 按 ro.board.platform 匹配平台,
 * 不命中时返回 BaseDevice —— 反编译确认其 refreshScreen 为空方法(no-op),
 * 全刷会"成功返回但不执行"。因此以 currentDevice() 返回的设备类名判定:
 * 仅 BaseDevice 以外的专有设备类(如 SDMDevice)视为可用,BaseDevice 直接回退 Generic。
 *
 * 线程约定:invalidate 链含 view.invalidate()(要求 View 创建线程),
 * partial/fullRefresh 必须在主线程调用(现有调用点均已合规)。
 */
class OnyxEinkController(
    private val fallback: EinkController,
) : EinkController {
    companion object {
        private const val TAG = "LeafDashboard"

        /** 能力探测命中的设备类 simpleName(如 "SDMDevice");null = SDK 类不可用 */
        val DEVICE_NAME: String? =
            try {
                val device =
                    Class
                        .forName("com.onyx.android.sdk.device.Device")
                        .getMethod("currentDevice")
                        .invoke(null)
                device?.javaClass?.simpleName
            } catch (t: Throwable) {
                null
            }

        /** BaseDevice = 平台未命中,专有刷新(尤其 refreshScreen)为 no-op,不可用 */
        val AVAILABLE: Boolean = DEVICE_NAME != null && DEVICE_NAME != "BaseDevice"
    }

    private var degraded = false

    override val name: String = "onyx"

    override val capabilities: Map<String, Boolean>
        get() =
            mapOf(
                "onyxPartialAvailable" to usable(),
                "onyxFullAvailable" to usable(),
            )

    override fun isAvailable(): Boolean = usable()

    override fun partialRefresh(view: View) {
        if (!usable()) {
            fallback.partialRefresh(view)
            return
        }
        try {
            EpdController.invalidate(view, UpdateMode.GU)
        } catch (t: Throwable) {
            degrade(t)
            fallback.partialRefresh(view)
        }
    }

    override fun fullRefresh(
        view: View,
        showFrame: () -> Unit,
        onComplete: () -> Unit,
    ) {
        if (!usable()) {
            fallback.fullRefresh(view, showFrame, onComplete)
            return
        }
        try {
            // GC 全刷黑闪清残影;调用前调用方已贴好当前内容帧,无需 showFrame 白黑闪
            EpdController.refreshScreen(view, UpdateMode.GC)
            Log.i(TAG, "eink full refresh via onyx GC")
            onComplete() // 官方 API 同步语义,返回即完成
        } catch (t: Throwable) {
            degrade(t)
            fallback.fullRefresh(view, showFrame, onComplete)
        }
    }

    private fun usable(): Boolean = AVAILABLE && !degraded

    private fun degrade(t: Throwable) {
        if (!degraded) {
            degraded = true
            Log.w(
                TAG,
                "onyx epd api failed, degrade to generic: ${t.javaClass.simpleName}: ${t.message}",
            )
        }
    }
}
