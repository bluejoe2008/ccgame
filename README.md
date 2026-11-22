# Command&Conquer

蓝红两队智能体在同一张随机地图上竞赛。观战者可以切换阵营视角、查看行动记录或跟踪单位。对局在服务器运行，浏览器刷新后会重新接入当前比赛。

## 运行

使用 Node.js 22 或更新版本。项目直接使用 Node.js 内置模块。

```sh
npm start
```

打开 [http://127.0.0.1:8770](http://127.0.0.1:8770/)。需要从局域网观战时，可用 `npm start -- --bind 0.0.0.0`。如果服务器已配置 Codex CLI，可加 `--codex` 启用战略规划。本地智能体负责模拟、执行指令和处理紧急反应。

服务自动开始连战。每局分出胜负后归档双方日志和复盘，约 10 秒后进入下一局。「结束」停止连战并保留当时的地图和战况，「开始」恢复连战。正在运行的对局会自动保存，服务重启后从最近存档继续。用 `--state /path/to/match.bin` 指定存档路径。默认路径为 `$XDG_STATE_HOME/ore-command/match.bin`，未设置时使用 `~/.local/state/ore-command/match.bin`。

「战史」显示当前阵营的历局胜负、复盘和日志下载。日志与复盘保存在存档路径加上 `.history` 的目录下。每个阵营从自己最近八场分出胜负的对局中提取决策重点。跨越功能升级的首局从升级时仍留存的记录开始归档。

## 代码与素材

- `server.cjs` 提供网页、观战接口和开始、结束操作。
- `match-worker.cjs` 在工作线程中运行对局、恢复存档和滚动开局，`battle-history.cjs` 保存分阵营日志并生成复盘。
- `game.js` 和 `commander.js` 包含模拟和智能体逻辑。浏览器从 `observer.js` 接收战况并绘制地图。
- `GET /api/match/status` 返回对局编号、状态和进度。`GET /api/match?perspective=player` 或 `perspective=enemy` 返回对应阵营的观战数据。
- `GET /api/history?perspective=player` 或 `perspective=enemy` 返回该阵营已归档的对局复盘。使用 `before` 查询更早的页，使用 `GET /api/history/<局号>/log?perspective=player` 下载日志。
- 位图和生成说明位于 [assets](assets/)。
