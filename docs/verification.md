# Verification record

## Current approved scope

The user approved a unified Paste to remote entry for clipboard text/images and
explicit file uploads, alongside file drops. Native text/image paste remains
trusted and untouched: bypassing bridge validation is
not a defect, and the bridge does not impose post-handoff native queue/focus or
atomic original-draft rules. Earlier fail-closed-all-images and dedicated-entry
rejection assessments are withdrawn.

Images uploaded through the bridge are handed to OMP's native image-paste
handling. Ordinary files become paths in a private temporary receiving inbox,
with a README, agent-visible archival reminder and user notice. The instruction
is to copy/archive into durable project storage, report the chosen destination,
and work on those copies. The bridge neither selects that destination nor
submits a prompt or automatically deletes referenced assets.

The broader original specification remains open for platform/GUI acceptance;
the limited Windows setup-sidebar check below does not establish three physical
clients, complete remote Windows GUI behavior, or attached-device ADB acceptance.

## v0.5.1：客户端读图在分组读取中显示返回的图片

- 现象：beta.12 之后，远端 Agent `read client:///tmp/signout-dlg.png`（绑定的是另一台客户端）实时显示仍为 `Not found /tmp/signout-dlg.png`。会话进程 2026-11-13 17:05 UTC 已升级到 OMP 18.20.0 并重新加载扩展，扩展指向 beta.12 包；broker 仍是 11 月 8 日启动的 beta.11 包，结果仍带设备上的 `mediaPath`。
- 根因：OMP 把未注册内部 URL 的读取（包括 `client://`）折叠进读取分组，分组读取的图片由助手消息按 `details.mediaPath` 以 `media` 节点显示，不经过工具的 `describeResult`。beta.12 的展示层修复只覆盖工具卡片，从未覆盖这一路径；它的测试与宿主验证也都只走了 `ToolExecutionComponent`。适配层去掉 `mediaPath` 才有效，而 broker 没有切换到新包。
- 复现：在 wawa-dev 实际的 OMP 18.20.0 中加载一次性探针，用会话里的真实结果驱动宿主自己的组件。分组路径（`AssistantMessageComponent.setToolResultImages`）带 `mediaPath` 时生成 `media` 节点 `/tmp/signout-dlg.png`，去掉后生成 `image` 节点，blob 为返回字节的 SHA-256；工具卡片路径在 beta.12 展示代码下本就生成 `image` 节点。两次运行结果一致。
- 修复：OMP 扩展在把客户端结果交给 OMP 之前去掉 `mediaPath`，不再依赖 broker 版本。新增回归用例走真实扩展执行路径（模拟 beta.11 broker 返回带 `mediaPath` 的结果），并用 OMP 自己的分组读取组件渲染：修复前失败，修复后通过。
- 边界：扩展改动在会话重新加载扩展后生效。此前已持久化、仍带 `mediaPath` 的客户端读图，在历史中仍显示 `Not found`，重新读取即可。

## v0.5.0：正式版

- 以 `v0.5.0-beta.13` 的代码发布正式版，只改版本号和文档里的预发布措辞，没有功能改动；发布前平台 CI 通过，发行包在本机用 `tern plugin install` 安装后插件状态为 ready。
- 正式版不扩大验收范围：完整 Windows GUI、三台物理客户端共同使用、跨设备桌面控制、完整粘贴与拖放、真实 Android 设备操作，以及 beta.13 记录的卡片与上传实机项仍待分别验收。

## v0.5.0-beta.13：Tern 0.9.18 widget 与 Bridge 菜单

- 背景：Tern 0.9.18（SDK 2026-11-12）把状态栏改为 widget 栏，并新增 `tern.chrome.widget`（文本/环形等样式、`title` 悬停卡片、单一 `command`）。Bridge 改为提供 **OMP Bridge** widget，默认入口从临时悬浮面板改为原生 Bridge 菜单；悬浮面板保留为插件存储中的可选设置（菜单 Settings 或 **Toggle legacy Bridge panel**）。
- 卡片结构在本机 Tern 0.9.18 用 `tern ctl` 实测：`title` 每行对应一行，`键: 值` 分成两列，卡片元素带 `data-widget`；鼠标可以移进卡片，但卡片内点击不向插件派发事件，只有点击 widget 本身执行 `command`。因此卡片只读，操作留在菜单。实测期间用户未操作电脑，未点击任何操作项。
- 卡片样式由 `tern.css` 按聚焦面板的卡片模型生成，只写入固定词汇和数字。用临时预览包（伪造 42% 上传与 1 个失败）在两个远端 OMP 面板上截图核对状态徽章、设备主值、会话行、传输进度条与页脚；预览包已由正式构建替换。
- Edit widgets 列出 OMP Bridge；放入 widget 栏后，Plugin segments 不再重复显示 Bridge 状态；点击 widget 打开 Bridge 菜单，按 Escape 关闭。
- 设备选择改用本机原生选择器：离线设备不会绑定；选择后重新解析，会话、草稿、绑定版本或所见选项任一变化即不绑定。
- 226 项 shipped Luau 边界回归通过，新增 widget 卡片、Bridge 菜单、设备选择与旧面板开关 4 项。`upload` 不是 Tern 图标名，旧状态段的上传图标一直不显示，现改用 Tern 自带的 `arrow-up`。
- 边界：卡片依赖 Tern 内部类名，改名时退回普通两列文字，功能不受影响；卡片不能放按钮。正式包在切换聚焦后的样式刷新与 `arrow-up` 图标未在实机复核；真实上传进度与设备绑定未在实机执行。

## v0.5.0-beta.12：客户端媒体读取预览

- 现象：`read client:///…/setup-005.png` 在 Tern 中显示 `Not found /home/…/setup-005.png`。适配层把 `meta.source` 转成 `client:///…`，却原样保留设备上的裸 `mediaPath`；支持 `media` 的宿主按该路径在 agent 主机上打开文件，优先于结果中已返回的图片字节。若 agent 主机恰有同名文件，会显示另一份文件。
- 修复两处：适配层不再转发客户端结果的 `mediaPath`；展示层对带 `clientBridge` 归属的结果关闭按路径的媒体预览，使原生 renderer 使用返回的图片字节。后者也覆盖旧版本已持久化、或仍由旧 broker 产生的结果。agent 主机上的读取保持原生媒体查看器。
- 回归：修改前 5 项失败（适配层 1 项；真实 ToolExecutionComponent 的实时/历史 × data-first/fallback 4 项），修改后通过；预览节点的 blob 字节与返回图片逐字节一致。279 项相关单元与集成用例 264 通过、15 项平台跳过。真实 native read 经适配层与展示层：返回 1 个图片块，生成 1 个 `image` 节点、0 个 `media` 节点。
- 实际渲染面：隔离的 Tern 0.9.14 headless 原生渲染器（pi-tui 18.10.4）。同一份带裸路径的客户端结果，原生 hooks 显示 `Not found /home/client/shots/setup-005.png`，修复后的 hooks 显示该 PNG；agent 主机文件仍在带缩放控件的媒体查看器中按路径显示。
- 实际宿主：wawa-dev 上安装的 OMP 18.18.6 以隔离 rpc 进程加载候选展示模块，未建立会话、未发起模型请求。原生 renderer 对客户端结果给出 `media` 节点及裸路径；候选给出 `image` 节点，blob 标识等于返回字节的 SHA-256；agent 主机结果两者一致。
- 边界：预览显示的是模型收到的图片，native read 可能已缩放，不是原始文件。未返回图片块的客户端媒体不再有内联媒体查看器，本版未为其提供跨设备传输。未在用户正在运行的会话中验收：已运行的会话在重新加载扩展前仍使用旧展示代码。

## v0.5.0-beta.11：稳定绑定历史与窗口轮询恢复

- 现场认证端点 connected=true，而真实 Tern 状态栏显示 Waiting for connection；未先重载生产插件。绑定扩展的逐请求 context 尾注入与持久消息重复存在，已改为宿主 before_agent_start 暂存/提交及当前有效历史去重，不改写旧快照。
- 用户明确接受 Bridge 范围：压缩或工具循环中的绑定变化在下一次用户回合准备时补齐模型快照；实时工具路由仍使用当前 broker 状态。不保证自动压缩后的工具循环立即补齐，不修改 provider 的续接/签名/输入转换检查。
- 真实 Tern 0.9.12 隔离窗口复现预约下一轮前的 timer 预算中断。基线暂停恢复后失去驱动；候选使用单一有所有权的可取消 timer 和 budget 事件恢复。另修复可选维护发现阻塞健康端点探测，以及健康回执未清除 absent 状态导致的错误 Setup 展示。
- 222 项 shipped Luau 边界回归通过；8 项绑定历史/真实 ExtensionRunner 生命周期测试通过，共125次断言。原生隔离窗口在中断后经正常渲染/时间推进、不重载插件，恢复 Connected · No session，GET 持续约500ms一轮。
- 原生空闲窗口在预算暂停后自主唤醒尚未得到证明；timer、sleep 和单次 chrome refresh 均不能据此宣称无条件恢复。已证明的是宿主恢复回调交付后插件不再永久丢失轮询；不能绕过宿主暂停或伪造连接健康。
- 真实 AgentSession 离线探针已验证绑定历史、回复重放、最终 wire 前缀及请求配置保持一致；原始续接断言仍被外部 Recode 0.10.12 的 context_changed 拒绝，诊断定位为工具对象内部 runner.settings.valueCache 变化。用户明确要求仅消除本插件造成的阻碍；未修改 provider，也不宣称完整 provider 续接通过。探针保留严格断言与版本/摘要记录，不能将此结果报告为通过。

## v0.5.0-beta.10：Windows worker 控制台与失败上下文

- rina 的隔离取证复现了可见 worker 控制台关闭后产生退出码 129、空 stderr，以及后续调用重复返回缓存错误的链路；生产关闭动作的操作者与精确时间未被直接观测。
- worker 启动使用 windowsHide，避免 Windows 分离客户端为工具执行暴露可关闭的控制台。Windows 原生回归通过分离父进程、可见正对照和 Win32 控制台可见性检查验证行为，不以源码字符串或 spawn 参数断言替代。
- 已失败上下文的新调用在派发前返回 runtime_context_lost；已经派发的调用保留原始失败，不自动重建、重放或静默丢失持久状态。恢复使用所有者生命周期，不能用客户端 online 或维护 ready 推断 worker 健康。
- 本机定向回归已观察到修改前失败、修改后通过（24 次断言），覆盖在途退出、后续写入未派发、Eval reset 不越过失败边界、其他上下文保留状态与显式释放后的全新执行；类型检查通过。平台 CI 与实际安装状态以对应发行记录为准。

## v0.5.0-beta.9：轮询中断恢复

- 旧版实际 Tern 隔离实例已复现 fetch 回调预算中断：记录 hook 暂停与恢复，但后续状态 GET 未继续。生产现场的客户端仍在线，维护记录为 ready；不能将此故障误判为客户端退出。
- 状态 fetch 回调仅存放回执，独立驱动在处理回执前预约下一轮；十秒请求期限、三秒失败退避、连接代际与回执所有权限制迟到结果。面板发布和 chrome 刷新可恢复，用户操作不会自动重放。
- 215 项执行 shipped window.luau 的 SDK 边界用例通过，包括 15 项新增回归；覆盖回调放弃、缺失/重复/迟到回执、心跳恢复、保留真实传输失败和副作用不重放。既有健康维护用例持续提供健康回执，不再通过跳过请求期限制造无关超时。
- 本机生成的 Tern SDK 明确规定到期 timer/process/fetch 回调等待 hook 暂停结束。无界面 serve 实例未可靠交付新版连续窗口 timer，故不声称已在该实例证明暂停后的完整恢复；SDK 契约与合成边界证据不等于原生 GUI 验收。

## 2026-11-02：插件侧 Tern 原生工具展示修复

- 用户明确禁止修改 OMP，并在接口实测后选择仅修复 Tern 语义展示、保持既有纯终端行为。Bridge 只接入宿主公开的 describeCall/describeResult 与语义合并规则，不伪造内置工具来源、不复制 ANSI renderer、不安装 Edit openArgStream。
- 实际宿主探针：本机 OMP 18.14.2-1.1.73、远端编译版 18.15.0 均将静态公开导入绑定到宿主 registry；导入 VERSION 与宿主一致，公开 ask renderer 对象身份一致。远端无磁盘 pi-tui 包仍能正确加载，不能仅凭 import.meta.resolve 判定来源。
- 120 项定向用例、1329 次断言与类型检查通过，覆盖语义展示、旧 Bridge ANSI 行为不变、工具元数据、agent 执行与会话审批隔离。Edit 预览测试只验证已有输入的展示，不声称恢复执行前流式预览生产。
- 在远端实际 OMP 18.15.0 中，七类工具的原生/扩展语义输出在 data-first 与 fallback-card 两种模式下共 14 组一致。将其中 Bash、Edit 结果经 TSP 输入隔离的真实 Tern 原生渲染器，截图确认命令/输出区、结果 diff 和统计呈现一致；不是浏览器仿制。
- 仅更新远端 Bridge 自有扩展 loader 和独立运行包，原 OMP 可执行文件 SHA-256 前后一致；未修改 OMP 源码、安装依赖或全局渲染器，未重启既有会话。新会话或原生扩展重载后生效；没有对用户正在运行的会话强制重载。

