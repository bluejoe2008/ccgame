# Command&Conquer

蓝红两队智能体在同一张随机地图上竞赛。观战者可以切换阵营视角、查看行动记录或跟踪单位。对局在服务器运行，浏览器刷新后会重新接入当前比赛。

## 运行

使用 Node.js 22 或更新版本。项目直接使用 Node.js 内置模块。

```sh
npm start
```

打开 [http://127.0.0.1:8770](http://127.0.0.1:8770/)。需要从局域网观战时，可用 `npm start -- --bind 0.0.0.0`。如果服务器已配置 Codex CLI，可加 `--codex` 启用战略规划。本地智能体负责模拟、执行指令和处理紧急反应。

「开始」创建新对局。「结束」停止模拟并保留当时的地图和战况。正在运行的对局会自动保存，服务重启后从最近存档继续。用 `--state /path/to/match.bin` 指定存档路径。默认路径为 `$XDG_STATE_HOME/ore-command/match.bin`，未设置时使用 `~/.local/state/ore-command/match.bin`。

## 代码与素材

- `server.cjs` 提供网页、观战接口和开始、结束操作。
- `match-worker.cjs` 在工作线程中运行对局、保存并恢复战局，并按阵营的视野提供观战数据。
- `game.js` 和 `commander.js` 包含模拟和智能体逻辑。浏览器从 `observer.js` 接收战况并绘制地图。
- `GET /api/match/status` 返回对局编号、状态和进度。`GET /api/match?perspective=player` 或 `perspective=enemy` 返回对应阵营的观战数据。
- 位图和生成说明位于 [assets](assets/)。
