# Bridge 自动 PiP：窗口定向、原生派发与证据边界

研究日期：2026-10-28。范围仅为接口与现有证据研究；未安装/重载插件，未改变窗口、焦点、布局或设置，未运行构建/测试，未创建 worktree。本文新增的本机观察仅来自 CLI 帮助、版本和只读 `inspect`。下文 `[INFERENCE]` 表示推导或待实测方案，不是已成功实现。

## 结论

**最值得继续的路线不是裸 `tern ctl pip float tr`，而是“取得可信窗口作用域 → 后台进程执行按 pane 指定的 `tern pip`”。** 已安装 CLI 有独立的 `tern pip BLOCK --over BLOCK --corner tr --window KEY`，不必先修改焦点；这与依赖 focused pane 的 `tern ctl pip float tr` 是两套接口。`tern.process.run` 的进程工作在 VM 线程外，能避免把 CLI 的等待直接计入插件回调，但不能凭空提供窗口身份，也没有文档保证整个原生命令不等待远端。[C1][S1][S4]

**目前仍未找到公开、直接、只读的 `WindowCx → native window key/control endpoint` API，也未找到通用的原子“校验当前 pane/owner 后派发 PiP”接口。** 当前声明里的 `TaskInfo.window` 是值得专门验证的间接窗口标识来源；CLI `inspect` 可见 client connection，但本机结果没有窗口 key/socket/pane-to-window 对照，不能把 `conn` 当 `--window KEY`。以上是已检查接口的边界，不是对未公开实现的断言。[S2][S8][C2]

**不能将现有超时解释为“单条 PiP 原生动作必然等远端超过 50 ms”。** 文档证明动作立即派发、插件调用有总预算、native operation 不在执行中被 Luau 中断；并不证明 PiP 内部的网络等待策略。`ctl pip` 的 650 ms 是脚本动画 settle，与插件 API 的 50 ms、远端 RTT 不是一个量。没有 Tern 内核实现源码或单调用计时/跟踪，不能归因。[S3][S4][S5]

## 证据与版本

- 本机 `tern --version`：`tern 0.9.5 (2863c37)`。[C1]
- 本机既有声明：`.scratch/native-repair-sdk/tern.d.luau`；本研究未重新生成。当前 Bridge 的 `tern/window.luau:3` 自行生成 `windowId`，它不是 native window key；`644–688` 在回调中检查 session/host/destination 后，以 `new_block(..., "beside", {focus=false})` 创建 panel。[L1][L2]
- 官方公开 SDK 当前 `main`：`9e9c07463f4958b0c633424c9860aba499487d28`，提交时间 2026-10-19，commit message 的上游 Source-Commit 为 `6952b6486313175f7f456532b15c15d171473d47`。相关 `How`、`WindowCx`、`LayoutCx`、`TaskInfo`、`tern.carly` 声明与本机快照的相关接口一致。公开仓库提供 SDK/声明/示例，不是 Tern 的 PiP/daemon/Rust 内核实现；本次可见官方组织仓库列表也没有该内核仓库。不能把声明读取称为实现源码审计。[S2][S13]
- 任务给定的既有现场事实：`ctl pip float tr`、`pip focus "#1"`、`pip resize "#1" 340 560` 成功；`layout:float` 失败；创建返回的远端数字 ID 传 `pane(id)` 得到 nil；`pane_created`/await 中的 action 超时。这些作为用户提供的一手现场观察接受，未重跑，也没有新增“修复成功”结论。[U1]

## 1. 窗口身份与 endpoint：哪些是真接口