## v0.5.0-beta.7：SSH 别名复用与旧客户端迁移

- SSH 地址不再单独决定客户端归属。Setup 在远端安装前核验候选 broker 与现有客户端的认证身份；同一 broker 的别名保留原连接和恢复授权，不把客户端改接到另一 broker。
- 生命周期接口 404 明确分类为旧版迁移，不再当作忙时等待；非托管客户端由原所有者更新。维护状态文件记录最终 ready/waiting/blocked，而不是停留在带失败文案的 installing。
- 显式旧版迁移提供只读预览与绑定进程、授权、端点及候选包的确认值。核验 OS 所有者、启动时间、执行文件和监听进程后只发送一次 SIGTERM；无法验证或目标变化即拒绝，不强杀。旧客户端不能证明执行上下文空闲，必须明确接受上下文中断风险。
- 本机经用户确认后从 beta.4 PID 81994 迁移到 beta.7 候选 PID 52805，认证连接恢复。身份、配置和恢复授权文件摘要一致；共享 broker PID 与实例标识保持一致。实际 `wawa-dev` 别名只读核验通过，保留原 `root@173.231.15.27` 连接。
- 定向验证：200 项 Luau 窗口用例、26 项迁移/就绪用例、9 项 alias 集成用例及类型检查通过。未执行整机重启；Windows 旧进程显式迁移不使用 POSIX 证据冒充支持，须由原进程所有者处理。

## 2026-11-02：关闭面板后的残留告警

- 现场原生状态栏显示 `Needs attention`，但本机认证接口 `connected=true`、操作回执无错误，客户端仍为原 PID 81994。日志同时存在网络中断与原生 timer 超时；历史日志没有保存具体发布错误，不能断言唯一触发事件。
- 在实际 shipped window 模块中复现：面板发布失败后关闭面板，`panelError` 未随面板所有权清除，健康轮询仍持续显示告警。修复将面板退出与其发布错误一起退役；仍存活面板的发布失败继续显示告警。
- 新增显式关闭与 broker 关闭两条回归；修复前出现 `closed panel left a permanent attention status`，修复后 193 项路由用例通过。
- 更新本机插件并重载后，实际原生状态栏为 `Connected · No session`，认证连接正常，客户端 PID 未变。未重启 broker、OMP 会话或整机；未更新公开 beta.4 附件。
- 本轮 computer 检查受当前 OMP 进程中 18.14.0/18.14.2 原生模块版本不一致阻断，改用 Tern 自带只读 accessibility/状态接口验证；该工具问题不作为 Bridge 根因。

## v0.5.0-beta.5：客户端自动恢复、更新与回退

