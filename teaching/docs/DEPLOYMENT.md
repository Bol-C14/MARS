# 部署方式

另有[纯浏览器内核版](BROWSER-RUNTIME.md)：完整 IDE、MARS 执行器和检查器都在学生浏览器运行，可直接静态托管。下文保留个人 Java 服务和教师服务器 JVM 两种入口。

同一套浏览器前端、MARS 调试核心和独立 Checker，提供个人本地版与教师公开版。源码、前端构建、字体、双语示例和生产网关都在本仓库，公开部署可独立完成。

| | 个人本地版 | 教师公开版 |
| --- | --- | --- |
| 入口 | `scripts/local.sh` / `local.ps1` | `scripts/teacher.sh` / Docker Compose |
| 执行位置 | 用户电脑 | 教师服务器 |
| 调试会话 | 每个本地服务一个 | 每个浏览器会话一个独立 JVM |
| 检查器 | 独立 JVM | 全班共用独立 JVM，串行排队 |
| 前端 | Java Server 提供 | Caddy 提供静态页面、字体与 HTTPS |
| 工程 | 当前浏览器保存；ZIP/JSON 导入导出 | 同样保存在学生浏览器 |

## 获取源码

```sh
git clone --branch feature/teaching-ide https://github.com/Bol-C14/MARS.git
cd MARS
```

以下命令在仓库根目录执行。

## 个人：从源码启动

需要 JDK 17 或更新版本。前端已经提交打包结果和字体，正常启动无需 Node、Python 或 Docker。在仓库根目录执行：

```sh
sh teaching/scripts/local.sh
```

打开 http://127.0.0.1:8765 。Ctrl+C 停止。端口可作为参数传入，例如 `sh teaching/scripts/local.sh 8766`。

Windows PowerShell：

```powershell
powershell -File teaching/scripts/local.ps1
# 或自选端口
powershell -File teaching/scripts/local.ps1 -Port 8766
```

源码启动会编译 Java。macOS 原有 `Start-Teaching-IDE.command` 和后台启动脚本继续可用，它们额外需要 Python 3；前台 `local.sh` 只需要 JDK。

同一服务的多个浏览器标签共用执行状态。需要独立实验时启动不同端口；浏览器也按端口分别保存工程。服务监听 loopback，适合个人本机使用。

## 个人：制作可分发 ZIP

维护者在源码目录运行：

```sh
sh teaching/scripts/package-local.sh
```

得到 `teaching/dist/mars-trace-local.zip`。包里有编译后的 JAR、完整前端与字体、示例、启动器和使用说明。学生解压整个包，安装 Java 17+ 后即可启动，无需编译器。

- macOS/Linux：`sh teaching/scripts/local.sh`。
- Windows：双击 `Start.cmd`。
- 打开 http://127.0.0.1:8765 。

发行包中的 `local.sh`、`local.ps1` 会自动使用 JAR。ZIP 本身是普通发布产物，不提交 Git；可以作为 GitHub Release 附件分发。

## 教师：先在本机试运行

需要 Docker Engine + Compose v2（或 Docker Desktop），初始化脚本使用 OpenSSL 生成服务令牌：

```sh
sh teaching/scripts/teacher.sh init
sh teaching/scripts/teacher.sh up
```

打开 http://localhost:8080 。初始化会生成私有的 `teaching/deploy/.env`；重复运行 init 会保留已有配置。首次启动会构建 Java 和容器镜像，之后复用构建缓存。

Compose 也可直接使用：

```sh
docker compose --env-file teaching/deploy/.env -f teaching/deploy/compose.yaml up --build -d
```

脚本可以在任意工作目录调用；直接 Compose 命令以上面的仓库根目录为基准。默认项目名是 `mars-trace`，可用 `COMPOSE_PROJECT_NAME` 同时给 up/status/down 指定另一名字。

## 教师：公开发布

准备一台 Linux 服务器（当前 8 人课堂可从 4 GB 内存配置起步），安装 Docker 与 Compose。将域名的 A/AAAA 记录指向服务器，放行 TCP 80、443，然后在源码目录执行：

```sh
sh teaching/scripts/teacher.sh init mars.example.edu
sh teaching/scripts/teacher.sh up
```

将示例域名换成自己的域名。Caddy 自动申请与续期 HTTPS 证书，学生打开 `https://mars.example.edu` 即可使用。无需 Sites 账户或 OVH 专用功能。

如果先做过本机初始化，编辑 `.env` 中以下四项，再执行 `up`：

```dotenv
MARS_SITE_ADDRESS=mars.example.edu
MARS_HTTP_PORT=80
MARS_HTTPS_PORT=443
MARS_SECURE_COOKIE=1
```

保留已生成的 `MARS_GATEWAY_TOKEN`。该令牌只供 Caddy 与网关通信；不会放进页面。`.env` 已被 Git 和 Docker 构建上下文忽略。

配置项：

