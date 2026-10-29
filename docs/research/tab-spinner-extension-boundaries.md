# Tab Spinner：原生 Tab 样式与扩展边界

## 结论与证据范围

**`tern-tab-spinner` 不是替换 Tab 图标的接口示例，更不是向 Tab 栏注入按钮的示例。** 它通过 window 插件的 `tern.css`，为原生左侧竖排 Tab 的现有图标容器绘制 `::after` 装饰：保留图标，在其外围添加运动高亮；不改标题、不注册点击动作、不新增 pane 或替代侧栏。[S1][S2][S3]

本次读取实际 `window.luau`、`plugin.toml`、作者 README 和官方 SDK 文档；插件源码固定为提交 `bcbb3ed24ef62ad010b44898cd669c74f4cdbdd7`，manifest 版本 `0.2.1`。[S1][S2] 未安装插件、未运行测试、未操作 UI；下述视觉运行结果均明确归属于作者报告，不代表本机 macOS 验证。标记 `[INFERENCE]` 的内容是基于这些接口的设计推断。

## 1. 它究竟改了什么

manifest 只有 `schema`、`id`、`name`、`version`、`description` 和 `window = "window.luau"`；没有 host 入口或 manifest `styles`。整个 window 入口只调用一次 `tern.css("spinner", [[…]])`，没有其他注册或业务逻辑。[S1][S2]

| 候选机制 | 实际情况 | 证据 |
| --- | --- | --- |
| 替换原生图标文件、glyph 或 icon 名称 | **没有**。没有图标资源、`url()`、隐藏原 glyph 的规则或 icon setter；改变的是图标外围视觉。 | [S1][S2] |
| 在现有图标上生成伪元素装饰 | **有**。选择器为 `#sidebar .tn-vt .nav-row.working > .tn-dk::after`。 | [S1] |
| 重写 Tab 标题 | **没有**。未调用 `tern.chrome.tab_title`。 | [S1] |
| 添加独立可点击 Tab 栏按钮 | **没有**。没有按钮节点、command 注册或点击回调；装饰明确 `pointer-events: none`。 | [S1] |
| 替换侧栏、创建额外 pane | **没有**。入口没有 UI 构建或 layout 调用。 | [S1][S3] |

实现细节如下：[S1]

1. 对 working 图标容器设置 `position: relative; overflow: visible`。
2. 以 `content: ""` 生成 `::after`；绝对定位，四边均为 `-3px`，不是重新绘制原图标。`0.2.1` 使用相对图标的四边偏移，而非固定宽高。
3. 装饰使用 `padding: 2px`、`border-radius: 6px` 和两层白色渐变 mask；`mask-clip: content-box, border-box` 配合 `mask-composite: exclude` 挖掉中心，避免高亮盖住图标。
4. `perimeter-gradient(6px, phase, …)` 的 phase 从 `0` 动画到 `1`，周期 `1s linear infinite`；方框和图标本身不旋转。`--accent` 提供主题色。

官方将 `::after` 定义为在设置 `content` 后产生的生成框，将 `perimeter-gradient` 定义为沿圆角矩形周长顺时针布置颜色的原生扩展。这是 **Tern 自有渲染引擎的 CSS**，不是向浏览器页面注入 JavaScript/DOM。[S7]

### “覆盖伪元素”需要保留的限定

可以确证它向现有容器的 `::after` 写入样式；不能据此断言原生样式原本就有同用途的 `::after`，或已经覆盖掉某个原生标记。本次没有读取目标版本内部 Tab 样式。作者声明既有 gradient 和 attention 指示器不受影响，但这仅是该插件作者的描述及其所列验证范围。[S1][S3]

`[INFERENCE]` 如果其他插件或未来 Tern 版本也使用这个元素的 `::after`，会发生同一伪元素上的样式竞争，而不是自动得到第二个独立装饰层；官方级联规则说明插件样式在原生样式之后，同 specificity 可胜出，插件间顺序则不应依赖。[S4][S8]

## 2. working 状态、点击与减少动态效果

### 状态由 Tern 提供，不由插件检测

插件只匹配 `.nav-row.working`，不订阅事件、不检查进程、不轮询、不计时计算任务状态。没有 `.working` 时，这组插件装饰规则不再命中；它不是进度百分比或 Bridge 连接/授权状态的实现。[S1][S3]

作者报告：在 Tern `0.9.5 (2863c37)` Linux 原生桌面版中，测试程序发出 OSC `9;4;3` 后出现 indeterminate progress，随后发出 `9;4;0` 清除，Tab 的活动装饰随之消失。这证明的是**作者所测构建中的一条状态输入路径**，不是所有版本 `.working` 的完整状态机契约；本次未独立复现。[S3]

不要把 `.working` 直接等同于 chrome formatter 的 `busy`。官方 `tab_title` 将 `busy` 描述为 Tab 中是否有命令运行；Window API 的 `status` 则明确其 `busy` 来自 shell integration，未集成的程序不会靠进程存活推断活动。已读文档没有把这些字段与内部 `.working` 定义为完全等价；spinner 本身也不读取 `busy`。[S1][S5]

