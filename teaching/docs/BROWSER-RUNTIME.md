# 浏览器内核版

浏览器版复用完整 MARS Trace IDE，把 Java MARS 经 TeaVM 0.16.0 提前编译为 JavaScript。汇编、执行、回退、断点、监听、专注模式、检查器与文件 I/O 都在学生设备运行。服务器只分发静态页面、字体、示例和内核文件，用户增加时不再按人数增加服务器 JVM。

这是一条独立构建入口。原来的个人本地 Java 服务和教师 Docker Compose 部署继续使用 HTTP 网关；浏览器版不连接它们。

## 构建与启动

构建需要 JDK 17+、Node/npm、Python 3、curl 和 tar。在仓库根目录执行：

```sh
npm ci --prefix teaching
sh teaching/scripts/build-browser.sh
python3 -m http.server 8877 --bind 127.0.0.1 --directory teaching/dist
```

打开 `http://127.0.0.1:8877` 是产品主页，`http://127.0.0.1:8877/app/` 是 IDE（见 [产品主页与反馈](SITE.md)）。构建器优先使用系统 Maven；未安装时下载 Maven 3.9.11 到忽略的 `teaching/build/tools/`。TeaVM 依赖进入 Maven 缓存。以后构建复用缓存。

发布时把 **`teaching/dist/` 的完整内容** 上传到静态托管。根目录的 `index.html` 是产品主页；IDE 在 `app/` 下，`kernel-worker.js` 和 `kernel.js` 与 `app/index.html` 同目录。也能放到域名下的子目录。公网使用 HTTPS；本地 `localhost` / `127.0.0.1` 可直接使用 HTTP。无需运行 Java、Python 网关、数据库或服务密钥。

生成的内核和静态页面不提交主仓库。部署产物包含 MARS MIT 许可、TeaVM Apache 2.0 许可及字体许可。

## 执行结构

```text
完整 IDE / CodeMirror / 浏览器工程存储
                │
          ui/runtime.js
         ┌──────┴──────┐
         │             │
  调试 Worker       检查 Worker（首次检查时加载）
  BrowserKernel      BrowserKernel
  DebugSession       Checker
  MARS 全局状态 A     MARS 全局状态 B
  虚拟源码与 I/O     独立虚拟源码与 I/O
```

两个 Worker 各自加载同一个内核文件，拥有完全独立的 Java 静态字段、内存、符号表和文件系统。全量检查重新汇编时不会清掉暂停的调试程序。原来的实时检查调度、文本版本和过期结果丢弃继续由前端负责。

`BrowserKernel` 使用原 JSON 命令与响应字段。`runtime.js` 在构建时选择 HTTP 或 Worker；普通调试请求串行，暂停消息直接送入 Worker。Java 协程约每 8 毫秒让出一次事件循环，保留 `run()` 的局部调用深度、断点跳过和监听状态。跨过与跳出长循环也能暂停。

## 保留的 MARS 逻辑与平台替换

`browser/prepare.py` 在忽略的构建目录中生成平台适配，原 JVM 源码不改动：

- 汇编器、伪指令表、整数/浮点指令实现、异常处理和延迟分支复用原 MARS。
- Simulator 的真实执行循环在构建时从原文件提取，移除 Swing 更新与后台线程外壳，改为同步调用同一循环。没有第二套 MIPS 解释器。
- 偏好设置改为 Worker 内存；桌面语法配色由现有 CodeMirror 负责。
- 配置与伪指令资源在构建时嵌入，syscall 类改为静态注册。
- 源码写入 TeaVM 的内存文件系统。syscall 一律使用同一 `VirtualIO`，保留工程相对路径、输入队列、可回退输出、生成文件和文件描述符。
- Java 标准库中 TeaVM 缺少的连接字符串、十六进制编码和 SHA-256 使用小型等价实现；生成文件 hash 与 JVM 相同。

syscall 范围与现有 IDE 一致：1–17、34–36。原 IDE 未开放的服务继续显示不支持。

## 工程与部署的关系

工程仍通过现有文件树导入、编辑、保存与 ZIP/JSON 导出。`input.txt`、`output.txt` 和其他文本文件使用同一编辑器。每个标签页拥有自己的执行器；同一来源仍使用原来的浏览器工程保存键。

新站与课堂站的域名不同，所以它们的浏览器存储独立。把工程从旧站转到新站时，在旧站导出 ZIP/JSON，再在新站导入。新版本部署不会清理原站工程。

容量与运行速度由学生设备决定；历史上限仍为 100,000 步，控制台仍为 1 MB。关闭或刷新页面后执行历史重建，工程草稿保留。

## 验证

构建完成并启动静态服务后：

```sh
python3 teaching/tests/browser_core_test.py
python3 teaching/tests/browser_parity.py
python3 teaching/tests/browser_runtime.py http://127.0.0.1:8877/app/
python3 teaching/tests/browser_acceptance.py http://127.0.0.1:8877/app/
python3 teaching/tests/workspace_browser.py http://127.0.0.1:8877/app/
python3 teaching/tests/site_browser.py http://127.0.0.1:8877
```

前两项将生成内核放在 Node 中运行，复用核心场景并与 JVM 逐指令对照；后三项用真实 Chromium 验证界面和 Worker。`browser_runtime.py` 额外验证两个执行器隔离、检查器隔离、首次单行检查、输入文件、生成文件 SHA-256、长循环跨过/跳出的暂停和无 `/api` 请求。

原 JVM 版使用 `npm run build --prefix teaching` 与 `sh teaching/scripts/test.sh` 验证。浏览器构建不会覆盖已提交的 `teaching/web/app.js`。

## 首次发布验收（2026-11-08）

基于 `564da83`，在独立 `feature/browser-runtime` 分支实现。浏览器版通过核心 30 项、界面 225 项、文件管理 63 项、Worker 专项 13 项，以及 3,474 个 JVM/浏览器逐步状态对照。原 JVM 版回归通过：核心 30、检查器 10、前端单元 123、上游逐步快照 1,935、界面 226、文件管理 63、英文界面 28 和 release 回归。

本机 Chromium 156 实测：冷启动一个内核 Worker 约 157 ms；首次启动检查 Worker 约 149 ms；无限子调用中跨过/跳出暂停约 84/86 ms；小程序的热运行约 3 ms。未压缩内核文件 727,429 字节，完整静态发布目录约 2.6 MB。这些时间由 `browser_runtime.py` 测量，随设备与浏览器变化。
