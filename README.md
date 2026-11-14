# HALOFLUX ON Ekko · Studio 插件

把 [HALOFLUX](https://github.com/Ryder191/haloflux) 的动效看板接入 Ekko Studio：
原版舞台（圆环 / 光束 / 扫描线）+ HUD + 8 个数据面板，数据全部来自 Studio 公开接口。

## 功能

- 原版 canvas 舞台与动效，按令牌吞吐驱动圆环转速、节拍与脉冲
- HUD：会话、模型、今日用量、速率、命中率、工具、消息、CPU、硬盘、运行时长、技能、7 日趋势
- 8 个面板：事件流 / 吞吐 / 思考过程 / CPU-磁盘 / 任务计划 / 工具 / 代理调度 / 系统负载
- 状态片：最少 3、最多 5、6 秒轮换、点击锁定
- 设置：看板标题、动效开关、兼容模式
- 跟随 Studio 主题容器、桌面与手机自适应

## 数据来源

不读取 Studio 数据库、transcript 或 token，全部走 SDK：

| 数据 | 来源 |
|---|---|
| 会话 / Agent / 模型 / Provider / 消息数 | `ctx.host.sessions.list` |
| 今日用量、7 日趋势 | `ctx.host.request('/api/studio/usage/stats')` |
| 速率、缓存命中、上下文 | `ctx.host.request('/api/studio/sessions/usage')`、`/sessions/context-length` |
| 实时思考 / 工具 / 任务计划 | 页面端 `ctx.host.sessions.connect` |
| 历史思考回看 | 页面端 `ctx.host.sessions.messages`（最近 3 个会话） |
| 技能 | `ctx.host.request('/api/hermes/skills/usage/stats')` |
| CPU / 内存 / 磁盘 / 网络 / GPU | 插件后端的 Node `os`、`/proc`、Mali sysfs |

实时连接使用**查看者自己的身份**建立，服务端不使用管理员身份代读会话。权限仅 `api.read` + `ui`。

## 已知限制

- 历史工具总数：公开接口没有聚合值，只保留最近 8 条与插件运行期间计数
- 技能“使用中”：接口只有 7 日聚合，没有单次调用时间
- 思考回看：只补最近 3 个会话的最后一条，不做完整历史
- 非 Linux 平台：磁盘/网络/GPU 显示 `—`
- 归档会话不计入累计令牌与消息数

## 安装

Studio → 插件中心 → 安装 → 本地目录或 `github:` 地址，启用后从左侧导航打开
「HALOFLUX ON Ekko」。

开发：

```bash
npm run build          # 从 docker 版 index.html 生成页面并打包 client.mjs
npm run harness:check
npm test
```

## 归属与许可

- 原作：Ryder191（HALOFLUX），界面、舞台与视觉设计版权归原作者
- Studio 插件二次开发：andychao2024
- **数据对接思路参考**：[yeshuiwushen/haloflux-ai-link](https://github.com/yeshuiwushen/haloflux-ai-link)
- 许可：PolyForm Noncommercial 1.0.0（仅限非商业用途，保留原作 Required Notice）