| 入口 | 已证实的契约 | 对 Bridge 的意义与限制 |
| --- | --- | --- |
| `WindowCx` | 暴露 session/sessions/hosts/layout/actions 等，没有 `window_id`、`window_key`、socket、defer-action 方法。[S2，1572–1634] | 现有 fresh `cx` 作用域天然正确，但没有已公开的方法把该作用域转交给子进程。 |
| `tern.getenv(name)` | 读取当前 context 所在进程的环境。[L1，1807–1808] | 不是读取 focused pane 的环境。既有 probe 证明 window VM 的 key/socket 均 absent，子进程也没有 key。[L3] |
| `tern.chrome.window_title(fn)` | 输入仅 `space,tab,pane,cwd,tabs`；纯 formatter，无 `cx`，预算 4 ms。[S7] | 无隐藏身份字段证据；标题/当前 pane 也不是稳定窗口唯一键。 |
| `tern pip … --window KEY` 等 daemon CLI | 选择 `--window`，否则 pane 的 `$TERN_WINDOW_KEY`，否则第一个 window。[C1][S6] | 必须显式可信 KEY；缺失环境时不可自动 fallback。命令帮助没有承诺该 key 与每个 GUI/插件 VM 一一对应。 |
| `tern ctl --control EP COMMAND` | EP 为 Unix socket 路径或 loopback TCP 端口；一行命令、一行 JSON 回应。[S5] | 知道并绑定正确 EP 时有明确地址。默认 `/tmp/tern.sock` 不是当前 Bridge 窗口证明。 |
| `tern inspect --json` | 本机输出顶层 `sessions,detached,panes,clients`；clients 只有 `conn,identity,kind,since`。[C2] | 没有获得 KEY/endpoint。identity 是机器/连接身份，不能替代窗口归属；client conn 也无对应 API 契约。 |
| `tern whoami --json` | 主研究者从插件外进程调用，得到本机身份 `hops`，没有当前 viewer window 信息。[C3] | 身份链查询不是窗口查询；不把主机 principal 当 KEY。 |
| `tern.carly.tasks()` → `TaskInfo.window` | 返回所有窗口任务；每条含创建窗口 `window:string`；schedule 从 scoped callback 创建任务并返回 task id。[S2，1675–1716、1742–1760][S8] | **间接候选**：以本 VM 创建的 task id 精确反查其 window。`TaskInfo.window == CLI KEY`、生命周期与同 session 多窗口区分都未证明。不能仅从全体任务任选一个。 |
| host `spawn(spec)` → `spec.env` | daemon pane 的新增环境包含 `TERN_PANE,TERN_PANE_SOCKET,TERN_WINDOW_KEY,TERN_WINDOW_SOCKET`，后者是空串；plugin block 不触发 spawn。[S9] | **部分映射候选**：可以在真正 shell spawn 时保留映射。它描述程序创建环境，不是现在查看该 pane 的 viewer；两个窗口查看同一 remote pane 时，不能从同一份创建环境唯一识别发起 Bridge 的窗口。远端记录也不能直接作为本机 GUI endpoint。[S9][S14] |

### 只读探查发现的额外陷阱

本机 `tern inspect --window __bridge_research_no_such_window__ --json` 返回 **exit 0**、空 `sessions/detached/panes`，同时仍有 `clients`。因此“命令 exit 0 / clients 非空”不证明窗口 key 有效，更不证明它属于调用窗口。未知 key 的**写命令**行为未探测，不能从这个只读结果推导其安全性。[C2]

`cx.hosts:list()` 返回 host identity、host slot、sessions、panes，但没有 window endpoint；`SessionCx:tab_of(pane)` 只能反查 tab。更重要的是，官方明确禁止跨窗口比较 pane ID：远端 host tag 在 Lua 使用 bit 44、在 native 使用 bit 56；不同窗口的 host slot 不保证相同。不要自行算术转换后拼入 CLI，除非得到该版本明确、完整的转换/归属契约。[S2，562–590、1441–1476][S10]

## 2. 超时：可以纠正的结论

1. `cx:action(name)` **立即运行**普通 action，不返回 awaitable；`cx:command(id)` 是 built-in command 同步入口；`cx.actions:run(id_or_label)` 返回 string，也不是异步 API。`pip`、`pip_corner:top_right` 都是公开 built-in command id。[S3][S2，703–713、1617–1621]
2. window 普通 callback 总预算为 50 ms。Luau interrupt 在函数调用/循环处检查；长 native operation 先执行完，再由之后的检查发现超时。故 timeout 不代表动作未发生，也不能据它安全重试；更不能用 `pcall` 捕获后继续。超时会禁用对应 hook 到 reload。[S4]
3. 把动作移到 `tern.timer`/`tern.sleep(...):next` 只换到下一次同样 50 ms 的 UI-thread 回调；不是把同步 action 放到后台。[S4][S2，41–49、1810–1814]
4. `tern.process.run` 的进程本身在 VM 线程外，callback 才回 UI 线程。因而后台 CLI 是真实可研究的预算隔离路线；`timeout_ms` 控制进程，不会修复 native UI 卡顿，也不证明超时退出时远端动作已撤销。[S4][S2，51–73、1855–1860]
5. **三种等待必须分开记录**：plugin callback 50 ms；`ctl pip` 文档规定多数动作 settle 650 ms 动画时间、drag 50 ms；真正 remote mutation/replica convergence 的等待（本次无实现证据）。PiP 脚本页说不等浏览器页面加载、没有单独 real-time timeout，不等价于“不等待任何 remote daemon”。[S1][S4]
6. `[INFERENCE]` 创建返回 ID 暂时 `pane(id)==nil` 可能涉及 replica 可见性、返回 ID 路径或其他实现缺陷；声明仅承诺返回 pane 与透传 ID。不能用“加固定 sleep”当根因修复，也不能宣布只剩 ID 精度问题。[S2][S10][U1]

