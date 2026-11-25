# Antigravity 上下文监控（中文增强版）

基于 [dimitr-io/antigravity-desktop-context](https://github.com/dimitr-io/antigravity-desktop-context) 的轻量 Fork 增强版，使用 Antigravity 2.0 原生 Sidecar 面板机制，**零外联、零改盘、零额外 Token 消耗**。

## 相对上游的新增特性

- **缓存命中率统计**：实时展示本轮 Prompt Cache 命中率与会话累计缓存命中率（直接读取数据库中的真实缓存读取 Token 数）。
- **Token 生成速度与延迟**：实时统计本轮流式输出速度（tok/s）、会话平均生成速度、首字延迟（TTFT）、单轮总耗时，以及思考/回复输出拆分。
- **自动压缩预算提示**：在顶部模型旁展示当前单次请求的自动压缩预算（如 `压缩预算 256.0k`），避免原生 1M 窗口与实际压缩阈值混淆。
- **简体中文界面**：完整汉化侧边栏面板、插件元数据与复制文本摘要。

## 安装方式

需要 Antigravity 2.0 桌面端（或 SSH Remote 远端 Linux 主机）及 Python 3：

```powershell
# Windows (PowerShell)
git clone https://github.com/vvb7456/antigravity-desktop-context.git "$HOME\.gemini\config\plugins\desktop-context"
```

```bash
# macOS / Linux（含 SSH Remote 远端主机）
git clone https://github.com/vvb7456/antigravity-desktop-context.git ~/.gemini/config/plugins/desktop-context
```

安装完成后重启 Antigravity（或重连 SSH 窗口），在 **Customizations → Installed** 中开启 **上下文监控**，即可在右侧辅助栏打开面板。

## 本地测试

```bash
python -m unittest discover tests
```

## 许可协议

遵循上游项目 [MIT](LICENSE) 协议。