对应 [Issue #3](https://github.com/jiwangyihao/tern-omp-client-bridge/issues/3)。修复已有安装
升级后因缺少恢复记录仍离线、恢复固定旧包、窗口首次健康后不再恢复的问题。
连接授权与执行包分离，已有授权不随自动更新重写；撤销标记阻止旧安装重新授权。

### 原生 Windows 实机

- 环境为 Tern 0.9.9、Bun 1.4.3、固定 OMP SDK 18.10.4，不使用 WSL 代替验收。
- 产品 `maintain-client` 入口从完整旧安装记录自动发现既有 relay、迁移并启动
  同一客户端；没有手工填写恢复授权，没有重新安装远端组件或生成新身份。
- 安装候选并重载 Tern 插件后，由真实窗口自动准备新私有运行包、结束已认证的
  空闲旧实例并启动 beta.5 实例。观察到 PID 和包摘要更新，最终 `connected=true`；
  观察过程未手工执行客户端启动命令，恢复授权文件字节保持不变。
- 随后经认证的空闲停机接口关闭该客户端。没有再次运行启动或 Setup 命令，
  窗口自动恢复了另一个 beta.5 实例，签名连接成功。未强杀进程或中断执行上下文。
- 身份、配置、SSH 映射及历史 Setup 记录的前后摘要相同；共享 broker 的 PID
  和实例标识相同，未重启 Tern、OMP 会话或共享 broker。
- 独立原生窗口的实际截图显示 `Connected · No session`。生产验证窗口没有
  已解析 OMP 视图，因此不声称验证了生产会话绑定切换；绑定保留另有隔离回归。

### 回归证据与边界

- Windows 全量测试：262 通过、18 个平台条件跳过、0 失败；280 个用例、31 个
  文件、2072 次断言。类型检查、源码保留型构建及构建后 CLI help 通过。
- 196 个原生 Luau 窗口边界场景通过，包括旧安装自动迁移、撤销保护、重复离线
  自动恢复、暂时失败重试、健康客户端更新、忙时延后和回退冷却。
- 真实客户端 HTTP/执行器回归确认：认证和实例匹配前不能停机；活跃执行上下文
  与未使用的人工快照阻止更新，释放后才能安全退出，原始文件仍保留。
- 隔离 Linux 原生进程：故意损坏候选分离进程后，旧包自动恢复，后续维护遵守
  冷却期且不重写授权（12 次断言）；另一个实际停止、并发恢复场景验证同一身份、
  broker 与原会话绑定保留（47 次断言）。未使用共享 broker 作为测试夹具。
- 未执行整机重启；本轮不扩展 macOS/Linux GUI 冷启动、完整跨设备桌面、剪贴板
  或真实 Android 设备的验收范围。各发布提交的 CI 回执以发行说明链接为准。

首次候选 `238493a` 的 [CI 41344883090](https://github.com/jiwangyihao/tern-omp-client-bridge/actions/runs/41344883090)
暴露了私有执行包的路径文本比较问题：原生父目录别名经模块加载器规范化后，
合法包会被误判为不在安装目录。Windows 目录 junction 已复现同一拒绝错误。
修复先规范化数据目录，再比较真实执行包位置；仍拒绝包目录链接及被重定向的
安装缓存子树，不改写授权路径或放宽摘要检查。普通目录、父目录别名和缓存逃逸
三个定向回归通过（14 次断言），类型检查通过；最终平台 CI 见发行说明。

## 2026-11-01：Beta.4 本机客户端启动恢复

- 根因：旧版脱离终端的客户端不会跨系统重启存活，插件只读取临时端点；历史 setup `ready` 不能证明服务在线。
- 明确安装后保存私有恢复授权。后续 Tern 加载仅恢复原身份、原主机和已校验运行包；缺失授权要求明确迁移，身份缺失或授权被替换时拒绝启动。分离子进程在启动前再次检查授权、配置、身份与包摘要。
- 已运行 30 项 TypeScript 用例（295 次断言）、191 项窗口路由用例、28 项主机面板用例、33 项 Setup 渲染用例及 TypeScript 类型检查。集成用例实际停止并恢复客户端，验证并发恢复、身份和原 broker 会话绑定保留。
- 真实 macOS Tern 0.9.9：保留已有身份与远端 broker，完成一次明确本机迁移。主动停止本轮启动的客户端后，界面显示 `Start / repair Bridge`，没有在当前插件实例中自行重启。重载插件模拟冷启动后，原生启动路径自动恢复客户端；认证状态为 connected，界面变为 `Connected · No session`。
- 前后身份文件 SHA-256 一致；远端 broker PID 与实例标识一致，未重启 OMP 会话。当前真实窗口是浏览器工作区，没有已解析 OMP 视图，因此真实环境不声称验证了绑定切换；绑定保留由上述独立集成用例覆盖。未执行整机重启，Windows/Linux 原生冷启动 GUI 仍需分别验收。

## 2026-11-01：已认可连接卡片的原生实现与动效

- 用户认可静态连接卡片稿，并要求实际插件一致及补齐悬停等动效。本轮只更新源码及本机、wawa-dev 的插件资源，没有另发版本或替换 beta.3 附件；未重启共享 broker 或 OMP 会话。
- 真实窗口首次验收发现原生网格内边距与插件 16px padding 叠加、底部传输行裁切。现按原生网格 padding/zoom 扣除重复留白，并使用 `{31,13}` 初始尺寸提示。当前 profile 实测聚焦 PiP 约 362×359；把同一份真实标题放进已认可的浏览器稿后为 360×352。外框、字体及单元格量化仍由 Tern 控制，不作跨平台像素尺寸保证。
- 实际内容区为 `[1150,52,334,307]`，传输行为 `[1156,330.40625,322,20]`，完整落在可见区内。实际截图已检查主机身份、两行标题、上传图标、选择框及底部 History。主机名使用真实注册名 `Server`，不是写死静态稿中的 `wawa-dev`。
- 实际窗口只悬停按钮、展开/收起设备字段，没有点击 Paste、Upload 或 Use device；前后绑定一致。每次检查恢复当时的原工作区，检测到外部切换时不覆盖用户选择。
- 隔离 Tern 原生渲染器加载同一份生产 `host.luau` 的 view/event/key 和样式，使用无服务连接的公开 fixture 数据。菜单动画的缩放在 0/70/160ms 分别为 0.98、0.999436、无变换；减少动态效果下从开始即无变换。
- 原生按下选择框时观测 `matrix(0.98,0,0,0.98,0,1)`，减少动态效果下为 `none`。隔离选择变化显示 Apply 且其入口动画被原生时间线记录；没有提交真实绑定。此隔离证据不替代真实剪贴板、上传或权限验收。
- 164 个窗口路由案例及 28 个 host-panel 案例通过。新增的展示标签案例检查 UTF-8/长度边界及不能授予或重定向动作；移除依赖控件子节点顺序的旧断言，保留实际选择、失效与绑定安全检查。

## 2026-11-01：启动恢复与内嵌设备选择的实际窗口验证

本节记录 beta.3 发布后的源码修正，已安装到本机及 wawa-dev 的插件资源；没有另发 Release 或替换已发布附件。

- 经用户授权恢复本机客户端并升级共享 broker 后，Setup 返回 `ready`，包含签名注册、主机插件与实际 OMP view 握手；未重启 OMP 会话或修改设备绑定。
- 本机 Tern 0.9.9、远端 Tern 0.9.8 的实际已连接会话中，设备字段使用原生内嵌 select；展开后全局 picker 仍为 null，三个选项完整可见，离线选项显示为不可用。
- 最终 `{32,13}` 单元格提示产生约 248×239 的初始 PiP、372×359 的聚焦区域；这是当前窗口实测，不是跨平台固定尺寸承诺。
- 已观察最终收起与展开截图：UI 字体、双行目标标题、小号操作按钮、单行空传输区、原生 frame 标题及关闭按钮。控件皮肤由 Tern 提供，仅保留局部字体与几何样式。
- 本轮只展开/收起字段，没有点击 Use device、发送消息或传输文件；前后绑定一致，已恢复原 host 与 Default 工作区。
- 回归证据：164 个 window-routing 案例、27 个 host-panel 案例通过；属于合成 SDK 边界验证，不能替代完整 Windows GUI、多物理客户端或跨设备操作验收。
- 官网和官方设计指南用于视觉参考；实际窗口观察不代表用户已最终认可审美效果。

## 2026-11-01：未发布的 Tern 0.9.9 原生 UI 优化

本次只修改源码；没有发布新版本、安装到用户 profile 或重启现有服务。
已发布的 `v0.5.0-beta.2` 附件与历史验收结论不变。

- PiP 改用精确 pane ID 的 `cx.layout:float`，以 `{32,24}` 单元格提示初始化，
  再通过 `cx.layout:focus` 聚焦；删除外部 CLI、浮窗序号和 daemon socket 路径。
  后续尺寸与焦点放大由 Tern 管理，不持续覆盖用户调整。
- macOS Tern 0.9.9 的隔离 headless 原生渲染器中，实际执行了 float/focus：
  本地及 loopback 远端 pane alias 均保持原 tiled root，焦点落在目标 pane。
  实际尺寸受原生 frame 限制；这些观察不是固定像素尺寸的跨平台保证。
- 使用当前 Setup 渲染源码和合成公开快照，检查了原生下拉菜单、SSH 输入框、
  busy/readonly 状态。选择候选仅改变本地选择；点击 **Use host** 后才产生
  带 owner、panel、revision 的选择链接。检查中的按钮无执行链接。
- Bridge 当前渲染源码在相同隔离原生环境中展示了源设备、目标工作区、原生按钮、
  默认折叠的设备列表和传输区域。没有连接真实 broker、读取剪贴板或安装服务。
  原生按钮点击产生预期面板链接；断连快照中除关闭按钮外，所有动作均禁用且无链接。
- TypeScript 检查通过；135 个窗口路由、17 个宿主面板、33 个 Setup 视图、
  44 个 Setup 协调器场景通过；另有 1670 个 SSH 发现断言、432 个目标协议断言
  及 9 个只读本地 POSIX 探测用例通过。它们是 SDK/协议边界检查，不是完整 GUI 验收。
- 两个配置迁移用例通过：成功升级移除旧 socket 字段，保留自定义控制文件、
  身份和无关设置；失败安装不提前覆盖已有配置。
  另已通过严格 CLI 参数检查，退休的 socket 参数会被拒绝且不会创建身份。
  隔离的首次及重复 Setup 集成验证也通过：执行真实安装代码，复用客户端和 broker，
  保留身份与连接配置，并在两端移除旧 socket 字段；SSH 传输边界由测试替身提供。
- 本次隔离原生验证进程已退出，确认无临时目录引用后移除了验证目录。
  清理前后可用空间均约 53 GiB、系统内存空闲比例均为 65%；不将其他进程的
  资源变化记为本次清理收益。仅保留源码、回归用例、文档与验证记录。

本次未执行完整平台测试矩阵，也未新增原生 Windows GUI、真实远端 OMP 全链路、
剪贴板/文件选择器或多物理设备验收。历史证据不替代这些缺口。

## 2026-10-30：v0.5.0-beta.2 发布前验证

此修复版包含下文的原生 Windows 适配和通用 SSH 设置修复，继续标记为 Beta。
旧版附件、历史 CI 失败和未验收的跨设备 GUI 范围均不改写为成功。

- 独立状态目录中的原生 Windows x64 / Bun 1.4.3 验证正常退出：273 通过、
  19 个平台条件跳过、0 失败；共 30 个文件、292 个用例、1988 个断言。
  TypeScript 类型检查、源码保留型构建和构建后 CLI help 均通过。
- 原生 Luau：1670 个 SSH 发现断言、44 个协调器场景、27 个设置视图场景、
  219 个窗口路由场景、9 个宿主面板场景、432 个目标协议断言通过。
  最后一项在 Windows 只执行 Luau 边界，不把它当成 POSIX shell 实机探测。
- README 与安装指南中的 25 个本地文件链接有效。版本、发行附件名称和安装
  示例统一为 `v0.5.0-beta.2`；固定依赖及最低 Bun 要求未改变。

### 首次 CI 的环境相关断言校正

首次候选 `530af93` 的 [CI 40988893389](https://github.com/jiwangyihao/tern-omp-client-bridge/actions/runs/40988893389)
中，macOS 全部步骤通过；Windows 为 267 通过、19 跳过、6 失败。定位到两类
回归观察边界，而不是通过跳过失败、放宽 DACL 或更换 SDK 来发布：

- 五项失败检查了普通继承子项的 owner。显式保护的目录和凭据文件所有者检查
  已通过；Windows 的 DACL 继承并不继承父目录 owner，新对象使用
  [令牌默认所有者](https://learn.microsoft.com/en-us/dotnet/api/system.security.principal.windowsidentity.owner?view=netframework-4.8.1)，
  提权令牌可能使用 Administrators 组。删除继承子项的错误 owner 假设，继续严格
  检查显式保护路径的当前用户所有权，以及所有 DACL 的 SID、权限和继承属性。
- 一项失败在原生 OMP 已验证候选后，又用普通 Bun import 加载已发布扩展。
  Windows CI 的源码与临时目录跨卷，会使用依赖宿主模块图的入口；裸 import
  不是该入口的合法执行环境。改为通过真实 OMP 宿主验证已发布文件及生命周期
  注册，不复制 SDK、不创建第二个宿主作用域，也不只断言导出是函数。
- 校正后本机类型检查及三个相关套件通过：25 通过、3 个既有平台条件跳过、
  0 失败，共 28 个用例、377 个断言。产品权限策略和运行时实现未因此改变。

本版本 GitHub Actions 与发行附件的验证回执见对应发行说明；不使用 beta.1
的 macOS CI 代替新提交的结果。真实 Tern 设置流程与平台限制保留在下文。

## 2026-10-30：通用 SSH 识别、多候选与手动修正

本轮修改产品代码，不以手工修改本机映射代替修复；已移除上一轮临时添加的
直接地址映射，保留其他已有映射。`setup-ssh.luau` 是逐步执行的有界发现模块，
`setup-controller.luau` 负责预检顺序与生命周期，设置视图负责输入与公开结果。

### 行为与根因

- 通过本机 `ssh -G -v` 找到实际配置文件及有效参数；仅把关联的字面 Host 别名
  加入认证候选，保存映射、配置别名、原生地址按顺序尝试。最多 6 个认证候选，
  配置发现 30 秒、整轮检查 90 秒；不登录无关配置主机，不自动安装。
- 相同目标的更高 revision 曾无条件重置手动输入及选区；现在只有目标真正变化
  或输入得到权威确认才重置。手动失败不回退旧地址，可直接修改并再次检查。
- Windows 新开窗口使用 Git OpenSSH 时，原生日志给出 `/c/Users/...` 和
  `/etc/ssh/...`，原先被文件 API 当成 `C:/c/...`、`C:/etc/...`。现在定位实际
  SSH 程序，使用同工具链 `cygpath.exe` 转换路径；Windows 原生路径及 POSIX
  系统路径不被错误转换。诊断日志的反斜杠和八进制 UTF-8 转义只解码一次。
- 原有手动 `check` 动作语义保留，自动候选使用独立动作；旧控制端的快照没有
  新能力字段时，渲染器仍发送原有手动动作，不破坏共享远端界面的旧客户端。

### 已执行证据

- 原生 Luau：1670 个发现断言、44 个协调器场景、27 个设置视图场景、219 个
  窗口路由场景通过。覆盖多候选失败后成功、手动不回退、过期回调、输入保留、
  Include 跟踪、模式排除和 Windows/MSYS 路径转换。
- 类型检查与构建通过；精确路径的安装套件为 15 通过、3 个平台条件跳过、0 失败。
  曾误用无 `./` 的 Bun 过滤器而额外运行 dist 中的测试；该重复运行没有独立依赖，
  其失败不作为安装验证结果，已用项目规定的精确测试入口复验。
- 真实 Windows Tern 窗口：没有人工地址映射时，从本机配置识别正确别名，显示
  `Local SSH config` 与 `Passed`；系统/Git OpenSSH 的路径差异已实际诊断并修复。
- 独立可见测试窗口实际执行“错误目标失败 → 输入保留 → 正确别名成功”，显示
  `Manual SSH`；输入后立即检查也使用了新目标，没有复用旧的成功结果。
- Linux 原生 OpenSSH 用隔离配置验证 Include（含空格路径）、Match、User、Port
  和 ProxyJump 的有效参数解析；不对合成地址发起认证，临时配置已清除。
- 本机插件与远端共享设置渲染器均已部署，远端原生 catalog 报告 ready。部署前后
  共享 broker 的 PID/instance 和 Windows 客户端 PID 均保持不变；客户端健康检查
  确认仍连接且已有真实会话握手。本轮未重启这些服务或用户 OMP 会话。
  自建验证窗口、临时发布脚本及截图已清理，SSH 配置与密钥未修改。

macOS 分支采用同一 POSIX/OpenSSH 规则并有路径边界覆盖，本轮未执行 macOS
桌面实机测试。配置匹配不是 Tern/SSH 同机身份认证；模糊或无法枚举的配置保留
人工确认与手动入口。没有把任何用户主机名、IP 或密钥路径写进产品源码。

## 2026-10-30：原生 Windows 适配与本机安装

环境：Windows x64 10.0.26340、Tern 0.9.7（`c2f7563`）、独立 Bun 1.4.3、
锁定 OMP SDK 18.10.4。未替换全局 Bun、用户 SSH 配置或密钥；未重启现有
Tern 或 OMP 会话。安装器先保留健康的共享 broker，随后经用户单独授权，
核验归属后仅升级该 broker。以下证据不改变已发布附件或历史 CI 结果。

### 修复与真实行为证据

- Windows PowerShell 5.1 继承 PowerShell 7 模块路径时，Security 自动加载失败。
  私有 ACL 改用直接 .NET API；实测所有者、禁止继承、仅当前 SID FullControl、
  Unicode/空格/元字符路径及权限拒绝后不落盘。引导只调整自身模块路径。
- PowerShell 将传给 `File.Replace` 的 `$null` 绑定为空字符串；改用
  `NullString.Value` 保持原子替换。子进程 stderr 不再将成功或具体后端失败
  误写成笼统的运行时失败；回归覆盖退出码 0 与 23、进度保留与诊断不外泄。
- Tern 的真实 Windows 端点是 `\\.\pipe\tern-<USERNAME>`。安装器和窗口侧均
  接受本机命名管道，但不将它视为可执行文件。清除端点环境变量后，自动发现
  `.exe` 和管道仍能通过实际 daemon 执行 `ctl state`。
- ConPTY cooked stdin 使用 CR 提交行，原测试的 LF 只回显。产品保留原始字节，
  回归改为真实 Enter，并保留同名服务的上下文隔离、退出回调和处置行为。
  任意 CMD 内嵌引号仍受锁定 SDK 的 argv 转义限制，未以脚本包装掩盖该限制。
- Bun 1.4.3 的 Windows `rename(directory, existingFile)` 会覆盖原文件。
  Windows 上传发布改用原子、拒绝覆盖的 `Directory.Move`；实测碰撞保留原字节，
  正常上传及暂存/发布 ACL 另有原生断言。
- Windows Git 的 CRLF 导致传到 Linux 的 `.sh` 在 `set -eu` 处失败；
  `.gitattributes` 固定 POSIX 脚本、清单及归属标记为 LF，现有相关文件已规范化。
  修复后的真实脚本开头已通过目标主机 shell 执行。
- SSH 主机显示名称、Tern 地址和 OpenSSH `Host` 别名分别处理。按用户明确选择
  保存目标到别名的映射后，插件原样预检参数通过公钥认证并返回
  `TERN_OMP_SSH_PREFLIGHT_V1\tLinux\tx86_64`；错误提示指向 **Edit SSH**，
  不再将使用直接 IP 丢失别名配置误导为需要重新配置免密登录。

### 已执行验证

- 完整原生 Windows 套件：273 通过、19 个平台条件跳过、0 失败，覆盖 30 个文件、
  292 个用例；TypeScript 类型检查通过。源码保留型 `dist` 构建及其 CLI help 运行通过。
- 权限、引导、路由、上传发布的聚焦原生回归：43 通过、5 个非当前平台跳过、0 失败。
- Luau：219 个窗口行为场景、9 个 host-panel 场景、37 个设置协调器场景、
  22 个设置视图场景、432 个目标选择/协议断言通过。它们是 SDK 边界测试，
  不冒充系统剪贴板、桌面或完整远端 GUI 验收。
- 本机插件目录安装成功，原生 catalog 报告 `omp-client-bridge: ready`、无问题；
  两个既有插件仍为 ready，首次安装后 Tern `settings.json` 的 SHA-256 未变。
  实际窗口截图确认 **OMP → Set up Bridge** 入口及设置侧栏显示。
- 使用已配置的 SSH 别名重试真实初始化成功：本机新客户端签名注册并连接，
  远端插件 ready；安装器没有自动停止旧 broker。用户授权升级后，重新核对
  managed record、认证端点及 `/proc` 命令行，只向匹配的旧 broker 发送 SIGTERM，
  从已安装的新包启动替代服务。健康检查通过，Windows/macOS 客户端均重新在线。
  broker API 不暴露全局活动调用数，未将本机空闲误报为全部客户端空闲。

### 当前部署边界

共享 broker 升级后的实际回执为 `status=awaiting_session`、`stage=awaiting-session`。
客户端和 broker 均为 `connected=true`、`upgradeRequired=false`，远端插件为
`reloaded`。服务升级阻塞已消除；仍需新的原生 OMP 会话完成握手，并由用户
手动绑定设备。安装和注册成功不等于已经授权该会话使用客户端。
三台物理客户端、跨设备桌面/浏览器、真实剪贴板/拖放和 Android 设备仍未验收。

## October 29: v0.5.0-beta.1 prerelease checks

[GitHub Actions run 40898284516](https://github.com/jiwangyihao/tern-omp-client-bridge/actions/runs/40898284516)
executed the product code at `fcfad878ad826ac819d4c45445a6648a35d8cc64`.
The macOS job passed dependency installation, typecheck, the complete TypeScript
suite, package build and built CLI help. Windows dependency installation and
typecheck passed, but its suite reported 158 passes, 17 skips and 105 failures.
The log includes failure to load the PowerShell Security module for `Set-Acl`
and a native PTY timeout. Windows is a known failing beta target, not an accepted
platform. No permission check was bypassed or failed test skipped to publish.

All five local Luau boundary runners passed: 212 window cases, nine host-panel
cases, 37 setup-controller scenarios, 432 setup-target assertions with nine
read-only POSIX probe cases, and 22 setup-view cases. They are not GUI acceptance.
The source-only tar/zip archives have byte-identical payloads and SHA-256 checks;
the extracted package installs through native `tern plugin install` into an
isolated profile and lists ready with no catalog problems. That check started
no daemon or Bridge service. README/installation-guide local links were checked.

## October 29: native daemon routing from the GUI

After absolute executable launch was repaired, the native command still failed:
the GUI did not provide `TERN_PANE_SOCKET`. A window key alone left `tern ctl`
using the separate `/tmp/tern.sock` developer endpoint. Providing the existing
local session daemon socket made the same read-only `ctl state` request succeed.
Earlier explicit-`--control` smoke checks bypassed this routing branch and did
not establish GUI daemon forwarding. A headless loopback verifier also lacks
the ordinary external session-daemon socket, so it was stopped rather than
reported as equivalent evidence.

Install/setup now persist machine-local `ternPaneSocket`; native window children
receive it together with the captured window key. Saved routes survive daemon
downtime. Isolated file installation without an explicit/saved route remains
unrouted rather than adopting another daemon. Client overrides are not sent to
the remote host. Failed receipts record bounded exit codes and boolean timeout,
JSON/native-success and resize-phase evidence, never raw stdout/stderr.

Verification: TypeScript and 212 shipped-Luau boundary cases passed; 37 local
resolver/setup unit cases passed with three native-platform skips, and 29 native
Linux resolver cases passed with two platform skips. Two source installer cases
and the real isolated setup case passed. The setup case preserves identity and
proves the client's
socket is not copied into the agent host's config. Native macOS `ctl state`
through the ordinary daemon succeeded under GUI-equivalent PATH with no control
port, and a nonexistent window key was rejected rather than routed elsewhere.
Linux runtime-directory precedence was verified with read-only native CLI
probes. Native Windows socket/GUI acceptance remains unverified.

The plugin-only deployment preserved the signed identity, connection metadata and
existing managed client PID 96100. Main-window logs recorded the new plugin load
at 21:13:24.528 +08:00. Desktop control approval returned `unanswered`; no live
panel was clicked and no CLI was used to bypass that boundary. Actual main-window
PiP opening, geometry and focus remain pending foreground authorization.
Owned local and Linux verification directories were removed, the headless verifier
exited, and desktop control was released. No new persistent service was retained.

## October 29: portable absolute native CLI launch

The main macOS GUI process had only `/usr/bin:/bin:/usr/sbin:/sbin` in PATH.
Its panel opened successfully, but the bare `tern` child launch failed with
ENOENT. The terminal-launched headless checks had not reproduced that environment.

Installation and consented setup now save this machine's absolute
`ternExecutable`. The window validates its native path form, pins it into the
owned operation and passes it directly as argv[1], with the existing window key
and quoted ordinal unchanged. Missing CLI metadata blocks new PiP creation, not
independent transfers. Client and agent-host paths are resolved separately;
an explicit client override is not forwarded over SSH. No global PATH or runtime
configuration is changed.

Verification: macOS resolver/setup-unit tests passed (35 cases), as did 168
shipped-window Luau cases and typechecking. Two targeted installer regressions
passed, including launching a saved space/Unicode/apostrophe-containing native
executable with an empty PATH and preserving config after an invalid override.
The real, isolated setup regression passed with different client and host paths,
retaining the selected client path, connection metadata and device identity on
repeat setup. That fixture uses the project-pinned native OMP dependency; a prior
attempt using the independently upgraded global OMP hit its Bun >=1.4.4 minimum.
This task did not change global OMP/Bun or bypass production loader verification.

On the native Linux host, 27 resolver cases passed, including rejecting a parent
editor's unrelated APPIMAGE. The actual Tern 0.9.6 CLI was discovered and launched
with PATH restricted to `/usr/bin:/bin`. On macOS, a real Tern 0.9.7 headless plugin
loaded installer-produced config and the shipped command-launch helper under
the exact GUI PATH above. Its saved executable path contained spaces, an apostrophe
and Unicode. Both native resize and focus commands exited 0 and produced 240×360
glance / 360×540 focus settings. Only control-endpoint routing was scoped to the
isolated fixture; executable lookup was not replaced.

Windows drive, UNC, extended-path and `.exe` lexical/consumer cases passed on the
available runners. Native Windows discovery/process/GUI cases remain unexecuted;
macOS/Linux results are not a Windows platform-acceptance claim.

## October 29: background tabs and portrait glance/focus

The user accepted the small current-tab ordinal check/dispatch race. The panel
now opens in a background temporary tab and floats over its exact saved owner
without showing the temporary tab. A window-key-scoped native CLI resize sets
glance size to 240×360 and focused size to 360×540; a separately checked command
then focuses that panel. The quoted ordinal is recomputed before each command.
There is no ongoing resize, focus traversal or split-divider sizing sequence.

Verification: 136 behavior-focused shipped-Luau routing cases and TypeScript
`tsc --noEmit` passed. Cases cover delayed/failed process receipts, cancellation,
replacement owners, background creation, an unrelated existing PiP, changed
ordinals and preserving user sizes. A read-only CLI call with a nonexistent
`TERN_WINDOW_KEY` returned `no Tern window on this machine shows this pane`,
rather than returning another window's state. `ctl --window` is not supported;
the implementation uses the native context's explicit environment key instead.

A Tern 0.9.7 headless remote-loopback smoke loaded the shipped initialization
functions into a real window/host plugin. OMP destination metadata was synthetic
and timer steps were advanced through fresh native callbacks; layout, surfaces,
child processes and PiP commands were real. The fixture explicitly scoped child
control commands to its own endpoint. It verified background focus/root retention,
selection of ordinal 2 while ordinal 1's sizes stayed unchanged, portrait native
rectangles in both modes, and manual focus size 410×610 surviving focus changes.
Only the initial resize/focus pair was issued. An unobscured native offscreen
screenshot also showed the unfocused panel in portrait orientation.

These results supersede the glance-size blocker at the earlier checkpoint below.
The implementation does not claim an atomic or exact-ID size operation; a change
between checking and dispatch remains the user-accepted risk. Main-window visual
interaction, clipboard and physical multi-device acceptance were not exercised
by this isolated smoke.

## October 29: cross-tab PiP creation

The panel is now created in a temporary tab and floated by its exact window-API
pane ID over the captured OMP owner. The original tab is never transiently split
or reconstructed. Native placement failure or pre-float cancellation requests
only the owned panel's broker-driven self-close. An unresolved broker view cache
does not imply a closed target: initialization validates the actual original
OMP surface's destination marker, host attachment and tab instead.

Verification: 107 shipped-Luau routing cases passed, including nonuniform nested
trees, temporary-tab removal, false/throw placement failures, context changes,
owner replacement and preserving user sizing across polling and paste. TypeScript
`tsc --noEmit` passed. A separate Tern 0.9.7 (`c2f7563`) headless process loaded a
real window/host plugin and exercised new-tab creation, exact-owner floating and
closure on both its local host and an in-process remote loopback host. Three-pane
roots with ratios 0.5 and 0.550000011920929 remained unchanged; floating removed
the empty temporary tab and closure removed only the probe panel. Exact-pane
surface lookup also read an unfocused plugin surface on the remote replica.

This is native headless layout evidence, not main-window visual acceptance.
At this earlier checkpoint, glance-mode portrait initialization was unresolved.
Native `pip resize` set glance and focus dimensions differently, but its target
selector was an active-tab ordinal; `layout.resize` returned false for a floating
pane. No exact-pane glance-size setter was found. Ordinal dispatch had not yet
been accepted; the subsequent background/portrait implementation above resolves
that blocker under the user's explicitly accepted race. Desktop authorization was
not required for these isolated checks, and no live clipboard or user agent was
operated.

## Main-window panel failures reported October 26

The user reported that neither the remote OMP widget nor the main Tern plugin
entry opens its panel, while a local-session click produces Needs attention.
Read-only inspection found the installed 0.5.0 plugin ready and the Client
connected, but no retained panel. Those checks do not establish click delivery
or main-window usability; the earlier isolated-window pass does not cover this.

The local unsupported-context path incorrectly called the global error reporter.
The source now gives informational context feedback without setting or clearing
actual connection/panel errors. The new regression fails against the installed
window module and passes against the changed source: 73 shipped-Luau behavior
cases passed. This source fix is not yet installed or native-UI verified.

The remote no-panel cause remains unresolved. Current focus versus clicked pane,
native link dispatch and current-host block creation remain hypotheses, not
confirmed causes. The user chose read-only main-window inspection and will perform
clicks. No working-session input, host switching, restart or plugin reload was
performed for this investigation. Further native verification requires the
user-triggered failure feedback; do not claim both reported defects fixed.

### Invisible locator and bounded panel diagnostics

The subsequent source change removes the visible Client bridge label and click
action while preserving hidden native destination metadata for Tern discovery.
Panel diagnostics now cover entry, target selection, HTTP response and native
block creation, with bounded redacted fields and failure-isolated logging.
Startup logging does not add a timer or alter initial polling order.

Typecheck passed. The native-editor integration suite passed 20 cases with 203
assertions, including destination discovery and preservation of the unsent draft.
The shipped Luau routing harness passed 75 cases, including diagnostic rate
limiting, logger failure and unsupported-context behavior. These are synthetic
SDK-boundary checks, not a real Tern visual acceptance or proof that hidden nodes
remain discoverable through the actual Tern surface exporter.

The user subsequently authorized deployment and supported plugin reload, without
working-session input or restarting Tern/OMP. Release
`d829e1d405d634868d70f7f5ec771af13e5011be1b8706cbc657231f21fd7b9e`
was installed on both ends. Local and remote Tern reload reported ready. The
actual main-window native log emitted `[omp-client-bridge:panel]` with event
`loaded`; a fresh screenshot/AX observation showed `Connected · No session`
on the user's current browser pane. No tab switching or working-session input
was performed. This proves native logging loads, not remote panel opening.

Setup retained the old remote broker (PID 2151375, digest `115d6268…`) and reported
`awaiting-service-upgrade`, with no active OMP view handshake. The local managed
Client started on the new release (PID 71540). Existing OMP processes were not
reloaded or restarted, so their already-loaded visible widget may remain until
the user loads the updated extension. Real hidden-locator discovery and panel
opening remain unverified. Old immutable releases are retained because live
processes may still import them; existing dependencies were reused.

### October 28 private panel URL timeout repair

The main Tern window reproduced `route.link exceeded 50 ms`, followed by an
`open_url` failure for the private panel paste URL, despite opening the chooser.
The route now returns handled before surface inspection, HTTP or chooser work;
deferred execution revalidates the captured panel URL and pane with fresh context.
The source routing harness passed 82 cases, including seven deferred-action
ordering and stale-target regressions. The updated local window plugin was
installed with install-tern and reloaded without restarting OMP or Bridge services.

In the dedicated remote `Bridge-Paste-Verify-20261028` session, native OMP 18.13.1
was discovered without a visible Client bridge widget. Bridge opened successfully;
Paste to remote opened its native chooser twice, with cancellation between attempts,
without the macOS URL-handler dialog or a new route timeout in the observed log.
No clipboard payload was read or transferred and no model prompt was submitted.

The approved outermost 75/25 sidebar remains blocked by the installed host API:
TabTree is readable but has no live-root setter; TabSpec starts new panes, and
arrange cannot preserve arbitrary nested ratios. Official layout documentation
and the generated installed SDK were checked. No host source checkout was found.
No replacement processes, approximate width or flattened layout were substituted.

### PiP placement investigation (October 28)

The user superseded the tiled sidebar proposal with target-owned top-right PiP.
In the isolated remote Bridge-PiP-Verify-20261028 session, numeric lookup of both
the returned panel ID and original target ID returned nil while the focused
surface remained valid. layout:float refused with a needs-another-tiled-block
error, including after waiting for pane creation. A separate native-action
experiment used the verified `pip` and `pip_corner:top_right` actions against
the panel's own verified surface. It exceeded the native 50ms budget both from
pane_created and from a deferred await callback. Neither attempt established
a usable PiP; synthetic passing checks were not counted as native acceptance.

Failed PiP code, temporary diagnostics and its synthetic fixtures were removed.
The working deferred-private-route implementation was reinstalled; all 82
routing cases passed. The desktop locked before the separate native-command
geometry experiment, so default expansion, clickability and aspect ratio remain
unverified. The idle owned test session was closed after checking exact name,
host and running command; no existing agent was restarted or given input.

Subsequent native-command testing in Bridge-PiP-Native-20261028 succeeded:
with only the owned Bridge focused, `tern ctl pip float tr` created a PiP
whose AX label was `Bridge, top right, over omp`. The native state initially
reported glance mode at 480x280 logical pixels. `pip focus "#1"` followed by
`pip resize "#1" 340 560` produced focus mode at 340x560, corner tr. The
expanded PiP's Paste to remote button opened the real chooser successfully;
no clipboard contents were read. The OMP tiled pane regained its full width.
These observations establish native PiP usability, not automatic plugin setup.
An earlier callback timeout does not prove that a native side effect never ran.

For asynchronous plugin integration, a bounded process probe found no inherited
TERN_WINDOW_KEY or TERN_WINDOW_SOCKET. The window-title metadata exposed only
tab, cwd, tabs, space and pane, not a control endpoint. An unscoped CLI process
could operate another window or a newly focused pane, so it was not shipped as
an automatic fallback. Temporary probes were removed; the existing working
Bridge implementation remains installed pending a verified scoped dispatch path.

#### Viewer-local automatic PiP candidate

Single-action native probes subsequently demonstrated that returning `cx:action`
at the callback tail avoids the previously observed chained-action timeout in
those probes. Local `next_pane` focused the owned PiP; the top-right corner action
worked after focus. Starting at 720x420 logical pixels, right reduced width by
32 and down increased height by 32. These are individual-action observations,
not acceptance of the complete automatic sequence.

The source candidate now uses fresh deferred callbacks, one native action per
callback, bounded focus traversal, and owned-surface validation before geometry
changes. It requests 12 right and four down steps (336x548 from the observed
default), then stops geometry writes. Session/host changes, missing original
panes, lost panel focus during sizing, and the deadline stop initialization.
No remote daemon focus command or numeric pane mutation API is used. Rounded
pane IDs are not used to identify visited panes; exact panel ownership still
uses the existing surface marker and broker destination.

All 93 synthetic routing cases passed, including cancellation and preserved
destination behavior. Whole-sequence native acceptance was initially blocked: the
Mac locked and renewed desktop-control approval returned `unanswered`. Native logs
also contain timer-budget failures at 18:24:42 and 18:26:02; their cause has not
been attributed to the new PiP sequence. No visual success is inferred from
locked-screen captures or synthetic results.

The first candidate was briefly installed, then its automatic PiP helper and
trigger were removed from the installed window plugin while verification was
blocked. Source and regressions were retained; the temporary control-target
probe file was removed. No GUI reload or session close was attempted without
renewed control during that blocked phase.

#### Unlocked native acceptance and deployment

After renewed interactive desktop approval, the candidate was installed and
reloaded without restarting OMP or Bridge services. In the existing remote
Bridge-Daemon-PiP-20261028 test session, the real status entry automatically
produced `Bridge, top right, over omp`, focus mode, at 336x548 logical pixels.
Native logs recorded `panel.pip.ready`; the OMP tiled area regained its full
width. Paste to remote opened the actual source chooser and cancellation worked;
no clipboard payload was read or transferred.

One early close/reopen observation timed out: the authoritative remote layout
still held the panel while the local viewer did not show it. No deterministic
cause was established. Temporary phase diagnostics were removed before final
acceptance. With the probe-free implementation, both the panel's Hide Bridge
path and the owner status-toggle path closed and reopened successfully at
336x548 in focus mode. Closing restored the OMP to 162x49 cells. Leaving focus
uses native glance/visibility behavior rather than forcing the PiP to stay
expanded. These observations are not a multi-viewer isolation stress test and
do not establish that all intermittent native visibility issues are eliminated.

The probe-free implementation remains installed and loaded. README and usage
documentation now describe one-time PiP initialization rather than the old tiled
sidebar. No remote daemon focus command or input into another agent was used.
When the user switched to another working session, cleanup did not switch that
viewer back. The exact owned test pane was closed through the authoritative
daemon; subsequent inspection showed an empty retained pane with title/program
empty and live=false. Tern retained the test session and empty placeholder, but
the owned OMP process and Bridge panel were no longer live. No new resident
process was created in this continuation.








## Binding-authorized native tools (0.5.0)

The user approved removing the plugin-specific capability-grant system. Manual
binding authorizes native tools for that session, subject to client-local native
Agent policy and OS permissions. There is no `--allow` option or capability list.
Protocol 2 rejects mixed old/new peers; legacy identity migration retains the
device ID and keys while dropping the obsolete grant field.

The executor reads native global, project and explicit client configuration
without modifying those files. Runtime isolation preserves that effective policy
for both session-aware tools and native SDK singleton consumers. Provider-facing
safety and local native confirmations remain in force; the plugin adds no new
grant prompt or forced allow/deny map.

A standalone smoke launched the shipped broker CLI and real Client service with
native tools. Unbound execution was rejected; manual binding enabled a real Bash
call returning `Darwin` and `binding-native-ok`; a second invocation retained its
shell variable. A client-local native write denial prevented file creation, and
unbinding rejected new execution. The first smoke harness used an invalid bare
client path, then expected a denial result instead of the actual thrown native
error; neither attempt is counted as a pass. The corrected scenario passed and
its temporary script/processes/state were removed.

Typecheck passed. The scoped source suite passed 211 tests, skipped one
platform-specific case, and failed zero (1,682 assertions across 27 files).
Shipped Luau behavior checks passed 67 routing cases and 22 setup-renderer cases.
The initial broad test filters accidentally included distribution copies; scripts
now use explicit relative test paths. A new binding fixture also exposed concurrent
Broker/Client shutdown racing context disposal; orderly fixture teardown passed.
These are not native Windows or physical Android evidence. Earlier grant-related
sections below describe historical releases, not the authorization contract of 0.5.0.

The approved production cutover installed 0.5.0 on both ends, release digest
`115d6268389dbc92d1829acd9a66b3e8ac08585f871aac0b41474c48b5be40ad`.
Both managed services reported `upgradeRequired: false`; setup reported ready.
Before/after comparison confirmed identical device ID, public key and private key,
with no remaining capability field. Local and remote plugins reported ready.

In the existing acceptance window 892, the real device picker displayed binding
authorization under native safety rules instead of capability categories. An old
OMP process retained capability-schema errors after `/reload`; only that owned
acceptance process was reopened with its saved history. Working conversations
were not restarted. Existing old processes may need the same user-timed reopen;
do not treat a plugin reload alone as proof that their imported code changed.

The upgraded remote Agent then used native Write and Read on
`client:///tmp/bridge-binding-v2-892.txt`, returning the exact `BINDING_V2_OK`
content, native client Bash returned `Darwin`, and client JS Eval returned
`darwin`. Raw tool receipts recorded `isError: false`, the same Mac identity and
binding revision 1 without a capability field. The Agent removed only the
synthetic file; local inspection confirmed it no longer existed. No extra grants,
policy changes or SSH execution substitutions were used for these operations.



## Agent-host availability across conversation transitions

The extension previously checked its captured conversation policy before routing
every tool, including native agent-host calls. The installed SDK also emits
`session_branch` after changing conversation identity; the extension handled only
start/switch. A real SDK session reproduced the same missing-scoped-Settings error
on an ordinary server-file read after the manager changed identity.

The fix delegates agent-host routes before checking Client policy, retains native
approval against the runner-owned Settings object, and refreshes Bridge identity
on `session_branch`. No global or same-directory sibling Settings lookup is added.
Client routes still fail closed while their conversation policy is unavailable.

`omp-agent-local.test.ts` exercises real native Read, Write, Bash and Eval through
the live registered overrides, without a Client service or broker. It covers the
conversation-transition interval, default and explicit agent execution, shared
native Eval state, preserved Bash pattern denial, and branch-policy refresh.
Type checking and 42 tests across seven relevant files passed (357 assertions).
A separate standalone SDK smoke executed server-file reads, Bash and Eval without
a Client/broker, verified native denial and Client-route rejection, then verified
server-file access after `session_branch`; every reported check passed. The
throwaway smoke script and temporary files were removed. This is source/runtime
verification, not proof that an already-running remote conversation reloaded it.

### Installed 0.3.1 hotfix and production reconnection

The compatible 0.3.1 release is installed on the Mac and a POSIX agent host; both
managed services use package digest
`53061e8f177f7a16cc701f00ab7f56d41a2a30100ed142bd88e84b544c04518c`.
This is the agent-host availability hotfix, not deployment of the pending
0.4.0 native-destination implementation. The source release suite reported
186 passes, one Windows-only skip and zero failures before deployment.

The authorized reported conversation was resumed with its history. OMP later
reported that the original session file had another writer and saved subsequent
work to `2026-10-22T17-18-56-968Z_01a1649f-7fc8-7069-a1a8-6242faedf727.jsonl`
rather than mixing entries into that file. Read-only inspection found successful
Read, Write, Bash and Eval results and no missing-scoped-Settings error results
in that file. Other OMP conversations were not restarted by this recovery.

Production Client readiness initially remained false despite broker registration.
A no-capability synthetic identity registered successfully; the saved production
identity instead received `DUPLICATE_CLIENT`. Remote relay PID 1435788, retained
from the earlier connection, still held a broker socket after its local owner
was gone. After verifying its exact release path and relay command, only that
relay was terminated. The existing managed Client reconnected automatically;
three authenticated observations four seconds apart reported `connected: true`.
Identity and capability grants were preserved, and the broker was not restarted.
This repairs the observed stale ownership, not proof of automatic recovery from
every half-open SSH connection.

There were zero resolved views and zero transfers in those observations:
transport recovery does not establish a production native-view handshake.
Sidebar heartbeat, multiple windows, stale-draft delivery, unified clipboard
entry and physical drag acceptance remain separate gates, not hotfix passes.

### Bounded transport recovery and native receipt cancellation fixes

The pending 0.4.0 source now probes end-to-end Client liveness, rather than
treating a surviving relay WebSocket as proof of a live Client. Actual broker,
relay and Client reproductions retained `DUPLICATE_CLIENT` before the fix and
reconnected the same identity automatically after the fix; the orphan relay
settled and grants were unchanged. Broker probes run every 15 seconds with a
30-second response deadline; Client silence expires after 60 seconds. A blocked
relay EOF drain now fails after five seconds. Duplicate identity protection and
unknown-outcome/no-replay semantics remain in force. Matching Client and broker
versions are required; production 0.3.1 was not replaced by this candidate.

Two real native-editor reproductions also found cancellation races: cancelling
before an attach receipt arrived discarded completion correlation, and a late
cleanup failure could add an error after confirmed handoff. Both were fixed in
`client.ts`. Actual broker/client/upload/native-controller smoke cases observed
one attachment request, preserved source bytes, retained draft contents, native
image handoff, zero submissions and authoritative `attached` completion.

The focused native-editor, Client-service and draft run passed 74 tests with
641 assertions. The shipped window routing harness passed 67 synthetic cases;
these do not certify physical paste, drag or multi-window gestures. Dedicated
transport cases have focused passing evidence, but a subsequent full local run
was interrupted during documented clamshell sleep intervals and did not pass.
Unrelated native tests also exceeded their deadlines; production timeouts were
not relaxed to hide these results. Isolated Linux critical coverage passed 91
tests (752 assertions). A complete portable source payload subsequently passed
198 tests, one Windows-only skip and zero failures (1615 assertions, 26 files).
An earlier incomplete verification archive omitted docs and included macOS
AppleDouble files; its packaging/parser failures were corrected in the harness
payload, not hidden by modifying production behavior.

Task-scoped desktop confirmation initially returned `unanswered`; the documented
per-call native computer interface subsequently launched and inspected an owned
Tern fixture. A lock-screen interruption was resolved by the user unlocking the
Mac. No alternative desktop controller or approval bypass was used.

In that actual window, the old queue received HTTP 200 responses but stranded
deferred work and eventually lost the sidebar lease. Timer retention, awaitable
sleep at the old queue boundary and forced redraw experiments did not establish
a fix and were removed. The source now uses the fresh context already provided
by native HTTP completion and native zero-delay await callbacks for deferred UI
work, eliminating the redundant single-flight timer queue. A pass-through HTTP
observer measured 90 state polls and nine successful publications over 45 seconds,
with publication gaps of 5.04–5.137 seconds. The sidebar remained Connected during
subsequent operations. The observer was removed; clean plugin reload and reopening
retained the original draft and attachment without model submission. New window
owners do not adopt older view-scoped transfer history.

The unified native clipboard entry preserved an existing unsent draft while
appending multiline Unicode text. The user selected `AGENTS.md` through the native
file picker: 671/671 bytes, `attached`, matching SHA-256, archival guidance in the
original draft, zero submitted/rejected inputs, and a still-connected sidebar.
A second real native window without an eligible OMP destination rejected Toggle
Bridge without changing the originating draft. This is not proof of every
two-OMP-window or stale-conversation physical gesture.

Android discovery returned zero attached devices. Two isolated browser attempts
failed (approval-wait deadline, then a closed CDP session after a prolonged wait);
both reported successful cleanup. Physical file drag, image clipboard, complete
two-OMP-window gestures and native Windows/Android acceptance remain open. The
isolated window later exited before the authorized foreground drag could start;
its draft observation, selected file and private logs were retained. No drop was
attempted into the unrelated foreground work session.

### Native image-drop failure boundary (model-independent)

A subsequent isolated Tern 0.9.5 / OMP 18.12.6 native GUI run copied a
71-byte ordinary file into Tern's attachment cache with matching SHA-256 and
preserved the unsent draft. This was Tern-native path insertion, not a Bridge
transfer. Dropping a 68-byte PNG likewise produced a matching cached file and
path text, but no observed image attachment. A non-consuming routing probe
reported `No drop route observed`; this composer gesture did not reach the
Bridge's file-open hook. No model was selected or requested.

A separate executable comparison using the pinned 18.10.4 SDK and the existing
native-draft fixture passed with the same cached PNG: native `edit` left path
text and zero images; `pasteToEditor` produced one pending image, retained the
draft and submitted nothing. In-memory Settings initialization was required by
the fixture; the initial harness omitted it and failed before attachment. The
corrected comparison used no model configuration or model request. This proves
the pinned SDK delivery distinction, not an installed-host patch or GUI fix.

The official [TSP native editing contract](https://docs.stencil.so/tern/protocol/input.html#native-editing)
defines text edits, while [file-open routing](https://docs.stencil.so/tern/guides/routing.html#open-requests)
does not promise composer attachment delivery. This does not establish that a
new Tern protocol is required: OMP's existing TUI paste classifier already
converts recognized image-path text into attachments without requiring drop
provenance (`custom-editor.ts:1579-1586`). Its large-paste interaction also offers
explicit presentation choices (`input-controller.ts:2500-2535`). An explicit
path-versus-attachment choice can resolve intent without identifying the gesture.
The earlier conclusion that missing drop provenance prevents a Bridge-side
solution is withdrawn. The initial native drag attempt failed; the subsequent
automatic adapter and physical acceptance below supersede that failure.

### Automatic native image attachment acceptance

An instrumented installed OMP 18.12.6 run showed the actual GUI paste entering
`pasteText` directly, bypassing `handleInput` and `handleNativeEvent`. The first
edit-only candidate passed its SDK smoke but failed that real GUI path. The final
`NativeAttachmentEditor` also handles direct paste and delegates image loading to
the native bracketed-paste pipeline. Async-local callback scope prevents loader
text fallback from recursively attempting the same image; diagnostics were removed.

In isolated real Tern 0.9.5 windows, Cmd+V of a PNG path produced the native image
chip without a model. A subsequent Finder drag of `drop.png` produced image `#1`
in the pre-existing synthetic draft; dragging `drop.txt` next retained that draft
and image and appended the ordinary file's native cache path. The copied image
was 68 bytes and the ordinary file 41 bytes, both matching source SHA-256.
The observer recorded zero submitted/rejected prompts and an idle session.
These are real native gestures on a same-Mac remote-loopback host, not physical
SSH, Windows or Android acceptance. The new image adapter has not yet been
asserted deployed into the production GUI.

The focused native-editor suite passed 20 tests / 202 assertions; typecheck passed.
New regression cases exercise direct GUI paste, surrounding prose, selection
replacement, stale edits, invalid-image text fallback and Enter waiting for the
real image loader. No model or real clipboard is used by those regression tests.

Two real isolated native windows retained independent drafts during text paste.
The first window retained its synthetic prose, image and ordinary-file path while
the second received independent text. A real `ExtensionCommandContext.newSession`
transition in the second window changed the session ID without restarting its
OMP process. Reusing the captured pre-switch destination returned HTTP 400
`DESTINATION_CHANGED`; the new draft stayed empty and the first remained intact.
No model input was submitted. The acceptance observer explicitly permits only its
two registered local commands because OMP input hooks run before command dispatch;
all other submissions remain intercepted. This is same-Mac native-loopback proof,
not a claim about production SSH or other operating systems.

### Installed image adapter and real SSH acceptance on October 25

The image adapter release was built and installed on both ends with package digest
`65761867baa0d144be686a4162db2b22a7ba5a6b12397ea6ee88e56d5c6c6863`.
The stopped local Client was restored. The verified obsolete managed broker was
gracefully replaced; both services subsequently reported `upgradeRequired: false`.
Saved device identity and empty capability grants were retained. Local and remote
Tern plugin reloads reported ready without restarting working OMP conversations.

Acceptance window 892 connected over SSH to the configured agent host and started a fresh
OMP 18.12.6 in `/tmp`. Its isolated plugin configuration was pointed at the live
Client endpoint rather than the earlier loopback fixture. The authenticated view
resolved session `01a1729b-0441-74ff-b7e5-997c7b161f1e`; its real Bridge panel
rendered Connected, Paste to remote and Upload file.

After explicit human approval, the unified clipboard entry inserted
`BRIDGE_ACCEPTANCE_TEXT_892` into that remote unsent draft. The original clipboard
was restored. An earlier request expired while awaiting approval and did not
insert text. The system file picker opened, but its accessibility window could
not accept background keyboard input. Foreground-control confirmation remained
unanswered; no image/mixed-file GUI pass is claimed for this SSH run.

An operator-targeting error initially opened a tab in the user's working window
36 and attempted shell input before UserIntervened stopped delivery. The user
corrected the target; all subsequent desktop actions were confined to acceptance
window 892 and its owned picker. The user-touched tab/input was not overwritten
or automatically cleaned up.

### Revised terminal acceptance and authorized Client execution

The user replaced attached-Android acceptance for this round with actual remote
Agent execution of the local terminal, and explicitly deferred native Windows
acceptance until a device is provided. No physical ADB result is inferred from
terminal success; USB/driver/debugging authorization remains a separate boundary.

The existing Client identity was retained and granted `exec` through the same
validated identity-loading API used by `client --allow`. Only the idle managed
Client was restarted. Its authenticated state advertised `["exec"]`; other
capabilities were not added. This is a coarse arbitrary-code execution grant,
not filesystem or OS sandboxing.

In acceptance window 892, the real remote OMP Agent performed three actual Bash
tool calls in session `01a1729b-0441-74ff-b7e5-997c7b161f1e`:

- `target: client`: returned `Darwin` and the expected local account/home directory
  (machine-specific values redacted), plus `CLIENT_PROBE_892`.
- A separate `target: client` call returned the previously exported value
  `acceptance_892_20261025`, proving persistent shell state across invocations.
- `target: agent`: returned `Linux`, distinguishing the remote execution host.

The actual session JSONL tool results all recorded `isError: false`. Both Client
results carried the original device ID, `darwin/arm64`, `exec`, binding revision 1,
and distinct request IDs. The native UI also displayed the completed results.
No SSH command was used as a substitute for either Client tool invocation;
read-only SSH inspection afterward verified the recorded tool results.
This proves remote-Agent-to-local-shell execution, not browser, physical Android,
native Windows, or OS terminal-window automation acceptance.

### User-authorized production cutover to 0.4.0

After explicit approval to synchronize both sides without restarting working OMP
sessions, the native release was built and its CLI help executed successfully.
Installed Client, broker, OMP loader and both Tern plugin copies now use 0.4.0,
package digest `647157af594b1b86ab7a2af50db8239909a81648463ae2ffdfb282ab19df9632`.
The initial setup refused the old live Client's incompatible readiness schema;
its owner and authenticated idle state were checked before an explicit graceful
cutover. No unrelated process or OMP conversation was restarted.

The replacement broker and Client reported `upgradeRequired: false`. Authenticated
Client state remained connected after 197 seconds; the saved device identity and
empty capability grants were unchanged, with no active transfers or approvals.
The complete setup result is still `awaiting_session`, not production GUI-ready:
no view has yet completed the new native handshake. Old live conversations must
reload their extension or a new OMP view must be selected. The Mac was locked
again at the final desktop check, so no production window handoff is asserted.

Owned cutover scripts, portable verification archives and Linux test workspaces
were removed. Old managed release packages remain available for already-running
imports; user-selected attachment data and native acceptance evidence were kept.



## Native extension loader compatibility and pane lookup diagnosis

The remote OMP 18.12.5 extension failure was not missing installed dependencies:
the private Bun runtime could import the factory, but the generated `file://`
wrapper bypassed OMP's native module-graph SDK rewrite. The installer now generates
canonical relative imports (or the host module loader for Windows cross-volume
paths) and verifies the candidate in an isolated installed OMP process before
replacement. Candidate lifecycle handlers are observed but never registered;
stdin EOF terminates the verifier without a model request or broker activation.

The actual remote 18.12.5 executable accepted both the staged candidate and the
installed loader. Only the owned loader was atomically replaced, with its previous
contents backed up. Immutable package source, dependencies, service processes,
sessions, identities and grants were not replaced or restarted. A live conversation
that previously failed extension loading still needs a supported extension reload.

Verification: typecheck passed; loader/scoped-policy/schema/packaging tests passed
24 cases with one optional standalone skip and zero failures; the actual standalone
was separately exercised on the remote host. Binding lifecycle passed its real
broker/ExtensionRunner integration case. Routing passed 65 cases, including refusal
to fall back to another pane when the selected native surface is unavailable.

Authorized foreground inspection subsequently confirmed a native ID round-trip defect
on the screenshot's actual remote conversation. `cx.session:focused()` returned an
opaque numeric ID; passing that same value to `pane` and `surface` returned nil.
In the same context, `pane('@focused')` returned the live agent and
`surface('@focused')` returned the `omp.session` inline surface. This is no longer
an inference from a hidden pane. Observed builds are GUI/CLI 0.9.5 and remote host
0.8.3; aligning versions alone has not been shown to fix the native lookup.
The temporary probe was removed, and private metadata evidence is retained under
`.scratch/bridge-pane-probe/focused.json`. No OMP input was sent or session restarted.
The user navigated back to another local session during inspection; that choice was
left untouched and desktop control was released. The existing numeric-ID path remains
affected. The Bridge plugin does not decode IDs, guess another target or weaken
transport checks; alternative native interfaces were subsequently exercised below.

The user confirmed the installed application is already the latest available version.
Release-login investigation was stopped; no upgrade or daemon-state reset was performed.
Upstream [issue #30](https://github.com/stencil-hq/tern-sdk/issues/30) reports the same
ID round-trip failure, including observations on 0.9.5. A full-ID CLI replacement is
not a verified end-to-end repair: the window plugin and its child process exposed
no `TERN_WINDOW_KEY`, and [issue #131](https://github.com/stencil-hq/tern-sdk/issues/131)
documents missing caller-window targeting. The metadata-only context probe result is
retained at `.scratch/bridge-window-context-probe/result.json`; its installed plugin
and plugin-data directory were removed. No pane input or navigation was performed
by that probe. Inspection had not established a replacement for the complete layout,
snapshot-event, close and pinned-input path. That was not proof that all plugin-only
workarounds require a native Tern patch.

Subsequent isolated experiments used Tern 0.9.5 and actual OMP 18.12.5-1.1.66:
- `new_block(..., "beside", {focus=false})` opened a plugin block without a numeric
  target lookup and preserved focus.
- An exact full-decimal string passed to `session:event` addressed a remote loopback
  block after switching to another host. Host `tern.pane.write` used the receiver's
  authoritative `TERN_PANE`; ESC, BEL and UTF-8 bytes arrived unchanged at that PID.
- An event requesting `BlockCx:exit` removed only the owned block; the original
  receiver remained live and the other host's focus was preserved.
- A factory `setWidget` component exposed a dedicated native role through `describe`
  and received an action through `handleNativeEvent`. The exact control value arrived
  after a host switch; the synthetic unsent draft was unchanged and submissions were
  zero. The editor was not replaced. This is not the raw `onTerminalInput` path.

Evidence and the throwaway fixture are under `.scratch/api-bypass-probe-knJMBR/`,
including `result.json`, `widget-native-node.json`, `widget-event.json`, the per-PID
byte receipt, and `shots/serve/native-widget-control.png`. The isolated service was
stopped and no matching probe processes remained. No existing OMP session was changed.
These were API feasibility results, not a deployed Bridge repair. The subsequent
0.4.0 implementation replaces pane input with a structured widget locator and an
authenticated, draft-owned broker channel. Its native acceptance gate remains open.

### 0.4.0 native transport acceptance gate

The isolated high-counter loopback fixture reproduced failed numeric pane lookup
while the actual OMP widget remained discoverable through the focused surface.
The subsequent authorized desktop fixture opened and closed the host-rendered panel
and retained its connected state across repeated observations. High-counter desktop,
multi-window and stale-target acceptance remain separate; do not deploy on these
results alone.

The latest headless probe received HTTP 200 for `/v1/state`, but its queued native
dispatch never ran. A separate plugin registered 0/1/50/100 ms timers from a command;
none was observed firing after synthetic clock advancement and real elapsed time.
Retaining a timer handle did not change the result. This does not establish a timer
defect in normal desktop windows. Moving the receipt pump to a periodic load-time
timer did not resolve the observation and that speculative change was reverted.

Private evidence is under `.scratch/native-transport-EAL866/`: `queue-evidence.json`,
`native-timings.json` and the isolated renderer logs. The initially unanswered desktop
approval was subsequently granted. No existing OMP session was restarted, and this
revision was not deployed.

After reverting the speculative pump change, `bun run typecheck` passed. The five
targeted draft, native-editor, binding-lifecycle, broker-routing and client-service
test files passed 77 tests with zero failures (706 assertions); the local-UI tool
mutation case was excluded. The shipped Luau routing harness passed 67 cases and
the host-panel harness passed nine. These are contract/synthetic-boundary checks,
not desktop clipboard or multi-window acceptance. The isolated renderer, clock
driver and broker/client services were stopped; diagnostic evidence was retained.

Authorized desktop evidence (Tern native window, OMP 18.12.6-1.1.66) is retained in
the private fixture `/private/tmp/tog-zCBlg0`. The user completed Stencil login.
The fixture's separate broker/client roots required correcting `serverControlFile`
to the broker directory; the fixture launcher now writes that explicit mapping.
The widget opened a connected sidebar; Hide Bridge removed only its owned block
and preserved the synthetic unsent draft. Reopening succeeded.

The user selected `package.json` through the native upload picker. Client state
reported `attached`, with 1258/1258 bytes transferred, and the received file's byte
count was independently checked. The actual OMP core-editor observation and desktop
AX/screenshot showed its quoted import path appended to the original synthetic
draft, followed by receiving-inbox guidance. Both submitted-input counters remained
zero. The client remained connected; the sidebar was absent at the final inspection.
Its disappearance during the picker flow is not yet attributed or accepted as
intended behavior. This verifies one native ordinary-file attachment, not image,
clipboard, physical-SSH, multi-window or stale-conversation delivery.

A later desktop run reproduced the sidebar disappearing after opening it and
waiting 18 seconds without another action, beyond the broker's 15-second lease.
This is a failing lifecycle acceptance result, not successful heartbeat proof.
Temporary in-memory phase probes also observed stalled queue progress; the native
log recorded `timer exceeded 50 ms` during diagnostic reloads. Those observations
do not yet identify the original expiry's cause. The workstation then locked,
preventing further keyboard/AX verification. Diagnostic plugin edits were removed
by restoring the shipped window script, control was released, and the fixture's
existing draft and uploaded file were retained. No production deployment occurred.

After unlocking, retained timer handles did not prevent the sidebar expiry. A
window-owned periodic receipt-pump experiment also did not pass native opening;
both experiments were confined to the fixture and reverted. An independent
command registered 0/1/50/100 ms one-shot timers and observed all four firing, so
the evidence does not support a blanket claim that desktop timers are broken.
Further timer-chain probes were inconclusive: their diagnostic save commands
themselves exceeded the native 50 ms hook budget. A second isolated window was
created, but multi-window routing acceptance was not completed. The task-scoped
desktop grant subsequently became inactive and renewal was unanswered. Temporary
observer probes were removed; the isolated windows and original draft were retained.

## Setup selection and session lifecycle repair

Explicit selection of a server with a canonical or remembered address now starts
one bounded, read-only SSH check. Manual/unmapped selections require input.
Opening or refreshing does not repeat successful checks or installation.

Setup and ordinary Bridge views relocate to the caller's current session/tab;
only the previous owned display closes. Old view generations, queued publishing
and consent callbacks cannot act on the new view. In-flight operations retain
their approved target and receipts. Verified installation remains verified while
local endpoint metadata becomes available; host-plugin and service-upgrade gates
remain distinct from the remote OMP extension handshake.

Native logs identified 50 ms load/timer budget failures. The window no longer
loads the setup dependency chain in its load hook. Config read, endpoint read,
fetch startup and setup view operations are staged across separate callbacks.
Fixed 20-cell shrinking was removed from both displays after a native small-window
check showed it reduced the setup content to 183 px; the same viewport now retains
351 px of content using the native split.

Verification:
- Pre-fix regression reproduced `focused stale setup pane`; repaired coordinator
  passed 37 scenarios. Window routing passed 64, renderer 22 and host panel 12.
- Typecheck passed; setup UI and packaging suites passed 33 tests, zero failures,
  with 467 assertions. The unrelated full native-runtime suite was not rerun.
- Actual Tern session/layout APIs closed pane 8 and opened pane 13 in the second
  session while preserving caller focus 11. Closing that display and reopening in
  a third session created pane 18 while preserving focus 16. Native assertions
  confirmed the current session and absence of the previous setup panes.
- The isolated native driver used the shipped coordinator with real native
  contexts and manually advanced timer receipts, because headless `serve` does not
  deliver those window timers in this environment. This proves native pane/session
  operations, not a complete real remote installation or autonomous timer delivery.
- Native screenshots and the isolated driver are in `.scratch/setup-session-LzCxrX/`.

## Setup visual hierarchy revision

The setup view now has a compact native header, one target summary, a disclosed
host picker and a single primary action per stage. Manual choices are explicitly
marked by the controller, deduplicated by the view and retain their numeric route
key. Local Change/Cancel/Edit/Details actions do not authorize host operations.
Input identity remains `main.ssh`; stale and busy views cannot change selection,
edit, retry or install. Failed SSH checks say setup needs attention, not that an
installation ran and failed. Theme styling is scoped to the two setup surfaces.

Native verification used Tern's actual offscreen renderer, not a browser mock:
- Captured connection, host-picker, review, failure, inline edit, checking,
  installation, awaiting-session and ready surfaces.
- Inspected light and dark themes, with 471 px and 311 px content widths.
- Real native clicks opened the host picker (one manual option) and revealed the
  failure state's SSH editor without changing the selected target.
- Final phase screenshots are under `.scratch/setup-design-b17hwr/shots/serve/`.
- 20 setup-renderer, 20 coordinator, 52 routing and 12 host-panel cases passed.
- Typecheck and build passed. The broad Bun run finished with 176 passing tests,
  one platform skip and two failures in `client-service.test.ts`: native worker
  bootstrap exceeded its 30-second deadline; one teardown also timed out. This
  run is not a clean full-suite pass. No timeout was raised or failure suppressed.
- The redesigned package was installed into the main Tern directory and reloaded;
  native catalog reported host/window ready with no plugin problems.

These controlled snapshots verify rendering and local interactions, not a real
installation outcome. Desktop control approval timed out; no installation consent
was submitted and no existing OMP session was restarted.

## Native setup sidebar (0.3.0)

Setup uses a persistent native block. Process callbacks retain receipts only;
subsequent timer stages validate results and update the view. Initial snapshots
wait for the host surface to exist. Installation remains a separate affirmative
action after SSH verification; existing OMP sessions are not restarted.

The small display-only remote package uses the existing Tern connection, not
SSH. Its owned preparation terminal stays open for completion capture. Native
testing exposed a 50 ms budget failure with a single large input operation;
the controller now sends at most 512 payload bytes per timer stage.

Observed verification:
- 20 coordinator, 14 setup-renderer, 52 window-routing and 12 host-panel cases
  passed against the shipped Luau modules.
- Typecheck and build passed. The source-only Bun run passed 178 tests with
  one platform skip, zero failures and 1,891 assertions across 25 files.
  An earlier unqualified test filter also selected stale `dist/` test copies;
  the final run explicitly targeted `./tests` and the two source script suites.
- The actual generated package command ran through an isolated native Tern
  terminal in bounded chunks and returned the exact nonce-bearing READY marker.
  This installed only the display package into an isolated local configuration.
- Headless `serve` rendered the native form but did not deliver window-plugin
  timer callbacks in this fixture. It does not prove the full controller flow.
- Ordinary desktop control approval timed out. Real-window confirmation-to-
  completion, actual remote UI deployment and Windows remain unverified.

## Connected-host selection and SSH preflight (0.2.1)

Setup now lists connected remote hosts with the current session's host first,
uses connection addresses rather than display names, and preserves an explicit
manual SSH option. Opaque relay/device addresses require a user-supplied mapping.
Mappings are stored by exact connection address in native plugin storage only
after installation consent. Host switching cannot retarget an in-flight flow;
replacement/disconnection of the selected host invalidates it.

Observed verification:
- The shipped helper passed 432 assertions and nine executable local POSIX probe
  cases. The runner invokes the public argv builder, including remote-shell quoting.
- The exact shipped SSH argv and result classifier were exercised against a real
  Linux host and an intentionally invalid DNS name: success reported Linux/x86-64,
  and failure was classified as network-related. No remote installation or writes
  were performed by these probes; the throwaway smoke script was removed.
- The shipped window router passed 95 SDK-boundary scenarios; the host panel passed
  12. Coverage includes cancellation, duplicate guards, explicit retry, exact-address
  mapping isolation, target replacement, and current-host changes during selection.
- Typecheck/build passed. The full Bun suite passed 181 tests with one platform
  skip and zero failures (1,956 assertions across 25 files).
- Main Tern loaded 0.2.1 with both host/window entries ready and no plugin problems;
  a fresh screenshot and accessibility tree confirmed the setup entry remains visible.
  The native picker-click attempt was blocked by UserIntervened while the user was
  operating Tern; no input was sent and no installation consent was submitted.
  Native picker/confirmation interaction and Windows desktop acceptance remain unverified.

## Unified plugin initialization (0.2.0)

The plugin now exposes an explicit, consented **Set up Bridge** workflow rather
than treating copied display files as a completed installation. New identities
have no agent capabilities. Existing sessions, identities, grants, bindings and
unrelated configuration are retained.

Observed acceptance:
- With global Bun excluded from PATH, the Unix launcher downloaded and verified
  a private Bun 1.4.3 runtime. Full bootstrap reached the trusted-SSH preflight;
  an intentionally invalid host produced bounded, recoverable failure state.
- A real macOS-to-Linux SSH initialization installed into isolated directories,
  started the broker/client, and verified signed registration. A repeated run
  reused both service PIDs and the same client identity. The client remained
  connected after initializer exit, retained unrelated configuration, and had
  an empty capability grant.
- No OMP view existed in that isolated run, and its Tern directory intentionally
  did not identify a live daemon. The result remained `awaiting_session`, not
  `ready`; no production conversation or binding was changed.
- Cross-platform execution exposed AppleDouble metadata added by macOS tar.
  Archive creation now excludes that metadata instead of weakening integrity
  verification. The regression failed before the fix and passed afterward;
  the original real-SSH setup then succeeded.
- The shipped window router passed 59 synthetic SDK-boundary cases and the host
  panel passed 12. Host-plugin reload and service-upgrade attention remain visible
  even when an OMP view already exists; connectivity cannot erase those gates.
- Managed shutdown joins the native SDK cleanup registry instead of racing its
  signal-triggered hard exit. Real macOS client and Linux broker checks confirmed
  endpoint, ownership and lock removal after authenticated SIGTERM. Restart from
  stale records also preserved the existing client identity.
- Final integrated verification passed typecheck, build, and 170 Bun tests
  (one platform skip, zero failures; 1,736 assertions across 25 test files).
- Main Tern loaded version 0.2.0 with both host/window entries ready and no plugin
  problems. A fresh screenshot and accessibility tree confirmed the right-aligned
  **Set up Bridge** control. This does not establish setup confirmation-to-completion.

Native setup confirmation-to-completion GUI acceptance and real Windows setup
remain unverified. Desktop control approval was not obtained for this check;
no native initialization consent was submitted on the user's behalf.

## Right-side native Bridge Block

Implemented a real `omp-client-bridge.panel` host Block with a window-status
toggle, public device/target/transfer display, and window-routed actions. It is
not Canvas. Closing its UI does not cancel transfers. Snapshots omit credentials
and clipboard payloads; a 5-second owner heartbeat expires after 15 seconds
(the host timer observes expiry within 15–20 seconds).

Visual correction: the initial host view incorrectly relied on bare surface
defaults. Tern documents that regions inherit the terminal monospace font and
plain `el` buttons are reset to unstyled text. The panel now ships a stylesheet
scoped to `plugin.omp-client-bridge.panel`, using `--sans`, native control radii,
theme text/fill/hairline tokens, bounded control padding and hover/focus states.
The title and connection badge share a header row; section bodies no longer use
tree-like indents, and the redundant action hint was removed. No transfer or
approval contract changed. Twelve host-panel regressions and build passed;
the real isolated installer/catalog recognized the stylesheet and ready plugin.
After renewed permission, the stylesheet and host view were deployed only to the
isolated acceptance configuration. Fresh screenshots in horizontal-tab and Rail
layouts confirmed sans typography, a compact header badge, bordered rounded
buttons, unindented sections and the footer control. The neighboring terminal
retained its monospace typography. The observed panel was disconnected: enabled
and hover states, dark appearance and an explicit floating-margin setting were
not validated. Existing unrelated notifications obscured part of the upper panel
and were left untouched. Desktop control was released after inspection.

The user rejected that first styled composition as still visually unsuitable.
A subsequent composition revision removed repeated full-width controls, moved
Hide into the header, paired paste/upload, collapsed device details, and hid
zero-approval/unknown-placeholder sections. The disconnected state now contains
only its header and a connection explanation. A fresh read-only Rail screenshot
confirmed that empty state in the real isolated window. A later real connected
Rail inspection also verified the paired controls, collapsed/expanded device
details, and empty transfer list, alongside Tern's native Files sidebar. The
inspection replaced the debug pane ID label with its title/folder and reduced
vertical gaps. No clipboard read, upload or prompt submission was performed.
Hover/dark appearance and user aesthetic acceptance remain separate. Twelve host
behavior cases passed; a duplicate device-row/section key found by the harness
was corrected before packaging.

The next revision studied the rendered official Tern website's product demos,
not just its hero or extracted text; findings are in
[Tern design reference](research/tern-design-reference.md). It introduces a
workspace context card, native icons/item rows, compact state badges, and grouped
transfer progress. The 12 host-panel behavior cases and package build passed.
Installation into the isolated acceptance host reported ready with no problems.
After the user unlocked the Mac, the isolated SSH agent and stalled native remote
transport were restored with the existing endpoint identity. Fresh screenshots
confirmed the redesigned panel in the real connected Rail window at approximately
444 and 300 logical pixels wide (2x capture). The workspace card, source-device
row, paired actions, status badge and empty transfer section fit at both widths.
The narrow screenshot is `omp-computer-15adb707d52bc4a5.png`; the detail capture is
`omp-computer-15adb71c5f2bc4a6.png` in the desktop tool's temporary capture directory.
This is visual evidence, not complete functional acceptance: agent resolution
remained `Resolving` and a `timeout: global` toast appeared. Device-list expansion,
active transfer states, dark appearance and user aesthetic approval remain unverified.
No clipboard read, file upload or prompt submission was performed in this review.

The interaction follow-up restored the real services and reproduced an enabled
upload control rejecting an expired destination. A failing regression confirmed
that the click refreshed identity but never opened its prompt. Chooser preparation
now waits for matching identity and opens once; replacement conversations/drafts
remain rejected, and drop/capture validation is unchanged. The shipped router
passed 54 cases, the host panel passed 12, and the package build passed.
Real native verification opened and cancelled the upload prompt, paste source
picker and agent-device picker; expanded available devices; and exercised empty
transfer-history feedback. No clipboard was read, no file uploaded, and no binding
changed. Screenshots confirmed hover highlighting and the compact sans Bridge
status chip without the former debug-style sentence or duplicate paste shortcut.
Some scripted AX waits timed out before subsequent fresh captures showed the
requested chooser, so these checks do not establish a response-latency bound.
The isolated acceptance services are retained for the user's interactive review.

The file-chooser follow-up right-aligns the status plugin group using its native
flex layout; a fresh Tern screenshot confirmed the Bridge control at the right
edge. Upload now calls an authenticated local-human endpoint instead of asking
for a typed path. The actual macOS NSOpenPanel was captured both from the helper
and through that client endpoint; aborting the HTTP request closed the dialog,
with no file selected or uploaded. Typecheck/build passed, as did 48 routing and
12 host-panel cases after removing obsolete manual-path cases. Windows/Linux
dialog execution and a complete selected-file upload through the new chooser
remain unverified. The final Bridge-click visual check did not observe a dialog;
subsequent desktop capture timed out and the computer worker reset. This does
not establish that the native button-to-dialog path passed GUI acceptance.
The final full Bun suite passed 139 tests with one platform skip and no failures.
The retained review SSH broker subsequently exited 255 with `Broken pipe`;
the native transport also exited 255. This connection loss blocks the remaining
button-to-dialog GUI acceptance and is not evidence that an upload succeeded.

The informative-status revision replaces the generic Bridge label with the
client/broker connection and selected agent-device state, while retaining right
alignment. A regression checks the selected device rather than another listed
device, preserves that identity when the panel gains focus, warns for an offline
device, and removes stale device identity after disconnection. All 49 routing
cases and the package build passed. The actual Tern window displayed
`Connected · No session` after reload: its client link was online but its native
remote panes were unavailable. Bound/offline variants were exercised in the
shipped-code harness, not simulated as live GUI state. Tern's existing load/status
budget failures were observed during installation; a native reload restored the
formatter. No connection recovery or upload acceptance is claimed by this check.

Transfer status now distinguishes preparation, byte-weighted upload progress,
handoff, unknown/offline status, failure and a five-second completed-handoff
indicator. Shipped-code regression scenarios cover weighted totals, unknown
sizes, offline display, phase changes, completion expiry and historical replay.
The existing `plugin.omp-client-bridge.paste-remote` command was confirmed in the
real native palette under OMP; no user shortcut was changed. The live acceptance
host remained disconnected, so the progress scenarios are harness evidence,
not a new live file-upload acceptance result.
All 51 routing scenarios and the build passed for this revision. The native
palette visibly listed OMP → Paste to remote. The acceptance window subsequently
closed; no other Tern window or user keybinding was modified.


Verification: typecheck and build passed; the Bun suite passed 139 cases with
1 Windows-only skip and no failures. The shipped window router passed 52 Luau
cases; the shipped host panel passed 12. An isolated real installer invocation
followed by Tern 0.9.5 `plugin list --json` reported both host/window entries,
the hidden-from-palette `panel` block, `status: ready`, and no problems.
This catalog smoke is not a rendered-panel or native click-routing proof.

Integration corrected a native identity mismatch: the block kind is
`omp-client-bridge.panel`, while its surface role is
`plugin.omp-client-bridge.panel`. Using the real role made the original router
regression fail before the correction and pass afterward. An empty target-filtered
transfer list now avoids opening an invalid empty picker.

After renewed explicit desktop permission, the real isolated macOS window opened
the right-side native Bridge Block, received a Connected snapshot, and displayed
its target/source/device controls. Native panel hide and status-bar reopen worked.
The Upload file button opened Tern's native path prompt; a 218-byte synthetic
ordinary file reached the original Linux OMP draft as a quoted remote path with
the archival reminder. Source and received SHA-256 values matched.

The unified clipboard entry and its local approval picker also delivered
multiline Unicode text. The real remote editor observer retained the file path,
reminder and exact text/newline, with idle=true, pending=false and zero submitted
inputs. Panel focus did not retarget these operations.

Acceptance is still partial. A fetch callback exceeded Tern's 50 ms limit and
disabled the hook until reload; the owner heartbeat subsequently expired as
designed. Reload recovered the successful operations above, but this is not a
stability fix. Some background clicks and AX actions did not produce the expected
prompt; the successful fresh-panel AX action was observed directly. Temporary
route diagnostics were removed afterward.

The screen then locked, preventing further desktop inspection/input. Rail with
floating margins and image paste through this new panel remain unverified. Desktop
control was released and the owned broker/client were stopped; the isolated GUI
and referenced files were retained. No unrelated user sessions were modified.


## Unified paste and layout follow-up

The unified clipboard/file implementation passed typecheck, build, and the full
Bun suite: 139 passed, 1 Windows-only skip, 0 failures across 21 files. The shipped
Luau router passed 39 synthetic SDK-boundary cases with official Luau 0.743.
Its archive SHA-256 matched the official release asset. An initial routing run
failed because the previous temporary interpreter had been removed; this was
not a router assertion failure.

The native GUI remains unverified for this revision: desktop-control confirmation
timed out and the host reported a locked screen. Earlier successful image-only
GUI evidence below is not a pass for the unified entry or multiline text route.

After considering Rail and floating margins, the user approved a compact window
status summary/toggle plus a narrow right-side native plugin Block. Canvas stays
excluded. This composes existing status, host-block and layout APIs; it does not
claim a new Tab-bar button slot or inject controls into the OMP editor. Existing
split trees are preserved rather than rebuilt to simulate a full-height sidebar.
Fresh installed Tern 0.9.5 declarations remain the interface reference.

Files-directory drag upload is exploratory only. Official file-routing and
Files documentation do not establish local-to-remote-directory upload semantics;
the actual gesture was not attempted while locked. No Files upload feature was
added and no unsupported verdict was inferred. Ordinary-file paths alone carry
the archival reminder; image-only attachments do not add path/reminder prose.

Sources: [Chrome](https://docs.stencil.so/tern/guides/chrome.md),
[Window API](https://docs.stencil.so/tern/reference/api-window.md),
[Files](https://docs.stencil.so/tern/scripts/files.html),
[routing](https://docs.stencil.so/tern/guides/routing.md).


## Automated checks for this change

Review baseline: `026c4389005689e5f847996a25220d88acf54fcc`. Checks used Bun 1.4.3
on macOS arm64 and the pinned OMP SDK 18.10.4.

| Check | Observed result |
|---|---|
| `bun run typecheck` | Passed |
| Targeted image/inbox regressions | 59 passed across five files |
| `bun run test` | 136 passed, 1 skipped, 0 failed; 137 tests across 21 files |
| `bun run build` and built CLI `--help` | Passed |
| Shipped Luau routing harness | 16 cases passed |

The skipped case is Windows-only private-storage ACL coverage. It is not a
Windows pass. The first full run found an obsolete test asserting image rejection;
that test now checks real-broker PNG transfer, native format preservation and
unchanged source bytes. No production error was suppressed to satisfy it.

The native-editor regressions use the actual `ExtensionUiController`,
`InputController` and `CustomEditor`, not a pasted-image callback echo. They check
PNG payloads, mixed image/ordinary batches, preserved existing text/images, and
no automatic submission. Other cases cover approval/no-read denial, rejection of
programmatic approval flags, disconnect/late read cancellation, immutable
snapshots and claim ownership, README publication/permissions/cleanup, and the
existing upload-admission and queued-Eval cancellation repairs.

## Real remote interactive smoke

A Mac client with no agent-execution capabilities connected through real outbound
SSH to an isolated Linux broker and the installed interactive OMP 18.12.3.
The actual extension and native editor were used, not RPC mode or a replacement
frontend. Synthetic PNG and ordinary files exercised the selected-file upload
path while the session remained unbound.

Observed result: **passed**, with no cleanup errors.

- Image-only transfer produced a native image chip without ordinary-file prose.
- A mixed transfer retained the existing image and text, added the ordinary
  file's remote path and archival reminder, and produced a second native chip.
- All remote file SHA-256 values matched the source bytes; source files remained
  unchanged. The published README contained the archival/workspace warning.
- The native composer retained the originating conversation, remained idle and
  unsent, and contained both image chips and the ordinary-file reminder.
- The owned OMP, client, relay and broker were shut down.

This proves real SSH transfer and native unsent-draft handoff. It does not prove
an OS mouse-drag gesture, a physical clipboard read, or Windows GUI behavior.
The native-image payload checks belong to the separate actual-controller
regressions above; the CLI smoke observes native composer chips and verified files.

An earlier probe reached the same image/inbox observations but failed an extra
submission-event check. That probe was removed from the unsent-draft smoke rather
than requiring model submission to validate a feature that must not submit.
A subsequent attempt timed out starting its isolated broker; process/metadata
inspection found no surviving fixture broker and a direct CLI load succeeded.
The clean retry passed. These failed probes are not counted as successful runs.

## Desktop evidence boundary

After restarting OMP, built-in computer-use recovered. On 2026-10-20, a
real macOS Tern 0.9.5 window connected to an isolated Linux OMP 18.12.3
session. The human authorized synthetic clipboard and file-drop acceptance.

The explicit **Paste image to remote** action opened the local approval picker.
Approving **Read image once and upload** transferred 1,674 bytes and displayed
**Handed to OMP**. The actual native composer rendered a colored thumbnail,
image chip **#1**, and **356x200** dimensions while retaining the existing draft.
The remote observer confirmed the same conversation, idle state and zero
submitted/intercepted inputs. The received inbox contained `0-clipboard.png`
and a README requiring archival before work and preserving referenced files.

Earlier attempts encountered Tern's 50 ms plugin-hook limit, disabling timer
or fetch callbacks until reload. Scoped diagnostics and reload recovered this
clipboard run; no production timeout fix or general reliability claim follows.
Temporary diagnostic statements were removed afterward.

OS file dragging remains unverified: built-in foreground activation did not
reliably expose the isolated destination, and fresh focus checks instead named
another user conversation. No drag was attempted into that conversation. This
tool limitation was reported; no alternate desktop controller was used.
Ordinary-file path/reminder evidence remains the earlier SSH smoke above, not
a new mouse-drag pass. The owned remote OMP exited with code 0.
The tracked client, broker, SSH agent and native-server transport were stopped.
Closing the isolated GUI was refused with `UserIntervened`; the user-touched
window and its staged files were therefore preserved, and desktop control was
released. The referenced inbox was not automatically deleted.
Remote process inspection still found the private native listener and session
daemon. They were retained with the user-touched GUI, not counted as cleaned up;
stopping the SSH transport did not terminate these native processes.

## Standards

Independent review found no remaining actionable defects under the clarified
contract. Earlier concerns that required new native dequeue/focus interception
were withdrawn: those semantics are deliberately delegated to native OMP.
Approval, cancellation, capture ownership, finite HTTP deadlines and atomic
inbox publication had no remaining evidence-backed findings. The visible
terminal label is **Handed to OMP**, not a claim of rendered preview completion.

## Spec

Independent review found the requested explicit image entry, image handoff,
ordinary-file inbox and archival reminders implemented. Native paste remains
unintercepted, and no agent clipboard tool or watcher was added. No remaining
source-backed Spec blocker was identified for this clarified change.

Outstanding evidence is explicitly separate: actual OS file-drag gestures,
cross-pane and IME/streaming behavior, native Windows/mixed physical clients,
remote browser and authorized Android-device acceptance. Those broader gates
are not waived or marked passed by this change.

## Earlier verified baseline

Before this change, three independent client identities on one Mac were exercised
against a real Linux broker: shared binding/actor convergence, in-flight target
capture, retained contexts, native file/shell operations, and a 1,048,593-byte
unbound transfer with matching digest. Separate bounded macOS browser/desktop
checks are described in [Compatibility](compatibility.md). Those results are not
new cross-platform claims for this image/inbox change.