## 3. 直接创建 PiP、CSS cmd、原生事件入口

### 直接 `new_block(...,"pip")`：没有公开契约

`How = "default" | "beside" | "below" | "split" | "tab" | "replace" | "preview"`，当前 SDK 的 `new_block` 用的就是这个类型；Window API 对未知 how 明确列出 `unknown how`。`cx.board:open(...,{how="pip"})` 的专属参数确实包含 pip，但它创建的是 board，不是任意 plugin block。`pip new` 和 `new_browser_pip` 同样只针对 browser。[S2，12–13、859–860、1614–1616][S1][S3]

**可支持的基本模型仍是创建 block 再 `cx.layout:float(pane,over,"tr",{focus=false})`**；float 返回 `(boolean,string?)`，可重放置已有 float。但这条 API 在任务给定现场已失败，本文没有推翻该失败，也没有声称重复调用会成功。[S2，1499–1502][U1]

### CSS 可以绘制/命中，不是已有 native command API

官方 Supported CSS 的属性/Stencil extensions 列表没有 `cmd`、`-stencil-command` 或 animation-end 派发 command 的接口；`el.attrs` 允许 `data-* / aria-* / role / colspan / rowspan`，其他属性（包括 `onclick`）忽略。`el.actions` 的任意名字通常发送 TSP action 给 block/lens handler，不等价于 `cx:action`。[S11][S12]

因此没有一手证据支持“写 CSS `cmd: pip` 即可自动触发原生命令”。`position:fixed`、transform、动画可以改变呈现，但不把 session 的 split pane 转成 native PiP，也不建立 owner/corner/size 状态；后一判断是基于 CSS 与 PiP 状态接口分离的 `[INFERENCE]`。[S5][S11]

### 存在原生动作入口，但不能混称自动 PiP

- `tern.bind(chord,"pip")` 的 **string action** 由 keymap 解析；不是 `tern.bind(chord,function(cx) cx:action("pip") end)` 这个 Lua callback。status segment 的 `command="pip"` 也直接是 action 名；用户点击/按键是原生入口。它们仍依赖当时 focused pane，而且只是手动入口，不满足自动化。[S3][S7]
- control/scenario 的 `plugins run <action>` 已在本机 `tern help dev` 明确列出，可运行 built-in（如 `new_tab`）以及 plugin action。故已绑定 EP 后，**在插件 hook 之外启动一个 native action 有已公开入口**。但 `plugins run pip` 没有 expected pane/owner 条件；不能先异步检查 focus 再无条件运行它。[C1][S3]
- `cx.session:event(pane,event)` 发的是 TSP/Canvas event；Canvas action 延迟到 caller 返回后送给 owner handler，owner handler 仍有 50 ms 预算。它不是任意 window-native PiP action 队列，不能把 `{ev="action",act="pip"}` 当已验证 PiP 派发 API。Bridge 本身也排除了 Canvas 替代面板。[S2，1461–1463][S14][L2，1–2]
- `tern.on` 只有文档列出的 window/host 生命周期事件；没有公开 `emit_native`、`post_action` 或可写 native event queue。host effects 的 queued-after-return 是 toast/open/copy 等，不包含 layout/PiP。[S14][S9]

## 4. 原子校验与异步动作：没有被现成 API 补齐的部分

### `ctl --file` 不等于事务

同一连接上逐条发送、每条等 reply；control command 串行。它不承诺 UI 输入/远端更新不会在命令间发生，也没有 `if focused == … then pip` 的普通脚本语法。因此 `state → 验证 → focus → pip float` 是跨请求 TOCTOU，不适合自动操作真实用户窗口。[S5]

### `tern pip BLOCK --over OWNER --corner tr --window KEY` 更接近所需操作

