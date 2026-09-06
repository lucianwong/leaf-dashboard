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
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Toast
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * LeafDashboard 主界面:全屏显示服务端渲染的 1680x1264 E-Ink Frame。
 *
 * 职责(Milestone 1):
 *  - Immersive 全屏 + 横屏锁定,单 ImageView 直接贴图,无动画
 *  - 每 5 分钟轮询 status,version 变化才下载 frame;失败 30s 后快速重试,
 *    回前台自动恢复轮询(Milestone 2 自动更新)
 *  - frame 先落盘 frame_next.png,校验 PNG 魔数后原子 rename 为 frame_current.png;
 *    失败/无网时保留旧画面不动
 *  - 多页面(Milestone 4):页面清单由服务端下发,每页独立 PNG 缓存与版本号;
 *    触屏左/中/右三区 = 上一页/刷新/下一页,实体键(PAGE_UP/DOWN、DPAD)翻页
 *  - 版本推进时预取全部页面到本地,翻页离线即时切换
 */
class MainActivity : Activity() {
    companion object {
        private const val TAG = "LeafDashboard"
        private const val PREFS = "leaf_dashboard"
        private const val KEY_SERVER_URL = "server_url" // 已保存的自定义地址,空串 = 用默认
        private const val KEY_SETUP_DONE = "setup_done"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_LAST_VERSION_PREFIX = "last_version_" // 后拼页面名,每页独立版本跟踪
        private const val KEY_PAGES = "pages" // 服务端下发的页面清单(JSON 数组序列化)
        private const val KEY_CURRENT_PAGE = "current_page"
        private const val KEY_CONFIG_VERSION = "config_version" // manifest 配置版本
        private const val KEY_PARTIAL_COUNT = "partial_count" // 连续局刷计数(消残影策略)
        private const val KEY_LAST_FULL_AT = "last_full_at" // 上次全刷时刻(epoch ms)
        private const val KEY_LAST_REFRESH_SEQ = "last_refresh_seq" // 远程刷新信号
        private const val KEY_LAST_FULL_SEQ = "last_full_seq" // 远程全刷信号
        private const val KEY_APPLIED_DESIRED_SEQ = "applied_desired_seq" // 已应用的远程切页
        private const val POLL_INTERVAL_MS = 5 * 60 * 1000L
        private const val POLL_RETRY_MS = 30 * 1000L // 上轮失败(无网/超时)后的快速重试间隔
        private const val RESUME_POLL_DELAY_MS = 1 * 1000L // 回前台后延迟一点再刷新,避开焦点切换窗口
        private const val CONNECT_TIMEOUT_MS = 10_000
        private const val READ_TIMEOUT_MS = 30_000 // PNG 约 100KB,内网足够
        private val PNG_MAGIC = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47)
        private const val TAG_KEY_LOG = "LeafKeys" // 按键日志 tag:adb logcat -s LeafKeys
        private const val DEFAULT_PAGE = "home" // 未知的页面名一律回退首页
    }

    private lateinit var frameView: ImageView
    private lateinit var setupPanel: LinearLayout
    private lateinit var urlInput: EditText

    private val handler = Handler(Looper.getMainLooper())
    private val ioExecutor = Executors.newSingleThreadExecutor()

    // 刷新防抖:下载/请求进行中重复触屏或重复点按钮直接忽略
    private val refreshInFlight = AtomicBoolean(false)
    private var currentServerUrl: String = ""

    // 多页面(M4):页面清单由服务端 status 下发,翻页只切本地缓存并按需拉新
    private var pages: List<String> = listOf(DEFAULT_PAGE)
    private var currentPage: String = DEFAULT_PAGE

    // 轮询间隔由服务端 manifest 下发统一控制(钳制 1~60 分钟),默认 5 分钟
    private var pollIntervalMs: Long = POLL_INTERVAL_MS
    // 本轮 sync 要求 full 刷新(消残影),有新帧贴图后在 UI 线程触发整刷
    private var pendingFullRefresh = false
    // 待执行的远程全刷 seq:整刷真正触发后才 commit,失败下轮重试
    private var pendingFullSeq = 0L
    // 连续局刷阈值(manifest.refresh.forceFullAfter),超过即触发全刷
    private var forceFullAfter = 12
    // 全刷周期(manifest.refresh.forceFullMinutes)
    private var forceFullMinutes = 45

    private lateinit var frameDir: File

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

        frameDir = File(filesDir, "frames")
        // 目标目录必须先于迁移创建(rename 跨目录依赖目标存在)
        frameDir.mkdirs()
        // 迁移:0.2.0 及之前所有 frame 都写在 cacheDir 根(frame_current.png /
        // frame_<page>.png / 残留的 frame_next_*.png)。整目录搬到持久目录:
        //  - frame_current.png 语义上就是当前显示页,归位为 frame_home.png
        //  - frame_next_*.png 是下载中间态,直接丢弃
        //  - 其余 frame_*.png 原名迁移;只有 rename/copy 成功后才删除旧文件,
        //    失败的旧文件保留,下次启动重试(系统低存储清理 cacheDir 不再丢帧)
        val legacyNames = mutableSetOf<File>()
        cacheDir.listFiles()?.forEach { old ->
            if (old.isFile && old.name.startsWith("frame_")) legacyNames.add(old)
        }
        File(cacheDir, "frames").takeIf { it.isDirectory }?.listFiles()?.forEach { old ->
            if (old.isFile) legacyNames.add(old)
        }
        for (old in legacyNames) {
            val targetName = when {
                old.name.startsWith("frame_next_") -> null // 中间态直接删
                old.name == "frame_current.png" -> "frame_home.png"
                else -> old.name
            }
            if (targetName == null) {
                old.delete()
                continue
            }
            val target = File(frameDir, targetName)
            if (target.exists()) {
                old.delete()
                continue
            }
            val moved = old.renameTo(target)
            val copied = if (moved) true else try {
                old.copyTo(target, overwrite = false) != null
            } catch (e: Exception) {
                false
            }
            if (moved || copied) old.delete()
        }
        // 仅当旧目录已空才移除(残留未迁移成功的文件下次启动重试)
        File(cacheDir, "frames").takeIf { it.isDirectory && it.listFiles()?.isEmpty() == true }?.delete()

        frameView = findViewById(R.id.frame_view)
        setupPanel = findViewById(R.id.setup_panel)
        urlInput = findViewById(R.id.url_input)

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        currentServerUrl = resolveServerUrl(prefs)
        pages = loadPages(prefs)
        currentPage = prefs.getString(KEY_CURRENT_PAGE, null)?.takeIf { it in pages }
            ?: pages.first()

        findViewById<Button>(R.id.btn_save).setOnClickListener { onSaveClicked() }
        findViewById<Button>(R.id.btn_skip).setOnClickListener { onSkipClicked() }
        // 右下角浮动刷新按钮:与触屏手动刷新行为完全一致(含防抖)
        findViewById<ImageButton>(R.id.btn_refresh).setOnClickListener {
            Log.d(TAG, "manual refresh by button")
            pollOnce(manual = true)
        }

        // 首启动(未做过设置)显示简易设置面板;否则直接进入显示模式
        if (!prefs.getBoolean(KEY_SETUP_DONE, false)) {
            urlInput.setText(currentServerUrl)
            setupPanel.visibility = View.VISIBLE
        } else {
            showCachedFrame(currentPage)
            scheduleNextPoll()
        }
    }

    override fun onResume() {
        super.onResume()
        applyImmersive()
        maybeResumePolling()
    }

    override fun onPause() {
        super.onPause()
        // 移除待执行的轮询回调,避免后台无用唤醒
        handler.removeCallbacksAndMessages(null)
    }

    override fun onStop() {
        super.onStop()
        // 补一刀:onPause 之后仍在途的刷新完成后会重新排轮询回调,
        // 已入后台时再清一次,避免后台无谓唤醒(M2 网络恢复策略的一部分)
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
        showCachedFrame(currentPage)
        pollOnce() // 立即拉一次,不等下个轮询周期
    }

    // ------------------------------------------------------------------
    // 轮询与下载
    // ------------------------------------------------------------------

    private fun scheduleNextPoll(delayMs: Long = POLL_INTERVAL_MS) {
        handler.postDelayed({ pollOnce() }, delayMs)
    }

    /**
     * 回前台恢复轮询:onPause/onStop 已清空回调,若不补排,回到前台后
     * 将永远不再自动更新(M2 自动更新的恢复路径)。刷新防抖天然兜住
     * 在途任务,重复触发安全。
     */
    private fun maybeResumePolling() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        if (!prefs.getBoolean(KEY_SETUP_DONE, false)) return
        handler.postDelayed({ pollOnce() }, RESUME_POLL_DELAY_MS)
    }

    /**
     * 拉取一轮 status/frame。
     * @param manual 仅手动刷新(触屏中区/刷新按钮)时为 true——只有手动刷新
     * 才弹 Toast 反馈;自动轮询/翻页触发的拉取完全静默,不遮挡画面
     */
    private fun pollOnce(manual: Boolean = false) {
        // 防抖:已有刷新在进行中(下载/请求未返回)时,重复触屏或重复点按钮直接忽略
        if (!refreshInFlight.compareAndSet(false, true)) {
            Log.d(TAG, "refresh already in progress, ignore")
            return
        }
        // 即时反馈:仅手动刷新时提示,自动轮询不打扰观看
        if (manual) {
            Toast.makeText(this, "正在刷新…", Toast.LENGTH_SHORT).show()
        }
        // 清除已排队的周期轮询,立即执行本轮
        handler.removeCallbacksAndMessages(null)
        ioExecutor.execute {
            // Activity 已销毁:直接退出,不再 reschedule,避免僵尸轮询与 Activity 泄漏
            if (isFinishing || isDestroyed) {
                refreshInFlight.set(false)
                return@execute
            }
            val result = checkAndUpdate()
            runOnUiThread {
                refreshInFlight.set(false)
                if (isFinishing || isDestroyed) return@runOnUiThread
                when (result) {
                    is RefreshResult.Updated -> {
                        Log.i(TAG, "frame updated to version ${result.version}")
                        if (pendingFullRefresh) {
                            pendingFullRefresh = false
                            performEinkFullRefresh()
                            commitFullSeq()
                        }
                    }

                    is RefreshResult.Unchanged -> {
                        Log.d(TAG, "version ${result.version} unchanged, skip download")
                        // 远程全刷/消残影到期即使画面无变化也要执行整刷
                        if (pendingFullRefresh) {
                            pendingFullRefresh = false
                            performEinkFullRefresh()
                            commitFullSeq()
                        }
                    }

                    is RefreshResult.Failed -> {
                        Log.w(TAG, "refresh failed: ${result.reason}")
                        // 无网/失败:保持当前画面不动;仅手动刷新弹提示,自动轮询静默重试
                        if (manual) {
                            val msg =
                                if (frameFile(currentPage).exists()) {
                                    "刷新失败:${result.reason},保留当前画面"
                                } else {
                                    "刷新失败:${result.reason}"
                                }
                            Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
                        }
                    }
                }
                // 失败时 30s 快速重试(网络恢复即自动追上);成功/无变化按服务端下发周期
                scheduleNextPoll(if (result is RefreshResult.Failed) POLL_RETRY_MS else pollIntervalMs)
            }
        }
    }

    private sealed interface RefreshResult {
        data class Updated(
            val version: Long,
        ) : RefreshResult

        data class Unchanged(
            val version: Long,
        ) : RefreshResult

        data class Failed(
            val reason: String,
        ) : RefreshResult
    }

    /**
     * Leaf Runtime 1.0 同步:拉取 manifest,按页 version/sha256 差量下载,
     * 应用远程切页/刷新指令,最后上报心跳。失败走 Failed(保留旧画面)。
     */
    private fun checkAndUpdate(): RefreshResult {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        pendingFullSeq = 0L
        return try {
            val manifest = httpGetJson("$currentServerUrl/api/device/${deviceId(prefs)}/manifest")

            // 配置版本(内容 hash 字符串)变化 → 应用刷新策略(轮询间隔/全刷阈值/周期)
            // 升级迁移:0.2.0 曾以 Int 存储旧版递增计数,getString 会抛
            // ClassCastException 导致同步永远失败——遇到即清除,按未配置处理
            val configVersion = manifest.optString("configVersion", "")
            val storedConfigVersion = try {
                prefs.getString(KEY_CONFIG_VERSION, null)
            } catch (e: ClassCastException) {
                prefs.edit().remove(KEY_CONFIG_VERSION).apply()
                Log.i(TAG, "configVersion migrated Int -> String")
                null
            }
            if (configVersion != storedConfigVersion) {
                prefs.edit().putString(KEY_CONFIG_VERSION, configVersion).apply()
                manifest.optJSONObject("refresh")?.let { r ->
                    pollIntervalMs = r.optLong("pollSeconds", POLL_INTERVAL_MS / 1000)
                        .coerceIn(60, 3600) * 1000
                    forceFullAfter = r.optInt("forceFullAfter", 12)
                    forceFullMinutes = r.optInt("forceFullMinutes", 45)
                }
                Log.i(TAG, "config v$configVersion applied (poll=${pollIntervalMs / 1000}s fullAfter=$forceFullAfter fullMin=$forceFullMinutes)")
            }

            // 页面清单以服务端为准;当前页不在清单里时回退首页
            manifest.optJSONArray("pages")?.let { arr ->
                val list = (0 until arr.length())
                    .mapNotNull { arr.optJSONObject(it)?.optString("id")?.takeIf(String::isNotBlank) }
                if (list.isNotEmpty()) {
                    pages = list
                    prefs.edit().putString(KEY_PAGES, list.joinToString(",")).apply()
                    if (currentPage !in pages) {
                        currentPage = pages.first()
                        prefs.edit().putString(KEY_CURRENT_PAGE, currentPage).apply()
                    }
                }
            }

            // 远程切页指令:seq 比已应用的新才执行(先切本地缓存立即显示)
            manifest.optJSONObject("desiredPage")?.let { dp ->
                val seq = dp.optLong("seq", 0)
                val page = dp.optString("page")
                if (seq > prefs.getLong(KEY_APPLIED_DESIRED_SEQ, 0)) {
                    if (page in pages && page != currentPage) {
                        currentPage = page
                        prefs.edit().putString(KEY_CURRENT_PAGE, currentPage).apply()
                        showCachedFrame(currentPage)
                        Log.i(TAG, "remote page switch -> '$currentPage'")
                    }
                    prefs.edit().putLong(KEY_APPLIED_DESIRED_SEQ, seq).apply()
                }
            }

            // 远程刷新/全刷信号:seq 推进即视为有指令。
            // seq 不在此处持久化——必须等对应操作成功后才 commit,
            // 否则下载失败会吞掉指令;失败时下一轮 manifest 的 seq 仍更大,自动重试
            val remoteRefreshSeq = manifest.optLong("refreshSeq", 0)
            val remoteFullSeq = manifest.optLong("fullRefreshSeq", 0)
            val remoteRefresh = remoteRefreshSeq > prefs.getLong(KEY_LAST_REFRESH_SEQ, 0)
            val remoteFull = remoteFullSeq > prefs.getLong(KEY_LAST_FULL_SEQ, 0)
            pendingFullSeq = if (remoteFull) remoteFullSeq else 0L

            // 按页差量下载:version 与本地记录一致才跳过,sha256 校验失败丢弃;
            // 远程 Refresh 指令强制重拉当前页(即使 version 未变)
            val frameBase = manifest.optString("frameBaseUrl", "/api/device/frame")
            val pagesArr = manifest.optJSONArray("pages")
            var currentUpdated = false
            if (pagesArr != null) {
                for (i in 0 until pagesArr.length()) {
                    val p = pagesArr.optJSONObject(i) ?: continue
                    val page = p.optString("id")
                    val version = p.optLong("version", -1L)
                    val sha = p.optString("sha256")
                    if (page.isBlank() || version < 0) continue
                    val forceReload = remoteRefresh && page == currentPage
                    if (!forceReload && version == lastVersion(prefs, page)) continue
                    val url = "$currentServerUrl$frameBase/$page.png"
                    if (downloadFrame(page, url, version, sha)) {
                        setLastVersion(prefs, page, version)
                        if (page == currentPage) {
                            currentUpdated = true
                            // 强制重拉的当前页已成功落地,刷新指令才算完成
                            if (forceReload) {
                                prefs.edit().putLong(KEY_LAST_REFRESH_SEQ, remoteRefreshSeq).apply()
                            }
                        }
                        Log.d(TAG, "sync page '$page' v$version done")
                    } else if (page == currentPage) {
                        // 当前页下载失败:保留旧画面,不更新版本号
                        // (refreshSeq 也未 commit,下一轮自动重试)
                        return RefreshResult.Failed("download failed")
                    }
                }
            }

            // 心跳上报(失败不影响同步结果)
            postHeartbeat(prefs)

            // 全刷策略:远程全刷独立触发(即使画面无变化,消残影也是合法需求);
            // 其余按 连续局刷阈值 / 周期到期
            val now = System.currentTimeMillis()
            val lastFull = prefs.getLong(KEY_LAST_FULL_AT, 0)
            val partialCount = prefs.getInt(KEY_PARTIAL_COUNT, 0)
            val dueFull = remoteFull || (
                currentUpdated && (
                    partialCount + 1 >= forceFullAfter ||
                        now - lastFull >= forceFullMinutes * 60_000L
                    )
                )
            if (currentUpdated) {
                prefs.edit()
                    .putInt(KEY_PARTIAL_COUNT, if (dueFull) 0 else partialCount + 1)
                    .putLong(KEY_LAST_FULL_AT, if (dueFull) now else lastFull)
                    .apply()
            }
            pendingFullRefresh = dueFull
            val contentVersion = manifest.optLong("contentVersion", 0)
            if (currentUpdated) RefreshResult.Updated(contentVersion) else RefreshResult.Unchanged(0)
        } catch (e: Exception) {
            RefreshResult.Failed(describeError(e))
        }
    }

    /** 异常转可读中文:区分无法连接/地址解析失败/超时,其余不裸类名 */
    private fun describeError(e: Exception): String =
        when (e) {
            is java.net.ConnectException -> {
                "无法连接服务器"
            }

            is java.net.UnknownHostException -> {
                "无法解析服务器地址"
            }

            is java.net.SocketTimeoutException -> {
                "连接超时"
            }

            else -> {
                val detail = e.message
                if (detail.isNullOrBlank()) e.javaClass.simpleName else "网络错误:$detail"
            }
        }

    /**
     * 下载指定页 frame:写临时文件 → SHA256 校验 → PNG 魔数 → decode → 原子替换。
     * 任何一步失败保留旧 frame,返回 false。
     */
    private fun downloadFrame(
        page: String,
        url: String,
        version: Long,
        expectedSha: String,
    ): Boolean {
        val frameTarget = frameFile(page)
        val frameTemp = File(frameDir, "frame_next_$page.png")
        return try {
            val conn = URL(url).openConnection() as HttpURLConnection
            conn.connectTimeout = CONNECT_TIMEOUT_MS
            conn.readTimeout = READ_TIMEOUT_MS
            conn.inputStream.use { input ->
                frameTemp.outputStream().use { output -> input.copyTo(output) }
            } // finally 通过 use 保证流关闭

            val bytes = frameTemp.readBytes()
            // SHA256 完整性校验(manifest 下发的期望值,空则跳过)
            if (expectedSha.isNotBlank() && sha256Hex(bytes) != expectedSha) {
                Log.w(TAG, "frame '$page' sha256 mismatch, discard")
                frameTemp.delete()
                return false
            }
            if (bytes.size <= 8 || !bytes.startsWith(PNG_MAGIC)) {
                Log.w(TAG, "downloaded frame is not a valid PNG (${bytes.size} bytes), discard")
                frameTemp.delete()
                return false
            }

            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            if (bitmap == null) {
                Log.w(TAG, "PNG decode failed, discard")
                frameTemp.delete()
                return false
            }

            // 同目录 rename 为原子操作:替换完成后才展示,失败不清空当前画面
            if (!frameTemp.renameTo(frameTarget)) {
                Log.w(TAG, "rename frame_next_$page -> frame_$page failed")
                return false
            }
            // 只在展示中的页面下载完成后才贴图,后台预取页只落盘不扰动当前画面
            if (page == currentPage) {
                runOnUiThread { showBitmap(bitmap) }
            }
            Log.i(TAG, "frame '$page' v$version saved (${bytes.size} bytes, ${bitmap.width}x${bitmap.height})")
            true
        } catch (e: Exception) {
            Log.w(TAG, "download frame '$page' failed: ${e.message}")
            frameTemp.delete()
            false
        }
    }

    /** 字节数组的 SHA-256 十六进制串(小写) */
    private fun sha256Hex(bytes: ByteArray): String =
        java.security.MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

    /** 远程全刷已真正触发,才固化其 seq(失败下轮重试) */
    private fun commitFullSeq() {
        if (pendingFullSeq > 0) {
            getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putLong(KEY_LAST_FULL_SEQ, pendingFullSeq)
                .apply()
            pendingFullSeq = 0L
        }
    }

    /**
     * 心跳上报:电量/充电/WiFi/当前页/各页版本/运行时长,
     * 驱动 Admin 在线状态与远程管理;失败仅记日志。
     */
    private fun postHeartbeat(prefs: android.content.SharedPreferences) {
        try {
            val bm = getSystemService(BATTERY_SERVICE) as android.os.BatteryManager
            val battery = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
            val chargeStatus = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_STATUS)
            val charging = chargeStatus == android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
                chargeStatus == android.os.BatteryManager.BATTERY_STATUS_FULL
            val cm = getSystemService(CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            val wifi = caps?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) == true

            val pageVersions = JSONObject()
            for ((key, value) in prefs.all) {
                if (key.startsWith(KEY_LAST_VERSION_PREFIX)) {
                    pageVersions.put(key.removePrefix(KEY_LAST_VERSION_PREFIX), value)
                }
            }

            val body = JSONObject()
                .put("appVersion", BuildConfig.VERSION_NAME)
                .put("battery", battery)
                .put("charging", charging)
                .put("wifi", wifi)
                .put("currentPage", currentPage)
                .put("pageVersions", pageVersions)
                .put("uptime", android.os.SystemClock.elapsedRealtime() / 1000)
            httpPostJson("$currentServerUrl/api/device/${deviceId(prefs)}/heartbeat", body)
        } catch (e: Exception) {
            Log.d(TAG, "heartbeat failed: ${e.message}")
        }
    }

    /** POST JSON(心跳用);非 2xx 抛异常 */
    private fun httpPostJson(url: String, body: JSONObject) {
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.requestMethod = "POST"
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        conn.doOutput = true
        conn.setRequestProperty("Content-Type", "application/json")
        conn.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        val code = conn.responseCode
        if (code !in 200..299) {
            throw java.io.IOException("HTTP $code")
        }
        conn.inputStream?.close()
    }

    /** 展示指定页的本地缓存;无缓存(首装)则保持黑屏 */
    private fun showCachedFrame(page: String) {
        val file = frameFile(page)
        if (!file.exists()) return
        val bitmap = BitmapFactory.decodeFile(file.absolutePath) ?: return
        showBitmap(bitmap)
    }

    private fun showBitmap(bitmap: Bitmap) {
        frameView.setImageBitmap(bitmap)
    }

    /**
     * E-Ink 整屏刷新(M3,消残影):BOOX 专有 API 无公开文档且随固件变化,
     * 这里先反射尝试 Onyx 系统接口;全部失败则退回"白→黑→内容"三连贴图,
     * 利用墨水屏驱动对全黑帧的波形响应模拟整刷。
     * 真机效果待 Leaf5+ 实测校准,失败只记日志不影响显示链路。
     */
    private fun performEinkFullRefresh() {
        Log.i(TAG, "eink full refresh requested")
        if (tryOnyxFullRefresh()) return

        // 兜底:三连贴图模拟整刷。全黑帧会让墨水屏驱动做一次全波形刷新,
        // 是无 SDK 时的通行做法。临时 Bitmap 用完即回收,间隔期间不响应布局变化。
        val w = frameView.width
        val h = frameView.height
        if (w <= 0 || h <= 0) return
        val solid: (Int) -> Bitmap = { color ->
            Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also { it.eraseColor(color) }
        }
        frameView.setImageBitmap(solid(android.graphics.Color.WHITE))
        frameView.postDelayed({
            frameView.setImageBitmap(solid(android.graphics.Color.BLACK))
            frameView.postDelayed({
                showCachedFrame(currentPage)
            }, 150)
        }, 150)
    }

    /** 反射尝试 Onyx/BOOX 墨水屏整刷接口:任一命中即返回 true */
    private fun tryOnyxFullRefresh(): Boolean {
        val candidates = listOf(
            // Onyx SDK 常见入口:EpdController.refreshScreen / fullRefresh
            "com.onyx.android.sdk.device.EpdController",
            "com.onyx.android.sdk.api.device.epd.EpdController",
        )
        for (name in candidates) {
            try {
                val cls = Class.forName(name)
                for (method in cls.declaredMethods) {
                    val n = method.name.lowercase()
                    if (n == "fullrefresh" || n == "refreshscreen" || n == "fullrefreshwithhistogram") {
                        // 参数签名各固件不一,能无参调用就调,否则跳过
                        method.isAccessible = true
                        if (method.parameterTypes.isEmpty()) {
                            method.invoke(null)
                            Log.i(TAG, "eink full refresh via $name.${method.name}")
                            return true
                        }
                    }
                }
            } catch (e: Throwable) {
                Log.d(TAG, "eink api $name unavailable: ${e.javaClass.simpleName}")
            }
        }
        return false
    }

    /** 每页独立的 frame 缓存文件 */
    private fun frameFile(page: String): File = File(frameDir, "frame_$page.png")

    private fun lastVersion(
        prefs: android.content.SharedPreferences,
        page: String,
    ): Long = prefs.getLong(KEY_LAST_VERSION_PREFIX + page, -1L)

    private fun setLastVersion(
        prefs: android.content.SharedPreferences,
        page: String,
        version: Long,
    ) {
        prefs.edit().putLong(KEY_LAST_VERSION_PREFIX + page, version).apply()
    }

    /** 读取持久化的页面清单,空/损坏时回退单页 home */
    private fun loadPages(prefs: android.content.SharedPreferences): List<String> {
        val saved = prefs.getString(KEY_PAGES, null)?.split(",")?.map(String::trim)
            ?.filter(String::isNotEmpty).orEmpty()
        return if (saved.isEmpty()) listOf(DEFAULT_PAGE) else saved
    }

    /**
     * 翻页:先切本地缓存立即显示,再触发一次刷新按需拉新帧。
     * 循环翻页;只有一页时退化为刷新。
     */
    private fun switchPage(delta: Int) {
        if (pages.size > 1) {
            val idx = (pages.indexOf(currentPage) + delta).mod(pages.size)
            currentPage = pages[idx]
            getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit().putString(KEY_CURRENT_PAGE, currentPage).apply()
            showCachedFrame(currentPage)
            Log.i(TAG, "switch to page '$currentPage'")
        }
        pollOnce()
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

    /**
     * 触屏分三区(大点击区,符合 E-Ink 低频交互原则):
     * 左 1/3 上一页,右 1/3 下一页,中间 1/3 手动刷新
     */
    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.action == MotionEvent.ACTION_DOWN) {
            when {
                event.x < frameView.width / 3.0 -> {
                    Log.d(TAG, "page prev by touch")
                    switchPage(-1)
                }

                event.x > frameView.width * 2.0 / 3.0 -> {
                    Log.d(TAG, "page next by touch")
                    switchPage(+1)
                }

                else -> {
                    Log.d(TAG, "manual refresh by touch")
                    pollOnce(manual = true)
                }
            }
        }
        return super.onTouchEvent(event)
    }

    // 已确认可翻页的键码:标准 PAGE_UP/PAGE_DOWN 与 DPAD 左右(部分 ROM 把翻页键
    // 映射成这两组;BOOX 实际 KeyCode 真机采集后如有出入再补)
    private val pageUpKeys = intArrayOf(92, 21) // KEYCODE_PAGE_UP, KEYCODE_DPAD_LEFT
    private val pageDownKeys = intArrayOf(93, 22) // KEYCODE_PAGE_DOWN, KEYCODE_DPAD_RIGHT

    /** 实体翻页键切页(全部按键仍先在 LeafKeys tag 记录,便于真机采集) */
    override fun onKeyDown(
        keyCode: Int,
        event: KeyEvent?,
    ): Boolean {
        Log.d(TAG_KEY_LOG, "onKeyDown keyCode=$keyCode action=${event?.action} repeatCount=${event?.repeatCount}")
        when (keyCode) {
            in pageUpKeys -> {
                switchPage(-1)
                return true
            }

            in pageDownKeys -> {
                switchPage(+1)
                return true
            }
        }
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
