package com.boolwise.leafdashboard.boot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/**
 * 开机 / APK 覆盖安装后自动恢复 Dashboard(Leaf Runtime 1.1 M8)。
 *
 * 监听:
 *  - ACTION_BOOT_COMPLETED:整机重启后自动拉起
 *  - ACTION_MY_PACKAGE_REPLACED:APK 覆盖安装完成后自动拉起
 *
 * 注意:Android 对后台启动 Activity 有限制,但 BOOT_COMPLETED 拉起自身
 * 属常见豁免场景;BOOX 固件是否放行需真机验证(M8 验收项)。
 */
class BootReceiver : BroadcastReceiver() {
    companion object {
        private const val TAG = "LeafDashboard"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        val reason = when (action) {
            Intent.ACTION_BOOT_COMPLETED -> "boot"
            Intent.ACTION_MY_PACKAGE_REPLACED -> "package_replaced"
            else -> return
        }
        Log.i(TAG, "boot event: $action, launching dashboard")
        // 记录启动原因:系统性重启不计入 Crash Guard 的崩溃循环
        context.getSharedPreferences("leaf_dashboard", Context.MODE_PRIVATE)
            .edit().putString("startup_reason", reason).apply()
        val launch = context.packageManager.getLaunchIntentForPackage(context.packageName)
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try {
                context.startActivity(launch)
            } catch (e: Exception) {
                Log.w(TAG, "boot launch failed: ${e.message}")
            }
        }
    }
}