| 配置 | 默认值 | 用途 |
| --- | --- | --- |
| `MARS_MAX_SESSIONS` | 8 | 最大同时调试会话数 |
| `MARS_MEMORY_LIMIT` | 2800m | 整个网关与所有 JVM 的容器内存上限 |
| `MARS_IDLE_SECONDS` | 600 | 空闲会话释放时间（秒） |
| `MARS_COMMAND_TIMEOUT` | 20 | 单次调试命令时间上限（秒） |
| `MARS_SITE_ADDRESS` | `http://localhost` | 本地 HTTP 或公开域名 |
| `MARS_HTTP_PORT` / `MARS_HTTPS_PORT` | 8080 / 8443 | 主机端口；公开部署用 80 / 443 |
| `MARS_SECURE_COOKIE` | 初始化时设置 | HTTPS 用 1；本机 HTTP 用 0 |

每个调试 JVM 的最大 Java 堆为 192 MB，检查 JVM 使用同样的预算；进程与堆外内存也计入容器内存。增加并发时需相应增加服务器内存与容器内存上限。容量达到时，新用户会收到席位已满提示，已有会话继续运行。

## 管理、更新和回退

```sh
sh teaching/scripts/teacher.sh status
sh teaching/scripts/teacher.sh logs
# 拉取所用分支的更新后重新构建
git pull --ff-only
sh teaching/scripts/teacher.sh update
# 停止容器；证书卷和浏览器工程保留
sh teaching/scripts/teacher.sh down
```

更新前记下 `git rev-parse HEAD`。要回退，检出之前的提交并重新执行 `update`；保留 `.env`、相同域名与端口，以及 Caddy 证书卷。

更新会重启执行进程，学生需重新汇编。源码、普通文本、生成文件和界面设置保存在学生浏览器；保持相同网站地址和存储键，更新后会恢复。域名、协议或端口改变时，浏览器会视为另一个站点，应先导出工程。服务器上的容器数据卷只保存 Caddy 的配置和证书，不是学生工程数据库。

## 架构与接口

```text
个人：浏览器 → Java Server → DebugSession / MARS
                            └→ Checker 独立进程

教师：浏览器 → Caddy（页面、字体、HTTPS）→ Python 网关
                                          ├→ 学生 A 的 Stdio JVM
                                          ├→ 学生 B 的 Stdio JVM
                                          └→ 共用 Checker JVM
```

- `/api`：调试 JSON 请求，按 `mars_session` Cookie 分配独立 JVM。
- `/api/check`：语法检查，使用独立队列和进程，5 秒超时；检查失败不清除学生调试状态。
- `/examples`：读取双语示例的 `example.json` 和语言目录。
- `/health`：网关健康检查。

MARS 有全局内存和符号表，所以多学生用不同进程隔离，不能用一个 JVM 里的多个 DebugSession 代替。网关透传前端请求字段，包括 `generatedKnown` 和内存窗口长度。

Compose 只公开 Caddy 的端口。执行网关在内部网络、非 root 用户、只读根文件系统与临时目录中运行；Caddy 为请求添加服务令牌。网页请求沿用同源检查。

`Server.java` 是个人入口，默认只监听 127.0.0.1，只有一个调试会话。`Stdio.java` 是生产网关启动的单个学生进程入口，使用 JSON Lines。`Checker.java` 的协议见 [CHECKER-PROTOCOL.md](CHECKER-PROTOCOL.md)。

## 原生 Linux / 现有 Sites 部署

不使用容器时，可用仓库中的 `teaching/hosting/gateway.py`、`deploy/systemd/mars-trace.service` 和 `deploy/Caddyfile.native.example`。安装 Java 17+、Python 3 和 Caddy；从仓库根目录构建 Java，将网关服务配置中的用户、安装目录和 EnvironmentFile 按机器调整。网关默认监听 loopback:8767；服务环境至少提供 32 字符以上的 `MARS_GATEWAY_TOKEN`，Caddy 使用同一令牌。HTTP 调试时设 `MARS_SECURE_COOKIE=0`。

现有学生站仍可使用 Sites Worker 提供前端和代理，再连接原生网关。`teaching/hosting/` 是生产网关的源码归属；以后 Sites 打包应从这里复制网关与示例，避免在专用部署仓库里另改一份。实例地址、令牌和具体服务器配置留在部署环境。

本次整理提供独立部署入口，不改变现有学生网站的运行配置。

## 验证

```sh
sh teaching/scripts/build.sh
python3 teaching/hosting/test_gateway.py
python3 teaching/tests/deployment_smoke.py http://localhost:8080
```

网关测试覆盖 8 个独立学生、并发容量、超时与回收、独立检查器及故障恢复。smoke 检查静态页面与字体、示例、真实汇编与运行、Cookie 会话隔离、语法检查和文件路径。所有请求只针对传入的测试地址。

前端开发仍用 `npm ci --prefix teaching` 和 `npm run build --prefix teaching`；完成后重新打包或构建教师镜像。
