# leaf5-dashboard-server

BOOX Leaf5+ E-Ink Dashboard 服务端(MVP):渲染 1680×1264 纯黑白 PNG Frame,供 Android 客户端轮询下载。

## 安全说明

服务绑定 `0.0.0.0` 且**无任何鉴权**(MVP 按计划如此),仅供 BOOX 设备在**可信内网**访问;请勿将端口直接映射或暴露到公网,如需公网访问请在前面加反向代理与访问控制。

## 启动

要求 Node.js ≥ 20。

```bash
cd server
npm install
npm start          # 默认监听 39871
# 或自定义端口:
PORT=8080 npm start
# 开发模式(文件变更自动重启):
npm run dev
```

**代理依赖(必读)**:`start`/`dev` 脚本已固化 `NODE_USE_ENV_PROXY=1` —— 外网数据源(codex)依赖系统代理(`http_proxy/https_proxy`),Node 原生 fetch 不读代理环境变量,必须带此 env;若绕过 npm 直接 `node src/index.js` 启动,请自行携带 `NODE_USE_ENV_PROXY=1`,否则 codex 源拉取失败。

**数据源密钥**:仓库根/服务端目录的 `.env`(权限 0600,不入库)存放 `ZAI_API_KEY`/`KIMI_API_KEY`,由 index.js 启动时自动加载,无需手动 export。

## 接口

### GET /healthz

健康检查。

```bash
curl http://localhost:39871/healthz
# {"ok":true}
```

### GET /api/device/:deviceId/status

设备轮询状态。`version` 为时间驱动(每分钟 +1,与大时钟内容变化同步);`updatedAt` 为本版本内容生成时刻(本地时区 ISO 格式)。

```bash
curl http://localhost:39871/api/device/dev001/status
# {"version":29385123,"updatedAt":"2026-09-06T20:03:00+08:00","refresh":"partial","page":"home"}
```

### GET /api/device/:deviceId/frame

下载当前 Frame,`image/png`,固定 1680×1264,白底黑字(大时钟 + 日期星期 + 分区框线 + 设备名/版本角标)。同一 `version` 只渲染一次(内存缓存)。

```bash
curl -s -o frame.png -D - http://localhost:39871/api/device/dev001/frame
# 响应头含 Content-Type: image/png 与 X-Frame-Version
# 验证尺寸(macOS):
sips -g pixelWidth -g pixelHeight frame.png
# pixelWidth: 1680 / pixelHeight: 1264
```

可选参数 `?page=home`(M4 多页面之前任意 page 均渲染同一测试布局,page 名显示在角标)。

## APK 分发(路线 B)

设备无 adb 时,可直接浏览器打开 `http://<server-ip>:39871/` 进入安装引导页(极简黑白页),点击"下载 LeafDashboard APK"即下载;APK 直链为 `/download`(MIME:`application/vnd.android.package-archive`)。APK 文件放在 `server/public/LeafDashboard.apk`(构建产物,不入库,更新后重新复制即可)。

## Docker

```bash
cd server
docker build -t leaf5-dashboard-server .
docker run -d --name leaf5-dashboard -p 39871:39871 leaf5-dashboard-server
curl http://localhost:39871/healthz   # {"ok":true}
```

说明:

- 非 root(`node` 用户)运行,内置 `HEALTHCHECK`(wget /healthz)
- 镜像通过 `apk add font-noto` 提供西文字体;alpine 无中文字体,渲染器自动回退英文文案(macOS 本机有 PingFang,显示中文)
