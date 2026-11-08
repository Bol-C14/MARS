# 产品主页与反馈（2026-11-08）

浏览器版发布成一个完整站点：根路径是 MARS Trace 的产品主页，`/app/` 是 IDE。目标不是收入，而是知道有多少人在用、有多少人反馈、有多少老师和合作者来联系。

```text
teaching/dist/
├── index.html  site.css  site.js  media/     产品主页（中英双语）
└── app/                                      浏览器版 IDE
    ├── index.html  app.js  style.css  fonts/
    ├── kernel.js  kernel-worker.js  examples.json
    └── MARSlicense.txt  TEAVM-LICENSE.txt
```

`sh teaching/scripts/build-browser.sh` 一次生成整个目录。主页源文件在 `teaching/site/`，由 `teaching/site/build.py` 按 `config.json` 填好后写入 `dist/`。课堂服务器版不受影响：反馈按钮、署名和统计只在浏览器构建里出现。

## 设置：`teaching/site/config.json`

| 字段 | 作用 | 留空时 |
|---|---|---|
| `umami.websiteId` | Umami 站点 ID（公开值，本来就写在页面里） | 不加载统计脚本 |
| `tally.feedback` | 反馈表单 ID（`tally.so/r/<ID>` 里的 ID） | 反馈改为打开 GitHub issue |
| `tally.contact` | 联系表单 ID | 用 `email`，再没有就用 GitHub issue |
| `email` | 公开联系地址，如 `hello@bshark.dev` | 见上 |

这里只放公开值。任何 API 密钥、密码都不进仓库。

## 需要在服务后台建好的东西

**Umami**（cloud.umami.is 免费版或自托管）：新建网站，域名填正式域名，把 Website ID 填进 `config.json`。不用 cookie，不需要同意横幅。

**Tally 反馈表单**：字段建议为
- 类型（单选：问题 / 建议 / 其他）
- 描述（长文本，必填）
- 联系方式（选填）
- 身份（单选：学生 / 老师 / 其他）
- 隐藏字段，名字必须完全一致：`source`、`build`、`language`、`diagnostics`、`program`

IDE 打开表单时会填好这些隐藏字段。`program` 只有学生勾选“附上当前程序”时才有内容，最多 8000 个字符。

**Tally 联系表单**：身份（单选：老师 / 合作 / 其他）、学校或机构（选填）、想聊什么（长文本）、回复邮箱（必填）。

## 匿名事件

| 事件 | 何时 | 附带 |
|---|---|---|
| `try` | 主页点“立即试用”或“打开 IDE” | `from`（hero / nav） |
| `teachers` / `contact` / `feedback` | 主页对应按钮 | `from` |
| `language` | 主页切换语言 | `to` |
| `assemble` | 本次打开页面后第一次汇编 | `ok` |
| `step` / `back` / `run` | 本次打开后第一次单步（含源码单步、跨过、跳出）/ 回退 / 完整运行 | — |
| `example` | 打开示例 | `name`、`linked` |
| `feedback-open` / `feedback-continue` | 打开反馈 / 继续填写 | `from`、`program` |
| `kernel-error` | IDE 自身出错（不是学生程序的错） | — |

所有事件都附带界面语言。“第一次”只记一次，事件量很小，也正好回答“这个访客有没有真的用起来”。

## 链接约定

- 指定示例：`/app/?example=03-fizzbuzz`。首次访问直接打开并汇编；已有自己工程的学生会先被询问。打开后参数会从地址栏去掉。
- 直接打开反馈：`/app/#feedback`。
- 渠道追踪：任何链接加 `utm_source`、`utm_medium`、`utm_campaign`，Umami 自动记录。建议：
  - GPT 广告：`utm_source=chatgpt&utm_medium=ad&utm_campaign=<广告名>`
  - 给老师的邮件：`utm_source=email&utm_medium=outreach&utm_campaign=teachers-<月份>`
  - 社区：`utm_source=zhihu|bilibili|reddit|hn&utm_medium=post`

## 部署到 Cloudflare Pages

TeaVM 构建需要 JDK 17 和 Maven，所以在本机构建，再上传 `teaching/dist/`：

```sh
npm ci --prefix teaching
sh teaching/scripts/build-browser.sh
python3 -m http.server 8877 --bind 127.0.0.1 --directory teaching/dist   # 本地检查
npx wrangler pages deploy teaching/dist --project-name mars-trace       # 首次会要求登录 Cloudflare
```

也可以在 Cloudflare 后台 Pages → Create → Direct Upload，直接拖入 `teaching/dist` 文件夹。之后在项目的 Custom domains 里绑定域名。

## 域名邮箱（Cloudflare Email Routing）

域名托管在 Cloudflare 后：Email → Email Routing → 启用，按提示添加 DNS 记录；Destination addresses 填专用 Gmail 并验证；Routing rules 里添加 `hello@`、`feedback@` 等地址，全部转发到这个 Gmail。用域名地址回信：Gmail 设置 → 账号 → 以其他地址发送邮件，SMTP 填 `smtp.gmail.com`、端口 587，密码用 Google 账号的应用专用密码。

## 验证

```sh
python3 teaching/tests/site_browser.py http://127.0.0.1:8877
```

检查主页语言切换与存储、所有资源可访问、手机宽度无横向滚动、无 cookie；示例链接的首次与已有工程两种情况；反馈的诊断信息不含源码；IDE 出错时的报告入口；`#feedback` 直达。IDE 本身的回归见 [浏览器内核版](BROWSER-RUNTIME.md)。
