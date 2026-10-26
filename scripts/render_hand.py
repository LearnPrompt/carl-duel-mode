#!/usr/bin/env python3
"""Render one duel hand as a self-contained HTML fragment without networking."""

from __future__ import annotations

import argparse
import base64
import json
import math
from pathlib import Path
import re
import sys
from typing import Any
import uuid


MAX_HTML_BYTES = 1_000_000
MAX_AUDIO_BYTES = 128 * 1024
ASSET_ROOT = Path(__file__).resolve().parents[1] / "assets"
ART_NAMES = frozenset(("blade", "oracle", "portal"))
AUDIO_TYPES = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg"}
TOKENS = ("__ROOT_ID__", "__HAND_JSON__", "__STYLE__", "__RUNTIME__")


class RenderError(ValueError):
    """An expected input or asset error suitable for a short CLI message."""


def _text(value: Any, field: str, limit: int | None = None) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RenderError(f"{field} 必须是非空字符串")
    if limit is not None and len(value) > limit:
        raise RenderError(f"{field} 不能超过 {limit} 个字符")
    # Unpaired surrogates are accepted by Python's JSON parser but cannot be
    # emitted as UTF-8. Reject them here with the rest of the input errors.
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise RenderError(f"{field} 含有无效的 Unicode 字符") from exc
    return value


def validate_hand(value: Any) -> dict[str, Any]:
    """Validate known fields and return a minimal, normalized hand object."""
    if not isinstance(value, dict):
        raise RenderError("输入 JSON 的最外层必须是对象")
    turn_id = _text(value.get("turn_id"), "turn_id", 100)
    cards = value.get("cards")
    if not isinstance(cards, list) or len(cards) != 3:
        raise RenderError("cards 必须是恰好包含 3 张卡牌的数组")
    normalized_cards = []
    identifiers: set[str] = set()
    for index, card in enumerate(cards):
        field = f"cards[{index}]"
        if not isinstance(card, dict):
            raise RenderError(f"{field} 必须是对象")
        identifier = _text(card.get("id"), f"{field}.id", 100)
        if identifier in identifiers:
            raise RenderError(f"cards 中的 id 必须唯一，重复值：{identifier}")
        identifiers.add(identifier)
        art = _text(card.get("art"), f"{field}.art")
        if art not in ART_NAMES:
            raise RenderError(f"{field}.art 必须是 blade、oracle 或 portal")
        normalized_cards.append({
            "id": identifier,
            "title": _text(card.get("title"), f"{field}.title", 16),
            "effect": _text(card.get("effect"), f"{field}.effect", 100),
            "prompt": _text(card.get("prompt"), f"{field}.prompt", 4000),
            "art": art,
        })

    round_number = value.get("round", 1)
    if type(round_number) is not int or round_number <= 0:
        raise RenderError("round 必须是正整数")
    mode = value.get("mode", "duel")
    if not isinstance(mode, str) or mode not in ("duel", "acceptance"):
        raise RenderError("mode 必须是 duel 或 acceptance")
    audio = value.get("audio", {})
    if not isinstance(audio, dict):
        raise RenderError("audio 必须是对象")
    enabled = audio.get("enabled", True)
    if type(enabled) is not bool:
        raise RenderError("audio.enabled 必须是布尔值")
    volume = audio.get("volume", 0.22)
    if type(volume) not in (int, float) or not 0 <= volume <= 1 or not math.isfinite(volume):
        raise RenderError("audio.volume 必须是 0 到 1 之间的有限数字")
    normalized_audio: dict[str, Any] = {"enabled": enabled, "volume": volume}
    if "source" in audio:
        normalized_audio["source"] = _text(audio["source"], "audio.source")
    return {
        "turn_id": turn_id,
        "cards": normalized_cards,
        "round": round_number,
        "mode": mode,
        "audio": normalized_audio,
    }


