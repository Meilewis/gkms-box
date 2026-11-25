# gkms-box

《学园偶像大师》（学马仕）BOX 分享网页 + Cloudflare 短码后端 + Koishi 机器人插件与离线拼图套件。

- **致谢与说明**：本项目代码与文档由 **AI 辅助生成**，功能设计、交互思路与部分 Base64 编码协议借鉴参考了 [kitsurato/mini-gkms-box](https://github.com/kitsurato/mini-gkms-box)，卡池基础数据同步自上游解包跟踪仓库 [vertesan/gakumasu-diff](https://github.com/vertesan/gakumasu-diff)。
- **内网无公网暴露**：静态网页与短码接口部署在 Cloudflare Pages + KV，本地服务器 / NAS 中的 Koishi 机器人仅主动向外请求读取短码并在本地完成 HTML→JPEG 拼图。
- **图数分离**：未导入卡面图包时前后端均可正常使用并自动绘制流派渐变卡片；本地准备好卡面图片后运行导入脚本即可切换高清卡面。

## 目录结构

- `scripts/sync_catalog.py` — 从 `vertesan/gakumasu-diff` 同步最新支援卡、P 卡与角色目录 JSON（纯 Python 标准库）
- `scripts/import_assets.py` — 识别、压缩本地卡面图片为 WebP 并生成 `asset-manifest.json`
- `web/` — 零构建、零外部 CDN 的前端页面与 Cloudflare Pages Functions 短码接口（详见 [DEPLOY_CF.md](./web/DEPLOY_CF.md)）
- `koishi-plugin/` — Koishi v4 插件 `koishi-plugin-gkms-box`（支持 `box`、`绑定box`、`查box`、`晒box`、`解绑box`）
- `tests/` — 编解码与短码 API 自动化单元测试

## 常用命令

1. 同步最新上游卡池目录：
   ```bash
   python scripts/sync_catalog.py
   ```
2. 导入本地卡面图包并同时写入前端和机器人目录：
   ```bash
   python scripts/import_assets.py --source "你的图片文件夹路径" --plugin-dir koishi-plugin
   ```
   然后把 `koishi-plugin/assets/` 与 `koishi-plugin/data/asset-manifest.json` 同步到你的 `<koishi数据目录>/gkms-box/` 即可（无需重启机器人，下次晒图自动加载高清图）。
3. 运行本地自动化测试：
   ```bash
   node --test tests/test_codec_and_api.mjs
   ```

## 免责与版权说明

- 本项目代码基于 MIT 协议开源，由 AI 辅助编写与重构，非官方工具，亦非作者手写商业项目。
- 卡池基础数据同步自开源数据跟踪项目 `vertesan/gakumasu-diff`，网页端与编码兼容方案参考了 `kitsurato/mini-gkms-box`。
- 本工具仅供玩家非营利同好交流。所有《学园偶像大师》相关角色、名称与美术素材版权均归 Bandai Namco Entertainment Inc. / QualiArts, Inc. 所有。
