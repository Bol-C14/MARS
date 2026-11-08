# MARS Trace 个人本地版

安装 Java 17 或更新版本，解压整个 ZIP。

macOS/Linux：在解压后的 mars-trace-local 目录运行：

```sh
sh teaching/scripts/local.sh
```

Windows：双击 Start.cmd，或在 PowerShell 中运行：

```powershell
java -Djava.awt.headless=true -cp teaching/mars-trace.jar mars.ide.Server 8765
```

打开 http://127.0.0.1:8765 。macOS 也可以在终端运行 `sh Start.command`。
服务以前台方式运行，Ctrl+C 停止。换端口：`sh teaching/scripts/local.sh 8766`。

该包已包含前端、字体、示例与编译后的 Java 核心；使用时无需 Node、Python、Docker 或 JDK 编译器。所有计算在本机进行，可离线使用。

每个本地服务一个调试会话；需要独立实验时使用不同端口。浏览器按域名及端口分别保存工程；保持相同地址访问即可恢复。关闭服务或更新程序会结束执行历史，源码与文本保存在浏览器中。

“保存”保存浏览器中的工程副本；通过“导出到电脑”下载 ZIP/JSON、或“下载当前文件”取回文件。导入文件夹是读取副本。更新时先导出重要工程，再解压新版本到新目录，使用原来的地址与端口打开即可继续编辑。
