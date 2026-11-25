# Cloudflare Pages + 自定义域名 + KV 短码部署指南

这套站点采用**零构建纯静态前端 + Cloudflare Pages Functions + Cloudflare KV** 架构，**不需要暴露本地服务器或自建 NAS 的任何公网端口**。

---

## 第一步：把代码推到 GitHub 私有仓库（推荐）

Cloudflare Pages 支持直接关联 **GitHub 私有仓库（Private）** 自动部署，无需把站点和静态资源暴露在公开仓库中。

1. 在 GitHub 新建一个私有仓库（例如 `my-gkms-box`）。
2. 把 `gkms-box` 整个工程目录提交推送上去即可。

---

## 第二步：在 Cloudflare 创建 KV（用于存 `g########` 短码）

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 左侧菜单进入 **存储和数据库（Storage & Databases） → Workers KV**。
3. 点击 **创建命名空间（Create a namespace）**，名称填 `gkms-box-binds`（便于识别即可），点创建。

---

## 第三步：创建 Cloudflare Pages 项目并绑定自定义域名

1. 左侧菜单进入 **计算 → Workers 和 Pages → 创建 → Pages → 导入现有 Git 存储库 / 连接到 Git**。
2. 选择你在第一步创建的 GitHub 仓库，填写构建设置：
   - **框架预设**：选 `无（None）`
   - **构建命令**：留空
   - **构建输出目录**：填 `public`
   - 展开下方的 **根目录（高级 / Root directory）**：填 `web`  
     > ⚠️ 这一步非常关键：`Root directory` 设为 `web`、`Build output directory` 设为 `public`，Cloudflare Pages 才会同时把 `web/functions/api/binds/*` 作为同域名后端接口一起部署；同时仓库中仅保留参考文件 `wrangler.toml.example`，不要直接创建 `wrangler.toml`，否则会锁定控制台的 KV 绑定按钮。
3. 点击 **保存并部署** 完成首次部署。
4. 进入该 Pages 项目的 **设置（Settings） → 绑定（Bindings） → 添加**：
   - 类型选 **KV 命名空间**
   - **变量名称** 严格填写：`BOX_BINDS`
   - **KV 命名空间** 选择第二步创建的 `gkms-box-binds`
   - 分别在 **Production** 和 **Preview** 环境下保存。
5. 进入 **自定义域（Custom domains） → 设置自定义域**：
   - 输入你想用的二级域名（如 `box.你的域名.com`），按提示确认后 Cloudflare 会自动配好 CNAME 和 HTTPS 证书。
6. 进入 **部署（Deployments）** 点一次最新部署右侧的 **重试部署（Retry deployment）**，让 `BOX_BINDS` KV 绑定立即生效。

> 网络提示：部分本地网络直连 `*.workers.dev` 可能会超时，而直连 **Pages 自定义域名** 更稳定；本系统的短码接口与前端共用同一域名 `/api/binds`，无需额外搭建独立 Worker 域名。

---

## 第四步：把自定义域名接入 Koishi 机器人

绑定好自定义域名后，在你的 `<koishi数据目录>/koishi.yml` 中配置 `gkms-box` 插件：

```yaml
gkms-box:gb0001:
  webUrl: https://box.你的域名.com
  apiBaseUrl: https://box.你的域名.com
```

重启 Koishi 服务即可启用完整功能：
- 群友 `@机器人 box`：返回你的工具网址与指令提示；
- 群友在网页点「生成并复制 9 位短码」拿到 `g12345678`；
- 群友在群里发 `@机器人 绑定box g12345678`，机器人主动向外请求 `https://box.你的域名.com/api/binds/g12345678` 拉回数据存进本地 SQLite；
- 群友发 `@机器人 查box` 或 `@机器人 晒box 筱泽广`，Koishi 本地 Chromium 自动拼图并发送进群。

---

## 第五步：日常维护（更新新卡池 / 放入卡面图）

1. **新卡池更新**：在本机运行：
   ```powershell
   python scripts/sync_catalog.py
   ```
   提交 `web/public/data/*.json` 推到 GitHub，Cloudflare Pages 会自动重部署；同时把 `koishi-plugin/data/*.json` 同步到 `<koishi数据目录>/gkms-box/data/`。
2. **导入卡面图片包**：如果你手头准备了卡面图（`.png/.jpg/.webp`），在本机运行：
   ```powershell
   python scripts/import_assets.py --source "你的图片文件夹路径" --plugin-dir koishi-plugin
   ```
   - `web/public/assets/` 会生成压缩后的 WebP 与 `asset-manifest.json`，随仓库推上去后网页立刻展示高清卡面；
   - `koishi-plugin/assets/` 与 `koishi-plugin/data/asset-manifest.json` 上传到 `<koishi数据目录>/gkms-box/` 后，机器人群内拼图也会立刻自动使用高清卡面。
