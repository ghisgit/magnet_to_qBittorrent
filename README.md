# Magnet to qBittorrent（域名即分类）v3.0.0

一个 Tampermonkey / Violentmonkey 用户脚本：识别网页里的**磁力链接**与**裸 infohash**，
一键发送到 qBittorrent，并按**域名自动归类**。

## 一键安装

已安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey 时，直接打开这个链接就会弹出安装页：

**https://raw.githubusercontent.com/ghisgit/magnet_to_qBittorrent/master/Magnet_to_qBittorrent.js**

也可以在脚本管理器里新建脚本，把仓库里的 `Magnet_to_qBittorrent.js` 全文粘贴进去保存。
脚本带上 `@downloadURL` / `@updateURL`，之后有新版本脚本管理器会提示更新。

> 首次安装后请先打开设置填好 qBittorrent 地址，见下方「首次配置」。

---

## 这版修了什么：为什么以前"不会出现按钮"

某些图库型页面会把正文写成下面这样（结构示意）：

```html
<div>
  <img src=".../01.jpg" ...>
  <img src=".../02.jpg" ...>
  <img src=".../03.jpg" ...>
  48b2e7c1a728925959a6b7ca51100ba6e2b350de
</div>
```

在这类页面上旧版脚本一个按钮都不出，原因有三点：

1. **页面里根本没有 `<a href="magnet:...">`**。全文唯一带 `btih` 的地方往往是页脚一句
   写死的说明文案 `magnet:?xt=urn:btih:`，冒号后面是空的。
2. **那串 40 位十六进制就是 infohash**，它是**纯文本**，直接贴在最后一张图后面，
   外层是**没有 class 的 `<div>`**。
3. 旧版脚本只认两种东西：`a[href^="magnet:"]`，以及 `li/p/div[class*="magnet"]/td/pre/code`
   里的 `magnet:?` 文本。这两条都不成立 → **0 个按钮**，看起来就像脚本没工作。

v3 的做法：把**裸 hash 自动合成为完整 magnet 链接**，按钮精确插在该 hash 文本所在的位置。
同时按你的反馈重做了设置界面。

---

## 功能

- **裸 infohash 识别**：40 位 hex（默认开）、32 位 base32（可选）、64 位 v2（可选）。
- **精确注入**：按钮插在 hash/链接文本**旁边**，不是塞在容器末尾；同一页多个 hash 各自成钮。
- **一键批量**：本页识别到多于 1 个磁力时出现 `⚡ N` 徽标，一次全部发送；
  悬浮菜单里也有「发送本页全部磁力」。
- **域名即分类**：`example.com:anime, sample.org` 这种规则继续有效；
  分类名可从 qBittorrent 直接下拉选择，不用手打。
- **同一 hash 去重**：同一页重复出现的 hash 只注入一个按钮、只发送一次（可在设置里关闭）。
- **tracker 兜底**：裸 hash 合成的 magnet 会带上你配置的 tracker；
  页面里现成的、一个 tracker 都没有的 magnet 也会被补上。
- **现代化设置面板**：Shadow DOM 隔离（不受宿主页面 CSS 影响）、5 个标签页、
  自动深色模式、ESC 关闭、`Ctrl/⌘+S` 保存、窄屏自适应。
- **诊断能力**：面板内显示"本页识别 N 个 / 已注入 N 个 / 已发送 N 个"，
  可一键重新扫描、复制诊断信息，方便定位问题。

---

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或 Violentmonkey。
2. 新建脚本，把 `Magnet_to_qBittorrent.js` 的全部内容粘贴进去，保存。
   （或直接打开该 `.js` 文件，扩展会提示安装。）
3. 打开任意网页，右下角会出现半透明齿轮按钮 ⚙。

> 从 v2.1 升级：设置项**自动迁移**（`domains` 字符串会转成规则表），无需重新配置。

## 首次配置

点齿轮 ⚙ →「⚙ 打开设置」：

| 标签页 | 要填什么 |
|---|---|
| **🔌 连接** | qB 的 WebUI 地址（如 `http://127.0.0.1:8080`）、用户名、密码；可选默认保存路径与 Tags。填完点「🔌 测试连接」确认能通，再点「保存设置」。 |
| **🗂 分类** | 选一个全局默认分类（「🔄 从 qB 重新读取分类」会拉取 qB 里已有的分类）。 |
| **🌐 域名规则** | 点「📌 添加当前站点」把当前域名加进白名单并选分类。**空列表 = 所有网站都启用**；只要有一条规则，就只有命中的网站注入按钮。 |
| **🎯 识别与外观** | 识别开关、悬浮按钮、tracker 列表、额外下载参数（JSON）、自定义选择器。 |
| **🩺 诊断** | 当前站点命中情况、本页识别/注入计数、重新扫描、复制诊断信息。 |

### 快捷操作

| 操作 | 方式 |
|---|---|
| 打开设置 | 右下角齿轮 ⚙ / `Alt+Q` / 油猴菜单 |
| 添加单个 | 点页面上的 `📥 qB` 按钮 |
| 添加本页全部 | 点 `⚡ N` 徽标，或齿轮菜单 →「发送本页全部磁力」 |
| 临时停用本站 | 齿轮菜单 →「在本站停用脚本」 |
| 移动齿轮位置 | 直接拖动（位置会记住） |

---

## 常见问题

**页面上没有按钮？**
① 齿轮菜单看「本站已启用 / 未启用」，未启用就点「在本站启用脚本」；
② 诊断页点「🔄 重新扫描本页」，看**识别数**：
识别数为 0 → 这个页面确实既没有 magnet 链接也没有 40 位 hash；
识别数 > 0 但注入数为 0 → 本站没在白名单里。

