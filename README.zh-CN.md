# dsh-shell-surfaces

<img src="assets/dessa-sophia.jpg" alt="Dessa Sophia" width="320">

[![test](https://github.com/Nesarf/dsh-shell-surfaces/actions/workflows/test.yml/badge.svg)](https://github.com/Nesarf/dsh-shell-surfaces/actions/workflows/test.yml)
[![licence: MIT](https://img.shields.io/badge/licence-MIT-blue.svg)](LICENSE)

[English](README.md) | **简体中文**

`https://github.com/Nesarf/dsh-shell-surfaces` —— 一个 DSH 插件。

```
dsh plugin --profile <profile> add github:Nesarf/dsh-shell-surfaces          # main 的最新
dsh plugin --profile <profile> add github:Nesarf/dsh-shell-surfaces#v1.0.0  # 某个标签
```

标签是「可以被叫出名字的版本」。从 `main` 装拿到的是它今天的样子；装一个标签，拿到的是当初决定下来的那个提交 —— 「明天再装同一个」和「退回能用的那一版」都需要它。

## 这是什么

一个 DSH 工具，把这台机器上的**执行面**收在一处。最后一次实测是三十五个面：

- 一个 WSL Linux 用户空间，以及它里面十个各自的 shell
- MSYS2 用户空间里的六个 shell
- Git for Windows 用户空间
- 四个解释器：python、perl、node、cscript
- 两个 PowerShell（7 与随系统自带的 5.1）、cmd、nushell
- 四个窗口宿主：Windows Terminal、mintty、Tabby、WezTerm
- 两个容器运行时：podman、docker
- 一个 ssh 目的地、一个真实控制台（pty）

它存在的原因是：**只写在文档里的规则不算能力**。这些面的选用规则早就记下来了，但一个会话只能用这些规则拼一条 pwsh 命令字符串，然后祈祷引号能活过这一路。现在它们是可调用的。

```
shell_surfaces(action="surfaces")                    这台机器上有什么，每个面是去哪儿找的
shell_surfaces(action="versions")                    每个面报出来的版本（缓存，refresh 重问）
shell_surfaces(action="run", surface="wsl",  command="grep -P '(?<=Linux )[0-9.]+' /proc/version")
shell_surfaces(action="run", surface="nu",   command="open data.json | where n > 3 | to json")
shell_surfaces(action="run", surface="msys", command="pacman -Q | wc -l")
shell_surfaces(action="run", surface="pwsh", command="Get-CimInstance Win32_OperatingSystem | Select-Object Caption")
shell_surfaces(action="run", surface="pty",  command="powershell -File install.ps1", send=["y\n"])
```

一句话：一条命令进，标准输出、标准错误、退出码出。

## 三个动作

`run` 在一个面上跑一条命令。`surfaces` 报出有哪些面、各自找在哪儿。`versions` 问每个面自己是哪个版本。

`surfaces` 的文字是一棵缩进的树：面那一行带 `[种类]`，它下面缩进一层的是它的说明行，以中点开头。树的最后有两段：`crossings`（哪些面协作、而不互相包含）与 `found, without a face of its own`（扫到了、但还没有独立条目的程序）。

## PowerShell 在这里也是一个面

「退回 pwsh」以前的意思是「离开这个工具、去用另一个」。`pwsh` 这个面把那段缝补上了：一条 PowerShell 命令在这里是一次普通调用，和其他面同一个形状，所以一个会话撞上别扭的面时，不必换工具才能把 PowerShell 的活干完。后台任务、超时提升、升级审批、持久会话在它身上一样有效 —— 这些是面的功能，不是某一个工具的特权。

两个 PowerShell 都可寻址，而这件事需要两条表项而不是一条。`pwsh` 是 PowerShell 7，也是更好的默认；`powershell` 是随 Windows 自带的 5.1。把两者藏在同一个 `DSH_PWSH` 变量后面，意味着一台机器上两个都装了却只能碰到其中一个，而「这个脚本在 5.1 上还能跑吗」是两条表项能回答、一个变量回答不了的问题。

这个工具不携带的唯一形状，是一个画着提示符或光标的终端会话。那是内置 `pwsh` 工具还站得住的地方；「命令是 PowerShell」不构成去那里的理由。

面级别的失败也不是换工具的借口。某个面缺失、起不来、或者超时，工具会说出来，并指出下一步该打哪个调用（`action="surfaces"`）—— 那个调用仍然留在这个插件里。

## 为什么是一个工具，不是七个

七种面放进七个工具，模型就得在调用之前先选对工具 —— 而选错的代价是一次失败的调用，且看不出是命令错了还是工具选错了。收进一个工具之后，选面是一个参数，错了能立刻看见是哪一步错。

面本身仍然各不相同：每一种都有自己的 `when:`，写明什么时候用它、它不做什么。

## 版本

`action="versions"` 问每个面自己是哪个版本，答案缓存在 harness home 旁边（`shell-surfaces-versions.json`，可用 `DSH_VERSIONS_FILE` 改）。加 `refresh: true` 才重新问 —— 每问一个面要起一个进程，而版本只会在有人升级 shell 时变。

本机实测：三十五个面里**二十三个答得出来**，而且没有一条错误信息冒充版本。

三个需要特别处理的：

- `dash` 拒绝 `--version`，也没有版本变量，所以去问装它的包管理器（`pacman -Q dash`，回退到 `dpkg-query`）—— 那也是发行版实际打出来的版本
- `mksh` 要 `-c 'echo $KSH_VERSION'`
- `busybox` 无参数时才打自己的 banner

答不出的面留空，不去猜：`wt --version` 会开一个窗口，解释器面的 `--version` 会被塞进它的 `-c`，在那里是语法错误而不是一个开关。

## 能力

`action="surfaces"` 给每个面带一个 `capabilities` 对象，文字里每个面下面也有一行 `caps:`。六个布尔值，每一个都回答一个调用者能据此行动的问题：

| 能力 | 回答的问题 |
| --- | --- |
| `session` | 两次调用之间状态能保留吗 |
| `stdin` | 命令能从标准输入送进去吗（会话机制需要它） |
| `interactive` | 它需要真实终端吗 —— 一个会读提示的程序 |
| `gui` | 它会开窗口吗 |
| `pathTranslation` | `/tmp/x` 会变成 Windows 路径吗 |
| `throwaway` | 每次调用都是全新环境吗 |

这些值是**从 `kind`、`session` 与 `tags` 推导**出来的，写在一个函数里，所以以后新加的面会自动带上正确答案，而不会「忘记填」。唯一的例外写在数据里：`brush` 是 MSYS2 用户空间里唯一拒绝路径翻译的 shell，它的 tag 就写着这件事。

本机实测：十个面有会话、三十个能接标准输入、七个翻译路径、四个开窗口、两个一次性、**恰好一个**需要真实终端（`pty`）。这些数字写进了 `test/surfaces-test.mjs` 的断言里 —— 以后表里要是长出第二个 `interactive`，测试会先坏掉，而不是先误导读者。

## 树，以及同一批行的两个视图

`surfaces` 的文字是一棵树，客户端画的是同一个形状：先按 family 分带，再按种类分，中间那行 `found, without a face of its own` 是扫到了却没有独立条目的程序。

同一批行有两个视图：

- **表格**：名字、种类、状态、跑过几次、能力、父级、说明，表头点一下换排序
- **树图**：按 family 与种类分带，每格的大小随「跑过几次」变，格与格之间有把手可以拖，横向还有滑块

两个视图读的是同一份文字。客户端拿不到结构化数据 —— 宿主只把拍平的文本交给它，所以结构是从缩进里重新解析出来的。

### 谁和谁协作

树说的是「谁住在谁里面」，说不出「谁借用谁」。四个窗口面都借 node 垫片把结果带回来，两个容器面都借 wsl 里的守护进程，pty 面借 python 驱动控制台 —— 这些边单独成段：

```
· crossings: faces that work together rather than live inside each other
    · wt — node: the answer comes back through scripts/dss-exec.mjs
    · wezterm — cmd: each pane runs a cmd /k command line
    · docker — wsl: the daemon runs inside the distribution; this face only drives it
```

它不画进树里，有两个理由。一条边可以连接任意深度的两个面 —— 一个在顶层的窗口和一个在顶层的解释器、一个容器和一个 userland —— 所以两行之间画线就得取决于那两行恰好落在哪儿，同一张表会被读出两种意思。而树木来的职责是归属：一条读起来像父子关系的线，正是这一段要避免的错误。`node` 不在 `wt` 里面，它被 `wt` 借用。

### 一次调用长什么样

一次 `run` 的结果是一行摘要加一段输出：

```
wsl: exit code 0 in 412 ms · 2 runs
```

左边是面和退出码，中间是耗时，右边是这个面累计跑过几次。输出被截断时多一行 `truncated`，并给出溢出文件的路径 —— 那份文件是完整的。后台起的那次显示 job id 而不是耗时。

### 参数形状的由来

每个面的 argv 不是随手写的，是从「那个程序怎么收命令」反推出来的：

- shell 面是 `-c` 或 `-lc`。登录 shell 是故意的：不这样的话，`/tmp` 对这个进程和它的邻居会是两个不同的地方
- 解释器是 `-c`、`-e`，或者 cscript 的「写临时文件再跑」
- 容器面是 `run --rm <镜像> sh -c`
- 窗口面没有 argv，是一套启动加回收：起进程、等结果文件、必要时关掉

表里每个面旁边的注释写着它为什么是那个形状，以及当初是什么让它变成那样。改这张表之前值得先读那些注释。

## 会话

给一次调用传 `session`，就保持一个长命的进程：当前目录、导出的变量、别的进程留下的文件，下一次调用还在。

一个面要不要支持会话由它自己决定：`wsl` 之内是 `bash -l -s`，`busybox` 之内是 `sh -s`，窗口面与容器面不支持。池子里每个（所有者、面、名字）一条进程，前面写一个随机标记行，用来把那一次调用的输出从之前的垃圾里切出来。

三条关闭路径：每次调用之前、空闲时每六分之一周期扫一遍、以及会话被销毁时。

## 后台任务与超时提升

`run_in_background: true` 把命令当成一个 job 起，立刻返回 id，用 `job_output` 取、`job_kill` 停。这样起的命令没有超时。

`promote_on_timeout: true` 让一条超出预算的命令继续活着，转成后台 job，而不是被杀掉。

`pty` 面两者都不支持 —— 一个控制台没有干净的进程可以交接出去。

## 沙箱

和内置 shell 工具是同一个沙箱。文件效果被拒时，那是一个**策略回答**，不是执行失败：结果里带着模式、是否被拒、以及后端能执行得多彻底。

处理方式是明确的：用 `sandbox_permissions` 带着理由升级一次，或者解释清楚这条命令为什么不能跑。绕开围栏不是选项。

## 命令走标准输入，不走参数

`wsl.exe` 会把交给它的词重新拼成一条命令行，再在发行版里解析一次。于是参数里的 `$VAR` 会先被外层吃掉，含引号或 `$` 的脚本到里面时已经不是原来那条了。

修法在这张表里是统一的：命令写到发行版的标准输入上，`bash -l -s` 去读。

同样的坑还有一处：探测发行版里有什么时，脚本写成**临时文件**再按路径交给它。`spawnSync` 的 `input` 在宿主进程里送不到 `wsl.exe`，而 `wsl -l -q`（不碰 stdin）答得好好的 —— 结果是这个发行版读起来像空的，十个派生面与两个容器面就这么静静地消失了。文件没有 stdin 可以丢。

## 解释器、ssh、容器

解释器是面，只是不是 shell：命令走 `-c`（python / node）、`-e`（perl），或者 VBScript 写成临时 `.vbs` 再跑。没有管道可以套在它们外面，管道属于代码里面。

### ssh 目的地

一个 ssh 目的地是一个面。主机名与用户写在 ssh config 里，这个面只负责把命令送过去 —— `ssh <开关> <主机> <命令>` 本来就是「开关在前、命令在最后」的形状，和每个 shell 面一样，不需要新的机制。

有两类条目是**故意丢掉的**，因为一个次次都失败的面比没有面更糟：

- `User git` 的主机（这台机器的 `github.com` 就是这样）—— 那说的是 git 协议而不是 shell，另一端会拒绝别的一切
- 通配符（`Host *.internal`）—— 那是一条匹配用的模式，不是一个能拨过去的目的地

`BatchMode=yes` 不是偏好。没有它，一个要密码的主机会停在没人能敲的提示符上，调用读起来像卡住了；有了它，那种主机立刻失败并说出原因。

`StrictHostKeyChecking=accept-new` 是同一段论证的另一半：第一次见的主机记下来，密钥**改过**的主机仍然拒绝。没有它，第一次连任何新目的地都会死在「Host key verification failed」上，读起来像一个坏掉的面，而不是一台还没被记录的主机。

ssh 连命令都没能送达时答 255，结果里带一条说明：主机不可达、密钥被拒、主机密钥变了，都是面级别的问题，不是命令失败。

### 搭一个 loopback 目的地，好让这个面能被测

这台机器的 ssh 家族本来是空的（唯一的配置条目只走 git），而一个没人能调用的面是一个说法，不是能力。这里不需要第二台机器 —— 用发行版自带的 openssh 就能搭：

```
# 在发行版里，以 root 身份
ssh-keygen -A                         # 这个镜像一个主机密钥都没有
mkdir -p /run/sshd
/usr/sbin/sshd -p 2222 -o ListenAddress=127.0.0.1 \
               -o PubkeyAuthentication=yes -o PasswordAuthentication=no
```

然后在 Windows 这一侧生成一对专用密钥，公钥放进发行版用户的 `~/.ssh/authorized_keys`（700 / 600），`~/.ssh/config` 加：

```
Host dss-loopback
  HostName 127.0.0.1
  Port 2222
  User nyarch
  IdentityFile ~/.ssh/id_ed25519_loopback
  IdentitiesOnly yes
```

`action="surfaces"` 随后就会报出 `ssh-dss-loopback [remote]`。

### 容器

容器也是面，而且分两种：一种每次调用起一个全新的一次性容器（alpine），另一种是**已经跑着的容器**（`<runtime> exec`）—— 后者能看见它自己的文件系统，前者什么都留不下。

一次性那条路径没有会话，所以两次调用之间什么都不留；需要状态时该用 `wsl`。一台两个运行时都没有的机器，两个面都不报。

两个运行时都在这台机器上，而且不可互换：`podman` 是 rootless，`docker` 不是。`DSH_PODMAN_IMAGE` 与 `DSH_DOCKER_IMAGE`（或者一个 `DSH_CONTAINER_IMAGE`）挑镜像，默认 `docker.io/library/alpine:latest`，第一次调用时拉取。

## 窗口面

四个窗口宿主需要 GUI：`wt`、`mintty`、`Tabby`、`WezTerm`。它们都是「开一个窗口、跑一条命令、把结果带回来」，带回的方式各有各的：

- `wt` 与 `mintty` 通过一个 Node 垫片（`scripts/dss-exec.mjs`）把输出写进结果文件
- `WezTerm` 用它自己的 mux 服务读回来
- `Tabby` 靠一个私有 profile，那个 profile 指向一个固定 agent（`scripts/dss-tabby-agent.mjs`），每次调用只重写它读的 job 文件

Tabby 那一路有两处实测踩过的坑：profile 里写 `command: node` 不行（Tabby 起得来 profile，agent 却从不运行），要用绝对路径；`cmd /c start /min` 也不是藏窗口的办法（`start` 会把带引号的程序路径当窗口标题，然后拿下一个词当文件去开）。

还有一条：回答到了之后窗口**原本会留着**，因为 Tabby 会保留一个进程已经退出的 tab。现在它自己关：宿主拿到结果后跑 `scripts/close-tabby-dss.ps1`，脚本只认命令行里带本工具 `user-data-dir` 的实例，所以你自己开的 Tabby 绝不会被碰。宿主这一处是**同步**调用 —— 实测 detached 的助手够不着那个实例。

## 打开一个路径，而不是拒绝它

有些面拒绝被调用，原因不在它自己：`git-shell` 需要有人先把它加进允许列表，`nologin` 需要先有登录，一个没起过的发行版需要先起一次。

这些情况的回答不是「失败」，而是**说出开路的那一步**：要跑哪条命令、在哪一侧跑。拒绝本身也是一条信息。

## 它不是

- 不是终端模拟器。要一个能画提示符、能读光标位置的会话，用内置的 `pwsh` 工具。
- 不是安全审查。列在这里不构成对某个 shell 的背书。
- 不替你选面。它把每个面的边界写清楚，选哪个由调用者决定。

## 布局

```
lib/index.js        工具注册：schema、三个动作、结果形状、渲染
lib/surfaces.js     三十五张面的表：种类、可执行文件、参数、说明、when、能力、版本问法
lib/discover.js     扫描这台机器：PATH、安装根、WSL 发行版
lib/runner.js       起进程、收输出、窗口面与容器面的特殊路径
lib/sessions.js     会话池：一个（所有者、面、名字）一条长命进程
lib/usage.js        每个面跑过几次（客户端按这个决定格子大小）
lib/versions.js     问版本、缓存答案
lib/client.js       浏览器那一半：表格、树图、滑块、把手
scripts/            垫片、Tabby agent、清理脚本、live check、各类探针
test/               纯自测 195 项、客户端 99 项
```

## 验收

```
node test/surfaces-test.mjs          # 不需要宿主；够得着时也问一次宿主的 schema 校验器
node test/client-bundle-test.mjs     # 真实的客户端 bundle，套在一个假模块加载器后面
node scripts/live-check.mjs          # 这台机器上每个面跑一条真命令
DSH_LIVE_TERMINALS=1 node scripts/live-check.mjs   # 连四个窗口面一起（会开窗）
```

`live-check.mjs` 是一份探针：加上 `LIVE_CHECK_JSON=1` 时，它把 `probe-table.mjs` 吃的 JSON 写到 stdout、把人读的行写到 stderr，于是一次运行同时回答「这个面活着吗」与「它是哪个版本」。

它默认**跳过窗口面**：日常跑一次，不该往别人屏幕上放四个窗口。加上窗口面之后，本机实测三十一个面答了、一个跳过（那个面所在的发行版里 nushell 跑不起来）。

CI 在两个平台各跑一遍自测与探针 —— 于是「这台机器上有哪些面」是一条有历史的记录，而不是某人某天量过一次的数字。

## 诚实边界

- 面表是手写的。扫描能找到新的可执行文件，但它不知道那是什么、该怎么用，所以自动发现只到「有一个东西在这里」为止。
- 能力是从 `kind`、`session`、`tags` 推导的。推导出来的是「按这张表应该是什么」，不是「这台机器上真的能做什么」——后者要跑一次才知道。
- 版本只对二十三个面成立。其余十二个说不知道，而「不知道」是准确的。
- 某些行为依赖具体实现细节：Tabby 的 profile 机制、WezTerm 的 mux、`wsl.exe` 对参数的重组。这些都写在各面的注释里，因为它们会变。

---

MIT 许可。作者：Nesarf。
