// URL 防护(M6 安全约束):服务端会按配置主动发起请求(ICS/AI 用量/探活),
// Admin 无鉴权可写,必须把可请求的目标限制在公网 http(s),防止 SSRF 打内网。
//
// 校验点:① 配置写入时(storage.js)过滤;② 请求发起前(datasources.js)复核。
// 文本层校验不含 DNS 解析(异步成本高),但域名在发起前还会再过一遍本函数。

import net from "node:net";

const BLOCKED_HOST_PATTERNS = [
	/^localhost$/i,
	/\.localhost$/i,
	/\.local$/i,
	/\.internal$/i,
];

// 私网/环回/链路本地/保留 IPv4:10/8、172.16/12、192.168/16、127/8、
// 169.254/16、0/8、100.64/10(CGNAT)、198.18/15(基准测试)
const V4_RANGES = [
	["0.0.0.0", 8],
	["10.0.0.0", 8],
	["100.64.0.0", 10],
	["127.0.0.0", 8],
	["169.254.0.0", 16],
	["172.16.0.0", 12],
	["192.0.0.0", 24],
	["192.168.0.0", 16],
	["198.18.0.0", 15],
	["224.0.0.0", 4], // 组播+保留
	["240.0.0.0", 4], // 保留
];

function v4ToInt(ip) {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
		return null;
	}
	return parts.reduce((acc, p) => acc * 256 + p, 0);
}

function isPrivateV4(ip) {
	const n = v4ToInt(ip);
	if (n === null) return true; // 解析失败按不安全处理
	return V4_RANGES.some(([base, bits]) => {
		const baseInt = v4ToInt(base);
		const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
		return (n & mask) === (baseInt & mask);
	});
}

// IPv6 私有/环回/链路本地/唯一本地/保留段:整体归一后按前缀判断
function isPrivateV6(host) {
	const h = host.replace(/^\[|\]$/g, "").toLowerCase();
	if (h === "::" || h === "::1") return true;
	if (h.startsWith("fe80") || h.startsWith("fc") || h.startsWith("fd")) return true;
	if (h.startsWith("::ffff:")) {
		// IPv4-mapped:取出内层 v4 再判
		return isPrivateV4(h.slice(7));
	}
	return false;
}

/**
 * 是否为可安全请求的公网 http(s) URL。
 * @param {string} raw
 * @returns {boolean}
 */
export function isSafePublicHttpUrl(raw) {
	if (typeof raw !== "string" || !raw) return false;
	let u;
	try {
		u = new URL(raw);
	} catch {
		return false;
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") return false;
	const host = u.hostname;
	if (!host) return false;
	if (BLOCKED_HOST_PATTERNS.some((re) => re.test(host))) return false;
	if (net.isIPv4(host)) return !isPrivateV4(host);
	if (host.includes(":")) return !isPrivateV6(host);
	// 普通域名:交给配置时与发起时的双重文本校验兜底
	return true;
}
