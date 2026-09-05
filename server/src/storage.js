// 存储层(Milestone 5 Admin):设备注册表 + 显示配置持久化。
//
// 单设备/家庭场景数据量极小,JSON 文件 + 进程内 Map 足够,不上数据库。
// 写入统一走原子写(临时文件 + rename),避免进程被杀时文件写半截。

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DATA_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"storage",
);
const DEVICES_FILE = path.join(DATA_DIR, "devices.json");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");

// 默认配置:轮询 5 分钟;45 分钟一次 full 刷新消残影(E-Ink 常规做法)
export const DEFAULT_CONFIG = {
	pollIntervalSec: 300,
	fullRefreshIntervalSec: 45 * 60,
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
	atomicWrite(CONFIG_FILE, config);
	return getConfig();
}

/** 节流落盘:注册表变更由外部定时 flush,避免每次请求都写盘 */
export function flushDevices() {
	if (!dirty) return;
	dirty = false;
	atomicWrite(DEVICES_FILE, Object.fromEntries(devices));
}
