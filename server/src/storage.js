// 存储层(Milestone 5 Admin):设备注册表 + 显示配置持久化。
//
// 单设备/家庭场景数据量极小,JSON 文件 + 进程内 Map 足够,不上数据库。
// 写入统一走原子写(临时文件 + rename),避免进程被杀时文件写半截。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
	// 天气:Open-Meteo 免费无 key,只需经纬度(默认杭州)
	weatherLat: Number(process.env.WEATHER_LAT ?? 30.27) || 30.27,
	weatherLon: Number(process.env.WEATHER_LON ?? 120.16) || 120.16,
	// 日历:ICS 订阅链接(WebCal/ICS)
	icsUrl: process.env.CAL_ICS_URL ?? "",
	// AI 用量:任意返回 JSON 的用量端点,期望 {label, used, quota} 或 {label, text}
	aiUsageUrl: process.env.AI_USAGE_URL ?? "",
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
	config.aiUsageUrl = typeof saved.aiUsageUrl === "string" ? saved.aiUsageUrl : "";
	config.servers = sanitizeChecks(saved.servers);
	config.agents = sanitizeChecks(saved.agents);
	config.todos = sanitizeTodos(saved.todos);
}

function clampInt(v, min, max, fallback) {
	const n = Number.parseInt(v, 10);
	if (!Number.isInteger(n) || n < min || n > max) return fallback;
	return n;
}

/** 设备心跳:status/frame 请求都会走到这里,upsert 并持久化(节流写盘) */
let dirty = false;
export function touchDevice(deviceId, { version, page }) {
	const now = Date.now();
	const rec = devices.get(deviceId) ?? {
		firstSeen: now,
		lastSeen: now,
		lastVersion: null,
		page: null,
	};
	rec.lastSeen = now;
	rec.lastVersion = version;
	rec.page = page;
	devices.set(deviceId, rec);
	dirty = true;
}

export function listDevices() {
	return [...devices.entries()].map(([deviceId, rec]) => ({
		deviceId,
		...rec,
	}));
}

export function getConfig() {
	return { ...config };
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
	for (const key of ["icsUrl", "aiUsageUrl"]) {
		if (key in patch && typeof patch[key] === "string") {
			// SSRF 防护:仅接受公网 http(s) URL(Admin 无鉴权,URL 是用户可写输入)
			const val = patch[key].trim();
			config[key] = val && isSafePublicHttpUrl(val) ? val : "";
		}
	}
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