### 点击穿透，而不是获得新点击入口

源码把 `pointer-events: none` 放在装饰伪元素上，作者明确说明该生成框不拦截点击、不增加布局宽度；官方原生 CSS 支持该属性。[S1][S3][S7] 因而插件意图是保留原有 Tab 点击行为，不创建独立命中目标。本机实际命中行为未验证。

`[INFERENCE]` 把这个值改成 `auto` 不能单凭这一改动就宣称获得“点击打开 Bridge”的按钮：仍缺独立命令绑定、目标语义和可访问性契约。实际插件没有这些代码；官方已记录的可点击 chrome 扩展是带 `command` 的 status segment，位置在 status line 而非 Tab 栏。[S1][S4][S5]

### reduce-motion 不是完全隐藏状态

`@media (prefers-reduced-motion: reduce)` 仅将动画改成 `none`，基础 `background-image` 的 phase `0` 仍在，因此高亮静止而非消失。作者报告开启 Tern reduce-motion 后相隔 250ms 的图标截图一致；这是作者验证，不是本机实测。[S1][S3]

官方特别说明自定义动画**不会自动**因 reduced motion 停止，需自己写 media query。这条处理可以复用，不能只复制 keyframes 而遗漏它。[S7]

## 3. 三类能力必须分开

| 层次 | 官方已记录能力 | 不能混同的能力 |
| --- | --- | --- |
| 原生 Tab 的样式 | `tern.css(name, source)` 安装全局 author sheet；选择器可以命中窗口已有元素。spinner 是对内部竖排 Tab 选择器的实例。 | 不是新增语义节点/事件回调的 API；成功画出图形不能证明增加了按钮。[S1][S4][S5] |
| Tab 标题格式化 | `tern.chrome.tab_title(fn)` 返回 `string?`；多个插件按 id 顺序第一个非空结果获胜。 | 返回值不是 UI tree、icon slot 或点击 handler。若尊重用户命名，应先检查 `tab.name`。[S4][S5] |
| 状态栏格式化与动作 | `tern.chrome.status(fn)` 返回 `{text, icon?, tone?, command?}` 列表；`command` 让 segment 获得 `.on`、`role="button"` 并运行动作。 | 这是 status line 末端的点击入口；状态栏关闭时不显示，不是 Tab 栏按钮。[S4][S5] |
| 真正新增独立可点击 Tab 栏按钮 | **本次读到的 chrome API 没有记录这一挂载接口；spinner 也未实现。** | 不能从“未找到文档”推导出 Tern 内部、其他版本或未来接口绝对不可能实现。[S1][S4][S5] |

chrome formatter 是纯格式化函数：没有 `cx`，4ms 预算，按输入缓存；每个插件每种 slot 只有一个 formatter，再注册会替换。外部状态改变时，可在事件或异步回调中调用 `tern.chrome.refresh()`，不能在 formatter 内调用它。[S4][S5] 因此标题上的“Bridge”文本、状态栏上的 Bridge 点击 segment，以及 Tab 栏上一个新增按钮，是三个不同交付物。

官方确有**其他部位**替换图标的示例：Files pane 用 `.ft-ic[data-…]` 设置 `background-image: url(…)` 并隐藏原 `svg.ico`。这是 Files 的已记录属性与结构，不是原生 Tab 图标 setter，也不是 spinner 采用的实现。[S4]

## 4. 版本与部署风险

- **作者验证范围有限。** README 仅列 Linux 原生 Tern `0.9.5 (2863c37)`、深色、竖排 Tab；其他平台和版本未验证。`0.2.1` 的字体适配检查只报告 UI 字号从 13 增到 15px，不能扩展成 macOS、任意字号或任意缩放保证。[S3]
- **公开入口不等于稳定内部选择器。** `tern.css` 有官方契约；`#sidebar .tn-vt .nav-row.working > .tn-dk` 则被插件作者明确称为内部 UI selector，结构与图标尺寸可能变化；横向 Tab 是故意不处理，不是遗漏了标题接口。[S3][S5]
- **CSS 不是浏览器全集。** `perimeter-gradient` 是 Stencil 扩展，mask、动画和 media query 需目标构建支持；解析错误不会让 `tern.css` 抛异常，而会记入日志并丢弃不能用的规则/声明。因此“入口加载完成”不是“装饰渲染正确”的证据。[S5][S7]
- **全局级联与动画名。** 插件 sheet 未自动隔离，keyframes 名同样全局。复用时应给 selector、动画名加 Bridge 自己的作用域/前缀，而非继续覆盖原生 Tab 或复用 `tab-spinner-turn`。[S8]
- **部署边界。** 该插件只有 window 入口中的 `tern.css`，没有 manifest `styles`。官方说明远端 host 的 window half 不会在本机窗口运行，只有 manifest styles 随远端插件传播；web tab 无 window Lua，收不到 `tern.css` sheet。不能把该插件装在远端 daemon 上就假定所有客户端获得效果。[S2][S4][S5]

## 5. 对 Bridge 入口与 PiP 样式的可复用点

以下是设计建议，不是已实现或经本机运行验证的方案。

