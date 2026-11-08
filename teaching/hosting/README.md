# 生产会话网关

这里是从实际教师站部署整理回主仓库的生产网关，源码归属此目录。

- `gateway.py`：一个浏览器会话一个 Stdio JVM，共用独立 Checker，双语示例接口。
- `test_gateway.py`：使用真实 JVM 验证学生隔离、容量、检查器与故障回收。

教师推荐入口为 `sh teaching/scripts/teacher.sh init` 和 `up`。完整配置、个人发行包与更新说明见 [部署文档](../docs/DEPLOYMENT.md)。

网关独立运行需要 `MARS_GATEWAY_TOKEN`（至少 32 字符）。默认监听 `127.0.0.1:8767`；容器通过 `MARS_BIND=0.0.0.0` 监听内部网络，不把网关端口公开映射到主机。
