package com.boolwise.leafdashboard.eink

import android.view.View

/** E-Ink 刷新模式(BOOX 专有模式下有意义;Generic 仅区分 PARTIAL/FULL) */
enum class EinkMode {
    NORMAL,
    PARTIAL,
    FAST,
    FULL,
}

/**
 * E-Ink 刷新控制器抽象(Leaf Runtime 1.1 M9)。
 *
 * 实现约定:
 *  - BooxEinkController:反射调用 BOOX/Onyx 专有 API,失败自动降级
 *  - GenericEinkController:标准 Android 显示链路(FULL 用白→黑→内容模拟)
 *
 * 实现不得抛异常:显示链路永不因刷新控制器出错而中断。
 */
interface EinkController {
    /** 控制器名(心跳 einkController 字段) */
    val name: String

    /** 专有 API 是否真实可用(BOOX 上 false 时调用方应视作 Generic 行为) */
    fun isAvailable(): Boolean

    /** 局部刷新:普通内容变化/切页 */
    fun partialRefresh(view: View)

    /**
     * 整屏刷新:消残影。
     *  - showFrame:回退方案最后重绘当前内容(不得触发新的局部刷新)
     *  - onComplete:整屏刷新真正完成(帧已全部贴出)后回调,
     *    用于固化远程指令 seq;保证被调用且只被调用一次
     */
    fun fullRefresh(view: View, showFrame: () -> Unit, onComplete: () -> Unit)

    /** 设置刷新模式(专有 API 支持时生效) */
    fun setMode(mode: EinkMode) {}
}