### 入口：优先复用有行为契约的路径

- `[INFERENCE]` 如果接受**状态栏入口**，可让 Bridge 的 status formatter 返回带 `icon`、`text`、`command = "plugin.<实际插件ID>.<实际命令ID>"` 的 segment，并调用已有 Bridge 打开命令。官方 `tern.command` 可注册该 action，status 的点击行为有文档支持；它仍受状态栏可见性限制。示意标识不是本仓库已核实的命令 ID。[S4][S5]
- `[INFERENCE]` 如果只需**原生 Tab 上的活动提示**，可以借鉴“真实状态驱动装饰，而不是根据进程存活猜测”的原则；但不能用 `.working` 冒充 Bridge 已连接、设备已授权或任务等待用户批准。spinner 没有这些状态来源。[S1][S3]
- `[INFERENCE]` 如果要求**Tab 栏新增专用 Bridge 按钮**，本研究没有可直接复用的已文档化挂载方案；需要另行取得目标版本的按钮注册/点击分发证据，而不是把 CSS 装饰或标题字符当作完成。[S1][S4][S5]

### PiP：复用视觉技术，不混同窗口行为

- `[INFERENCE]` 对已经存在且可寻址的 Bridge 内容 surface，可复用主题变量、图标周边的轻量装饰、点击透明的非交互层与 reduced-motion 分支。优先使用自有 `[data-role]` 或 `.sf-main[data-surface='plugin.<plugin>.<block>']` 等官方 hook，不直接复制原生 Tab 的内部 selector。[S4][S7][S8]
- `[INFERENCE]` 如果 Bridge 内容确实运行在原生 PiP 容器中，上述方法可以作为**内容区域**样式候选；是否能命中该 PiP 的原生外框、阴影、标题区以及尺寸行为，本研究未取得专用 selector/接口证据。不能仅由“插件 CSS 全局可达”推导出这些目标一定暴露。[S4][S8]
- **自动 PiP 不由此插件解决。** `window.luau` 没有检测 Bridge pane、监听 tab/focus/window 事件、打开/关闭/切换 PiP 或保存其生命周期状态的代码。即使装饰渲染完全正确，也没有实现“自动出现/收起 PiP”；这部分必须由另一个经确认的行为 API 和目标识别逻辑完成。[S1]
- `[INFERENCE]` 同理，装饰层不能解决 Bridge 入口指向哪个 pane、跨窗口/远端目标识别、连接权限或设备绑定，也不能证明 PiP 不抢焦点、不重复创建。这些不是该源码包含的行为，需独立验证，不能从其作者的视觉 smoke test 继承保证。[S1][S3]

## 一手来源

- **[S1] 固定提交的实际 `window.luau`**：https://github.com/jorgoose/tern-tab-spinner/blob/bcbb3ed24ef62ad010b44898cd669c74f4cdbdd7/window.luau （入口与规则 `L1–L42`；原始内容：https://raw.githubusercontent.com/jorgoose/tern-tab-spinner/bcbb3ed24ef62ad010b44898cd669c74f4cdbdd7/window.luau）。
- **[S2] 固定提交的实际 `plugin.toml`**：https://github.com/jorgoose/tern-tab-spinner/blob/bcbb3ed24ef62ad010b44898cd669c74f4cdbdd7/plugin.toml 。
- **[S3] 插件作者的行为、兼容性与验证说明**：https://github.com/jorgoose/tern-tab-spinner/blob/bcbb3ed24ef62ad010b44898cd669c74f4cdbdd7/README.md#behavior 、https://github.com/jorgoose/tern-tab-spinner/blob/bcbb3ed24ef62ad010b44898cd669c74f4cdbdd7/README.md#compatibility 、https://github.com/jorgoose/tern-tab-spinner/blob/bcbb3ed24ef62ad010b44898cd669c74f4cdbdd7/README.md#verification 。
- **[S4] 官方 Chrome and Styling**：https://docs.stencil.so/tern/guides/chrome.md#formatters 、https://docs.stencil.so/tern/guides/chrome.md#status-segments 、https://docs.stencil.so/tern/guides/chrome.md#global-css 、https://docs.stencil.so/tern/guides/chrome.md#file-icons 。
- **[S5] 官方 Window API**：https://docs.stencil.so/tern/reference/api-window.md#terncommand 、https://docs.stencil.so/tern/reference/api-window.md#chrome-formatters 、https://docs.stencil.so/tern/reference/api-window.md#ternchromestatus 、https://docs.stencil.so/tern/reference/api-window.md#terncss 。
- **[S7] 官方 Supported CSS**：https://docs.stencil.so/tern/styles/css.md#images 、https://docs.stencil.so/tern/styles/css.md#pseudo-elements 、https://docs.stencil.so/tern/styles/css.md#interaction-and-scrolling 、https://docs.stencil.so/tern/styles/css.md#transitions-and-animations 。
- **[S8] 官方 Styling Views**：https://docs.stencil.so/tern/styles/index.md#plugin-sheets 、https://docs.stencil.so/tern/styles/index.md#the-cascade 、https://docs.stencil.so/tern/styles/index.md#stable-hooks 。
