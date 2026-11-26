# `gkms-box` HIF 支援卡算分与配卡系统交接说明

> 本文档面向新对话直接接手开发与维护，完整汇总截至 **2026-11-26** 已锁定并上线的 **HIF 算分/配卡引擎、Koishi 机器人 `hif配卡` 拼图功能、网页端 P 卡复制指令按钮、核心架构与已踩坑点**（不含任何密码、密钥等敏感信息）。

---

## 一、当前上线状态与版本基线

- **本地工作区**：`e:\软件\GEMINI工作区\gkms-box`
- **Git 仓库状态**：已推送至 `origin/main`（最新两次提交）：
  - `7cdefe3` `fix(koishi-plugin): do not auto-recall HIF deck recommendation images`
  - `e9074a6` `feat(web,koishi-plugin): add HIF 6-card deck planner and P-card copy-command buttons`
- **Koishi 服务端状态（已同步部署并重启生效）**：
  - 容器 `koishi` 已加载最新版 `gkms-box` 插件与 `193` 张支援卡公式（启动日志 `2895/2895 线性校验通过`）。
- **网页端（Cloudflare Pages）**：
  - 构建设置：`Root directory = web`，`Build output directory = public`（推送 `main` 后自动构建更新 `https://gkms.134491.xyz`）。

---

## 二、核心文件架构清单