def _read_text(path: Path, label: str) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise RenderError(f"无法读取{label}：{path.name}（{exc.strerror if isinstance(exc, OSError) else '不是有效 UTF-8'}）") from exc


def _audio_url(source: str, input_dir: Path) -> str:
    if "://" in source or source.startswith("data:"):
        raise RenderError("audio.source 只支持本地音频文件，不能使用网络或 data URL")
    path = Path(source).expanduser()
    if not path.is_absolute():
        path = input_dir / path
    mime_type = AUDIO_TYPES.get(path.suffix.lower())
    if mime_type is None:
        raise RenderError("audio.source 只支持 .mp3、.wav 或 .ogg 文件")
    try:
        if not path.is_file():
            raise RenderError(f"audio.source 文件不存在或不是普通文件：{path.name}")
        if path.stat().st_size > MAX_AUDIO_BYTES:
            raise RenderError("audio.source 文件不能超过 128 KiB")
        # Limit the read as well as stat: a concurrently growing file must not
        # bypass the size check or consume unbounded memory.
        with path.open("rb") as stream:
            data = stream.read(MAX_AUDIO_BYTES + 1)
    except OSError as exc:
        raise RenderError(f"无法读取 audio.source：{path.name}（{exc.strerror}）") from exc
    if len(data) > MAX_AUDIO_BYTES:
        raise RenderError("audio.source 文件不能超过 128 KiB")
    if not data:
        raise RenderError("audio.source 不能是空文件")
    return f"data:{mime_type};base64,{base64.b64encode(data).decode('ascii')}"


def safe_json(value: Any) -> str:
    """Make JSON safe inside an HTML script element, without changing its data."""
    serialized = json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    return (serialized.replace("&", "\\u0026")
            .replace("<", "\\u003c")
            .replace(">", "\\u003e")
            .replace("\u2028", "\\u2028")
            .replace("\u2029", "\\u2029"))


def render_hand(value: Any, *, assets_dir: Path | None = None,
                input_dir: Path | None = None, standalone: bool = False) -> str:
    """Validate and render; only trusted local assets become executable content."""
    hand = validate_hand(value)
    assets_dir = Path(assets_dir) if assets_dir is not None else ASSET_ROOT
    input_dir = Path(input_dir) if input_dir is not None else Path.cwd()
    template = _read_text(assets_dir / "hand.html", "卡牌模板")
    style = _read_text(assets_dir / "style.css", "卡牌样式")
    runtime = _read_text(assets_dir / "runtime.js", "卡牌运行脚本")
    for token in TOKENS:
        if token not in template:
            raise RenderError(f"卡牌模板缺少占位符 {token}")

    root_id = f"carl-duel-{uuid.uuid4().hex}"
    hand["root_id"] = root_id
    image_cache: dict[str, str | None] = {}
    for card in hand["cards"]:
        art = card["art"]
        if art not in image_cache:
            path = assets_dir / "art" / f"{art}.webp"
            try:
                if not path.is_file():
                    image_cache[art] = None
                else:
                    with path.open("rb") as stream:
                        data = stream.read(MAX_HTML_BYTES + 1)
                    if len(data) > MAX_HTML_BYTES:
                        raise RenderError(f"插画文件过大：{path.name}")
                    if not data:
                        raise RenderError(f"插画文件为空：{path.name}")
                    image_cache[art] = "data:image/webp;base64," + base64.b64encode(data).decode("ascii")
            except OSError as exc:
                raise RenderError(f"无法读取插画：{path.name}（{exc.strerror}）") from exc
        card["image"] = image_cache[art]
        if card["image"] is None:
            card["image_missing"] = f"插画缺失：{art}.webp"

    if "source" in hand["audio"]:
        hand["audio"]["source"] = _audio_url(hand["audio"]["source"], input_dir)
    replacements = {
        "__ROOT_ID__": root_id,
        "__HAND_JSON__": safe_json(hand),
        "__STYLE__": style.replace("__ROOT_ID__", root_id),
        "__RUNTIME__": runtime.replace("__ROOT_ID__", root_id),
    }
    # Replace only original template tokens. Sequential .replace() calls could
    # accidentally treat a token supplied inside a user's prompt as a template.
    pattern = re.compile("|".join(re.escape(token) for token in TOKENS))
    fragment = pattern.sub(lambda match: replacements[match.group(0)], template)
    if len(fragment.encode("utf-8")) >= MAX_HTML_BYTES:
        raise RenderError("生成的卡牌片段必须小于 1,000,000 字节，请缩小插画或音频素材")
    if not standalone:
        return fragment
    document = ("<!doctype html>\n<html lang=\"zh-CN\"><head>\n"
                "<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
                "<title>决斗模式 · 浏览器预览</title>\n"
                "<style>body{margin:0;background:#0a0d18;color:#f3e4b7;font-family:system-ui,sans-serif}"
                ".duel-preview-notice{padding:12px 20px;font-size:13px;line-height:1.6;"
                "border-bottom:1px solid #73613a;background:#181b26}</style>\n"
                "</head><body>\n<aside class=\"duel-preview-notice\">浏览器预览 · 宿主桥接待验证。"
                "此页面不会注入或模拟宿主接口；能展示卡牌不代表已完成对话续聊验收。</aside>\n"
                + fragment + "\n</body></html>\n")
    if len(document.encode("utf-8")) >= MAX_HTML_BYTES:
        raise RenderError("生成的独立页面必须小于 1,000,000 字节，请缩小素材")
    return document