它在同一请求里明确 block/owner/corner，**不用**依赖 `@focused`，比 `ctl pip float` 少了一个焦点竞态。`[INFERENCE]` 可由 helper 在提交前验证本次 Bridge panel nonce、session、host、pane/owner，并要求双方仍然存在；但帮助未给出 expected generation / expected owner token / compare-and-swap，不能将多步验证称为原子，也不能承诺原生内部以单事务验证全部条件。远端 pane 的 CLI 表示与作用域仍须解决。[C1][S10]

### `carly lua` 是单次可编程请求，但不是已证明的事务

`tern ctl --control EP carly lua "<code>"` 可以运行真实 shared window APIs。可在一个 Lua 请求中先检查两个 pane 的 block kind、surface owner nonce、session/host/tab，再调用 `layout:float`，而不是两次 ctl 请求间切焦点。[S5][S15]

但必须保留限制：

- Carly Lua 支持 preemption/await；官方没有说多个 API 调用构成不可抢占事务。不能把“一条 command”写成“已保证原子”。[S16]
- 仍调用同一个 shared `layout:float`，不能假设绕过已知 remote pane lookup 问题；也不能假设 Carly 有无限预算。[S2][S16]
- `carly lua` 会把 literal output 放入会话 turn，持有 conversation-local VM；工具错误可能只是 error answer，脚本成功退出不代表工具成功，应检查 `carly ok`/`state.carly.last_tool`。作为静默 Bridge 基础设施有可见副作用，优先级低于 native typed CLI。[S15]
- 不需要也不应为此新增 Bridge Carly exports；它们仍按普通 plugin 50 ms 执行，并会扩大 Bridge 入口面。[S8][L2，1–2]

`cx.layout:arrange` 的确有原子 regroup/预校验契约，但它的 spec 只有 session/tabs/blocks/split/rest，没有 float/owner/corner；不能借它冒充 atomic PiP。[S2，925–937、1522–1524][S16]

## 5. 最有希望的后续实测路径（本研究未执行）

| 优先级 | 路径 | 精确 API / 最小观察目标 | 硬门槛 |
| --- | --- | --- | --- |
| 1 | **身份已绑定的后台 typed PiP CLI** | 在隔离、显式绑定窗口内，从 `tern.process.run` 运行 `tern pip <确证的CLI pane> --over <确证的CLI owner> --corner tr --window <确证的KEY> --json`；只观察其本次 panel 是否 float、owner/corner 是否正确。[C1][S4] | 本机 GUI KEY 与 pane native 表示必须来自可靠映射，不可用 Lua 数字强转、标题模糊匹配、第一窗口或 `@focused`。目前身份来源尚未闭环。 |
| 2 | **`TaskInfo.window` 精确反查实验** | 在当前 VM 的 scoped callback 创建一条明确不会触发模型/动作的短期实验任务，按 `schedule` 返回的 id 在 `tasks()` 中找唯一 row，记下 `window`，随后 `cancel(id)`；只读验证该字符串是否能定位同一窗口。[S8] | 这是会写持久任务的实验，须另获许可。check 要对 `dry_run/resume/live` 都不做事、不返回用于触发模型的内容；只取消自己的 task。重点验证 CLI KEY 等价、同 session 两窗口、reload/reopen 生命周期。未通过前不可用于生产。 |
| 3 | **独占已知 EP 的单请求 guarded native操作实验** | 隔离窗口显式 `--control EP`；研究单个 `carly lua` 中 guard + explicit `layout:float`，并读取结果；或让上游新增 typed guarded native PiP 命令。[S5][S15][S16] | 现有 helper 不得猜 EP；Carly 可见 turn / preemption / shared API 故障均需接受并测清。上游原子接口是建议，不是已有 API。 |
| 4 | **shell spawn 的环境关联** | host `spawn` 只记录原生提供的 pane/key，不改 env；结合既有 Bridge owner nonce 判断它能否建立原窗口映射。[S9] | plugin block 不 spawn；远端 daemon key 不是本机 GUI key；旧 pane / 多观察窗口都需检验。不得通过向用户 shell 注入命令来补取身份。 |
| 对照 | **单个原生 PiP action 的计时归因** | 在已授权隔离窗口，对比 Lua hook 内 `cx:command("pip")` 或 `cx:action("pip")` 与显式 EP 的 `plugins run pip`，单动作、不串 corner/resize；区分动作效果、回调总时间、远端复制时间。[S3][C1] | 这是诊断实验，不是新的产品路线；用户报告的现有失败无需重跑“确认”。需新问题导向证据才能归因，不能宣称换 command 即修复。 |

