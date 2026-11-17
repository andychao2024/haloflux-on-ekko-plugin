# HALOFLUX ON Ekko

把 AI 在 Ekko Studio 里的运行轨迹，变成一块实时联动的桌面看板。

HALOFLUX ON Ekko 是基于 HALOFLUX 原作舞台的 Studio 插件：圆环、光束、扫描线、公式标注和 8 个数据面板，全部由 Studio 会话、工具调用、任务计划和本机指标驱动。

> **推荐玩法**：[把看板用作桌面壁纸 / 屏保](docs/WALLPAPER.md)

## 亮点

- **原版舞台**：canvas 圆环、光束、扫描线和节拍动效，按令牌吞吐与 Agent 活动驱动
- **实时数据**：会话、模型、令牌、缓存命中、上下文、工具、消息、任务计划、技能
- **8 个面板**：AI 事件流 / 令牌吞吐 / 思考过程 / CPU-磁盘 / 任务计划 / 工具调用 / 代理调度 / 系统负载
- **双端入口**：Studio 插件页 + 独立端口的壁纸页，共用同一套页面和显示设置
- **ΣρdV 标注**：工具调用和 AI 事件流会触发随机公式动画，多会话排队、自动淡出
- **桌面壁纸 / 屏保**：支持 Plash、WebViewScreenSaver、Lively Wallpaper 等网页壁纸工具
- **自适应**：跟随 Studio 主题容器，桌面和手机均可使用

## 壁纸与屏保

在插件设置里开启壁纸服务后，会得到一个可配置端口和访问密钥的独立页面：

```text
http://<局域网 IP>:8790/?k=<访问密钥>
```

通过反向代理可以走 HTTPS：

```text
https://<你的域名>:8443/?k=<访问密钥>
```

推荐工具：

- macOS 桌面：[Plash](https://github.com/sindresorhus/Plash)（Mac App Store 免费）+ 屏保：[WebViewScreenSaver](https://github.com/liquidx/webviewscreensaver)
- Windows：[Lively Wallpaper](https://github.com/rocksdanister/lively)

完整玩法、URL 参数、纯净模式、屏保配置和常见问题见：

**[docs/WALLPAPER.md](docs/WALLPAPER.md)**

## 安装

需要 **Ekko Studio 0.8.25 或更高版本**。

打开 Ekko Studio 插件中心，搜索「HALOFLUX ON Ekko」，一键安装插件市场版。

## 设置

- 看板标题
- 侧栏入口图标开关（Studio 导航被重置时会自动补回）
- 动效舞台开关
- 兼容模式（DPR=1，关闭 will-change 与 CSS 动画）
- 显卡显示开关
- 工具调用显示条数（3–15，默认 8）
- 代理调度显示行数（3–12，默认 8）
- 空闲圆环旋转间隔（2–60 秒，默认 3 秒）
- 壁纸服务：启用 / 端口 / 访问密钥 / 访问者数量

壁纸服务保存后会重启；已打开的壁纸页刷新一次即可生效。

## URL 参数

常用参数：

| 参数 | 作用 |
|---|---|
| `k` / `token` | 访问密钥 |
| `aihud=off` | 隐藏 HUD，适合纯净壁纸 |
| `aihud=top-right` / `bottom-left` | HUD 位置 |
| `preset=A` / `B` / `MINE` | 视觉预设 |
| `cursor=hide` / `show` | 隐藏 / 显示鼠标指针 |
| `api=<url>` | 覆盖 `/stats` 地址，高级用法 |

完整参数表、示例和认证方式见 [docs/WALLPAPER.md](docs/WALLPAPER.md)。

## 数据与权限

插件只读 Studio 数据，不读取数据库文件，不读取 transcript，不访问外部网络。

| 数据 | 来源 |
|---|---|
| 会话 / Agent / 模型 / Provider / 消息数 | `ctx.host.sessions.list` |
| 今日用量、7 日趋势 | `/api/studio/usage/stats` |
| 速率、缓存命中、上下文 | `/api/studio/sessions/usage`、`sessions/context-length` |
| 实时思考 / 工具 / 任务计划 | `ctx.host.sessions.connect` |
| 历史思考与工具回看 | `ctx.host.sessions.messages` |
| 技能 | `/api/hermes/skills/usage/stats` |
| CPU / 内存 / 磁盘 / 网络 / GPU | 插件后端的 Node `os`、`/proc`、`/sys` |

权限：

- `api.read`：读取会话、用量和本机指标
- `api.write`：仅用于同步 Studio 侧栏入口
- `ui`：插件页面、设置页和侧栏图标

实时连接使用查看者自己的身份建立，服务端不代替用户读取会话。

## 已知限制

- 历史工具总数：公开接口没有聚合值，只保留最近工具和插件运行期间的计数
- 思考回看：只补最近 4 个会话的最后一条，不做完整历史
- 技能“使用中”：接口只有 7 日聚合，没有单次调用时间
- 非 Linux 平台：磁盘、网络、GPU 指标显示 `—`
- 壁纸页可以独立打开；壁纸服务会自动连接最近 4 个会话，当前回合的工具和思考不依赖插件页打开。超过 4 个活跃会话时，其余会话使用 10 秒历史回填
- 归档会话不计入累计令牌与消息数

## 归属与许可

- 原作：Ryder191（HALOFLUX），界面、舞台与视觉设计版权归原作者
- Studio 插件二次开发：andychao2024
- 数据对接思路参考：[yeshuiwushen/haloflux-ai-link](https://github.com/yeshuiwushen/haloflux-ai-link)
- 许可：PolyForm Noncommercial 1.0.0，仅限非商业用途；保留原作 Required Notice

仓库：https://github.com/andychao2024/haloflux-on-ekko-plugin