def _object_without_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise RenderError(f"JSON 对象含有重复字段：{key}")
        result[key] = value
    return result


def _reject_constant(value: str) -> None:
    raise RenderError(f"JSON 不能包含非有限数字：{value}")


def load_hand(path: Path) -> Any:
    source = _read_text(path, "输入 JSON")
    try:
        return json.loads(source, object_pairs_hook=_object_without_duplicates,
                          parse_constant=_reject_constant)
    except json.JSONDecodeError as exc:
        raise RenderError(f"输入 JSON 格式错误：第 {exc.lineno} 行，第 {exc.colno} 列") from exc
    except RenderError:
        raise
    except ValueError as exc:
        raise RenderError("输入 JSON 的数字超出解析范围") from exc
    except RecursionError as exc:
        raise RenderError("输入 JSON 嵌套过深") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="把 3 张行动牌渲染为无网络依赖的 HTML；默认输出可嵌入片段。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="用例：\n  python3 scripts/render_hand.py --input examples/hand.json --output /tmp/duel-hand.html\n"
               "  python3 scripts/render_hand.py --input examples/hand.json --output /tmp/duel-preview.html --standalone\n"
               "音频相对路径按输入 JSON 所在目录解析。已有输出文件不会被覆盖。",
    )
    parser.add_argument("--input", required=True, type=Path, help="本地 UTF-8 手牌 JSON 路径")
    parser.add_argument("--output", required=True, type=Path, help="新建的 HTML 输出路径")
    parser.add_argument("--standalone", action="store_true", help="输出带有宿主待验证说明的浏览器预览页面")
    args = parser.parse_args(argv)
    output = args.output.expanduser().absolute()
    created = False
    try:
        if output.exists() or output.is_symlink():
            raise RenderError(f"输出已存在，拒绝覆盖：{output}")
        input_path = args.input.expanduser().absolute()
        document = render_hand(load_hand(input_path), input_dir=input_path.parent,
                               standalone=args.standalone)
        encoded = document.encode("utf-8")
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("xb") as stream:
            created = True
            stream.write(encoded)
        print(json.dumps({"output": str(output.resolve()), "bytes": len(encoded),
                          "standalone": args.standalone}, ensure_ascii=False))
        return 0
    except (RenderError, OSError, UnicodeError, OverflowError) as exc:
        if created:
            try:
                output.unlink()
            except OSError:
                pass
        print(f"错误：{exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
