package com.boolwise.leafdashboard.eink

import android.util.Log
import android.view.View

/**
 * 标准 Android 显示链路实现(兜底,任何设备可用)。
 *  - PARTIAL:invalidate,由系统墨水屏驱动走默认波形
 *  - FULL:白 → 黑 → 内容 三连贴图,利用全黑帧触发驱动全波形,
 *    是无专有 SDK 时的通行模拟做法
 */
class GenericEinkController : EinkController {
    companion object {
        private const val TAG = "LeafDashboard"
        private const val FLASH_STEP_MS = 150L
    }

    override val name: String = "generic"

    override fun isAvailable(): Boolean = true

    override fun partialRefresh(view: View) {
        view.postInvalidate()
    }

    override fun fullRefresh(view: View, showFrame: () -> Unit, onComplete: () -> Unit) {
        Log.i(TAG, "eink full refresh (generic white-black-frame)")
        val imageView = view as? android.widget.ImageView
        val solid: (Int) -> android.graphics.Bitmap = { color ->
            android.graphics.Bitmap.createBitmap(
                view.width.coerceAtLeast(1),
                view.height.coerceAtLeast(1),
                android.graphics.Bitmap.Config.ARGB_8888,
            ).also { it.eraseColor(color) }
        }
        imageView?.setImageBitmap(solid(android.graphics.Color.WHITE))
        view.postDelayed({
            imageView?.setImageBitmap(solid(android.graphics.Color.BLACK))
            view.postDelayed({
                showFrame()
                // 内容帧贴出即完成(白→黑→内容三连的最后一步)
                onComplete()
            }, FLASH_STEP_MS)
        }, FLASH_STEP_MS)
    }
}
