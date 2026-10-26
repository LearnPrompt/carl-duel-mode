# 手牌 JSON 与渲染命令

`scripts/render_hand.py` 只读取本地文件，使用 Python 标准库，不发起网络请求。默认生成可嵌入宿主的 HTML 片段；`--standalone` 生成清楚标注“浏览器预览 · 宿主桥接待验证”的独立页面。独立页面不注入或模拟宿主接口。

```sh
python3 scripts/render_hand.py --input examples/hand.json --output /tmp/duel-hand.html
python3 scripts/render_hand.py --input examples/hand.json --output /tmp/duel-preview.html --standalone
```

输出必须是尚不存在的文件；父目录可自动创建。成功时 stdout 返回 JSON 元信息，含输出绝对路径、实际 UTF-8 字节数和是否为独立页面。输入、素材或写入失败时 stderr 输出中文错误，退出码为 `2`，不覆盖已有文件。

## 输入格式

```json
{
  "turn_id": "conversation-turn-1",
  "round": 1,
  "mode": "duel",
  "audio": {"enabled": true, "volume": 0.22},
  "cards": [
    {"id": "research", "title": "深度检索", "effect": "继续查找案例。", "prompt": "请继续查找案例并给出依据。", "art": "oracle"},
    {"id": "build", "title": "立即构筑", "effect": "开始制作原型。", "prompt": "请开始制作可交互原型。", "art": "blade"},
    {"id": "finish", "title": "结束决斗", "effect": "关闭此对话的决斗模式。", "prompt": "关闭决斗模式。", "art": "portal"}
  ]
}
```

| 字段 | 规则 |
| --- | --- |
| `turn_id` | 必填，非空字符串，最多 100 个字符；由调用方为本轮提供稳定标识。 |
| `cards` | 必填，恰好 3 个对象。 |
| `cards[].id` | 必填，非空字符串，最多 100 个字符，三张牌之间唯一。 |
| `cards[].title` | 必填，非空字符串，最多 16 个字符。 |
| `cards[].effect` | 必填，非空字符串，最多 100 个字符。 |
| `cards[].prompt` | 必填，非空字符串，最多 4000 个字符；包含独立可执行的完整后续指令。 |
| `cards[].art` | 必填，`blade`、`oracle` 或 `portal`。 |
| `round` | 可选，正整数，默认 `1`；布尔值和浮点数不作为整数接受。 |
| `mode` | 可选，`duel` 或 `acceptance`，默认 `duel`。`acceptance` 用于真实宿主验收，不改变宿主接口的真实性。 |
| `audio.enabled` | 可选，布尔值，默认 `true`。 |
| `audio.volume` | 可选，`0` 到 `1` 之间的有限数字，默认 `0.22`。 |
| `audio.source` | 可选，已存在且非空的本地 `.mp3`、`.wav`、`.ogg` 文件，最大 128 KiB；相对路径按输入 JSON 所在目录解析。不能填网络或 data URL。 |

未列出的扩展字段会被忽略，不会原样传入页面。已知字段为 `null` 或错误类型会被拒绝；重复 JSON 对象字段、NaN、Infinity 和无效 Unicode 会被拒绝。字符数按 Python 字符串长度计算。标题、效果和指令不得填入 HTML；运行时使用 `textContent` 呈现。

## 打包与模板约定

- 模板为 `assets/hand.html`，必须包含 `__ROOT_ID__`、`__HAND_JSON__`、`__STYLE__`、`__RUNTIME__` 四种占位符。样式从 `assets/style.css`、运行时从 `assets/runtime.js` 内联；样式和运行时的 `__ROOT_ID__` 同样被替换，包括 CSS 作用域及关键帧名称。
- 每次渲染生成唯一 `root_id`，同时用于模板和打包后的 JSON，避免多副手牌共用 DOM 根节点。
- `cards[].image` 由 `assets/art/{art}.webp` 打包为 data URL，忽略输入自行传入的 `image`。找不到插画时设为 `null`，同时提供 `image_missing: "插画缺失：{art}.webp"`；运行时必须把该说明直接显示在插画区域。缺图不编造替代插画。
- `audio.source` 如有提供，会被转为内联 data URL；不再把本地路径传入页面。未提供时由运行时合成默认配乐和音效。
- JSON 会安全转义 `<`、`>`、`&`、U+2028 和 U+2029，防止结束 `<script>` 标签或插入代码。模板替换只处理原模板标记，指令内的同名字符串保持原义。
- 默认片段与独立页面均必须小于 **1,000,000 UTF-8 字节**。素材超限直接报错，不截断内容。
- 渲染成功只证明 HTML 已生成。宿主显示、音频播放、选择回传和 AI 继续执行必须分别做真实验收。

## 渲染器检查

```sh
python3 -m unittest discover -s tests -p 'test_renderer.py' -v
```

测试使用临时目录中的最小模板与素材，不依赖最终插画或宿主接口，覆盖输入类型、中文与脚本转义、唯一标识、不覆盖输出、内联音频、大小限制、缺图说明和独立预览标记。
