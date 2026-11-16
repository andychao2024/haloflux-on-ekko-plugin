# HALOFLUX ON Ekko 壁纸与屏保玩法

把 HALOFLUX ON Ekko 作为桌面壁纸或屏保使用。插件页和壁纸页共用同一套页面与数据，设置中的标题、动效、兼容模式、显卡、工具行数、代理行数会同步到壁纸页。

## 1. 先开启壁纸服务

Studio → 插件 → HALOFLUX ON Ekko → **设置**：

1. 打开「启用壁纸服务」。
2. 设置壁纸端口，默认 `8790`。
3. 设置访问密钥；可以使用「随机」生成。
4. 保存后会重启壁纸服务，已打开的壁纸页刷新一次即可。

设置页会显示当前壁纸地址和访问者数量。访问密钥也是 URL 的一部分，修改后旧地址会失效。

## 2. 壁纸地址

### 局域网

```text
http://<局域网 IP>:8790/?k=<访问密钥>
```

例如：

```text
http://192.168.1.186:8790/?k=YOUR_TOKEN
```

不要在另一台设备上使用 `127.0.0.1`，那会指向设备自己。请使用运行 Studio 的主机局域网 IP。

### 外网

通过 Lucky、Nginx 或其他反向代理把 `8790` 暴露到 HTTPS：

```text
https://<你的域名>:<端口>/?k=<访问密钥>
```

例如：

```text
https://ekko.example.com:8443/?k=YOUR_TOKEN
```

反向代理需要转发查询参数 `k` 和 Cookie；壁纸服务默认监听 `0.0.0.0`。建议只开放 HTTPS，并在路由器/防火墙中限制来源。

## 3. URL 参数总表

多个参数用 `&` 连接，顺序不影响结果。

| 参数 | 可选值 | 作用 | 示例 |
|---|---|---|---|
| `k` | 访问密钥 | 页面和 `/stats` 的访问密钥 | `?k=YOUR_TOKEN` |
| `token` | 访问密钥 | `k` 的别名，二选一即可 | `?token=YOUR_TOKEN` |
| `api` | URL 或 `/stats` URL | 覆盖 `/stats` 地址，适合页面不在壁纸服务同源时使用 | `?k=TOKEN&api=https://host:8790` |
| `aihud` | `off`、`top-right`、`bottom-left` | HUD 位置；`off` 隐藏 HUD，适合纯净壁纸 | `?k=TOKEN&aihud=off` |
| `preset` | `A`、`B`、`MINE` | 选择内置视觉预设；不填使用上次保存的预设 | `?k=TOKEN&preset=A` |
| `cursor` | `show`/`on`、`hide`/`off` | 显示或隐藏鼠标指针；壁纸引擎中默认自动隐藏 | `?k=TOKEN&cursor=hide` |
| `linedebug` | `1`、`on` | 显示扫描线调试信息，仅排查问题用 | `?k=TOKEN&linedebug=1` |
| `t` | 毫秒时间戳 | 页面内部防缓存参数，不需要手动添加 | — |

常用组合：

```text
# 普通桌面壁纸，保留 HUD
http://192.168.1.186:8790/?k=YOUR_TOKEN

# 纯净壁纸：隐藏 HUD 和鼠标
http://192.168.1.186:8790/?k=YOUR_TOKEN&aihud=off&cursor=hide

# 使用 A 预设 + 隐藏 HUD
http://192.168.1.186:8790/?k=YOUR_TOKEN&aihud=off&preset=A

# 外网屏保，隐藏 HUD 和鼠标
https://ekko.example.com:8443/?k=YOUR_TOKEN&aihud=off&cursor=hide
```

## 4. 其他接口

| 地址 | 用途 | 需要密钥 |
|---|---|---|
| `/` 或 `/index.html` | 壁纸页面 | 是 |
| `/stats` | 兼容 `/stats` JSON 数据 | 是 |
| `/health` | 健康检查，`{"ok":true}` | 否 |
| `/ai-link.js` | 页面脚本 | 否 |
| `/wp.js` | 舞台脚本 | 否 |
| `/audio/sw421k.mp3` | 背景音乐 | 否 |

浏览器正常打开 `/?k=...` 后，服务端会写入 `halofluxk` Cookie，后续 `/stats` 可以自动携带。脚本调用 `/stats` 时也可以使用：

```http
X-AI-Link-Token: YOUR_TOKEN
```

或：

```http
Authorization: Bearer YOUR_TOKEN
```