**实测通过标准建议 `[INFERENCE]`：**同时打开两个窗口（最好同 session）、在请求排队期间切 tab/切 focus、关闭/重建 panel、切远端 host，再发送带旧 nonce 的请求。只有对应 owner 的仍有效 panel 可被改动；缺 key、失配、歧义、pane 消失一律不发写命令。返回 success 也须由后续 fresh scoped `session:layout(tab).floats` / `pane.floating` 确认对象与 owner；这只是结果检查，不补足提交时的原子性。[S2][S5][S10]

尺寸要单独列缺口：`LayoutCx:resize` 调的是 split divider，以 cells 为单位；`ctl pip resize` 调的是 PiP glance/focus 两套 CSS-pixel size，且以 active tab 的 `#n` 排序选卡。`#1` 是最老 card，不是稳定 pane ID。即便 typed `tern pip` 成功，也不等于已有安全的后台 `340×560` 定向 resize 全链路。[S1][S2，1491–1492]

### 后续主窗口身份探测实测

在用户交互批准后，主研究者于当前窗口插件中创建一条 `on="pane_created"`、
`once=true`、`expires="1m"` 的无 prompt 探测记录；check 仅返回 false，
不执行模型或窗口动作。按 schedule 返回的 id 精确查找 tasks()，然后立即 cancel。
结果为 `ok=true, cancelled=true, by="plugin:omp-client-bridge", window=""`。
因此本次没有获得可证明唯一绑定当前 GUI viewer 的非空窗口键；不能把空串
擅自解释为可靠的当前窗口能力，也不能凭此断言它在所有构建上都无效。
临时代码和输出文件已清理。该项更新上述“未执行”的候选状态：已完成一次
单窗口探测，但 CLI KEY 等价和多窗口隔离仍未证实。

### 远端 daemon 路线的跨设备副作用：已否决自动 focus

后续在自有 Bridge-Daemon-PiP-20261028 会话中，通过远端 CLI 的完整原生 pane ID
执行 `tern pip PANEL --over OWNER --corner tr`，本机观察到正确的右上角 PiP。
随后执行远端 `tern focus PANEL`，本机 PiP 进入 focus 模式；用户立即报告：
**所有连接同一 agent host 的设备都被切换窗口。** 这是确定的跨设备副作用，不需要复跑。

因此，远端 pane 精确寻址不等于 viewer 隔离；远端 focus 不能用于本机默认展开。
此前“由 authoritative daemon 执行即可避开窗口绑定问题”的推导不成立。
已停止共享窗口写操作、释放桌面控制；没有通过切回或关闭测试会话尝试恢复，
以免再次改变其他设备的视图。自有测试会话暂留，等待安全的清理范围。
此路线未部署为插件自动化。后续必须证明发起 viewer 的局部作用域，不能用
远端共享 focus 替代；对共享布局操作本身也必须分别标注传播范围。

## 6. 本轮 CLI 一手记录（脱敏）

### C1：帮助与版本

```text
$ tern --version
tern 0.9.5 (2863c37)

$ tern pip --help
tern pip BLOCK [--over BLOCK] [--corner tl|tr|bl|br]
BLOCK is an id, @focused, a title or a program name, as SESSION/BLOCK to
look in one session. --json prints what a command found or did as JSON.
Every command works on one window's sessions: --window KEY's, else the
window of the pane it runs in (its key is $TERN_WINDOW_KEY there), else
the first window.

$ tern inspect --help
tern inspect [--json]                     that, every pane and every client

$ tern help dev
tern ctl [--control EP] COMMAND...
tern ctl [--control EP] --file SCENARIO
plugins run <action>  Runs an action by name, as a key would
                      (new_tab, plugin.hello.say_hi).
```

`tern ctl --help` 不是帮助入口：本机返回 `{"ok":false,"error":"unknown command \"--help\""}`，exit 1；故本轮改读 `tern help dev`，没有继续试验任何 mutation。

### C2：read-only inspect 的 shape

```text
$ tern inspect --json
exit 0
root: sessions, detached, panes, clients
pane keys (union): args, cols, cwd, exited, followed, height, identity,
  keep_open, omp_session_file, pane, program, quiet_ms, rows, title, width, working
client keys (union): conn, identity, kind, since
client kinds seen: window, cli, remote

$ tern inspect --window __bridge_research_no_such_window__ --json
exit 0
sessions: []
detached: []
panes: []
clients: nonempty, same schema
```

未把 session 名称、cwd、身份链、真实 pane ID 或连接端点写入本文。这里的未指定 window 只用于**读 schema**，绝不作为自动写入范例。

