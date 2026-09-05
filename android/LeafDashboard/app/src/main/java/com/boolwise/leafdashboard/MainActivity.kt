package com.boolwise.leafdashboard

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors

/**
 * LeafDashboard 主界面:全屏显示服务端渲染的 1680x1264 E-Ink Frame。
 *
 * 职责(Milestone 1):
 *  - Immersive 全屏 + 横屏锁定,单 ImageView 直接贴图,无动画
 *  - 每 5 分钟轮询 status,version 变化才下载 frame(简化版,完整 diff 策略在 M2)
 *  - frame 先落盘 frame_next.png,校验 PNG 魔数后原子 rename 为 frame_current.png;
 *    失败/无网时保留旧画面不动
 *  - 触屏任意处手动刷新;onKeyDown/onKeyUp 全量记录按键(Milestone 0 采集翻页键 KeyCode)
 */
class MainActivity : Activity() {
    companion object {
        private const val TAG = "LeafDashboard"
        private const val PREFS = "leaf_dashboard"
        private const val KEY_SERVER_URL = "server_url" // 已保存的自定义地址,空串 = 用默认
        private const val KEY_SETUP_DONE = "setup_done"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_LAST_VERSION = "last_version" // -1 = 从未下载
        private const val POLL_INTERVAL_MS = 5 * 60 * 1000L
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 30_000 // PNG 约 100KB,内网足够
        private val PNG_MAGIC = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)
        private const val TAG_KEY_LOG = "LeafKeys" // 按键日志 tag:adb logcat -s LeafKeys
    }

    private lateinit var frameView: ImageView
    private lateinit var setupPanel: LinearLayout
    private lateinit var urlInput: EditText

    private val handler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadExecutor()
    private var currentServerUrl: String = ""

    private lateinit var frameDir: File
    private lateinit var frameNext: File
    private lateinit var frameCurrent: File

    // ------------------------------------------------------------------
    // 生命周期
    // ------------------------------------------------------------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 关闭 Activity 过渡动画,符合 E-Ink 无动画原则
        @Suppress("DEPRECATION")
        overridePendingTransition(0, 0)
        setContentView(R.layout.activity_main)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) // 信息屏常亮

        frameDir = cacheDir
        frameNext = File(frameDir, "frame_next.png")
        frameCurrent = File(frameDir, "frame_current.png")

        frameView = findViewById(R.id.frame_view)
        setupPanel = findViewById(R.id.setup_panel)
        urlInput = findViewById(R.id.url_input)

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        currentServerUrl = resolveServerUrl(prefs)

        findViewById<Button>(R.id.btn_save).setOnClickListener { onSaveClicked() }
        findViewById<Button>(R.id.btn_skip).setOnClickListener { onSkipClicked() }

        // 首启动(未做过设置)显示简易设置面板;否则直接进入显示模式
        if (!prefs.getBoolean(KEY_SETUP_DONE, false)) {
            urlInput.setText(currentServerUrl)
            setupPanel.visibility = View.VISIBLE
        } else {
            showCachedFrame()
            scheduleNextPoll()
        }
    }

    override fun onResume() {
        super.onResume()
        applyImmersive()
    }

    override fun onPause() {
        super.onPause()
        // 移除待执行的轮询回调,避免后台无用唤醒
        handler.removeCallbacksAndMessages(null)
    }

    override fun onDestroy() {
        super.onDestroy()
        // 关闭 IO 线程池:避免线程池泄漏;未完成的网络任务被中断
        ioExecutor.shutdownNow()
    }

    // 失焦恢复后重新进入沉浸模式(经典做法:窗口焦点变化时重设)
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) applyImmersive()
    }

    /** Immersive Sticky 全屏:隐藏状态栏/导航栏,滑出自动回缩 */
    @Suppress("DEPRECATION") // systemUiVisibility 在 API 30+ 标记废弃,但 minSdk 28 全版本可用且行为一致
    private fun applyImmersive() {
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
        )
    }

    // ------------------------------------------------------------------
    // 首启动设置
    // ------------------------------------------------------------------

    private fun resolveServerUrl(prefs: android.content.SharedPreferences): String {
        val saved = prefs.getString(KEY_SERVER_URL, "") ?: ""
        return if (saved.isNotBlank()) saved.trimEnd('/') else BuildConfig.SERVER_URL.trimEnd('/')
    }

    private fun onSaveClicked() {
        val input = urlInput.text.toString().trim()
        if (input.isEmpty() || !input.startsWith("http")) {
            Toast.makeText(this, "地址无效,请以 http:// 或 https:// 开头", Toast.LENGTH_SHORT).show()
            return
        }
        saveSetup(input.trimEnd('/'))
    }

    private fun onSkipClicked() {
        saveSetup("") // 空串 = 使用 BuildConfig.SERVER_URL
    }

    private fun saveSetup(customUrl: String) {
        getSharedPreferences(PREFS, MODE_PRIVATE)
            .edit()
            .putString(KEY_SERVER_URL, customUrl)
            .putBoolean(KEY_SETUP_DONE, true)
            .apply()
        currentServerUrl = resolveServerUrl(getSharedPreferences(PREFS, MODE_PRIVATE))
        setupPanel.visibility = View.GONE
        Toast.makeText(this, "服务端:$currentServerUrl", Toast.LENGTH_SHORT).show()
        showCachedFrame()
        pollOnce() // 立即拉一次,不等下个轮询周期
    }

    // ------------------------------------------------------------------
    // 轮询与下载
    // ------------------------------------------------------------------

    private fun scheduleNextPoll() {
        handler.postDelayed({ pollOnce() }, POLL_INTERVAL_MS)
    }

    private fun pollOnce() {
        // removeCallbacksAndMessages(null) 兼具防抖:连续触屏不会叠加并发刷新
        handler.removeCallbacksAndMessages(null)
        ioExecutor.execute {
            // Activity 已销毁:直接退出,不再 reschedule,避免僵尸轮询与 Activity 泄漏
            if (isFinishing || isDestroyed) return@execute
            val result = checkAndUpdate()
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread
                when (result) {
                    is RefreshResult.Updated -> {
                        Log.i(TAG, "frame updated to version ${result.version}")
                    }

                    is RefreshResult.Unchanged -> {
                        Log.d(TAG, "version ${result.version} unchanged, skip download")
                    }

                    is RefreshResult.Failed -> {
                        Log.w(TAG, "refresh failed: ${result.reason}")
                        // 无网/失败:保持当前画面不动,仅提示
                        if (frameCurrent.exists()) {
                            Toast.makeText(this, "刷新失败,保留当前画面", Toast.LENGTH_SHORT).show()
                        } else {
                            Toast.makeText(this, "刷新失败:${result.reason}", Toast.LENGTH_LONG).show()
                        }
                    }
                }
                scheduleNextPoll()
            }
        }
    }

    private sealed interface RefreshResult {
        data class Updated(
            val version: Int,
        ) : RefreshResult

        data class Unchanged(
            val version: Int,
        ) : RefreshResult

        data class Failed(
            val reason: String,
        ) : RefreshResult
    }

    /** 拉取 status,version 有变化才下载 frame */
    private fun checkAndUpdate(): RefreshResult {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        return try {
            val status = httpGetJson("$currentServerUrl/api/device/${deviceId(prefs)}/status")
            val version = status.getInt("version")
            val page = status.optString("page", "home")
            val last = prefs.getInt(KEY_LAST_VERSION, -1)
            if (version == last) {
                RefreshResult.Unchanged(version)
            } else {
                return if (downloadFrame(page, version)) {
                    prefs.edit().putInt(KEY_LAST_VERSION, version).apply()
                    RefreshResult.Updated(version)
                } else {
                    RefreshResult.Failed("download failed")
                }
            }
        } catch (e: Exception) {
            RefreshResult.Failed("${e.javaClass.simpleName}: ${e.message}")
        }
    }

    /** 下载 frame:先写 frame_next.png,校验 PNG 魔数后原子替换为 frame_current.png */
    private fun downloadFrame(
        page: String,
        version: Int,
    ): Boolean {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        return try {
            val conn =
                URL("$currentServerUrl/api/device/${deviceId(prefs)}/frame?page=$page")
                    .openConnection() as HttpURLConnection
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.inputStream.use { input ->
                frameNext.outputStream().use { output -> input.copyTo(output) }
            } // finally 通过 use 保证流关闭

            val bytes = frameNext.readBytes()
            if (bytes.size <= 8 || !bytes.startsWith(PNG_MAGIC)) {
                Log.w(TAG, "downloaded frame is not a valid PNG (${bytes.size} bytes), discard")
                frameNext.delete()
                return false
            }

            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            if (bitmap == null) {
                Log.w(TAG, "PNG decode failed, discard")
                frameNext.delete()
                return false
            }

            // 同目录 rename 为原子操作:替换完成后才展示,失败不清空当前画面
            if (!frameNext.renameTo(frameCurrent)) {
                Log.w(TAG, "rename frame_next -> frame_current failed")
                return false
            }
            runOnUiThread { showBitmap(bitmap) }
            Log.i(TAG, "frame v$version saved (${bytes.size} bytes, ${bitmap.width}x${bitmap.height})")
            true
        } catch (e: Exception) {
            Log.w(TAG, "download frame failed: ${e.message}")
            frameNext.delete()
            false
        }
    }

    /** 展示本地缓存的最后一帧;无缓存(首装)则保持黑屏 */
    private fun showCachedFrame() {
        if (!frameCurrent.exists()) return
        val bitmap = BitmapFactory.decodeFile(frameCurrent.absolutePath) ?: return
        showBitmap(bitmap)
    }

    private fun showBitmap(bitmap: Bitmap) {
        frameView.setImageBitmap(bitmap)
    }

    /** 设备 ID:首启动生成 UUID 持久化,服务端用它区分多设备 */
    private fun deviceId(prefs: android.content.SharedPreferences): String {
        var id = prefs.getString(KEY_DEVICE_ID, null)
        if (id == null) {
            id = UUID.randomUUID().toString()
            prefs.edit().putString(KEY_DEVICE_ID, id).apply()
        }
        return id
    }

    private fun httpGetJson(url: String): JSONObject {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        conn.inputStream.use { input ->
            return JSONObject(input.bufferedReader().readText())
        }
    }

    // ------------------------------------------------------------------
    // 交互
    // ------------------------------------------------------------------

    /** 触屏任意处:触发一次手动刷新(检查 version → 有变化才下载) */
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_DOWN) {
            Log.d(TAG, "manual refresh by touch")
            pollOnce()
        }
        return super.onTouchEvent(event)
    }

    /** Milestone 0:全量记录实体按键,用于采集 BOOX 翻页键 KeyCode */
    override fun onKeyDown(
        keyCode: Int,
        event: KeyEvent?,
    ): Boolean {
        Log.d(TAG_KEY_LOG, "onKeyDown keyCode=$keyCode action=${event?.action} repeatCount=${event?.repeatCount}")
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(
        keyCode: Int,
        event: KeyEvent?,
    ): Boolean {
        Log.d(TAG_KEY_LOG, "onKeyUp keyCode=$keyCode action=${event?.action}")
        return super.onKeyUp(keyCode, event)
    }
}

/** ByteArray 前缀比较(PNG 魔数校验用) */
private fun ByteArray.startsWith(prefix: ByteArray): Boolean {
    if (size < prefix.size) return false
    for (i in prefix.indices) if (this[i] != prefix[i]) return false
    return true
}
