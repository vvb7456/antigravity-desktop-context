# Antigravity 上下文监控（中文增强版）

基于 [dimitr-io/antigravity-desktop-context](https://github.com/dimitr-io/antigravity-desktop-context) 的轻量 Fork 增强版，使用 Antigravity 2.0 原生 Sidecar 面板机制，**零外联、零改盘、零额外 Token 消耗**。

## 相对上游的新增特性

- **上游真实模型与分流洞察**：展示服务端实际应答的上游模型 ID（可识别 `-trial`、`-tiered` 等灰度/分流后缀）与内部模型枚举代号；若单次会话命中多个上游通道，自动汇总各通道调用次数、缓存命中率与均速。
- **缓存命中率与断裂提示**：实时展示本轮及会话累计 Prompt Cache 命中率、累计节省 Token 数，并自动标记命中率骤降的缓存断裂轮次。
- **Token 生成速度、延迟与思考占比**：展示本轮流式生成速度（tok/s）、会话均速、首字延迟（TTFT）、单轮总耗时，以及思考 / 回复输出比例条。
- **分段比例条与压缩警戒线**：以紧凑分段比例条取代大面积圆点矩阵，在进度条上精确标出 256K / 512K 自动压缩预算警戒线。
- **账号可用额度与重置倒计时**：复用宿主注入的本地 `language_server` 通道查询当前账号剩余额度与重置时间（默认 5 分钟缓存 + 15 秒防抖手动刷新；不碰 OAuth 密钥、不直连外部接口；企业号或无配额数据时自动静默隐藏）。
- **渐进式折叠交互与简体中文界面**：将账号额度、逐轮调用流水与关联文件收纳为默认折叠区（自动记住展开状态），完整汉化面板、元数据与复制摘要。

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
