# Tern / OMP Client Bridge

**Beta 预发布版 `v0.5.0-beta.11`** · [下载与版本说明](https://github.com/jiwangyihao/tern-omp-client-bridge/releases/tag/v0.5.0-beta.11) · [安装指南](docs/installation.md)

让远端 OMP 会话使用你手动绑定的客户端设备上的文件与原生工具，同时保留 Tern 的原生 OMP 界面。客户端主动通过 SSH 连接远端主机，只负责工具执行，不运行额外的推理 Agent。

当前为测试版。**已实现功能不等于所有平台均已通过验收**，部署前请阅读下方的验证范围与[兼容性说明](docs/compatibility.md)。

## 在哪台机器安装

| 机器 | 预先准备 | Bridge 安装内容 |
| --- | --- | --- |
| 本机客户端 | 已登录的 Tern 原生 GUI、本机 Tern CLI、原生 SSH | 先安装本仓库的 Tern 插件；初始化后运行客户端后台服务。 |
| 远端 Agent 主机 | 支持 POSIX 的 Linux/macOS 主机，已安装兼容的原生 OMP 与 Tern | 初始化安装 broker、OMP 扩展与 Tern 主机插件，并启动 broker 后台服务。 |

本机须能通过已信任、支持非交互认证的 SSH 别名连接远端主机，无需开放入站 SSH 服务。初始化不会安装 Tern 或 OMP，也不会代替你确认 SSH 主机密钥。

推荐安装路径由 **Set up Bridge** 为两端准备专用 Bun（`>=1.4.3`）和固定版本 OMP SDK（`18.10.4`），无需全局 Bun。发布包保留源码与资源，不包含 `node_modules` 或独立原生可执行文件；依赖按目标平台安装。

## 三步开始

1. **在本机安装原生插件**。从[版本下载页](https://github.com/jiwangyihao/tern-omp-client-bridge/releases/tag/v0.5.0-beta.11)选择 `.tar.gz` 或 `.zip` 附件，按 `SHA256SUMS` 校验并解压，再用本机 Tern 的原生 `tern plugin install` 安装包目录。完整命令见[安装指南](docs/installation.md)。从未初始化的安装不会自动选择主机、创建身份或下载依赖。
2. **首次选择 OMP → Start / repair Bridge**。在原生侧栏核对远端主机并完成 SSH 检查，明确授权首次完整安装。已经初始化的安装会自动维护同一本机客户端；可验证的旧安装自动迁移，不再要求为缺少恢复记录重新执行完整 Setup。恢复不会重装远端组件、生成新身份或改变会话绑定。
3. **新建远端 OMP 会话并显式绑定设备**。新会话加载扩展后，在 Bridge 面板中手动选择供 Agent 使用的客户端。**Awaiting OMP session** 仅表示安装和客户端注册完成，仍需真实会话握手与就绪检查。初始化不会重启现有会话，也不会自动绑定设备。

## 已实现的操作

- **客户端自动恢复与更新**。Tern 加载及窗口运行期间自动恢复已授权客户端，并跟随已安装插件准备新的私有运行包。存在执行上下文或传输时延后切换；新版启动失败时安全恢复原包并退避重试。保留身份与绑定，不重启共享 broker 或 OMP 会话。
- **通用 SSH 识别与修正**。用本机 OpenSSH 解析相关配置别名，最多顺序预检 6 个候选；支持 Windows 系统/Git OpenSSH 路径差异，macOS/Linux 使用相同候选规则。手动修改后只检查指定目标，保留输入和失败原因；成功仍需明确审核安装。
- **设备绑定与状态**。每个 OMP 会话默认未绑定，所有查看者共享目标、切换者与在线状态。切换只影响下一次调用，运行中的操作保留原目标。状态入口打开原生 PiP 面板，关闭面板不会取消已开始的上传。
- **文件与代码执行**。现有 `eval`、`bash` 可使用 `target: "client"`，文件工具通过 `client://` 路由访问已绑定设备。普通远端路径和未指定客户端的调用仍由 Agent 主机执行。浏览器、桌面和 ADB 沿用客户端的原生后端、设备上下文与权限要求。
- **人工传输**。本地用户触发 **Paste to remote** 后读取一次剪贴板文本或图片；**Upload file** 打开本机文件选择器，也提供本地文件拖放路径。传输源始终是发起操作的这台设备，与 Agent 绑定目标无关。这些显式手势无需第二次 Bridge 确认，原生工具与系统权限仍然有效。
- **草稿与附件**。上传的图片交给 OMP 原生附件处理；普通文件进入远端私有临时收件目录，并附归档提醒。草稿不会自动发送，引用文件不会自动删除。处理普通文件前，请先将其复制或归档到项目存储。

原生文本与图片粘贴保持不变。Bridge 不拦截、分类或重放 `Cmd/Ctrl+V`，也不添加 Agent 剪贴板工具或监听器。操作细节与高级维护命令见[使用指南](docs/usage.md)。

## 信任边界

**绑定设备允许该会话按设备自身的 Agent 策略和操作系统权限调用原生工具，不提供沙箱隔离。** 绑定前请阅读[安全与信任边界](docs/security.md)。

- 仅连接可信主机和设备。共享远端账号或 root 权限不构成按人的访问隔离，broker 与客户端控制端点不得公开暴露。
- 原生授权、应用登录、浏览器配置和桌面控制的本地确认仍然有效。设备注册成功不代表已经授权 Agent 使用它。
- 断连不会自动改选其他设备，也不会重放已派发的有副作用操作。结果不明确时，应先检查原目标状态。

## 原生 UI 与交互优化 (beta.3 新增)

当前发布包已包含以下原生 UI 增强功能（需要 Tern 0.9.9 或更高版本）：

- **原生独立悬浮与焦点**：Bridge 面板现在使用 `cx.layout:float(exactPanelPane, savedOwnerPane, 'tr', {size={32,24},focus=false})` 实现完全原生的画中画（PiP）悬浮，不再依赖旧有 CLI 悬浮列表索引（ordinal），并在渲染就绪后原生获得焦点。悬浮增长及后续调整交由 Tern 维护。
- **尺寸单位与限制**：初始尺寸声明（`{32,24}`）作为终端单元格（cell）的参考提示，其实际大小与边界约束由原生框架强制执行。
- **原生安装控件与极简样式**：Setup 和 Bridge 状态界面均转为使用原生表单控件（输入框、选择框、按钮、状态指示器）。Bridge 界面已完全移除 CSS，Setup 界面仅保留用于根节点边距及处理未截断地址溢出换行的极简样式。安装确认与主机选择保持本机操作体验，仅在显式点击确认后进入完整安装流程。
- **设备传输与展示体验**：提供带边界的设备列表滚动视图、可折叠区域以及传输进度展示，并全部保留原生按钮与状态提示。
- **废弃 Socket 参数**：不再通过 CLI 传递、使用或验证 `--tern-pane-socket`。现有自定义 `controlFile` 与身份配置（如 `ternExecutable` 用于 Setup/插件重载）不受影响。升级 Setup 合并时，会安全丢弃旧配置中的 `ternPaneSocket` 字段。

### 当前源码的后续修正（未另发版本）

- 启动入口为 **OMP → Start / repair Bridge**；服务不可达时直接进入恢复流程，不再反复打开错误面板。
- 设备选择改为 Bridge 内嵌 **Agent device** 字段；只有显式点击 **Use device** 才应用更改，不再打开全局选择器。
- 按已认可的连接卡片稿实现身份标记、会话信息、独立操作按钮、完整设备选择框与紧凑传输行；专属样式跟随 Tern 主题。扣除原生 pane 已提供的网格内边距，避免重复留白；初始尺寸提示为 `{31,13}`，仍尊重用户后续调整。
- 已在实际连接的 macOS Tern 窗口检查面板及下拉菜单，并恢复原工作区；未改变设备绑定。详见[验证记录](docs/verification.md)。以上源码已更新到本机及目标远端插件，不改变已发布 beta.3 附件。
- 补齐悬停、按下、选择框展开和 Apply 出现的短过渡；支持系统减少动态效果及 Tern 的静态 surface。PiP 外框与聚焦放大动画仍由 Tern 管理。

## Beta 验证范围
验证记录与实现范围分开维护，不作跨平台通用保证。

- **已有验证记录**。本地原生 Windows 已通过完整测试、类型检查、打包和 CLI 检查，并实测 Tern 设置侧栏中的自动 SSH 识别和手动修正。macOS 普通 daemon 转发、Luau 边界及原生 Linux 解析另有通过记录；这些结果不等同于全部桌面交互验收。当前 CI 见[原生平台工作流](https://github.com/jiwangyihao/tern-omp-client-bridge/actions/workflows/native-runtime.yml)，[beta.1 历史 CI](https://github.com/jiwangyihao/tern-omp-client-bridge/actions/runs/40898284516)保留不变。
- **Windows 修复版**。`v0.5.0-beta.2` 包含 ACL、PowerShell 5.1 原子替换、Tern 命名管道路由、上传发布防覆盖及跨系统换行修复；ConPTY 回归使用原生 Enter 字节，产品仍保留原始输入。通用 SSH 设置支持关联别名、多候选预检与手动修正。原生验证范围见[验证记录](docs/verification.md)，不以 WSL 结果代替 Windows 验收。
- **仍待实际验收**。本机设置、连接和单次会话握手证据不代表全部 GUI 场景通过。连接卡片已在实际 macOS Tern 窗口检查，动效及减少动态效果另经隔离原生渲染器验证；完整 Windows GUI、三台物理客户端共同使用、跨设备桌面控制、完整粘贴与拖放，以及真实 Android 设备操作仍需分别验收。

具体环境、历史结果与未完成项见[兼容性与验证边界](docs/compatibility.md)和[验证记录](docs/verification.md)。Linux 主机或安装检查通过，不代表全部客户端交互能力可用。

## 文档与项目

- [安装指南](docs/installation.md)
- [使用与维护](docs/usage.md)
- [安全与信任边界](docs/security.md)
- [兼容性与验证边界](docs/compatibility.md)
- [验证记录与待验收项](docs/verification.md)
- [领域术语](https://github.com/jiwangyihao/tern-omp-client-bridge/blob/v0.5.0-beta.11/CONTEXT.md)与[架构决策](docs/adr/)
- [接口调研与限制](docs/research/interface-verification.md)
- [Agent 工作约定](https://github.com/jiwangyihao/tern-omp-client-bridge/blob/v0.5.0-beta.11/AGENTS.md)

[源代码](https://github.com/jiwangyihao/tern-omp-client-bridge) · [问题反馈与实现跟踪](https://github.com/jiwangyihao/tern-omp-client-bridge/issues) · [产品规格 Issue #1](https://github.com/jiwangyihao/tern-omp-client-bridge/issues/1)

## 许可证

[Mozilla Public License 2.0](LICENSE)，SPDX 标识符为 `MPL-2.0`。
