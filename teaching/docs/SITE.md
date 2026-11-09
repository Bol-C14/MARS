# 产品主页与反馈（2026-11-08）

浏览器版发布成一个完整站点：根路径是 MARS Trace 的产品主页，`/app/` 是 IDE。目标不是收入，而是知道有多少人在用、有多少人反馈、有多少老师和合作者来联系。

```text
teaching/dist/
├── index.html  zh-cn/  site.css  site.js  media/  产品主页（中英入口）
└── app/                                      浏览器版 IDE
    ├── index.html  app.js  style.css  fonts/
    ├── kernel.js  kernel-worker.js  examples.json
    └── MARSlicense.txt  TEAVM-LICENSE.txt
```

`sh teaching/scripts/build-browser.sh` 一次生成整个目录。主页源文件在 `teaching/site/`，由 `teaching/site/build.py` 按 `config.json` 填好后写入 `dist/`。课堂服务器版不受影响：反馈按钮和统计只在浏览器构建里出现。站点只以 MARS Trace 的名义出现，不写个人姓名或账号。

## 设置：`teaching/site/config.json`

| 字段 | 作用 | 留空时 |
|---|---|---|
| `url` | 正式地址，现为 `https://mars.castralhub.com/`；用于 canonical、分享预览图、sitemap，以及只统计这个域名 | 不限定域名 |
| `umami.websiteId` | Umami 站点 ID（公开值，本来就写在页面里） | 不加载统计脚本 |
| `tally.feedback` | 反馈表单 ID（`tally.so/r/<ID>` 里的 ID） | 反馈改为打开 GitHub issue |
| `tally.contact` | 联系表单 ID | 用 `email`，再没有就用 GitHub issue |
| `email` | 公开联系地址，现为 `bsharkdev@gmail.com` | 见上 |

这里只放公开值。任何 API 密钥、密码都不进仓库。

## 需要在服务后台建好的东西

**Umami**（cloud.umami.is 免费版或自托管）：新建网站，域名填正式域名，把 Website ID 填进 `config.json`（已填）。不用 cookie，不需要同意横幅。本地地址（localhost、127.0.0.1）不加载统计，开发和测试不会进入后台；测试需要观察事件时设置 `localStorage["mars-trace:analytics-test"]="1"`，并拦下发出的请求。追踪脚本加载之前发生的事件（例如链接打开的示例）会先排队，脚本就绪后补发。

**Tally 反馈表单**：必填的反馈描述，以及隐藏字段 `diagnostics` 和 `program`。IDE 会先展示版本、浏览器与最近错误摘要；`program` 默认为空，用户勾选时才附带当前程序，最多 8000 个字符。

**Tally 联系表单**：身份（Educator、Student、Tech enthusiast、Engineer、Manager、Researcher、Investor、Other）、联系邮箱和留言。两份已发布表单均已开启项目邮箱通知；表单 ID 和站点 ID 是公开配置，不是密钥。

## 匿名事件

| 事件 | 何时 | 附带 |
|---|---|---|
| `try` | 主页点“开始使用”或“打开 IDE” | `from`（hero / nav） |
| `features` / `contact` / `feedback` | 主页对应按钮 | `from` |
| `language` | 主页切换语言 | `to` |
| `assemble` | 本次打开页面后第一次汇编 | `ok` |
| `step` / `back` / `run` | 本次打开后第一次单步（含源码单步、跨过、跳出）/ 回退 / 完整运行 | — |
| `example` | 打开示例 | `name`、`linked` |
| `feedback-open` / `feedback-continue` | 打开反馈 / 继续填写 | `from`、`program` |
| `contact-sent` / `feedback-sent` | 联系表单 / 反馈表单真正提交成功（Tally 回报） | — |
| `kernel-error` | IDE 自身出错（不是学生程序的错） | — |

所有事件都附带界面语言。“第一次”只记一次，事件量很小，也正好回答“这个访客有没有真的用起来”。

## 链接约定

- 指定示例：`/app/?example=03-fizzbuzz`。首次访问直接打开并汇编；已有自己工程的学生会先被询问。打开后参数会从地址栏去掉。
- 直接打开反馈：`/app/#feedback`。
- 渠道追踪：任何链接加 `utm_source`、`utm_medium`、`utm_campaign`，Umami 自动记录。建议：
  - GPT 广告：`utm_source=chatgpt&utm_medium=ad&utm_campaign=<广告名>`
  - 给老师的邮件：`utm_source=email&utm_medium=outreach&utm_campaign=teachers-<月份>`
  - 社区：`utm_source=zhihu|bilibili|reddit|hn&utm_medium=post`

## 站点部署

当前公开网站 `https://mars.castralhub.com/` 由 Sites 托管，产品主页在 `/`，中文主页在 `/zh-cn/`，IDE 在 `/app/`。源码为本仓库中的 `teaching/`，当前 Sites 的部署源码为独立快照；发布时须同步代码、构建产物和 Sites 版本，避免覆盖线上已有更新。不要把 Sites 凭据、运行时密钥或机器配置提交到仓库。

本地构建可用 `npm ci --prefix teaching` 和 `sh teaching/scripts/build-browser.sh`，生成 `teaching/dist/`，包含 `robots.txt` 和 `sitemap.xml`。也可以将该静态目录部署到其他支持静态文件的托管平台。

## 域名邮箱（Cloudflare Email Routing）

域名托管在 Cloudflare 后：Email → Email Routing → 启用，按提示添加 DNS 记录；Destination addresses 填专用 Gmail 并验证；Routing rules 里添加 `hello@`、`feedback@` 等地址，全部转发到这个 Gmail。用域名地址回信：Gmail 设置 → 账号 → 以其他地址发送邮件，SMTP 填 `smtp.gmail.com`、端口 587，密码用 Google 账号的应用专用密码。

## 验证

```sh
python3 teaching/tests/site_browser.py http://127.0.0.1:8877
```

检查主页语言切换与存储；配置了 Umami 时，还在浏览器里拦下发往 Umami 的请求（不会进入统计后台），确认访问带 UTM、IDE 只计一次访问、使用 / 示例 / 汇编 / 单步 / 回退 / 反馈 / 表单提交等事件都被记录，“第一次”类事件只记一次；、所有资源可访问、手机宽度无横向滚动、无 cookie；示例链接的首次与已有工程两种情况；默认不附带源码；IDE 出错时的报告入口；`#feedback` 直达。IDE 本身的回归见 [浏览器内核版](BROWSER-RUNTIME.md)。