## 引用

### 一手源码 / 声明 / 本地记录

- **[L1]** [本机 SDK 快照](../../.scratch/native-repair-sdk/tern.d.luau)：`How` 12–13；`SessionCx` 1441–1476；`LayoutCx` 1479–1525；`WindowCx` 1572–1634；`TaskInfo` 1708–1716；process 1855–1860。
- **[L2]** [Bridge window 实现](../../tern/window.luau)：3、83–89、644–688、849–855（行号为研究时快照）。
- **[L3]** [既有 probe 源码](../../.scratch/bridge-window-context-probe/window.luau) 与 [结果](../../.scratch/bridge-window-context-probe/result.json)：`appWindowKeyPresent=false, appWindowSocketPresent=false, childStatus=1, childWindowKeyPresent=false`。源码直接测试子进程的 key；不把它夸大为已逐项测试子进程全部环境。
- **[U1]** 本次研究任务提供的既有用户现场结果；未在本轮复测。
- **[C1] / [C2]** 本文第 6 节记录的已安装 Tern 自身输出；不是第三方资料。
- **[C3]** 主研究者本次只读 `tern whoami --json` 现场结果，经任务消息交接：插件外调用仅有本机身份 hops；本 worker 未重跑。
- **[S2]** [官方 SDK 固定 revision 的 tern.d.luau](https://github.com/stencil-hq/tern-sdk/blob/9e9c07463f4958b0c633424c9860aba499487d28/plugins/tern.d.luau)。引用行号按源码本身计，不按工具输出的 URL/header 前缀计。
- **[S13]** [官方 SDK README](https://github.com/stencil-hq/tern-sdk/blob/9e9c07463f4958b0c633424c9860aba499487d28/README.md)、[revision 元数据](https://api.github.com/repos/stencil-hq/tern-sdk/commits/9e9c07463f4958b0c633424c9860aba499487d28)、[官方组织仓库目录](https://api.github.com/orgs/stencil-hq/repos?per_page=100)。

### 官方文档

- **[S1]** [Pictures in Picture](https://docs.stencil.so/tern/scripts/pip.md)：创建/选择、尺寸、Timing and parsing。
- **[S3]** [Built-in Actions](https://docs.stencil.so/tern/reference/actions.md)：立即 action dispatch、PiP command ids、keymap。
- **[S4]** [Runtime, Budgets, and JIT](https://docs.stencil.so/tern/concepts/runtime.md)：Budgets、A tripped budget、Timers/process/fetch callbacks。
- **[S5]** [Control Commands](https://docs.stencil.so/tern/scripts/control.md) 与 [Scripts](https://docs.stencil.so/tern/scripts/index.md)：endpoint、wire、逐条回复与 settle。
- **[S6]** [Command Line](https://docs.stencil.so/tern/reference/cli.md#common-behavior)：`--window` 的选择优先级。
- **[S7]** [Chrome and Styling](https://docs.stencil.so/tern/guides/chrome.md)：window title input、status command、formatter budget。
- **[S8]** [Extending Carly](https://docs.stencil.so/tern/guides/carly.md#schedule-reminders-and-watches)：schedule/tasks/cancel、TaskInfo.window、50 ms checks、dry_run/resume。
- **[S9]** [Host Hooks and the Spawn Filter](https://docs.stencil.so/tern/guides/hooks.html#the-spawn-filter)：daemon/window 环境、plugin block 排除、host effects。
- **[S10]** [Layout and Workspaces — IDs](https://docs.stencil.so/tern/guides/layout.md#ids) 与 [Window API — Pane and tab ids](https://docs.stencil.so/tern/reference/api-window.md#pane-and-tab-ids)。
- **[S11]** [Supported CSS](https://docs.stencil.so/tern/styles/css.md#stencil-extensions)：属性范围与 native effects。
- **[S12]** [HTML Elements](https://docs.stencil.so/tern/elements/el.md#attributes)：属性 allowlist 与 Actions on any el。
- **[S14]** [Events](https://docs.stencil.so/tern/reference/events.md)：事件集合、pane_created 限制、Canvas action 的 after-return delivery。
- **[S15]** [Carly scripts — Real tools and assertions](https://docs.stencil.so/tern/scripts/carly.md#real-tools-and-assertions)：lua output、error answer、pending tools。
- **[S16]** [Window API](https://docs.stencil.so/tern/reference/api-window.md)：Carly preemption/await、Window cx、Layout cx、One-call grouping。
