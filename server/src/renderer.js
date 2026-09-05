// Frame 渲染器:输出 1680x1264 纯黑白(白底黑字)PNG,供 E-Ink 屏显示。
//
// E-Ink 设计原则:
//  - 只用 #000000 / #FFFFFF 两色,无灰阶、无渐变、无动画
//  - 线条加粗(>=4px),300PPI 下细线会发虚
//  - 大字号、大留白、清晰框线分区

import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

export const FRAME_WIDTH = 1680;
export const FRAME_HEIGHT = 1264;

const BLACK = "#000000";
const WHITE = "#FFFFFF";

// ---------------------------------------------------------------------------
// 字体初始化
//
// 策略(按任务书要求:系统可用字体优先;中文缺失时回退英文):
//  1. @napi-rs/canvas 会自动加载操作系统字体目录(macOS/Windows/部分 Linux),
//     先在 GlobalFonts.families 里探测常见中文字体家族名。
//  2. 若探测不到,再尝试从一组常见路径显式注册(macOS 的 PingFang/Hiragino、
//     Linux 的 Noto/WenQuanYi 等,alpine 容器默认无字体)。
//  3. 若仍失败(hasCJK = false),渲染文本走英文回退(标签函数 t(zh, en)),
//     避免中文渲染成豆腐块。Docker 镜像中额外通过 apk 安装 font-noto 保证
//     西文字体可用,中文则按上述逻辑自动回退英文。
// ---------------------------------------------------------------------------

const CJK_FAMILY_PROBES = [
	"PingFang SC",
	"Hiragino Sans GB",
	"Noto Sans CJK SC",
	"Noto Sans SC",
	"WenQuanYi Zen Hei",
	"WenQuanYi Micro Hei",
	"Source Han Sans SC",
];