**点「测试连接」报网络错误？**
qB 里 `工具 → 选项 → Web UI` 要勾选「Web 用户界面(远程控制)」；
如果脚本在另一台机器/浏览器上跑，还要取消「仅允许本地主机」或把来源加进白名单。
地址建议写 `http://127.0.0.1:8080` 而不是 `localhost`。

**401 / 403？**
用户名或密码不对；qB 默认用户名是 `admin`。

**点击后 qB 里没出现种子？**
冷门种子可能需要时间找 peer；另外检查 tracker 列表是否还有效（设置页可替换）。

**按钮位置有点怪？**
按钮插在 hash 文本旁。图库页面图片加载完成后布局会变，脚本会自动重扫一次；
也可以手动点诊断页的「重新扫描本页」。

**「重新扫描本页」后按钮会变多吗？**
不会。同一 hash 每页只注入一次、只发送一次（除非在设置里打开「允许重复添加同一 hash」）。
诊断页的「本页磁力」是去重后的数量。

**会不会误认？**
40 位十六进制串在极少数场景（git commit、某些校验码）也会出现。
防护措施：不扫描 `<script>`/`<style>`/`<textarea>` 等区域；
可用「永久停用的域名」按站点关闭；也可只留 magnet 链接识别（关掉 40 位 hex）。

---

## 开发与测试

零运行时依赖；测试用 Node 内置 `node:test` + 自写的极简 DOM 垫片，**完全离线可跑**。

```bash
npm test          # 语法检查 + 全部测试
node --test test/*.test.mjs
```

测试分三层：

| 文件 | 覆盖内容 |
|---|---|
| `test/scan.test.mjs` | 纯逻辑内核（hash/magnet/规则/迁移）+ 扫描器（真实页面 fixture、多 hash、去重、误报防护、注入位置、面板渲染与校验） |
| `test/userscript.test.mjs` | 真实浏览器路径：把整个脚本当用户脚本跑，验证 `DOMContentLoaded` 初始化、按钮注入→点击→HTTP 请求、v2.1 设置迁移、面板保存落盘 |
| `test/minidom.mjs` | 极简 DOM 垫片（`createElement`/`querySelectorAll`/`TreeWalker`/属性反射…） |

脚本内部用两个标记把可测部分切出来，测试通过 `vm.compileFunction` 注入依赖后运行：

```
// ==M2Q-PURE-BEGIN==   ... 无 DOM 依赖的纯函数（hash/magnet/规则/设置归一化）
// ==M2Q-SCANNER-BEGIN== ... 其余运行时代码（DOM、qB API、UI）
```

新增依赖时，需要同步更新 `Magnet_to_qBittorrent.js` 末尾的 `scannerBlock({...})` 调用
和 `test/harness.mjs` 中的同名参数。

### 已知取舍

- **`<pre>` / `<code>` 里的 40 位 hex 会被识别**。这是有意的：很多站点正是把 hash 放在代码块里。
  如果你常逛的站点在代码块里贴 git commit，可用「永久停用的域名」关掉那个站。
- **不做二次网络请求**去猜资源名，所以 `dn`（显示名）对裸 hash 是空的。
- **`/api/v2/torrents/add` 的响应以 body 判定**：qB 失败时常返回 200 且 body 为 `Fails.`，
  脚本会把它当失败处理。
- 分类、tracker、认证方式都以 qBittorrent 4.x 的 Web API v2 为准。

---

## 文件

```
Magnet_to_qBittorrent.js     用户脚本（单文件，直接安装）
README.md                    本文件
LICENSE                      MIT
package.json                 npm test（语法检查 + 全部测试）
test/
  scan.test.mjs              纯逻辑内核 + 扫描器测试
  userscript.test.mjs        端到端测试（以真实用户脚本方式加载）
  harness.mjs / minidom.mjs  测试装配与零依赖 DOM 垫片
  fixtures/gallery-post.html 图库型页面结构样本（已匿名化，回归用例）
  fixtures/regression.html   磁力链接/多 hash/data 属性/误报样本（合成数据）
```

## 更新日志

**3.0.1** — 补 `@homepageURL` / `@supportURL` / `@downloadURL` / `@updateURL`，支持从本仓库自动更新

**3.0.0**
- 新增：裸 40 位 hex infohash 识别与 magnet 合成（本次反馈的核心问题）
- 新增：同页多 hash 支持、批量发送、`⚡ N` 徽标
- 新增：Shadow DOM 设置面板（5 标签页、分类下拉、规则表可视化编辑、连接测试、诊断页）
- 新增：域名规则表 + 正则规则 + 按站点启用/停用
- 修复：无 class 的 `<div>` 中的 magnet/hash 被完全忽略
- 修复：每个容器只取第一个匹配（合集页丢按钮）
- 修复：`<script>`/`<style>`/`<textarea>` 内容被当作候选文本扫描
- 修复：添加失败时只看 HTTP 200，忽略 `Fails.` 响应体
- 修复：密码等设置值通过 `innerHTML` 拼接的转义隐患
- 保留：v2.1 的设置键与扁平字段（自动迁移，用户无感）

**2.1** — 域名即分类、浮动按钮

---

## 许可

[MIT](LICENSE) © 2026 ghisgit

## 免责声明

本脚本只是把页面**已经公开展示**的磁力链接/infohash 转发到你自己的 qBittorrent 客户端，
不抓取、不索引、不分发任何内容，也不提供任何资源。请自行遵守所在地区法律与目标站点的使用条款，
仅用于你有权获取的内容。
