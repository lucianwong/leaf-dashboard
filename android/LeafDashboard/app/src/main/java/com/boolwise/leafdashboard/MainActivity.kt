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
import com.boolwise.leafdashboard.command.CommandLedger
import com.boolwise.leafdashboard.eink.EinkController
import com.boolwise.leafdashboard.eink.EinkControllerFactory
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
        private const val KEY_PARTIAL_SINCE_FULL = "partial_count" // 距上次全刷的局刷计数(消残影策略)
        private const val KEY_LAST_FULL_AT = "last_full_at" // 上次全刷时刻(epoch ms)
        private const val KEY_LAST_REFRESH_SEQ = "last_refresh_seq" // 远程刷新信号
        private const val KEY_LAST_FULL_SEQ = "last_full_seq" // 远程全刷信号
        private const val KEY_APPLIED_DESIRED_SEQ = "applied_desired_seq" // 已应用的远程切页

        // Leaf Runtime 1.1:M7 稳定性指标 + M8 Crash Guard
        private const val KEY_RUNTIME_START = "runtime_start_at" // 本次进程启动时刻
        private const val KEY_LAST_ALIVE_AT = "last_alive_at" // 最近存活心跳(healthy-run 判定)
        private const val KEY_CRASH_COUNT = "crash_count" // 疑似连续崩溃计数
        private const val KEY_SAFE_MODE = "safe_mode" // 安全模式(暂停同步只显缓存)
        private const val KEY_SAFE_MODE_UNTIL = "safe_mode_until" // 安全模式截止时刻(持久化恢复)
        private const val KEY_STARTUP_REASON = "startup_reason" // boot/package_replaced/manual
        private const val KEY_SYNC_ATTEMPT = "sync_attempt_count" // 同步尝试次数
        private const val KEY_SYNC_SUCCESS = "sync_success_count" // 同步成功次数
        private const val KEY_SYNC_FAIL_COUNT = "sync_fail_count" // 同步失败次数
        private const val KEY_DL_COUNT = "frame_dl_count" // frame 下载成功次数
        private const val KEY_DL_FAIL_COUNT = "frame_dl_fail_count" // frame 下载失败次数
        private const val KEY_FULL_REFRESH_COUNT = "full_refresh_count" // 全刷执行次数
        private const val KEY_PARTIAL_TOTAL = "partial_refresh_total" // 局刷总数
        private const val KEY_LAST_REFRESH_STRATEGY = "last_refresh_strategy" // partial/full
        private const val KEY_LAST_ERROR = "last_error" // 最近一次错误摘要
        private const val KEY_LAST_SYNC_AT = "last_sync_at" // 最近同步时刻
        private const val KEY_LAST_SYNC_STATUS = "last_sync_status" // success/failed
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

    // E-Ink 控制器(BOOX 优先,Generic 兜底)
    private lateinit var eink: EinkController

    // Generic Full 的白→黑→内容约 300ms 异步窗口:期间忽略用户翻页/手动刷新
    private val fullRefreshInFlight = AtomicBoolean(false)

    // Safe Mode(M8):连续崩溃后暂停同步只显缓存,进程稳定 5 分钟自动退出
    private var safeMode = false

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
        // 命令台账:持久化于 filesDir,重启后依然幂等
        CommandLedger.init(filesDir)
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
            val targetName =
                when {
                    old.name.startsWith("frame_next_") -> null

                    // 中间态直接删
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
            val copied =
                if (moved) {
                    true
                } else {
                    try {
                        old.copyTo(target, overwrite = false) != null
                    } catch (e: Exception) {
                        false
                    }
                }
            if (moved || copied) old.delete()
        }
        // 仅当旧目录已空才移除(残留未迁移成功的文件下次启动重试)
        File(cacheDir, "frames").takeIf { it.isDirectory && it.listFiles()?.isEmpty() == true }?.delete()

        frameView = findViewById(R.id.frame_view)
        setupPanel = findViewById(R.id.setup_panel)
        urlInput = findViewById(R.id.url_input)

        // M9:控制器选择(BOOX 优先 + Discovery 日志 + Generic 兜底)
        eink = EinkControllerFactory.create()

        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        currentServerUrl = resolveServerUrl(prefs)
        pages = loadPages(prefs)
        currentPage = prefs.getString(KEY_CURRENT_PAGE, null)?.takeIf { it in pages }
            ?: pages.first()

        // M8 Crash Guard(1.1 修订):healthy-run / startupReason 降低正常重启误判
        //  - 上次会话存活 ≥5 分钟(healthy run)→ 重置崩溃计数(正常重启非崩溃)
        //  - startupReason = boot / package_replaced → 系统性重启,重置计数
        //  - 疑似崩溃 = 两次启动间隔 <5 分钟 且 上次会话非 healthy
        // Safe Mode 用持久化 safeModeUntil(epoch)判定,不依赖单个 Handler
        // callback——进程在截止前被杀再重启仍直接进入 heartbeat-only
        val now = System.currentTimeMillis()
        val lastStart = prefs.getLong(KEY_RUNTIME_START, 0)
        val lastAlive = prefs.getLong(KEY_LAST_ALIVE_AT, 0)
        val startupReason = prefs.getString(KEY_STARTUP_REASON, null)
        prefs.edit().remove(KEY_STARTUP_REASON).apply()
        val lastRunUptime = if (lastAlive > lastStart) lastAlive - lastStart else 0
        val healthyRun = lastRunUptime >= 5 * 60_000L
        val systemicRestart = startupReason == "boot" || startupReason == "package_replaced"
        val crashedRecently =
            !systemicRestart && !healthyRun &&
                lastStart > 0 && now - lastStart < 5 * 60_000L
        val crashCount = if (crashedRecently) prefs.getInt(KEY_CRASH_COUNT, 0) + 1 else 0
        safeMode = crashCount >= 3
        val safeModeUntil = if (safeMode) now + 5 * 60_000L else 0
        prefs
            .edit()
            .putLong(KEY_RUNTIME_START, now)
            .putInt(KEY_CRASH_COUNT, crashCount)
            .putBoolean(KEY_SAFE_MODE, safeMode)
            .putLong(KEY_SAFE_MODE_UNTIL, safeModeUntil)
            .apply()
        if (safeMode) {
            Log.w(TAG, "entering safe mode (crashCount=$crashCount, until=$safeModeUntil)")
            Toast.makeText(this, "连续异常,进入安全模式(仅显示缓存)", Toast.LENGTH_LONG).show()
        }
        if (crashedRecently || safeMode) {
            Log.i(
                TAG,
                "start: reason=$startupReason crashedRecently=$crashedRecently " +
                    "crashCount=$crashCount safeMode=$safeMode lastRunUptime=$lastRunUptime",
            )
        }

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
            // 启动原则:先显示本地缓存,不等网络。
            // Safe Mode 进入/退出由持久化 safeModeUntil 判定(pollOnce 内
            // heartbeat-only),不依赖单个 Handler callback
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
        // Safe Mode:safeModeUntil 截止前为 heartbeat-only(设备保持在线可见,
        // Admin 可看到 safeMode 标记);截止后本函数自动恢复正常同步。
        // heartbeat-only 分支先清旧回调再重排,保证始终只有一条定时链
        if (isSafeModeActive()) {
            Log.d(TAG, "safe mode, heartbeat-only sync")
            handler.removeCallbacksAndMessages(null)
            ioExecutor.execute {
                if (isFinishing || isDestroyed) return@execute
                val p = prefs()
                p.edit().putLong(KEY_LAST_ALIVE_AT, System.currentTimeMillis()).apply()
                postHeartbeat(p)
            }
            scheduleNextPoll()
            return
        }
        // 防抖:已有刷新在进行中(下载/请求未返回)时,重复触屏或重复点按钮直接忽略
        if (!refreshInFlight.compareAndSet(false, true)) {
            Log.d(TAG, "refresh already in progress, ignore")
            return
        }
        // Full 白黑帧窗口内忽略手动刷新(自动轮询不拦,避免杀死轮询链;
        // 300ms 窗口与 5 分钟周期碰撞概率极低)
        if (manual && fullRefreshInFlight.get()) {
            Log.d(TAG, "full refresh in flight, ignore manual refresh")
            refreshInFlight.set(false)
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
                            // 捕获本次 seq 传给异步整刷;seq 由 onComplete 唯一 commit
                            val fullSeq = pendingFullSeq
                            pendingFullSeq = 0L
                            performEinkFullRefresh(fullSeq)
                        }
                    }

                    is RefreshResult.Unchanged -> {
                        Log.d(TAG, "version ${result.version} unchanged, skip download")
                        // 远程全刷/消残影到期即使画面无变化也要执行整刷
                        if (pendingFullRefresh) {
                            pendingFullRefresh = false
                            val fullSeq = pendingFullSeq
                            pendingFullSeq = 0L
                            performEinkFullRefresh(fullSeq)
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
            // M7 指标:同步尝试计数(在发起请求前,失败也算一次 attempt)
            prefs.edit().putInt(KEY_SYNC_ATTEMPT, prefs.getInt(KEY_SYNC_ATTEMPT, 0) + 1).apply()
            val manifest = httpGetJson("$currentServerUrl/api/device/${deviceId(prefs)}/manifest")

            // 配置版本(内容 hash 字符串)变化 → 应用刷新策略(轮询间隔/全刷阈值/周期)
            // 升级迁移:0.2.0 曾以 Int 存储旧版递增计数,getString 会抛
            // ClassCastException 导致同步永远失败——遇到即清除,按未配置处理
            val configVersion = manifest.optString("configVersion", "")
            val storedConfigVersion =
                try {
                    prefs.getString(KEY_CONFIG_VERSION, null)
                } catch (e: ClassCastException) {
                    prefs.edit().remove(KEY_CONFIG_VERSION).apply()
                    Log.i(TAG, "configVersion migrated Int -> String")
                    null
                }
            if (configVersion != storedConfigVersion) {
                prefs.edit().putString(KEY_CONFIG_VERSION, configVersion).apply()
                manifest.optJSONObject("refresh")?.let { r ->
                    pollIntervalMs = r
                        .optLong("pollSeconds", POLL_INTERVAL_MS / 1000)
                        .coerceIn(60, 3600) * 1000
                    forceFullAfter = r.optInt("forceFullAfter", 12)
                    forceFullMinutes = r.optInt("forceFullMinutes", 45)
                }
                Log.i(
                    TAG,
                    "config v$configVersion applied (poll=${pollIntervalMs / 1000}s fullAfter=$forceFullAfter fullMin=$forceFullMinutes)",
                )
            }

            // 页面清单以服务端为准;当前页不在清单里时回退首页
            manifest.optJSONArray("pages")?.let { arr ->
                val list =
                    (0 until arr.length())
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
                        val targetPage = page // 捕获目标页:UI callback 不读可变的 currentPage
                        currentPage = targetPage
                        prefs.edit().putString(KEY_CURRENT_PAGE, targetPage).apply()
                        runOnUiThread {
                            if (currentPage == targetPage) {
                                showCachedFrame(targetPage)
                            }
                        }
                        Log.i(TAG, "remote page switch -> '$targetPage'")
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
                        // 当前页下载失败:统一走 catch 收尾(syncFail 计数、
                        // lastSyncStatus=failed),保证 attempt = success + fail;
                        // lastDlReason 携带真实原因(sha256/decode/rename 等);
                        // 保留旧画面,refreshSeq 未 commit 下一轮自动重试
                        throw java.io.IOException(lastDlReason ?: "current frame download failed ($page)")
                    }
                }
            }

            // 心跳上报移至 finally:在全部 metrics 更新之后执行,
            // 且下载失败等提前返回路径也照常上报

            // 全刷策略:远程全刷独立触发(即使画面无变化,消残影也是合法需求);
            // 其余按 连续局刷阈值 / 周期到期。
            // 局刷计数已在显示路径(performPartialRefresh)统一维护;
            // sinceFull/lastFullRefreshAt 只在整刷真正执行时更新(见 performEinkFullRefresh)
            val now = System.currentTimeMillis()
            val lastFull = prefs.getLong(KEY_LAST_FULL_AT, 0)
            val partialSinceFull = prefs.getInt(KEY_PARTIAL_SINCE_FULL, 0)
            val dueFull =
                remoteFull || (
                    currentUpdated && (
                        partialSinceFull >= forceFullAfter ||
                            now - lastFull >= forceFullMinutes * 60_000L
                    )
                )
            pendingFullRefresh = dueFull
            val contentVersion = manifest.optLong("contentVersion", 0)

            // 0.5.0 Command V1:执行 manifest 下发的命令(幂等,台账去重)
            processCommands(manifest.optJSONArray("commands"), pagesArr, frameBase, prefs)

            // M7 指标:同步成功 → success 计数 + 清除 lastError
            prefs
                .edit()
                .putInt(KEY_SYNC_SUCCESS, prefs.getInt(KEY_SYNC_SUCCESS, 0) + 1)
                .putLong(KEY_LAST_SYNC_AT, System.currentTimeMillis())
                .putString(KEY_LAST_SYNC_STATUS, "success")
                .putString(KEY_LAST_ERROR, null)
                .putLong(KEY_LAST_ALIVE_AT, System.currentTimeMillis())
                .apply()
            if (currentUpdated) RefreshResult.Updated(contentVersion) else RefreshResult.Unchanged(0)
        } catch (e: Exception) {
            // M7 指标:同步失败计数 + 错误摘要
            val reason = describeError(e)
            prefs
                .edit()
                .putInt(KEY_SYNC_FAIL_COUNT, prefs.getInt(KEY_SYNC_FAIL_COUNT, 0) + 1)
                .putLong(KEY_LAST_SYNC_AT, System.currentTimeMillis())
                .putString(KEY_LAST_SYNC_STATUS, "failed")
                .putString(KEY_LAST_ERROR, reason)
                .putLong(KEY_LAST_ALIVE_AT, System.currentTimeMillis())
                .apply()
            RefreshResult.Failed(reason)
        } finally {
            // 心跳在全部 metrics 更新之后上报;失败路径也照常上报
            postHeartbeat(prefs)
        }
    }

    /**
     * 0.5.0 Command V1:执行 manifest 下发的命令。
     * At-least-once 模型:同一命令可能重复到达,CommandLedger 幂等去重,
     * 已处理过的直接按台账重发 ACK,不重复执行。IO 线程调用。
     */
    private fun processCommands(
        commands: org.json.JSONArray,
        pagesArr: org.json.JSONArray?,
        frameBase: String,
        prefs: android.content.SharedPreferences,
    ) {
        for (k in 0 until commands.length()) {
            val cmd = commands.optJSONObject(k) ?: continue
            val id = cmd.optString("id")
            val type = cmd.optString("type")
            val payload = cmd.optJSONObject("payload") ?: JSONObject()
            if (id.isBlank()) continue

            // 幂等:台账命中 → 不重复执行,按记录重发 ACK
            if (CommandLedger.has(id)) {
                val st = CommandLedger.statusOf(id) ?: "succeeded"
                Log.d(TAG, "command $id already $st, re-ack")
                ackCommand(id, st, null, CommandLedger.resultOf(id))
                continue
            }
            // 过期命令:失败 ACK + 台账
            val expiresAt = cmd.optLong("expiresAt", 0)
            if (expiresAt in 1 until System.currentTimeMillis()) {
                Log.d(TAG, "command $id expired")
                ackCommand(id, "failed", "expired")
                CommandLedger.record(id, "failed", error = "expired")
                continue
            }

            Log.i(TAG, "command $id [$type] received")
            ackCommand(id, "received")

            var finalStatus = "succeeded"
            var finalError: String? = null
            val result = JSONObject()
            when (type) {
                "page.switch" -> {
                    val targetPage = payload.optString("page")
                    if (targetPage in pages) {
                        currentPage = targetPage
                        prefs.edit().putString(KEY_CURRENT_PAGE, targetPage).apply()
                        runOnUiThread { showCachedFrame(targetPage) }
                        result.put("page", targetPage)
                    } else {
                        finalStatus = "failed"
                        finalError = "unknown_page"
                    }
                }

                "device.refresh" -> {
                    // 强制重拉当前页(忽略本地 version 差异)
                    val cur = findPageEntry(pagesArr, currentPage)
                    if (
                        cur != null &&
                        downloadFrame(
                            currentPage,
                            "$currentServerUrl$frameBase/$currentPage.png",
                            cur.optLong("version", -1L),
                            cur.optString("sha256"),
                        )
                    ) {
                        setLastVersion(prefs, currentPage, cur.optLong("version", -1L))
                        result.put("refresh", "partial")
                    } else {
                        finalStatus = "failed"
                        finalError = lastDlReason ?: "frame_not_available"
                    }
                }

                "device.full_refresh" -> {
                    // 台账先记 succeeded(乐观):回退实现必然完成,300ms 窗口内
                    // 重复下发命中台账不再二次执行
                    CommandLedger.record(id, "succeeded", JSONObject().put("refresh", "full"))
                    runOnUiThread {
                        performEinkFullRefresh(0L)
                    }
                    result.put("refresh", "full")
                }

                "sync.restart" -> {
                    handler.postDelayed({ pollOnce() }, 500)
                    result.put("restarted", true)
                }

                else -> {
                    finalStatus = "failed"
                    finalError = "unknown_type"
                }
            }
            if (type != "device.full_refresh") {
                // full_refresh 的台账已乐观记录;其余命令此处记终态
                CommandLedger.record(id, finalStatus, result, finalError)
            }
            ackCommand(id, finalStatus, finalError, if (finalStatus == "succeeded") result else null)
            Log.i(TAG, "command $id [$type] -> $finalStatus")
        }
    }

    /** 从 pages 数组取指定页条目 */
    private fun findPageEntry(
        pagesArr: org.json.JSONArray?,
        page: String,
    ): org.json.JSONObject? {
        pagesArr ?: return null
        for (i in 0 until pagesArr.length()) {
            val p = pagesArr.optJSONObject(i) ?: continue
            if (p.optString("id") == page) return p
        }
        return null
    }

    /** ACK 上报(失败仅记日志:服务端 At-least-once 会重发,台账保证幂等) */
    private fun ackCommand(
        commandId: String,
        status: String,
        error: String? = null,
        result: JSONObject? = null,
    ) {
        try {
            val body = JSONObject().put("status", status)
            error?.let { body.put("error", it) }
            result?.let { body.put("result", it) }
            httpPostJson(
                "$currentServerUrl/api/device/${deviceId(prefs())}/commands/$commandId/ack",
                body,
            )
        } catch (e: Exception) {
            Log.d(TAG, "ack $commandId failed: ${e.message}")
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
        val prefs = prefs()
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
                return markDlFail(prefs, "sha256 mismatch ($page)")
            }
            if (bytes.size <= 8 || !bytes.startsWith(PNG_MAGIC)) {
                Log.w(TAG, "downloaded frame is not a valid PNG (${bytes.size} bytes), discard")
                frameTemp.delete()
                return markDlFail(prefs, "invalid png ($page)")
            }

            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
            if (bitmap == null) {
                Log.w(TAG, "PNG decode failed, discard")
                frameTemp.delete()
                return markDlFail(prefs, "png decode failed ($page)")
            }

            // 同目录 rename 为原子操作:替换完成后才展示,失败不清空当前画面
            if (!frameTemp.renameTo(frameTarget)) {
                Log.w(TAG, "rename frame_next_$page -> frame_$page failed")
                return markDlFail(prefs, "rename failed ($page)")
            }
            // 只在展示中的页面下载完成后才贴图,后台预取页只落盘不扰动当前画面。
            // page == currentPage 必须在 UI callback 执行时再确认:
            // IO 线程判断后、UI 贴图前用户可能已切走,旧页贴回会造成画面与状态不一致
            runOnUiThread {
                if (page == currentPage) {
                    showBitmap(bitmap)
                }
            }
            Log.i(TAG, "frame '$page' v$version saved (${bytes.size} bytes, ${bitmap.width}x${bitmap.height})")
            // M7 指标:下载成功计数
            prefs.edit().putInt(KEY_DL_COUNT, prefs.getInt(KEY_DL_COUNT, 0) + 1).apply()
            true
        } catch (e: Exception) {
            Log.w(TAG, "download frame '$page' failed: ${e.message}")
            frameTemp.delete()
            return markDlFail(prefs, "download error ($page): ${e.message}")
        }
    }

    /** M7 指标:下载失败计数 + 错误摘要(恒返回 false,便于失败点内联调用)。
     *  原因同时记入 lastDlReason,当前页失败外层 throw 时携带真实原因,
     *  避免被 "current frame download failed" 这类笼统消息覆盖 */
    private var lastDlReason: String? = null

    private fun markDlFail(
        prefs: android.content.SharedPreferences,
        reason: String,
    ): Boolean {
        lastDlReason = reason
        prefs
            .edit()
            .putInt(KEY_DL_FAIL_COUNT, prefs.getInt(KEY_DL_FAIL_COUNT, 0) + 1)
            .putString(KEY_LAST_ERROR, reason)
            .apply()
        return false
    }

    /** 字节数组的 SHA-256 十六进制串(小写) */
    private fun sha256Hex(bytes: ByteArray): String =
        java.security.MessageDigest
            .getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }

    /**
     * 心跳上报:电量/充电/WiFi/当前页/各页版本/运行时长,
     * 驱动 Admin 在线状态与远程管理;失败仅记日志。
     */
    private fun postHeartbeat(prefs: android.content.SharedPreferences) {
        try {
            val bm = getSystemService(BATTERY_SERVICE) as android.os.BatteryManager
            val battery = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY)
            val chargeStatus = bm.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_STATUS)
            val charging =
                chargeStatus == android.os.BatteryManager.BATTERY_STATUS_CHARGING ||
                    chargeStatus == android.os.BatteryManager.BATTERY_STATUS_FULL
            val cm = getSystemService(CONNECTIVITY_SERVICE) as android.net.ConnectivityManager
            val caps = cm.getNetworkCapabilities(cm.activeNetwork)
            val wifi = caps?.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) == true

            val pageVersions = JSONObject()
            var cacheBytes = 0L
            for ((key, value) in prefs.all) {
                if (key.startsWith(KEY_LAST_VERSION_PREFIX)) {
                    pageVersions.put(key.removePrefix(KEY_LAST_VERSION_PREFIX), value)
                }
            }
            frameDir.listFiles()?.forEach { if (it.isFile) cacheBytes += it.length() }
            // 存活心跳(healthy-run 判定依据)
            prefs.edit().putLong(KEY_LAST_ALIVE_AT, System.currentTimeMillis()).apply()

            // 0.5.0 Capability Negotiation:服务端据此选择控制方式
            // (commands-v1 vs 旧 desiredPage/seq 信号)
            val capabilities = org.json.JSONArray()
            capabilities.put("commands-v1")
            for ((cap, ok) in eink.capabilities) {
                if (ok) capabilities.put(cap)
            }
            if (eink.capabilities["booxFullAvailable"] == true) {
                capabilities.put("eink-native-v1")
            }

            val body =
                JSONObject()
                    .put("appVersion", BuildConfig.VERSION_NAME)
                    .put("buildCommit", BuildConfig.BUILD_COMMIT)
                    .put("battery", battery)
                    .put("charging", charging)
                    .put("wifi", wifi)
                    .put("currentPage", currentPage)
                    .put("pageVersions", pageVersions)
                    .put("uptime", android.os.SystemClock.elapsedRealtime() / 1000)
                    // Leaf Runtime 1.1:M7/M9 诊断与 E-Ink 指标
                    .put("androidVersion", android.os.Build.VERSION.RELEASE)
                    .put("deviceModel", "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}")
                    .put("lastSyncAt", prefs.getLong(KEY_LAST_SYNC_AT, 0))
                    .put("lastSyncStatus", prefs.getString(KEY_LAST_SYNC_STATUS, null) ?: "never")
                    .put("lastError", prefs.getString(KEY_LAST_ERROR, null) ?: JSONObject.NULL)
                    .put("frameCacheBytes", cacheBytes)
                    .put("syncAttemptCount", prefs.getInt(KEY_SYNC_ATTEMPT, 0))
                    .put("syncSuccessCount", prefs.getInt(KEY_SYNC_SUCCESS, 0))
                    .put("syncFailCount", prefs.getInt(KEY_SYNC_FAIL_COUNT, 0))
                    .put("frameDownloadCount", prefs.getInt(KEY_DL_COUNT, 0))
                    .put("frameDownloadFailCount", prefs.getInt(KEY_DL_FAIL_COUNT, 0))
                    .put("partialRefreshTotal", prefs.getInt(KEY_PARTIAL_TOTAL, 0))
                    .put("partialSinceFull", prefs.getInt(KEY_PARTIAL_SINCE_FULL, 0))
                    .put("fullRefreshCount", prefs.getInt(KEY_FULL_REFRESH_COUNT, 0))
                    .put("lastFullRefreshAt", prefs.getLong(KEY_LAST_FULL_AT, 0))
                    .put("lastRefreshStrategy", prefs.getString(KEY_LAST_REFRESH_STRATEGY, null) ?: "none")
                    .put("crashCount", prefs.getInt(KEY_CRASH_COUNT, 0))
                    .put("safeMode", safeMode)
                    .put("safeModeUntil", prefs.getLong(KEY_SAFE_MODE_UNTIL, 0))
                    .put("einkController", eink.name)
                    .put("einkAvailable", eink.isAvailable())
                    .put("einkMode", "normal")
                    .put("capabilities", capabilities)
            httpPostJson("$currentServerUrl/api/device/${deviceId(prefs)}/heartbeat", body)
        } catch (e: Exception) {
            Log.d(TAG, "heartbeat failed: ${e.message}")
        }
    }

    /** POST JSON(心跳用);非 2xx 抛异常 */
    private fun httpPostJson(
        url: String,
        body: JSONObject,
    ) {
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

    /**
     * 展示本地缓存页。
     * @param triggerPartial true=切页/普通展示,触发一次局部刷新;
     *                       false=整刷回退恢复内容(display 与 refresh 解耦)
     */
    private fun showCachedFrame(
        page: String,
        triggerPartial: Boolean = true,
    ) {
        val file = frameFile(page)
        if (!file.exists()) return
        val bitmap = BitmapFactory.decodeFile(file.absolutePath) ?: return
        showBitmap(bitmap, triggerPartial)
    }

    /**
     * 显示帧(默认触发一次局部刷新)。
     * Full 回退恢复内容时用 triggerPartial=false——display 与 refresh 解耦,
     * 整刷完成后的内容重绘不得再计一次 partial/覆盖 full 策略标记
     */
    private fun showBitmap(
        bitmap: Bitmap,
        triggerPartial: Boolean = true,
    ) {
        frameView.setImageBitmap(bitmap)
        if (triggerPartial) {
            performPartialRefresh()
        }
    }

    /**
     * Partial 刷新统一入口(M9):所有真正执行的局部刷新都从这里走,
     * 计数(total/sinceFull)与策略标记在此集中维护
     */
    private fun performPartialRefresh() {
        prefs()
            .edit()
            .putInt(KEY_PARTIAL_TOTAL, prefs().getInt(KEY_PARTIAL_TOTAL, 0) + 1)
            .putInt(KEY_PARTIAL_SINCE_FULL, prefs().getInt(KEY_PARTIAL_SINCE_FULL, 0) + 1)
            .putString(KEY_LAST_REFRESH_STRATEGY, "partial")
            .apply()
        eink.partialRefresh(frameView)
    }

    /** E-Ink 整屏刷新(M9):走 EinkController(BOOX 优先,Generic 白黑帧兜底)。
     *  metrics 与远程 seq 固化一律在 onComplete(整刷真正完成)时更新,
     *  fullSeq 由调用方捕获传入,异步 callback 不依赖全局可变状态。
     *  onComplete 供 Command 模型在真正完成后 ACK(需自行切 IO 线程) */
    private fun performEinkFullRefresh(
        fullSeq: Long,
        onComplete: () -> Unit = {},
    ) {
        if (!fullRefreshInFlight.compareAndSet(false, true)) {
            Log.d(TAG, "full refresh already in flight, skip")
            onComplete()
            return
        }
        Log.i(TAG, "eink full refresh requested via ${eink.name}")
        // 回退恢复内容帧时不再触发 partial(display/refresh 解耦)
        eink.fullRefresh(
            frameView,
            { showCachedFrame(currentPage, triggerPartial = false) },
        ) {
            prefs()
                .edit()
                .putInt(KEY_FULL_REFRESH_COUNT, prefs().getInt(KEY_FULL_REFRESH_COUNT, 0) + 1)
                .putLong(KEY_LAST_FULL_AT, System.currentTimeMillis())
                .putInt(KEY_PARTIAL_SINCE_FULL, 0)
                .putString(KEY_LAST_REFRESH_STRATEGY, "full")
                .apply()
            // 远程全刷指令真正完成后才固化其 seq
            if (fullSeq > 0) {
                prefs().edit().putLong(KEY_LAST_FULL_SEQ, fullSeq).apply()
            }
            fullRefreshInFlight.set(false)
            onComplete()
        }
    }

    /** 每页独立的 frame 缓存文件 */
    private fun frameFile(page: String): File = File(frameDir, "frame_$page.png")

    private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

    /**
     * Safe Mode 活跃判定:以持久化 safeModeUntil(epoch)为准,
     * 进程死亡重启后依然生效;截止后自动清除并恢复正常同步。
     */
    private fun isSafeModeActive(): Boolean {
        val prefs = prefs()
        if (!prefs.getBoolean(KEY_SAFE_MODE, false)) return false
        if (System.currentTimeMillis() >= prefs.getLong(KEY_SAFE_MODE_UNTIL, 0)) {
            Log.i(TAG, "safe mode expired, resuming normal sync")
            prefs
                .edit()
                .putBoolean(KEY_SAFE_MODE, false)
                .putInt(KEY_CRASH_COUNT, 0)
                .apply()
            safeMode = false
            return false
        }
        safeMode = true
        return true
    }

    private fun lastVersion(
        prefs: android.content.SharedPreferences,
        page: String,
    ): Long =
        try {
            prefs.getLong(KEY_LAST_VERSION_PREFIX + page, -1L)
        } catch (e: ClassCastException) {
            // 升级迁移:0.2.0 及之前以 Int 存储分钟版本号,新版本域为
            // sha256 前缀 Long(可达 2^32-1)。读即迁移,旧值保留为 Long——
            // 与新版本域数值不重叠,首 轮 sync 会自然比对出新帧并重下
            val legacy = prefs.getInt(KEY_LAST_VERSION_PREFIX + page, -1)
            prefs.edit().putLong(KEY_LAST_VERSION_PREFIX + page, legacy.toLong()).apply()
            Log.i(TAG, "lastVersion '$page' migrated Int -> Long ($legacy)")
            legacy.toLong()
        }

    private fun setLastVersion(
        prefs: android.content.SharedPreferences,
        page: String,
        version: Long,
    ) {
        prefs.edit().putLong(KEY_LAST_VERSION_PREFIX + page, version).apply()
    }

    /** 读取持久化的页面清单,空/损坏时回退单页 home */
    private fun loadPages(prefs: android.content.SharedPreferences): List<String> {
        val saved =
            prefs
                .getString(KEY_PAGES, null)
                ?.split(",")
                ?.map(String::trim)
                ?.filter(String::isNotEmpty)
                .orEmpty()
        return if (saved.isEmpty()) listOf(DEFAULT_PAGE) else saved
    }

    /**
     * 翻页:先切本地缓存立即显示,再触发一次刷新按需拉新帧。
     * 循环翻页;只有一页时退化为刷新。
     */
    private fun switchPage(delta: Int) {
        // Full 白黑帧窗口(约300ms)内忽略翻页,避免显示与指标交叉
        if (fullRefreshInFlight.get()) {
            Log.d(TAG, "full refresh in flight, ignore page switch")
            return
        }
        if (pages.size > 1) {
            val idx = (pages.indexOf(currentPage) + delta).mod(pages.size)
            currentPage = pages[idx]
            getSharedPreferences(PREFS, MODE_PRIVATE)
                .edit()
                .putString(KEY_CURRENT_PAGE, currentPage)
                .apply()
            // 局刷计数由 showCachedFrame → performPartialRefresh 统一维护
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

    // 已确认可翻页的键码:标准 PAGE_UP/PAGE_DOWN 与 DPAD 左右,以及 24/25
    // (BOOX Leaf5+ 实机:翻页键发音量键码;系统 MediaSessionService 会消费未拦截的
    // 音量键,必须在 onKeyDown 拦截消费 return true 才能切页,实机验证)
    private val pageUpKeys = intArrayOf(92, 21, 24) // KEYCODE_PAGE_UP, KEYCODE_DPAD_LEFT, KEYCODE_VOLUME_UP
    private val pageDownKeys = intArrayOf(93, 22, 25) // KEYCODE_PAGE_DOWN, KEYCODE_DPAD_RIGHT, KEYCODE_VOLUME_DOWN

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
        // 翻页键(含 24/25 音量键码)在 keyDown 已消费切页;keyUp 也消费,
        // 避免系统把未处理的音量键 keyUp 再交给音量调整流程
        when (keyCode) {
            in pageUpKeys, in pageDownKeys -> return true
        }
        return super.onKeyUp(keyCode, event)
    }
}

/** ByteArray 前缀比较(PNG 魔数校验用) */
private fun ByteArray.startsWith(prefix: ByteArray): Boolean {
    if (size < prefix.size) return false
    for (i in prefix.indices) if (this[i] != prefix[i]) return false
    return true
}