// [文件路径, 注册用的家族名]
const FONT_FILE_PROBES = [
	// macOS 中文字体(ttc,capable skia 取第一个 face)
	["/System/Library/Fonts/PingFang.ttc", "DashCJK"],
	["/System/Library/Fonts/Hiragino Sans GB.ttc", "DashCJK"],
	// Linux 常见中文字体
	["/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "DashCJK"],
	["/usr/share/fonts/truetype/wqy/wqy-microhei.ttc", "DashCJK"],
];

const LATIN_FILE_PROBES = [
	// macOS 西文
	["/System/Library/Fonts/Supplemental/Arial.ttf", "DashSans"],
	["/System/Library/Fonts/Helvetica.ttc", "DashSans"],
	// Linux 常见西文(alpine apk add font-noto 的安装路径)
	["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "DashSans"],
	["/usr/share/fonts/noto/NotoSans-Regular.ttf", "DashSans"],
];

function firstExistingFamily(names) {
	try {
		const families = GlobalFonts.families.map((f) => f.family);
		for (const name of names) {
			if (families.includes(name)) return name;
		}
	} catch {
		// families 列表不可用时忽略,走文件注册路径
	}
	return null;
}

function registerFirstExisting(probes) {
	for (const [path, family] of probes) {
		try {
			if (GlobalFonts.registerFromPath(path, family)) return family;
		} catch {
			// 注册失败(文件不存在/格式不支持)则尝试下一个候选
		}
	}
	return null;
}

function initFonts() {
	// 中文字体:先探测系统家族,再尝试显式注册
	let cjk = firstExistingFamily(CJK_FAMILY_PROBES);
	if (!cjk) cjk = registerFirstExisting(FONT_FILE_PROBES);

	// 西文字体:同上;全部失败时留 null,交给 skia 内置默认字体兜底
	let latin = firstExistingFamily([
		"Arial",
		"Helvetica",
		"DejaVu Sans",
		"Noto Sans",
	]);
	if (!latin) latin = registerFirstExisting(LATIN_FILE_PROBES);

	return {
		hasCJK: Boolean(cjk),
		cjkFamily: cjk,
		latinFamily: latin,
	};
}

const fonts = initFonts();

// 文案选择:有中文字体用中文,否则回退英文(代码层面避免豆腐块)
const t = (zh, en) => (fonts.hasCJK ? zh : en);

// font 简写:加粗时依赖 skia 合成粗体(ttf 只有 Regular 也可用)
function fontCss(px, { bold = false, cjk = false } = {}) {
	const family = (cjk && fonts.cjkFamily) || fonts.latinFamily || "sans-serif";
	const name = family.includes(" ") ? `"${family}"` : family;
	return `${bold ? "bold " : ""}${px}px ${name}`;
}

// ---------------------------------------------------------------------------
// 版本号:时间驱动,每分钟 +1,与大时钟 HH:MM 内容变化节奏一致
// ---------------------------------------------------------------------------

export function currentVersion(now = Date.now()) {
	return Math.floor(now / 60_000);
}

// 内容变化的时刻(本分钟起点),格式化为带本地时区的 ISO 字符串
// 例:2026-09-06T12:34:00+08:00
export function formatUpdatedAt(version) {
	const d = new Date(version * 60_000);
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	const offsetMin = -d.getTimezoneOffset();
	const sign = offsetMin >= 0 ? "+" : "-";
	const oh = pad(Math.floor(Math.abs(offsetMin) / 60));
	const om = pad(Math.abs(offsetMin) % 60);
	return (
		`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
		`T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
		`${sign}${oh}:${om}`
	);
}

// ---------------------------------------------------------------------------
// Frame 渲染
// ---------------------------------------------------------------------------

const WEEK_ZH = [
	"星期日",
	"星期一",
	"星期二",
	"星期三",
	"星期四",
	"星期五",
	"星期六",
];
const WEEK_EN = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];
const MONTH_EN = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function pad2(n) {
	return String(n).padStart(2, "0");
}

// 居中画一行文字(textAlign=center, baseline=middle)
function drawCenteredText(ctx, text, cx, cy, css) {
	ctx.font = css;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(text, cx, cy);
}

// 左对齐 / 右对齐单行文字(baseline=middle)
function drawText(ctx, text, x, y, css, align = "left") {
	ctx.font = css;
	ctx.textAlign = align;
	ctx.textBaseline = "middle";
	ctx.fillText(text, x, y);
}

function drawFrameBorder(ctx, x, y, w, h, lineWidth) {
	ctx.lineWidth = lineWidth;
	ctx.strokeRect(x, y, w, h);
}

function drawHLine(ctx, y, x0, x1, lineWidth) {
	ctx.lineWidth = lineWidth;
	ctx.beginPath();
	ctx.moveTo(x0, y);
	ctx.lineTo(x1, y);
	ctx.stroke();
}

/**
 * 渲染一帧测试 Dashboard。
 * @param {object} opts
 * @param {string} opts.page    页面名(角标显示,M4 之前均为 home)
 * @param {number} opts.version 当前版本号(分钟数)
 * @param {string} opts.deviceId 设备 ID(footer 显示)
 * @param {number} [opts.now]   渲染时刻(默认当前时间)
 * @returns {Buffer} PNG 数据
 */
export function renderFrame({ page, version, deviceId, now = Date.now() }) {
	const d = new Date(now);

	const canvas = createCanvas(FRAME_WIDTH, FRAME_HEIGHT);
	const ctx = canvas.getContext("2d");

	// 白底
	ctx.fillStyle = WHITE;
	ctx.fillRect(0, 0, FRAME_WIDTH, FRAME_HEIGHT);
	ctx.fillStyle = BLACK;
	ctx.strokeStyle = BLACK;

	const M = 48; // 页面外边距

	// ---- 顶栏:设备名 + 页面角标 | 版本号角标 ----
	const topY = M + 34;
	drawText(
		ctx,
		t("BOOX LEAF5+", "BOOX LEAF5+"),
		M,
		topY,
		fontCss(48, { bold: true }),
	);
	drawText(
		ctx,
		`PAGE: ${page.toUpperCase()}`,
		M + 400,
		topY,
		fontCss(48, { bold: true }),
	);
	drawText(
		ctx,
		`V${version}`,
		FRAME_WIDTH - M,
		topY,
		fontCss(48, { bold: true }),
		"right",
	);
	drawHLine(ctx, M + 88, M, FRAME_WIDTH - M, 4);

	// ---- 大时钟 + 日期星期 ----
	const hh = pad2(d.getHours());
	const mm = pad2(d.getMinutes());
	drawCenteredText(
		ctx,
		`${hh}:${mm}`,
		FRAME_WIDTH / 2,
		470,
		fontCss(360, { bold: true }),
	);

	const dateText = fonts.hasCJK
		? `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEK_ZH[d.getDay()]}`
		: `${WEEK_EN[d.getDay()]}, ${MONTH_EN[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
	drawCenteredText(
		ctx,
		dateText,
		FRAME_WIDTH / 2,
		690,
		fontCss(76, { cjk: true }),
	);

	// ---- 中部分隔线 + 三个占位 Widget 框 ----
	drawHLine(ctx, 790, M, FRAME_WIDTH - M, 4);

	const boxTop = 830;
	const boxBottom = 1140;
	const boxH = boxBottom - boxTop;
	const gap = 36;
	const boxW = Math.floor((FRAME_WIDTH - 2 * M - 2 * gap) / 3);

	const widgets = [
		{ title: t("天气", "WEATHER"), line: t("待接入数据源", "NO DATA YET") },
		{ title: t("日历", "CALENDAR"), line: t("待接入数据源", "NO DATA YET") },
		{ title: t("待办", "TODO"), line: t("待接入数据源", "NO DATA YET") },
	];

	widgets.forEach((widget, i) => {
		const x = M + i * (boxW + gap);
		drawFrameBorder(ctx, x, boxTop, boxW, boxH, 5);
		drawText(
			ctx,
			widget.title,
			x + 32,
			boxTop + 56,
			fontCss(56, { bold: true, cjk: true }),
		);
		drawCenteredText(
			ctx,
			"—",
			x + boxW / 2,
			boxTop + boxH / 2 + 20,
			fontCss(72, { bold: true }),
		);
		drawText(
			ctx,
			widget.line,
			x + 32,
			boxBottom - 40,
			fontCss(38, { cjk: true }),
		);
	});

	// ---- 底栏:设备 ID | 刷新策略 ----
	drawHLine(ctx, 1176, M, FRAME_WIDTH - M, 4);
	const footY = 1214;
	drawText(ctx, `ID: ${deviceId}`, M, footY, fontCss(38));
	drawText(
		ctx,
		t("刷新: PARTIAL · 5 分钟", "REFRESH: PARTIAL / 5 MIN"),
		FRAME_WIDTH - M,
		footY,
		fontCss(38, { cjk: true }),
		"right",
	);

	return canvas.encode("png");
}