`/health` 不需要密钥，可用于反向代理或监控探活。

## 5. macOS：Plash + WebViewScreenSaver

### 桌面壁纸：Plash

1. 在 **Mac App Store 搜索 Plash** 下载，完全免费；也可以从 [GitHub](https://github.com/sindresorhus/Plash) 获取。
2. 点击菜单栏 Plash 图标，选择「Open URL…」或「Set Website…」。
3. 粘贴完整壁纸地址，例如：
   `http://192.168.1.186:8790/?k=YOUR_TOKEN&aihud=off&cursor=hide`
4. 多显示器时，对每个显示器分别设置同一个 URL。
5. Plash 首次加载网页时如果提示网络访问，允许局域网/HTTPS 访问。

### 屏保：WebViewScreenSaver

1. 安装 [WebViewScreenSaver](https://github.com/lwouis/WebViewScreenSaver)。
2. 打开「系统设置 → 屏幕保护程序」。
3. 选择 `WebViewScreenSaver`，进入「选项」。
4. 填入同一个壁纸 URL，并保存。
5. 建议使用 `aihud=off&cursor=hide`，屏保画面更干净。

如果屏保没有加载，先在 Safari 或 Chrome 中打开同一个 URL，确认密钥和 HTTPS 证书正常，再重新进入屏保预览。

## 6. Windows：Lively Wallpaper

1. 安装 [Lively Wallpaper](https://github.com/rocksdanister/lively)。
2. 点击「添加壁纸」→「输入 URL」或「打开 URL」。
3. 粘贴完整壁纸地址，例如：
   `http://192.168.1.186:8790/?k=YOUR_TOKEN&aihud=off&cursor=hide`
4. 选择网页类型壁纸，设为当前壁纸。
5. 多显示器时给每块屏幕分别指定同一个 URL。
6. 需要屏保时，在 Lively 的屏保设置中启用 Lively 屏保（或让 Windows 屏幕保护程序加载同一 URL）。

Lively 使用内部浏览器渲染网页。如果页面显示“离线”，先确认这台 Windows 电脑能直接访问 URL；局域网使用主机 IP，外网使用 HTTPS 域名。

## 7. 推荐配置

### 桌面常驻

```text
?k=YOUR_TOKEN&aihud=top-right&preset=MINE
```

保留 HUD，方便看会话、工具和 CPU/磁盘状态。

### 纯净壁纸

```text
?k=YOUR_TOKEN&aihud=off&cursor=hide&preset=A
```

隐藏 HUD 和鼠标，只保留舞台动效与公式标注。

### 屏保

```text
?k=YOUR_TOKEN&aihud=off&cursor=hide
```

如果希望屏保也显示令牌、工具和会话摘要，可以把 `aihud=off` 改成 `aihud=top-right`。

## 8. 数据联动说明

- 壁纸页与插件页共用数据源；插件设置里的标题、动效、兼容模式、显卡、工具/代理行数会同步。
- 当前 Studio 版本下，建议保持插件页在 Studio 侧边栏后台打开，以确保会话、工具和思考流实时刷新。
- 只打开壁纸页时，CPU、内存、网络等本机指标仍会更新，但会话/工具历史可能需要等待或重新打开插件页。
- 后续如果 Studio 开放稳定的后台取数能力，壁纸页可以完全脱离插件页运行。

## 9. 常见问题

### 打开页面是 401 或登录框

访问密钥缺失、错误或已更换。使用设置页最新的完整 URL，或在 URL 中加 `?k=YOUR_TOKEN`。

### 页面能打开，但数据不刷新

先确认 Studio 侧边栏的 HALOFLUX ON Ekko 页面处于打开状态；再直接访问：

```text
http://<主机>:8790/health
http://<主机>:8790/stats?k=YOUR_TOKEN
```

`/health` 应返回 `{"ok":true}`，`/stats` 应返回 JSON。

### 外网打不开或时好时坏

检查反向代理、HTTPS 证书、端口转发和 DNS。域名如果同时解析到多个 IPv6 地址，删除不可达的记录，避免浏览器随机选到坏地址。

### 端口被占用

在插件设置中换一个端口并保存；壁纸服务会自动重启。旧 URL 需要同步更新。

### 修改设置后旧页面不生效

保存设置可能重启壁纸服务；刷新壁纸页，必要时关闭后重新打开。

### 屏保里没有声音

浏览器和屏保对自动播放有限制，背景音乐通常需要用户点击页面右上角按钮才会播放；屏保场景建议不依赖声音。
