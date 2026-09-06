// 存储层(Milestone 5 Admin):设备注册表 + 显示配置持久化。
//
// 单设备/家庭场景数据量极小,JSON 文件 + 进程内 Map 足够,不上数据库。
// 写入统一走原子写(临时文件 + rename),避免进程被杀时文件写半截。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { isSafePublicHttpUrl } from "./urlguard.js";

const DATA_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"storage",
);
const DEVICES_FILE = path.join(DATA_DIR, "devices.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

// 默认配置:轮询 5 分钟;45 分钟一次 full 刷新消残影(E-Ink 常规做法)。
// 数据源配置(M6):全部字段可选,未配置的源渲染时回退占位文案;
// 位置默认上海(仅天气展示用),可被环境变量覆盖(凭据/隐私信息只走 env)。
export const DEFAULT_CONFIG = {
	pollIntervalSec: 300,
	fullRefreshIntervalSec: 45 * 60,
	// 天气:Open-Meteo 免费无 key,只需经纬度(默认杭州)。
	// 不从 env 播种:env 字符串会被污点分析视为不可信输入并流入请求 URL;
	// 位置改动统一走 Admin 配置(写入时过 urlguard)
	weatherLat: 30.27,
	weatherLon: 120.16,
	// 日历:ICS 订阅链接(经 Admin 配置,写入时过 urlguard)
	icsUrl: "",
	// AI 用量源列表:[{name, url}],name 决定解析适配器:
	//  - codex:免 URL 免 key,读本机 ~/.codex/auth.json 的 ChatGPT 登录态
	//  - zai:  GLM Coding Plan 用量端点,key 走 env ZAI_API_KEY
	//  - kimi: Kimi For Coding 用量端点,key 走 env KIMI_API_KEY
	//  - custom: 任意返回 JSON {label, used, quota} 或 {label, text} 的端点,无鉴权
	aiUsage: [],
	// 服务器/Agent 探活列表:[{name, url}]
	servers: [],
	agents: [],
	// 待办:[{text, done}] 由 Admin 维护
	todos: [],
};

/** @type {Map<string, object>} deviceId -> 设备记录 */
const devices = new Map();
let config = { ...DEFAULT_CONFIG };

function atomicWrite(file, data) {
	fs.mkdirSync(DATA_DIR, { recursive: true });
	const tmp = `${file}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
	fs.renameSync(tmp, file);
}

function loadJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return fallback;
	}
}

export function initStore() {
	for (const [id, rec] of Object.entries(loadJson(DEVICES_FILE, {}))) {
		devices.set(id, rec);
	}
	// 配置字段做下限钳制,防止手改 JSON 出极端值(60s~1h)
	const saved = { ...DEFAULT_CONFIG, ...loadJson(CONFIG_FILE, {}) };
	config.pollIntervalSec = clampInt(saved.pollIntervalSec, 60, 3600, DEFAULT_CONFIG.pollIntervalSec);
	config.fullRefreshIntervalSec = clampInt(
		saved.fullRefreshIntervalSec,
		5 * 60,
		24 * 3600,
		DEFAULT_CONFIG.fullRefreshIntervalSec,
	);
	// 数据源字段同走 sanitize,保证从文件读入的结构可靠
	config.weatherLat = Number.isFinite(Number(saved.weatherLat)) ? Number(saved.weatherLat) : DEFAULT_CONFIG.weatherLat;
	config.weatherLon = Number.isFinite(Number(saved.weatherLon)) ? Number(saved.weatherLon) : DEFAULT_CONFIG.weatherLon;
	config.icsUrl = typeof saved.icsUrl === "string" ? saved.icsUrl : "";
	// 旧版单端点字段迁移:aiUsageUrl -> custom 源(未配置 aiUsage 时一次性迁移)
	config.aiUsage = sanitizeAiUsage(
		saved.aiUsage ?? (saved.aiUsageUrl ? [{ name: "custom", url: saved.aiUsageUrl }] : []),
	);
	config.servers = sanitizeChecks(saved.servers);
	config.agents = sanitizeChecks(saved.agents);
	config.todos = sanitizeTodos(saved.todos);
}

function clampInt(v, min, max, fallback) {
	const n = Number.parseInt(v, 10);
	if (!Number.isInteger(n) || n < min || n > max) return fallback;
	return n;
}

/** 设备心跳:status/frame/manifest/heartbeat 请求都会走到这里,upsert 并持久化(节流写盘) */
let dirty = false;
export function touchDevice(deviceId, { version, page, telemetry } = {}) {
	const now = Date.now();
	const rec = devices.get(deviceId) ?? {
		firstSeen: now,
		lastSeen: now,
		lastVersion: null,
		page: null,
		desiredPage: null, // {page, seq}:后台远程切页指令
		desiredPageSeq: 0,
		// 运行时遥测(Leaf Runtime 1.0 心跳)
		appVersion: null,
		battery: null,
		charging: null,
		wifi: null,
		uptimeSec: null,
		pageVersions: null,
	};
	rec.lastSeen = now;
	if (version != null) rec.lastVersion = version;
	if (page != null) rec.page = page;
	if (telemetry) {
		// Leaf Runtime 1.1 诊断/E-Ink 指标白名单
		for (const key of [
			"appVersion",
			"battery",
			"charging",
			"wifi",
			"uptimeSec",
			"pageVersions",
			"androidVersion",
			"deviceModel",
			"lastSyncAt",
			"lastSyncStatus",
			"lastError",
			"frameCacheBytes",
			"syncCount",
			"syncFailCount",
			"frameDownloadCount",
			"frameDownloadFailCount",
			"partialRefreshCount",
			"fullRefreshCount",
			"lastFullRefreshAt",
			"crashCount",
			"safeMode",
			"einkController",
			"einkMode",
		]) {
			if (telemetry[key] != null) rec[key] = telemetry[key];
		}
	}
	devices.set(deviceId, rec);
	dirty = true;
}

/** 远程切页指令:seq 单调递增,客户端只应用比已应用 seq 更新的指令 */
export function setDesiredPage(deviceId, page) {
	const rec = devices.get(deviceId) ?? {
		firstSeen: Date.now(),
		lastSeen: 0,
		lastVersion: null,
		page: null,
	};
	rec.desiredPage = page;
	rec.desiredPageSeq = (rec.desiredPageSeq ?? 0) + 1;
	devices.set(deviceId, rec);
	dirty = true;
	return { page, seq: rec.desiredPageSeq };
}

/** 远程刷新指令:refresh/fullRefresh 各自 seq 单调递增,客户端感知变化后触发同步 */
export function bumpDeviceSignal(deviceId, signal) {
	const rec = devices.get(deviceId) ?? {
		firstSeen: Date.now(),
		lastSeen: 0,
		lastVersion: null,
		page: null,
	};
	const key = signal === "fullRefresh" ? "fullRefreshSeq" : "refreshSeq";
	rec[key] = (rec[key] ?? 0) + 1;
	devices.set(deviceId, rec);
	dirty = true;
	return rec[key];
}

/** 设备在线状态:最后心跳 <10min Online,10-30min Stale,>30min Offline */
function onlineStatus(lastSeen) {
	if (!lastSeen) return "offline";
	const min = (Date.now() - lastSeen) / 60_000;
	if (min < 10) return "online";
	if (min < 30) return "stale";
	return "offline";
}

export function listDevices() {
	return [...devices.entries()].map(([deviceId, rec]) => ({
		deviceId,
		...rec,
		online: onlineStatus(rec.lastSeen),
	}));
}

export function getConfig() {
	return { ...config };
}

// 配置版本:设备相关配置的稳定内容 hash(进程重启不变、内容不变不变、
// 内容变更自动变化)。todos 属内容数据不参与 hash,避免待办编辑触发
// 客户端配置重应用。
const CONFIG_HASH_KEYS = [
	"pollIntervalSec",
	"fullRefreshIntervalSec",
	"weatherLat",
	"weatherLon",
	"icsUrl",
	"aiUsage",
	"servers",
	"agents",
];
export function getConfigRev() {
	const stable = {};
	for (const key of CONFIG_HASH_KEYS) stable[key] = config[key];
	return createHash("sha256")
		.update(JSON.stringify(stable))
		.digest("hex")
		.slice(0, 8);
}

/** 更新配置:逐字段钳制校验,非法字段不报错只忽略,返回生效后的配置 */
export function updateConfig(patch) {
	if ("pollIntervalSec" in patch) {
		config.pollIntervalSec = clampInt(patch.pollIntervalSec, 60, 3600, config.pollIntervalSec);
	}
	if ("fullRefreshIntervalSec" in patch) {
		config.fullRefreshIntervalSec = clampInt(
			patch.fullRefreshIntervalSec,
			5 * 60,
			24 * 3600,
			config.fullRefreshIntervalSec,
		);
	}
	// 数据源字段:宽松校验,类型不对就忽略该字段
	if ("weatherLat" in patch) {
		const n = Number(patch.weatherLat);
		if (Number.isFinite(n) && n >= -90 && n <= 90) config.weatherLat = n;
	}
	if ("weatherLon" in patch) {
		const n = Number(patch.weatherLon);
		if (Number.isFinite(n) && n >= -180 && n <= 180) config.weatherLon = n;
	}
	for (const key of ["icsUrl"]) {
		if (key in patch && typeof patch[key] === "string") {
			// SSRF 防护:仅接受公网 http(s) URL(Admin 无鉴权,URL 是用户可写输入)
			const val = patch[key].trim();
			config[key] = val && isSafePublicHttpUrl(val) ? val : "";
		}
	}
	if ("aiUsage" in patch) config.aiUsage = sanitizeAiUsage(patch.aiUsage);
	if ("servers" in patch) config.servers = sanitizeChecks(patch.servers);
	if ("agents" in patch) config.agents = sanitizeChecks(patch.agents);
	if ("todos" in patch) config.todos = sanitizeTodos(patch.todos);
	atomicWrite(CONFIG_FILE, config);
	return getConfig();
}

// 探活条目:仅保留 name/url 两个字符串字段,丢弃空行与多余字段
function sanitizeChecks(raw) {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((it) => ({
			name: String(it?.name ?? "").slice(0, 40),
			url: String(it?.url ?? "").trim(),
		}))
		.filter((it) => it.name && isSafePublicHttpUrl(it.url))
		.slice(0, 12);
}

// AI 用量源:类型白名单内有效;codex 不需要 URL(读本机登录态),
// 其余类型必须给公网 http(s) URL;同名条目取先出现的那个
const AI_SOURCE_NAMES = new Set(["codex", "zai", "kimi", "custom"]);
function sanitizeAiUsage(raw) {
	if (!Array.isArray(raw)) return [];
	const seen = new Set();
	return raw
		.map((it) => ({
			name: String(it?.name ?? "").trim().toLowerCase(),
			url: String(it?.url ?? "").trim(),
		}))
		.filter((it) => {
			if (!AI_SOURCE_NAMES.has(it.name) || seen.has(it.name)) return false;
			seen.add(it.name);
			// codex 的 URL 固定走代码内常量;其余源的 URL 必须过 SSRF 防护
			return it.name === "codex" ? true : isSafePublicHttpUrl(it.url);
		})
		.map((it) => ({ name: it.name, url: it.name === "codex" ? "" : it.url }))
		.slice(0, 6);
}

// 待办条目:text 截断,done 必须是布尔
function sanitizeTodos(raw) {
	if (!Array.isArray(raw)) return [];
	return raw
		.map((it) => ({
			text: String(it?.text ?? "").slice(0, 60),
			done: Boolean(it?.done),
		}))
		.filter((it) => it.text)
		.slice(0, 30);
}

/** 节流落盘:注册表变更由外部定时 flush,避免每次请求都写盘 */
export function flushDevices() {
	if (!dirty) return;
	dirty = false;
	atomicWrite(DEVICES_FILE, Object.fromEntries(devices));
}
