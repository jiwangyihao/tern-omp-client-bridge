# 安装指南

本文面向安装或升级到 `v0.5.0-beta.2` 的用户。推荐先下载并校验发行包，通过 Tern 原生安装器安装本机插件，再在 **OMP → Set up Bridge** 中授权远端初始化。此路径不需要全局安装 Bun，也不依赖已发布的 npm 全局包。

这是 Windows 适配修复预发布版本，包含原生权限、运行时引导、命名管道、上传发布及通用 SSH 设置修复。`v0.5.0-beta.1` 的 Windows CI 失败记录与旧附件保留不变；不要将旧附件视为已更新。macOS PiP 几何与焦点、完整跨设备 GUI 行为仍需分别验收。[原生平台 CI](https://github.com/jiwangyihao/tern-omp-client-bridge/actions/workflows/native-runtime.yml)、[验证记录](verification.md)与[兼容性说明](compatibility.md)区分发布版本、实际验证和未验收范围。

## 1. 准备本机与 Agent 主机

| 位置 | 必要条件 |
| --- | --- |
| 本机客户端 | 已正常登录的原生 Tern GUI、可用的原生 Tern CLI、OpenSSH `ssh` 和 `tar`。使用预期的交互用户运行，并通过 Tern 连接目标主机。 |
| Agent 主机 | 可通过 SSH 访问的 POSIX Linux 或 macOS，架构为 x64 或 ARM64；具备 POSIX shell、`sh`、`tar` 及常规文件工具。已安装兼容的原生 OMP 与 Tern，非交互 SSH 环境能够找到 `omp`。 |
| 两端 | 可写的私有状态目录、足够的存储空间，以及访问 GitHub 发行附件和依赖 registry 的网络条件。初始化不安装 OMP 或 Tern 本身，也不使用 `sudo`。 |

macOS/Linux 的私有运行时下载还需要 `curl`、`unzip` 和 `sha256sum` 或 `shasum`。Windows 客户端需要原生 `powershell.exe`，用于引导及私有 ACL；使用原生 Windows Tern、SSH 和文件路径，不能用 WSL 安装代替。运行时引导覆盖 x64/ARM64，具体操作系统仍须满足 Bun 的平台要求。

Windows 私有 ACL 通过 Windows PowerShell 5.1 的 .NET 文件系统 API 设置，不依赖 `Set-Acl` 自动加载；引导进程仅对自身固定系统模块路径，避免继承 PowerShell 7 的不兼容模块。权限保护失败会停止初始化，不写入未经保护的进度或凭据。已有进度文件与私有 Bun 的替换使用原子 `File.Replace`，不会先删除旧文件。

完整初始化会准备受支持的 Bun **>=1.4.3**，已有兼容运行时可被复用，否则下载经校验的私有运行时；依赖按锁文件安装，原生 SDK 固定为 **18.10.4**。不要将另一操作系统的 `node_modules` 复制过来。Python、浏览器、桌面和 ADB 的额外条件见[兼容性说明](compatibility.md)。

### 先建立可信的非交互 SSH

以下 `bridge-agent` 只是示例别名，请替换为自己配置的目标主机及账号对应的 SSH 别名。

1. 先从可信渠道核对主机密钥指纹，再由本人完成首次 SSH 连接与信任设置。不要关闭主机密钥检查来绕过失败。
2. 配置无需交互输入密码的认证，并在本机终端执行下面的只读检查。

```sh
ssh -T -o BatchMode=yes -o ForwardAgent=no -o StrictHostKeyChecking=yes bridge-agent "printf 'ssh-ok\n'"
```

应成功退出并输出 `ssh-ok`。若出现密码提示需求、未知或变更的主机密钥、超时，先修复 SSH。非交互 shell 不应向标准输出写入欢迎横幅等额外内容。Bridge 使用独立的出站 SSH 连接，Tern 已连接远端并不代表此通道已经可用；本机无需运行 SSH 服务。不要复制私钥、登录配置或另一设备的身份文件来完成初始化。

设置界面会用本机 OpenSSH 配置识别相关别名，并在显式检查时顺序探测多个候选，
不需要 Agent 后台写入机器专属映射。Windows 系统 OpenSSH 和 Git/MSYS OpenSSH
使用不同的诊断路径格式，插件按实际工具链解析；不会把 `/c/...` 误读为 `C:/c/...`。
手动编辑的目标拥有优先权，失败后保持可编辑。多候选探测不会自动安装组件。

## 2. 下载并校验发行包

打开 [`v0.5.0-beta.2` 发行页](https://github.com/jiwangyihao/tern-omp-client-bridge/releases/tag/v0.5.0-beta.2)，在 **Assets** 中选择对应附件，并下载同页的 `SHA256SUMS`。

| 建议使用环境 | 附件 |
| --- | --- |
| macOS / Linux | `tern-omp-client-bridge-v0.5.0-beta.2.tar.gz` |
| Windows PowerShell | `tern-omp-client-bridge-v0.5.0-beta.2.zip` |

两种压缩包包含相同的源码保留型包结构，没有捆绑 `node_modules`、凭据或原生可执行文件。本指南使用上述发行附件，不使用 GitHub 自动生成的 **Source code** 压缩包。校验和用于核对下载内容，不能替代对发行来源的信任。

### macOS / Linux

在一个新的下载目录中执行，避免覆盖已有的解压目录。

```sh
version=v0.5.0-beta.2
package="tern-omp-client-bridge-$version"
archive="$package.tar.gz"
base="https://github.com/jiwangyihao/tern-omp-client-bridge/releases/download/$version"
curl --fail --location --proto '=https' --proto-redir '=https' -o "$archive" "$base/$archive"
curl --fail --location --proto '=https' --proto-redir '=https' -o SHA256SUMS "$base/SHA256SUMS"
```

只校验本次下载的附件。macOS 使用下面的命令。

```sh
awk -v name="$archive" '$2 == name || $2 == "*" name { print }' SHA256SUMS | shasum -a 256 -c -
```

Linux 使用下面的命令。

```sh
awk -v name="$archive" '$2 == name || $2 == "*" name { print }' SHA256SUMS | sha256sum -c -
```

**仅当对应文件显示 `OK` 且命令成功退出时继续。** 没有匹配记录、下载失败或摘要不一致时停止安装，重新核对发行页与文件，不跳过校验。

```sh
tar -xzf "$archive"
tern plugin dir
tern plugin list
tern plugin install "$(pwd)/$package"
```

### Windows PowerShell

在原生 PowerShell 中进入新的下载目录，执行以下命令。不要在 WSL 中运行。

```powershell
$ErrorActionPreference = 'Stop'
$Version = 'v0.5.0-beta.2'
$Package = "tern-omp-client-bridge-$Version"
$Archive = "$Package.zip"
$Base = "https://github.com/jiwangyihao/tern-omp-client-bridge/releases/download/$Version"
Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Archive" -OutFile $Archive
Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHA256SUMS" -OutFile SHA256SUMS
$Pattern = '^[0-9a-fA-F]{64}\s+\*?' + [regex]::Escape($Archive) + '$'
$Entries = @(Get-Content -LiteralPath .\SHA256SUMS | Where-Object { $_ -match $Pattern })
if ($Entries.Count -ne 1) { throw 'Missing or duplicate checksum entry.' }
$Expected = ($Entries[0] -split '\s+')[0]
$Actual = (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash
if ($Actual -ne $Expected) { throw 'SHA-256 mismatch. Do not install.' }
Write-Output 'SHA-256 OK'
Expand-Archive -LiteralPath $Archive -DestinationPath .
$PackageRoot = (Resolve-Path -LiteralPath ".\$Package").Path
tern plugin dir
tern plugin list
tern plugin install $PackageRoot
```

### 确认包根目录与已有安装

解压后应只有一个顶层目录 `tern-omp-client-bridge-v0.5.0-beta.2`。传给 `tern plugin install` 的必须是这个目录的绝对路径，根目录内应有 `plugin.toml`、`package.json`、`bun.lock`、`tsconfig.json`、`README.md`、`LICENSE`，以及 `src/`、`scripts/`、`tern/`、`docs/`。不要只安装其中的 `tern/`，也不要向安装器传入压缩文件路径。

原生 `tern plugin install` 会复制插件并重载插件列表，不会因此下载 Bridge 运行时、连接 SSH 或启动 Bridge 服务。

- **已有安装副本**时，先确认 `tern plugin dir` 和 `tern plugin list` 指向预期 profile，再给原安装命令追加 `--force`。例如 `tern plugin install "/absolute/path/to/tern-omp-client-bridge-v0.5.0-beta.2" --force`。
- **已有 linked package** 时，`--force` 不会覆盖链接。若确定切换为发行包副本，先执行 `tern plugin unlink omp-client-bridge`，再安装解压目录；保留原链接指向的源码目录。不要直接删除 `.path` 文件或对未知目录递归删除。
- 多 profile 或隔离配置必须与实际使用的 Tern daemon 一致。新 profile 需要单独完成正常登录与首次设置，不能复制其他 profile 的凭据。

此时只完成了插件安装，继续下一节。

## 3. 在侧栏授权初始化

1. 在 Tern 中选择预期的远端主机，打开命令面板中的 **OMP → Set up Bridge**。初始化状态会保留在原生侧栏中。
2. 冷主机可能先要求一次**仅准备界面**的确认。该阶段通过 Tern 已连接的主机通道准备小型侧栏界面，不建立新的 SSH 连接，不安装 Bun/SDK，不启动 broker/client，也不重启 OMP。它不等于完整安装授权。
3. 在侧栏核对目标主机及 SSH 地址。需要改目标时使用 **Change**；手动地址通过 **Check SSH** 检查。已有已知地址的主机选择可能自动开始一次只读检查。修改地址后必须重新检查。
4. 核对安装目的地与变更范围后，点击侧栏中的 **Install**，单独授权私有运行时、依赖、两端集成与后台服务。身份文件保留；初始化不会修改全局 shell profile、SSH 信任、Tern 快捷键或现有会话绑定。
5. 查看同一侧栏中的进度或失败原因。关闭侧栏不会取消已经授权的后台安装；重新打开可继续查看。安装目标在选择时已固定，切换标签页不会将安装转移到其他主机。
6. 安装完成后，在**同一目标主机**新建一个 OMP 会话，使其通过原生扩展加载器加载 Bridge。聚焦该会话并打开 **OMP → Toggle Bridge**，完成真实会话握手。不要为了安装自动重启或关闭正在使用的旧会话。
7. 确认设备在线后，使用 **OMP: Select agent client** 或 Bridge 的设备状态区域，为该会话显式选择设备。新会话默认为 **Unbound**；**This device** 表示当前查看者，不一定是 Agent 已选的执行设备。

绑定决定 Agent 的客户端工具执行目标，授权仍受客户端原生 Agent 策略和操作系统权限限制，**绑定不构成沙箱**。仅使用人工传输时可以保持未绑定。原生文本和图片粘贴保持不变，**Paste to remote** 与 **Upload file** 是单独的人工操作入口。详见[使用说明](usage.md#choose-the-shared-execution-target)与[安全边界](security.md)。

## 4. 分层确认就绪状态

| 层次 | 可观察结果 | 尚不能据此认定 |
| --- | --- | --- |
| 插件安装 | 在实际使用的 Tern daemon 中，`tern plugin list` 能识别 `omp-client-bridge`，且没有相关加载问题。daemon 未运行时，该命令可能只列出磁盘目录。 | Bridge 服务已启动或远端会话可用。 |
| 客户端连接 | 侧栏确认签名注册，设备状态在线。 | `Awaiting OMP session` 仍未达到完整就绪；手工命令的 `client-ready` 也只表示本地 UI endpoint 可用。 |
| 会话与主机就绪 | 新 OMP 会话完成真实视图握手，主机插件确认就绪，侧栏不再要求 **Reload host plugin** 或 **Service update required**，并报告 Bridge 就绪。 | 已授权 Agent 使用客户端，或浏览器/桌面已获权限。 |
| 实际 UI 与绑定 | Bridge 面板实际出现在预期会话中；需要 Agent 客户端能力时，绑定显示自己选择的在线设备。 | 所有平台的 PiP 几何、焦点、剪贴板和桌面行为均已验收。 |

本指南的安装完成标准是前三层均满足，并能在目标会话观察到 Bridge 面板；Agent 客户端操作还需要第四层的显式绑定及对应原生授权。HTTP 响应成功、文件已复制或服务进程存在，都不能替代这些观察。

## 5. 高级维护 executable、socket 与隔离目标

普通安装无需执行本节。自定义 Tern 位置、迁移 CLI 或修复 daemon 路由时，原生安装副本使用项目实际提供的 `setup` 命令。此高级路径需要可用的 Bun **>=1.4.3** 和包依赖；不假设存在全局 `tern-omp-bridge` 命令。

取一份已校验的发行包作为长期保留的维护副本，进入其根目录。不要在 setup 管理的不可变运行包目录中安装或修改依赖。以下路径均为示例，先替换为当前机器的真实路径。

**下面的 `setup` 会执行完整初始化，可能准备远端依赖并启动服务，不只是修改两个路径字段。** 先核对主机、原有插件数据目录和变更范围，接受这些变更后再执行。`--plugin-data` 必须指向当前 profile 已使用的 `plugin-data/omp-client-bridge`，以保留其连接配置与身份。

```sh
cd "/absolute/path/to/maintenance-package"
bun install --frozen-lockfile --ignore-scripts
bun src/cli.ts setup \
  --host bridge-agent \
  --plugin-data "/absolute/path/to/tern-data/plugin-data/omp-client-bridge" \
  --package-root "$(pwd)" \
  --tern-executable "/absolute/path/to/tern" \
  --tern-pane-socket "/absolute/path/to/daemon.sock"
```

- `--tern-executable` 必须是本机可执行文件的绝对路径。Windows 使用真实 `.exe`，例如 `C:\Program Files\Tern\tern.exe`，不接受 `.cmd`、`.bat` 或 WSL 路径。显式错误路径会失败，不会悄悄改用另一程序。
- `--tern-pane-socket` 指向**已有的本机原生 daemon**。Windows Tern 0.9.7 默认使用 `\\.\pipe\tern-<USERNAME>` 命名管道；优先保留已有配置或 `TERN_PANE_SOCKET` / `TERN_DAEMON_SOCKET`，不要填 `%APPDATA%\Tern\daemon.sock`。Linux 优先使用 `$XDG_RUNTIME_DIR/tern/daemon.sock`，未设置时与 macOS 一样使用 settings 目录中的 `daemon.sock`。自定义路由必须以实际 daemon 为准；命名管道不能填入 `--tern-executable`。
- `ternExecutable` 和 `ternPaneSocket` 都是机器本地配置；`setup` 的同名覆盖参数只作用于客户端，不会经 SSH 转发给主机。主机必须独立解析自己的路径。仍被服务引用的维护副本及其依赖不能移动或删除。
- 若此前使用了 `setup --remote-root`、`--agent-dir` 或 `--tern-dir`，重试时保留原值。这三项均为远端绝对 POSIX 路径，不能填客户端路径；`--plugin-data` 本身不会让运行中的 Tern 切换 profile。

对于原先由 `install-tern` 管理的手工安装，可使用 `bun src/cli.ts install-tern --control-file "/absolute/path/to/existing-bridge-state/client.json" --tern-executable "/absolute/path/to/tern" --tern-pane-socket "/absolute/path/to/daemon.sock"` 维护。该有限命令不启动服务，但不要与原生安装器混用；覆盖原生完整副本可能因文件归属校验触发 `INSTALL_CONFLICT`，应改用前述 `setup`，不要删文件绕过。`--control-file` 应保留原配置使用的 `client.json` 路径，不能填 `identity.json`；省略它会采用默认状态目录，可能偏离已有 setup 配置。

`install-tern --target PATH` 将 Tern 插件配置与数据同时写入该目录，不会让正在运行的 Tern 自动切换 profile。隔离目标不能仅凭目录推导 daemon，应显式提供 socket 或确认保存的路由正确。完成后只重载对应 daemon 的插件，例如在目标路由下执行 `tern plugin reload omp-client-bridge`。完整手工部署见[高级用法](usage.md#advanced-install-from-source-on-both-machines)。

## 6. 常见故障与恢复

| 现象 | 处理方式 |
| --- | --- |
| `spawn tern ENOENT`、`TERN_EXECUTABLE_NOT_FOUND` 或 GUI 中找不到命令 | GUI 不一定继承登录 shell 的 `PATH`。确认本机原生 CLI 存在，通过上一节保存正确的 `--tern-executable`，再重载正确的插件。远端需要独立检查；不要把客户端路径复制过去。 |
| 找不到 socket，或错误指向 `/tmp/tern.sock` | 不要猜测该路径就是当前 daemon。核对机器本地 `ternPaneSocket`、Linux runtime 目录与正在使用的 profile，通过 `--tern-pane-socket` 修复。不要为此启动 `tern serve`、清空 daemon 状态或自动重启 daemon。 |
| SSH 检查或客户端注册失败 | 查看候选来源和每次检查结果。可选择 **Find SSH alternatives** 重新发现配置，或在 **SSH destination / Edit SSH** 中输入终端使用的别名。手动检查失败不会自动换目标，也不需要重新生成密钥。配置读取或路径转换失败会明确提示；保留 `BatchMode=yes` 和严格主机密钥检查。 |
| 从 Windows 发送后报 `set: Illegal option -` | POSIX 脚本可能带有 CRLF。源码的 `.gitattributes` 固定 `.sh` 及界面清单使用 LF；重新部署修复后的完整包，不修改远端 shell 来忽略 CR。 |
| 引导只显示笼统的运行时失败 | 查看私有 `setup.log` 中的实际阶段。Windows 引导保留 preparer 的退出码与详细进度，不因子进程 stderr 覆盖后端错误，也不将原始诊断公开到界面。 |
| `host_sdk_mismatch` 或原生 loader 拒绝扩展 | 核对实际 OMP 与固定 SDK 的兼容性，使用原生扩展安装/加载路径。单独用 Bun 导入模块成功不足以证明兼容；不要替换安全策略来绕过。保留完整包路径，修复后新建 OMP 会话。 |
| 一直显示 `Awaiting OMP session` | 确认新会话位于安装目标主机，已加载 Bridge 扩展并打开 **Toggle Bridge**。本地 OMP 会话不能完成远端目标的握手；查看是否另有主机插件重载或服务升级要求，不要反复清空状态重装。 |
| **Reload host plugin** / **Service update required** | 前者要求在正确 daemon 中确认主机插件加载；后者说明已安装新文件但仍在运行旧服务。先确认服务归属和活动任务，在安全维护时段显式处理对应服务，再重试同一目标；连接成功不会消除这些要求。 |
| 浏览器不可用、没有桌面权限或无法控制窗口 | 检查本机 backend、正常登录且未锁定的交互桌面、操作系统权限及实时人工授权。Bridge 不绕过这些要求；不要借用其他 profile 或改用管理员账号。连接与绑定成功不代表权限齐备，Windows GUI 仍属未验收范围。 |
| 安装中断、锁归属未知或缺少完成回执 | 回到原目标查看保留的侧栏状态与私有日志。只有确认没有其他初始化运行后，才使用界面提供的显式恢复操作。缺少回执表示结果未确认，不能当作成功；不要删除整个状态目录或夺取活跃锁。 |

私有日志可能包含主机、路径或敏感运行信息，排查后只分享必要且脱敏的错误摘要，不能公开 `identity.json`、`client.json`、`server.json`、私钥或完整机器配置。更多恢复细节见[使用说明](usage.md#shutdown-reconnect-and-recovery)。

## 7. 升级、回退与安全移除

### 升级与回退

1. 为新版本保留独立下载与解压目录，重新校验其 `SHA256SUMS`，不要覆盖旧的不可变运行包。
2. 保持原来的客户端身份和状态目录。按第 2 节更新插件副本，在相同目标重新打开 **Set up Bridge** 并审核安装。broker、client、OMP 扩展和 Tern 两端插件需要配套更新。
3. 安装器会保留健康的已有服务；文件更新不等于正在运行的代码已更新。出现服务升级要求时，先等待活动操作结束，由服务原有所有者在维护时段显式停止旧服务，再重新初始化。手工前台服务可在原终端用 Ctrl+C 停止；setup 的脱离终端服务需先依据私有记录确认进程归属。本包不提供统一的服务停止命令，不要无差别结束 Bun、OMP 或 Tern 进程。
4. 通过新 OMP 会话重新观察就绪状态，并在需要时重新绑定。broker 重启会使旧执行上下文失效；保留身份不等于恢复原来的 Eval 内核或所有会话绑定。

本版本为首个公开预发布，暂不提供更早的公开回退包。后续若需回退，应使用自己保留且已校验、确认兼容的旧包，让两端组件一起回退，并复用原身份；不保证任意版本之间的状态向后兼容。任何服务或 loader 仍引用的旧包、依赖及路径都必须保留，不能仅因为新版本已解压就删除。

### 安全移除

**移除 Tern 插件不会停止已经运行的后台服务。** 先解除会话绑定以阻止新的客户端调用，处理在途任务，并按原有启动方式显式停止 client 与 broker。解除绑定不会撤销已分发操作，关闭侧栏也不会取消安装或上传。

确认正确的设备与 profile 后，可使用 Tern 原生命令移除已安装副本。

```sh
tern plugin remove omp-client-bridge
```

linked package 使用 `tern plugin unlink omp-client-bridge`。主机上的集成应单独处理；通过 OMP 原生机制卸载扩展，并仅在核对本地改动后移除安装器明确标识的自有 loader。Bridge 没有 `uninstall` 子命令，也不会自动清理其他应用配置。

身份、完成的上传文件、持久服务和旧运行包的保留期限需要分别决定。删除身份文件会在下次启动生成新身份，不会撤销仍在运行的进程；删除上传文件可能破坏草稿或历史会话引用。操作前阅读[保留与移除说明](usage.md#retention-and-removal)及[安全边界](security.md)。
