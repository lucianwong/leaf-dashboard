// BOOX Leaf5+ E-Ink Dashboard 服务端(MVP)
//
// 接口:
//   GET /healthz                          -> { ok: true }
//   GET /api/device/:deviceId/status      -> { version, updatedAt, refresh, page }
//   GET /api/device/:deviceId/frame       -> image/png (1680x1264), ?page=home
//
// 版本策略:MVP 阶段时间驱动 —— version = floor(epochMinutes),
// 与大时钟 HH:MM 内容变化节奏一致,每分钟自然 +1。

import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
	currentVersion,
	formatUpdatedAt,
	renderFrame,
	FRAME_WIDTH,
	FRAME_HEIGHT,
} from "./renderer.js";

const DEFAULT_PAGE = "home";

// 默认端口 39871:本机 3300 被其他长期服务占用,避开常见开发端口。
// PORT 解析后必须校验:非法值(如 PORT=abc)会让 listen(NaN) 抛出同步
// RangeError,error 事件兜不住,所以在这里直接中文提示后退出。
const PORT = Number.parseInt(process.env.PORT ?? "39871", 10);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT >= 65536) {
	console.error(
		`[leaf5-dashboard] 启动失败:PORT 环境变量 "${process.env.PORT}" 不是合法端口号(1-65535)。请换一个端口,例如:PORT=39872 npm start`,
	);
	process.exit(1);
}

const app = express();
app.disable("x-powered-by");

// frame LRU 缓存:key = `${deviceId}:${page}`。
//  - 按 deviceId 区分:渲染内容含设备名,多设备共用 key 会串显别人的画面;
//  - LRU 上限 CACHE_MAX:?page= 是客户端可控输入,不设上限可被刷爆内存。
//    实际设备数与页面数都极少,16 条足够;版本推进后旧内容自然被覆盖。
const CACHE_MAX = 16;
/** @type {Map<string, { version: number, buffer: Buffer }>} */
const frameCache = new Map();

function cacheGet(key) {
	const hit = frameCache.get(key);
	if (hit !== undefined) {
		// LRU touch:删除后重插,把该 key 移到"最新"端
		frameCache.delete(key);
		frameCache.set(key, hit);
	}
	return hit;
}

function cacheSet(key, value) {
	if (frameCache.has(key)) {
		frameCache.delete(key);
	}
	frameCache.set(key, value);
	if (frameCache.size > CACHE_MAX) {
		// Map 迭代按插入序,第一个 key 即最旧条目
		const oldest = frameCache.keys().next().value;
		frameCache.delete(oldest);
	}
}

// 统一解析 ?page=:仅接受单个字符串值,多值(?page=a&page=b)/非字符串/空串
// 一律回退 home,status 与 frame 两个端点行为保持一致
function getPageParam(query) {
	const page = query.page;
	return typeof page === "string" && page ? page : DEFAULT_PAGE;
}

// 请求日志:一行一条(时间 IP 方法 路径 状态 耗时)。必须挂在所有路由之前,
// 否则先注册的路由命中后不会经过此中间件,API 请求将永远无日志(实测踩过)
app.use((req, res, next) => {
	const start = Date.now();
	res.on("finish", () => {
		console.log(
			`[req] ${new Date().toISOString()} ${req.ip} ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`,
		);
	});
	next();
});

app.get("/healthz", (_req, res) => {
	res.json({ ok: true });
});

app.get("/api/device/:deviceId/status", (req, res) => {
	const version = currentVersion();
	res.set("Cache-Control", "no-store");
	res.json({
		version,
		updatedAt: formatUpdatedAt(version),
		// M3 之前固定 partial,full 刷新策略后续再做
		refresh: "partial",
		page: getPageParam(req.query),
	});
});

app.get("/api/device/:deviceId/frame", async (req, res, next) => {
	try {
		const deviceId = req.params.deviceId;
		const page = getPageParam(req.query);
		const version = currentVersion();
		const cacheKey = `${deviceId}:${page}`;

		// 缓存命中:同 version 不重复渲染
		const cached = cacheGet(cacheKey);
		let buffer;
		if (cached && cached.version === version) {
			buffer = cached.buffer;
		} else {
			buffer = await renderFrame({
				page,
				version,
				deviceId,
			});
			cacheSet(cacheKey, { version, buffer });
		}

		res.set("Content-Type", "image/png");
		res.set("Cache-Control", "no-store");
		res.set("X-Frame-Version", String(version));
		res.send(buffer);
	} catch (err) {
		// Express 4 不会自动把 async handler 的 rejection 交给错误中间件,
		// 必须显式 next(err),否则渲染异常会以 unhandledRejection 杀死进程
		next(err);
	}
});

// APK 分发(路线 B:设备无 adb 时的安装通道)
const PUBLIC_DIR = path.join(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"public",
);
const APK_PATH = path.join(PUBLIC_DIR, "LeafDashboard.apk");

// /download:APK 直链下载(显式指定 E-Ink 设备浏览器可识别的 MIME)
app.get("/download", (_req, res) => {
	res.setHeader("Content-Type", "application/vnd.android.package-archive");
	res.download(APK_PATH, "LeafDashboard.apk", (err) => {
		if (err && !res.headersSent) {
			res.status(err.status || 500).json({ error: "apk not found" });
		}
	});
});

// 静态分发 public/(index.html 安装引导页;需在 404 兜底之前挂载)
app.use(express.static(PUBLIC_DIR));

// 404 兜底:统一 JSON,避免客户端解析到 HTML
app.use((_req, res) => {
	res.status(404).json({ error: "not found" });
});

// 错误兜底:渲染异常返回 500 JSON(配合 frame handler 的 try/next 生效)
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
	console.error("[leaf5-dashboard] internal error:", err);
	res.status(500).json({ error: "internal error" });
});

const server = app.listen(PORT, () => {
	console.log(
		`[leaf5-dashboard] listening on http://0.0.0.0:${PORT} (frame ${FRAME_WIDTH}x${FRAME_HEIGHT})`,
	);
});

// 监听失败(如端口被占用)时输出友好中文提示后退出,不裸栈崩溃
server.on("error", (err) => {
	if (err.code === "EADDRINUSE") {
		console.error(
			`[leaf5-dashboard] 启动失败:端口 ${PORT} 已被占用。请换一个端口启动,例如:PORT=39872 npm start`,
		);
	} else {
		console.error(`[leaf5-dashboard] 启动失败:${err.message}`);
	}
	process.exit(1);
});
