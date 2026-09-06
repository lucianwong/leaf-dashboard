package com.boolwise.leafdashboard.command

import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * 命令台账(Leaf Dashboard 0.5.0):幂等执行依据。
 *
 * At-least-once 下发模型下,同一命令 ID 可能重复到达;
 * 台账记录最近 ~100 条已处理命令,命中即不重复执行、只重发 ACK。
 * 持久化 filesDir/cmd_ledger.json,重启后依然幂等。
 */
object CommandLedger {
    private const val TAG = "LeafDashboard"
    private const val MAX_ENTRIES = 100

    private val entries = LinkedHashMap<String, JSONObject>()
    private lateinit var file: File
    private var loaded = false

    /** 在 Activity onCreate 调用一次 */
    fun init(dir: File) {
        file = File(dir, "cmd_ledger.json")
        loaded = true
        try {
            if (file.exists()) {
                val obj = JSONObject(file.readText())
                for (key in obj.keys()) {
                    entries[key] = obj.getJSONObject(key)
                }
                Log.i(TAG, "command ledger loaded: ${entries.size} entries")
            }
        } catch (e: Exception) {
            Log.w(TAG, "ledger load failed: ${e.message}")
        }
    }

    /** 该命令是否已处理过(无论成功失败) */
    fun has(id: String): Boolean = entries.containsKey(id)

    fun statusOf(id: String): String? = entries[id]?.optString("status")

    fun resultOf(id: String): JSONObject? = entries[id]?.optJSONObject("result")

    /** 记录命令处理结果(终态);超过 100 条丢最旧 */
    fun record(
        id: String,
        status: String,
        result: JSONObject? = null,
        error: String? = null,
    ) {
        if (!loaded || id.isBlank()) return
        val entry = JSONObject()
            .put("status", status)
            .put("completedAt", System.currentTimeMillis())
        result?.let { entry.put("result", it) }
        error?.let { entry.put("error", it) }
        entries.remove(id)
        entries[id] = entry
        while (entries.size > MAX_ENTRIES) {
            entries.remove(entries.keys.first())
        }
        save()
    }

    private fun save() {
        try {
            val tmp = File(file.parentFile, "cmd_ledger.json.tmp")
            tmp.writeText(JSONObject(entries as Map<*, *>).toString())
            tmp.renameTo(file)
        } catch (e: Exception) {
            Log.w(TAG, "ledger save failed: ${e.message}")
        }
    }
}