| 模块 / 文件路径 | 职责与说明 |
| :--- | :--- |
| [extract_excel.py](file:///e:/软件/GEMINI工作区/gkms-box/hif-planner/extract_excel.py) | 从原 Excel（`D:\BaiduNetdiskDownload\chromedownload\支援卡-11.3新卡实装.xlsx`）无损提取 193 张卡 `0~4` 破（`noItem`/`withItem` × 3 槽位）公式至 `cards_data.json`，与 `support.json` 193/193 全匹配（含 `キュっと締めて` → `2-0024` 别名）。 |
| [cards_data.json](file:///e:/软件/GEMINI工作区/gkms-box/hif-planner/cards_data.json) | 193 张支援卡公式源文件（与 `koishi-plugin/data/hif_cards.json` 内容一致）。 |
| [hif_planner.py](file:///e:/软件/GEMINI工作区/gkms-box/hif-planner/hif_planner.py) | Python CLI 校准与排障原型（支持 `--idol`、`--box`、`--scan-routes`、`--trifold-drink`、`--consult-drinks`、`--sp20`、`--route-mode` 等详参分析与 Top 5 / 全配比排行打印）。 |
| [hif_cards.json](file:///e:/软件/GEMINI工作区/gkms-box/koishi-plugin/data/hif_cards.json) | Koishi 插件随包内置的公式数据（`cards_data.json` 副本）。 |
| [hif-planner.js](file:///e:/软件/GEMINI工作区/gkms-box/koishi-plugin/hif-planner.js) | **纯 JS 无依赖 HIF 求解引擎**：含安全 AST 表达式编译器（无 `eval`/`new Function`）、`2895/2895` 线性校验、预计算查表求解器 `solveBestHifDeck`（单次求解 ~50–245ms）、角色/流派/卡名检索 `resolveIdolForHif`。 |
| [renderer.js](file:///e:/软件/GEMINI工作区/gkms-box/koishi-plugin/renderer.js) | 新增 `buildHifDeckHtml` 与 `renderHifDeckImage`：`1200px` 暗夜霓虹 6 配卡拼图（含目标 P 卡头像、总评/有效三维/配比、3×2 支援卡大图、借卡高亮、三属性进度条、8 天 SP/选拔/营业/自由日速查）。 |
| [index.js](file:///e:/软件/GEMINI工作区/gkms-box/koishi-plugin/index.js) | 接入 `hif配卡 <P卡/角色名>` 指令（`parseHifDeckCommand`），自动读用户绑定 BOX，缺失卡全补 `-1`，**严格只回 1 张图片且不自动撤回**；同步更新 `CHAR_ALIASES` 简繁日文混写。 |
| [app.js](file:///e:/软件/GEMINI工作区/gkms-box/web/public/app.js) / [styles.css](file:///e:/软件/GEMINI工作区/gkms-box/web/public/styles.css) | 网页端「角色与皮肤（P卡）」卡片底部新增 **「📋 复制配卡指令」** 按钮（防点击冒泡不切换持有状态，附 Toast + 短暂确认态）。 |
| [支援卡算分机制解析.md](file:///e:/软件/GEMINI工作区/gkms-box/docs/支援卡算分机制解析.md) | 原 Excel 工作表、词条变量 `B11~B50` 对照、三大剧本对比与 HIF 实测口径明细。 |
| [test_hif_planner.mjs](file:///e:/软件/GEMINI工作区/gkms-box/tests/test_hif_planner.mjs) / [test_koishi_plugin.mjs](file:///e:/软件/GEMINI工作区/gkms-box/tests/test_koishi_plugin.mjs) | 自动化单测：覆盖双端黄金基准对齐、安全边界、简繁别名、`hif配卡` 纯图不撤回、315/315 张 P 卡网页复制指令全命中校验。 |

---

## 三、已锁定的 HIF 精准算分口径与寻优模型

### 1. 角色初始三维与成长率（与 `cidol.json` 解耦）
- `web/public/data/cidol.json` 对同一角色多个 SSR 沿用了旧模板（如琴音全部写成了 `Vi22%/Da18%`），不能直接用于准确算分。
- 引擎 `CHAR_BASE_STATS` 内置了游戏实测 **13 位角色** 初始三维与成长率（暂不计开花与特训，同角色 P 卡共享；未在表中的 `hkne` 冰渡香名江回退读 `cidol.json` 自带 `stats`）：

| 代码 | 角色 | Vo（成长%） | Da（成长%） | Vi（成长%） | 自动推导槽位（一 / 二 / 三属） |
| :---: | :--- | :--- | :--- | :--- | :--- |
| `amao` | 有村麻央 | 125 (`23.0%`) | 90 (`11.0%`) | 115 (`24.0%`) | Vi / Vo / Da |
| `atbm` | 雨夜燕 | 115 (`17.0%`) | 140 (`20.0%`) | 110 (`13.0%`) | Da / Vo / Vi |
| `fktn` | 藤田琴音 | 95 (`11.0%`) | 105 (`24.5%`) | 135 (`22.5%`) | Da / Vi / Vo |
| `hmsz` | 秦谷美铃 | 95 (`27.0%`) | 125 (`13.0%`) | 140 (`20.0%`) | Vo / Vi / Da |
| `hrnm` | 姬崎莉波 | 85 (`13.0%`) | 120 (`21.5%`) | 125 (`25.5%`) | Vi / Da / Vo |
| `hski` | 花海咲季 | 120 (`16.5%`) | 125 (`16.5%`) | 135 (`20.5%`) | Vi / Da / Vo |
| `hume` | 花海佑芽 | 115 (`20.0%`) | 120 (`23.0%`) | 125 (`18.0%`) | Da / Vo / Vi |
| `jsna` | 十王星南 | 175 (`16.0%`) | 125 (`13.0%`) | 140 (`22.5%`) | Vi / Vo / Da |
| `kcna` | 仓本千奈 | 95 (`13.0%`) | 125 (`24.0%`) | 135 (`21.5%`) | Da / Vi / Vo |
| `kllj` | 葛城莉莉娅 | 60 (`18.0%`) | 80 (`20.0%`) | 95 (`18.0%`) | Da / Vi / Vo |
| `shro` | 筱泽广 | 130 (`25.0%`) | 125 (`19.5%`) | 95 (`13.0%`) | Vo / Da / Vi |
| `ssmk` | 紫云清夏 | 105 (`12.0%`) | 115 (`25.0%`) | 95 (`24.0%`) | Da / Vi / Vo |
| `ttmr` | 月村手毬 | 120 (`27.0%`) | 100 (`22.5%`) | 80 (`11.5%`) | Vo / Da / Vi |

### 2. HIF 开局加成、回忆、蓝字、红字与最终评价分
- **HIF 开局全局加成**：三属性开局自带全局 **各 `+10%` 百分比加成** 与 **各 `+100` 固值加成**。
- **回忆加成默认**：一属 `+11.2%`（`4×2.8%`）、二属 `+11.2%`（`4×2.8%`）、三属固定白值 `+120`（`4×30`）。
- **蓝字（吃 `角色% + 全局10% + 回忆% + 支援卡%`，11 次事件逐次 `floor` 舍尾）**：
  - **选拔 1/2/3**：固定全属 `20 / 80 / 100`，另各有可分配控分白值 `80 / 200 / 220`（整场独立全给任意属性，全枚举 `3^3 = 27` 种分配）；
  - **8 天 SP 课**（选拔前 `2/4/9/11/15/18` 日 + 本战前 `2/5` 日）：主副白值依次为 `(60,20),(80,50),(80,20),(100,60),(100,20),(120,70),(120,20),(140,80)`。点一属时副属给二属、点二属时副属给一属。对一/二属 256 种排列按 `(sp1Count, 一属SP总白值)` 去重为 79 种精确寻优；默认满 SP（最低 SP 要求 `(0,0,0)`）。
  - 每次独立计算：`Math.floor(ev * (1 + totalPct / 100) + 1e-9)`。
- **不吃百分比项**：
  - **S 卡固值**：基础/词条/事件/道具白值（默认道具全发，开启 `--calc-item`；不计塞卡 `+20`）；
  - **6 次营业红字**（选拔前 `3/6/10/17` 日 + 本战前 `1/4` 日）：白值 `120 / 120 / 150 / 150 / 180 / 180`（合计 **900**），遍历全部唯一三属分割，优先最大化截断 `3200` 后的有效三维总和，其次最小化溢出，再次尽量补齐单极审查线 `1960 / 1307 / 1089`。
- **单属性 `3200` 截断与总评价分（与 `koishi-plugin-hif-calc` 100% 一致）**：
  - 超过 `3200` 溢出部分记 `0` 收益；
  - `finalRating = floor(有效三维总和 * 2 + 星耀1335 * 7.5 + 本战1分(140w→5500) + 本战2分(240w→7400) - 2000)`；
  - 排序关键字优先级：`(finalRating, effectiveTotal, -overflowLoss, -outingCount, sum(supFlatSum))`。

### 3. 自由日日程、全配比与饮料联动规则
- **全量配比**：枚举 `n1 + n2 + n3 = 6, n3 ≤ 3` 共 **22 种**合理配比（含 `4/2`、`2/4`、`4/1/1`、`1/4/1`、`3/3` 等）。
- **9 个自由日严格规则（`strict` 默认）**：「能支就支，能进商店(相谈)就不特指，仅 5 日一选保留外出/相谈对比」：
  - `1日(支给)` / `5日(相谈|外出)` / `8日(支给)` / `12日(相谈)` / `14日(支给)` / `16日(支给)` / `19日(相谈)` / `本战3日(支给)` / `本战6日(相谈)` -> 收敛为 **`4相谈/5支给/0外出/0特指`** 与 **`3相谈/5支给/1外出/0特指`**。
- **动作次数默认值（`BASE_HIF_ACTIONS`）**：抓 SSR(`B44`)=`10`、`20SP(B49)`=`4`（默认吃满）、基础饮料(`B40`)=`20`、相谈买饮料(`B39`)=`0`、删卡(`B35`)=`6`、变卡(`B38`)=`3`、买卡(`B50`)=`5`、A/M强化(`B28/B29`)=`2/2`。
- **饮料联动（仅小饮料）**：
  - 仅 **小饮料（`ふわふわでワクワク`，`2-0007`，`isMiniDrink: true`）** 动态绑定 `Da SP 次数 × 2` 瓶叠加到全队 `B40`，并强制关闭其原表静态道具 `+60` 估值避免重复计分；
  - 三折叠（`自分と向き合う時間だ`，`3-0110`）等其他 S 卡道具赠送饮料**暂不计入**动态联动（Python 原型保留 `--trifold-drink` 供实验对比）。

---

## 四、Koishi 插件与网页端交互规范

### 1. Koishi 端 `hif配卡` 指令（`koishi-plugin`）
- **触发方式**：`hif配卡 <P卡/角色名> [hp1_参数码]`（参数码前置或后置均可；`requireAt: true`、`allowDirectWithoutAt: true`；私聊免 `@`，群聊需 `@Hiro cos`）。
- **自定义参数码（[hif-params-codec.js](file:///e:/软件/GEMINI工作区/gkms-box/koishi-plugin/hif-params-codec.js)）**：
  - 支持在网页端「HIF 参数」页调整 **三属性回忆%/固值（6 项）、抓卡类（9 项）、强化/删卡/变卡/买卡/道具（8 项）、休息/相谈买饮料/饮料全局总数（3 项）**，共 26 项可调常量 + `B30` 营业固定锁定 `6`；
  - 仅编码偏离默认值的差异项，生成短无状态 `hp1_...` 代码（最多 256 字符），前后端模块字节级一致并校验范围与不可修改项。
- **回复规则**：
  - 成功时 **严格只发 1 张 6 配卡拼图**（`h.image(...)`），不附带文字或可选项，**不触发自动撤回**（`绑定` 与 `查box` 保留 30 秒撤回）；使用自定义参数时拼图底栏标注具体改动摘要。
  - 未绑定 BOX / 缺少有效支援卡 / 参数码有误 / 参数为空 / 多流派只输角色名 / 同名 P 卡跨角色撞名（先用用户已绑定 P 卡自动消歧）时返回简短文字提示，不扣冷却。
  - 复用 `renderCooldowns`（20s）与 `MAX_RENDER_PENDING`（4），求解不足 5 卡或渲染失败自动退还冷却。
- **角色名简繁/日文混写兼容**：
  - `hif-planner.js` 内 `normRoleText` 自动归一化常见异体字（`篠→筱`、`澤→泽`、`広/廣→广`、`姫→姬`、`倉→仓`、`雲→云`、`鈴→铃`、`亞/婭/亚→娅`、`會→会`、`長→长`、`氷→冰`），搭配全部 14 位偶像假名/日文别名表，支持如 `篠泽广 ガラクタロード`、`藤田ことね 感性`、`莉波感性` 等写法；单字别名（如 `广`、`燕`）仅在独立 token 命中时匹配，防止误伤长卡名。

### 2. 网页端 P 卡页与 HIF 参数页（`web/public`）
- **第 3 分页「HIF 参数」**：实时编辑上述 26 项常量与生成/导入 `hp1_...` 参数码，`localStorage` 自动保存；营业次数显示锁定 `6` 不可修改。
- **P 卡页「📋 复制配卡指令」**：写入 `hif配卡 ${charName} ${targetName}`；若已在「HIF 参数」页调整了参数且保持「自动附带参数码」勾选，则自动在末尾拼接 `hp1_...`（按钮标黄提示 `含参数`）。点击触发 `e.stopPropagation()` + `e.target.closest('[data-copy-hif]')` 守卫，绝不误触切换卡片拥有状态。

---

## 五、已确认的坑点与安全修复（交接必看）

1. **`boxLbs` 缺省值陷阱**：未持有卡**必须显式记为 `-1`**，绝不能 `.get(key, 4)` 默认 4 破（`hif_planner.py` 第 552 行与 `hif-planner.js` 已修复，生成完整 BOX 映射时亦显式全量填 `-1`）。
2. **强绑卡防白嫖漏洞**：在 `pickBestColorAtBlue` 中必须校验 `{card.id in mustList} == required_ids`；否则当用户未持有小饮料且将唯一借卡位分配给其他颜色（如黄位）时，会漏装小饮料却错误享受到 `+16` 瓶全队加成（双端已修复并加单测覆盖）。
3. **Cloudflare API 保护**：线上 `https://gkms.134491.xyz/api/binds/*` 启用了 Cloudflare Managed Challenge（HTTP 403），脚本侧直接 `fetch` 短码会被人机拦截；排查/跑本地测试请直接使用网页复制出的 Base64 字符串或本地 `box.json`。
4. **Windows PowerShell 与 Git**：
   - PowerShell 5.1 传含反引号/引号的多行脚本给 Node/Python 时，一律用单引号 here-string `@' ... '@ | node -` 或 `@' ... '@ | python -`；
   - 本机 `git` 不在默认 `PATH`，调用路径为 `C:\Program Files\Git\cmd\git.exe`，SSH 推送走 `$env:GIT_SSH = 'C:\Program Files\Git\usr\bin\ssh.exe'`（配置 443 端口 SSH 密钥）。
5. **NAS 路径（仅记录结构）**：Koishi 插件目录 `/vol2/1000/docker/koishi/data/plugins/gkms-box`，数据目录 `/vol2/1000/docker/koishi/data/gkms-box/data`，容器名 `koishi`。

---

## 六、黄金基准与常用命令

### 1. 黄金基准数值（Python 与 JS 100% 一致，含 HIF 全局 +10%/+100）
- **全 4 破 姬崎莉波 `hrnm-3-017`**：HIF 总评 **`35290`**（有效三维 `7189`，`2 / 4`，蓝 `3200(溢41)` / 黄 `2899` / 红 `1090`，选拔 `[黄/黄/黄]`，营业 `黄+360/红+540`）。
- **全 4 破 藤田琴音 `fktn-3-013`**：HIF 总评 **`35258`**（有效三维 `7173`，`4 / 2`，蓝 `3200(溢56)` / 黄 `2877` / 红 `1096`，选拔 `[黄/黄/黄]`，营业 `黄+360/红+540`）。
- **测试样本 BOX + `hrnm-3-017`**：HIF 总评 **`34990`**（有效三维 `7039`，`2 / 4`，0 溢出，黄 `2775` / 蓝 `3174` / 红 `1090`，借满破 `3-0099 本番前昼`，8 天全蓝 SP，选拔 `[蓝/黄/黄]`，营业 `黄+360/红+540`，自由日 `4相谈/5支给/0外出`）。

### 2. 日常验证与新卡更新命令
```powershell
# 1. 全量自动化单元测试（codec / API / HIF 引擎 / 315张P卡指令 / Koishi 插件，当前 17/17 通过）
node --test "e:\软件\GEMINI工作区\gkms-box\tests\test_hif_planner.mjs" "e:\软件\GEMINI工作区\gkms-box\tests\test_koishi_plugin.mjs" "e:\软件\GEMINI工作区\gkms-box\tests\test_codec_and_api.mjs"

# 2. 网页前端脚本语法校验
node --check "e:\软件\GEMINI工作区\gkms-box\web\public\app.js"

# 3. Python 原型查看单角色 Top 5 与多配比对比（含明细拆解）
$env:PYTHONIOENCODING='utf-8'
python "e:\软件\GEMINI工作区\gkms-box\hif-planner\hif_planner.py" --idol "hrnm-3-017" --round1 140 --round2 240 --scan-routes

# 4. 今后更新新版支援卡 Excel 时：重新提取并同步到插件内置数据
python "e:\软件\GEMINI工作区\gkms-box\hif-planner\extract_excel.py"
Copy-Item "e:\软件\GEMINI工作区\gkms-box\hif-planner\cards_data.json" "e:\软件\GEMINI工作区\gkms-box\koishi-plugin\data\hif_cards.json" -Force
```

---

## 七、潜在可扩展方向（待新对话按需开展）
1. **网页端在线 HIF 配卡计算页**：`koishi-plugin/hif-planner.js` 已做成 IIFE + UMD 双兼容（挂载 `window.GkmsHifPlanner`，纯浏览器可直接引入 `loadHifEngine` 改写成 `fetch('./data/hif_cards.json')` 或拆分纯计算 core），可直接复用同一套算法做到网页前端。
2. **自定义口径参数扩展**：当前 `hif配卡` 固定使用默认口径（本战 140w/240w、星耀 1335、回忆 +11.2%、仅小饮料联动、strict 自由日）；后续如需支持指令传参（如禁用卡、指定本战分数或三折叠联动），只需在 `parseHifDeckCommand` 和 `solveBestHifDeck(..., options)` 透传参数即可。
3. **第 14 名角色 `hkne` 实测初始三维/成长率**：待游戏内实装并取得准确截图后，补充到 `CHAR_BASE_STATS.hkne`。
