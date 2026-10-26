# carl-duel-mode

把 Codex 对话的下一步做成三张可选择的行动牌。`0.1.0` 是首个预览版：卡牌组件和自动测试已完成，真实对话验收尚未全部完成，详见[验证记录](docs/validation.md)。

- 三张竖向卡牌重叠成扇形，卡名、效果和后续指令随当前上下文生成。
- 鼠标悬停时抽高、放大、前置并轻微倾斜，移开收回；悬停不发送消息，点击才发动。
- 发牌配约 8 秒原创合成配乐，点牌触发发动音效；自动播放受限时可手动开启声音。
- 支持键盘和减少动态效果偏好；插画、样式、脚本与音效不依赖运行时网络请求。

下面是隔离浏览器验收场景的真实截图，用于展示默认手牌和悬停抽牌效果，不代表完整 AI 续聊验收已通过。

| 默认手牌 | 悬停抽牌 |
| --- | --- |
| ![验收场景：竖向重叠扇形手牌](docs/preview-rest.png) | ![验收场景：悬停抽高并前置一张牌](docs/preview-hover.png) |

## 本地预览

需要 Python 3.10+，无 pip 依赖。在仓库根目录运行：

```sh
python3 scripts/render_hand.py --input examples/hand.json --output work/hand.html
python3 scripts/render_hand.py --input examples/hand.json --output work/preview.html --standalone
```

用浏览器打开 `work/preview.html` 即可检查视觉、操作和声音。普通浏览器没有 AI 续聊桥接，点牌不会让 AI 回复。渲染器拒绝覆盖已有文件，再次运行时请换一个输出文件名。

手牌数据及本地音频替换方式见[格式说明](references/hand-format.md)。组件使用原生 HTML、CSS 和 JavaScript，不需要前端构建工具。

## 安装到 Codex

先确认你的 Codex 环境提供对话内 `visualize` 展示、可用的 `visualize` Skill，以及宿主的 `window.openai.sendFollowUpMessage` 接口。仅安装这份 Skill 不会为客户端增加这些能力，也不保证其他 AI 聊天软件支持。

```sh
git clone https://github.com/LearnPrompt/carl-duel-mode.git
python3 - <<'PY'
import os
from pathlib import Path
from shutil import copytree, ignore_patterns
codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
copytree("carl-duel-mode", codex_home / "skills" / "carl-duel-mode",
         ignore=ignore_patterns(".git", "work", "__pycache__"))
PY
```

复制命令会在目标目录已存在时停止，不合并或覆盖已有同名 Skill。请先自行备份、比较已有版本，再决定如何更新。

在 Codex 可发现该 Skill 后，显式调用：

```text
使用 $carl-duel-mode，开启决斗模式。
```

此后每次完整回复末尾生成三张行动牌，进度消息不发牌。你可以直接输入普通文字，或点击一张牌继续。说“关闭决斗模式”后停止发牌；新对话默认关闭。开关依靠本对话上下文，不修改全局 AGENTS、hooks 或客户端安装文件。

宿主可能要求确认续聊。桥接缺失或请求失败时，组件会显示可手动复制的完整指令；“已请求继续”不代表 AI 已收到或已执行。

## 测试与验收

Python 测试使用标准库；JavaScript 测试需要 Node.js 18+：

```sh
python3 -m unittest discover -s tests -p test_renderer.py
node --test tests/test_runtime.cjs
```

当前记录为 42 项单元测试、12 项隔离模拟宿主浏览器检查通过，另有 1 次真实 Codex 选牌回传和普通文字继续的证据。三轮完整回传、关闭模式与真人听音仍待验证。复验步骤与各层证据边界见[验证记录](docs/validation.md)，版本变化见[更新记录](CHANGELOG.md)。
