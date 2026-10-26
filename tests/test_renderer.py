"""Isolated CLI checks: fixtures do not depend on production visual assets."""

from __future__ import annotations

import base64
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "render_hand.py"


class RendererTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "scripts").mkdir()
        self.script = self.root / "scripts" / "render_hand.py"
        shutil.copyfile(SCRIPT, self.script)
        self.assets = self.root / "assets"
        (self.assets / "art").mkdir(parents=True)
        (self.assets / "hand.html").write_text(
            '<section id="__ROOT_ID__"><style>__STYLE__</style>'
            '<script type="application/json" data-duel-data>__HAND_JSON__</script>'
            '<script>__RUNTIME__</script></section>', encoding="utf-8")
        (self.assets / "style.css").write_text(
            "#__ROOT_ID__ .card{display:block;animation:__ROOT_ID__-draw 1s}"
            "@keyframes __ROOT_ID__-draw{from{opacity:0}to{opacity:1}}", encoding="utf-8")
        (self.assets / "runtime.js").write_text(
            '(function(){const root=document.getElementById("__ROOT_ID__");'
            'root.dataset.ready="true";})();', encoding="utf-8")
        for name in ("blade", "oracle", "portal"):
            (self.assets / "art" / f"{name}.webp").write_bytes(b"RIFF\x08\x00\x00\x00WEBPtest")
        self.hand = {"turn_id": "验收回合-一", "cards": [
            {"id": "action-1", "title": "深度检索", "effect": "继续查找案例。", "prompt": "继续查找案例并提供依据。", "art": "blade"},
            {"id": "action-2", "title": "立即构筑", "effect": "开始制作原型。", "prompt": "开始制作可交互原型。", "art": "oracle"},
            {"id": "action-3", "title": "结束决斗", "effect": "关闭此对话的决斗模式。", "prompt": "关闭决斗模式。", "art": "portal"},
        ]}

    def run_cli(self, hand=None, *, standalone=False, output="hand.html"):
        source = self.root / "hand.json"
        source.write_text(json.dumps(self.hand if hand is None else hand, ensure_ascii=False), encoding="utf-8")
        command = [sys.executable, str(self.script), "--input", str(source), "--output", str(self.root / output)]
        if standalone:
            command.append("--standalone")
        return subprocess.run(command, capture_output=True, text=True, cwd=self.root, check=False)

    def read_result(self, result, output="hand.html"):
        self.assertEqual(result.returncode, 0, result.stderr)
        content = (self.root / output).read_text(encoding="utf-8")
        match = re.search(r'<script type="application/json" data-duel-data>(.*?)</script>', content, re.S)
        self.assertIsNotNone(match)
        return content, json.loads(match.group(1))

    def assert_invalid(self, *, expected):
        result = self.run_cli()
        self.assertEqual(result.returncode, 2, result.stdout)
        self.assertIn(expected, result.stderr)
        self.assertFalse((self.root / "hand.html").exists())

    def test_chinese_special_characters_and_tokens_are_safe(self):
        special = '</script><img src=x onerror="alert(1)"> & 中文\u2028\u2029 __STYLE__ __RUNTIME__'
        self.hand["cards"][0]["prompt"] = special
        content, hand = self.read_result(self.run_cli())
        self.assertEqual(hand["cards"][0]["prompt"], special)
        self.assertNotIn("</script><img", content)
        self.assertIn(r"\u003c/script\u003e", content)
        self.assertIn(r"\u0026", content)
        self.assertIn(r"\u2028\u2029", content)
        self.assertIn("__STYLE__ __RUNTIME__", content)
        self.assertEqual(hand["round"], 1)
        self.assertEqual(hand["mode"], "duel")
        self.assertEqual(hand["audio"], {"enabled": True, "volume": 0.22})
        self.assertTrue(hand["cards"][0]["image"].startswith("data:image/webp;base64,"))
        self.assertIn(f'id="{hand["root_id"]}"', content)
        self.assertIn(f'getElementById("{hand["root_id"]}")', content)

    def test_exactly_three_cards_required(self):
        self.hand["cards"].pop()
        self.assert_invalid(expected="恰好包含 3 张")

    def test_root_placeholder_replaced_in_template_runtime_and_css(self):
        content, hand = self.read_result(self.run_cli())
        root_id = hand["root_id"]
        self.assertIn(f'id="{root_id}"', content)
        self.assertIn(f'getElementById("{root_id}")', content)
        self.assertIn(f"#{root_id} .card", content)
        self.assertIn(f"animation:{root_id}-draw 1s", content)
        self.assertIn(f"@keyframes {root_id}-draw", content)
        self.assertNotIn("__ROOT_ID__", content)

    def test_duplicate_card_id_rejected(self):
        self.hand["cards"][1]["id"] = self.hand["cards"][0]["id"]
        self.assert_invalid(expected="id 必须唯一")

    def test_missing_art_has_explicit_fallback_data(self):
        (self.assets / "art" / "oracle.webp").unlink()
        _, hand = self.read_result(self.run_cli())
        self.assertIsNone(hand["cards"][1]["image"])
        self.assertEqual(hand["cards"][1]["image_missing"], "插画缺失：oracle.webp")

    def test_output_metadata_and_size(self):
        result = self.run_cli()
        content, _ = self.read_result(result)
        metadata = json.loads(result.stdout)
        self.assertEqual(metadata["output"], str((self.root / "hand.html").resolve()))
        self.assertEqual(metadata["bytes"], len(content.encode("utf-8")))
        self.assertLess(metadata["bytes"], 1_000_000)
        self.assertFalse(metadata["standalone"])

    def test_existing_output_never_overwritten(self):
        destination = self.root / "hand.html"
        destination.write_text("原有文件", encoding="utf-8")
        result = self.run_cli()
        self.assertEqual(result.returncode, 2)
        self.assertIn("拒绝覆盖", result.stderr)
        self.assertEqual(destination.read_text(encoding="utf-8"), "原有文件")

    def test_symlink_output_never_followed(self):
        target = self.root / "absent.html"
        (self.root / "hand.html").symlink_to(target)
        result = self.run_cli()
        self.assertEqual(result.returncode, 2)
        self.assertIn("拒绝覆盖", result.stderr)
        self.assertFalse(target.exists())

    def test_fragment_size_limit(self):
        (self.assets / "style.css").write_text(" " * 1_000_000, encoding="utf-8")
        self.assert_invalid(expected="必须小于 1,000,000 字节")

    def test_missing_audio_rejected(self):
        self.hand["audio"] = {"source": "missing.wav"}
        self.assert_invalid(expected="文件不存在")

    def test_oversized_audio_rejected(self):
        (self.root / "big.wav").write_bytes(b"x" * (128 * 1024 + 1))
        self.hand["audio"] = {"source": "big.wav"}
        self.assert_invalid(expected="不能超过 128 KiB")

    def test_local_audio_embedded_relative_to_input(self):
        data = b"RIFFtestWAVEfixture"
        (self.root / "intro.wav").write_bytes(data)
        self.hand["audio"] = {"source": "intro.wav", "volume": 0.3, "enabled": False}
        _, hand = self.read_result(self.run_cli())
        self.assertEqual(hand["audio"]["source"], "data:audio/wav;base64," + base64.b64encode(data).decode())
        self.assertFalse(hand["audio"]["enabled"])

    def test_remote_audio_and_unsupported_extensions_rejected(self):
        for source, expected in (("https://example.com/intro.mp3", "只支持本地音频"),
                                 ("data:audio/wav;base64,AAAA", "只支持本地音频"),
                                 ("intro.m4a", "只支持 .mp3")):
            with self.subTest(source=source):
                self.hand["audio"] = {"source": source}
                self.assert_invalid(expected=expected)

    def test_standalone_is_labeled_and_does_not_fake_host_bridge(self):
        content, _ = self.read_result(self.run_cli(standalone=True))
        self.assertTrue(content.startswith("<!doctype html>"))
        self.assertIn("浏览器预览 · 宿主桥接待验证", content)
        self.assertNotRegex(content, r"(?:window|globalThis)\.openai\s*=")
        self.assertNotIn("sendFollowUpMessage:", content)

    def test_known_field_types_are_strict(self):
        cases = [
            ("round", True, "round 必须是正整数"),
            ("round", 1.0, "round 必须是正整数"),
            ("round", 0, "round 必须是正整数"),
            ("mode", [], "mode 必须是"),
            ("audio", {"enabled": 1}, "audio.enabled 必须是布尔值"),
            ("audio", {"volume": True}, "audio.volume 必须是"),
            ("audio", {"volume": 1.01}, "audio.volume 必须是"),
            ("audio", {"volume": 10 ** 400}, "audio.volume 必须是"),
            ("turn_id", " " * 2, "turn_id 必须是非空字符串"),
        ]
        for key, value, expected in cases:
            with self.subTest(key=key, value=value):
                hand = dict(self.hand, **{key: value})
                result = self.run_cli(hand)
                self.assertEqual(result.returncode, 2)
                self.assertIn(expected, result.stderr)

    def test_character_limits(self):
        for field, limit in (("id", 100), ("title", 16), ("effect", 100), ("prompt", 4000)):
            with self.subTest(field=field):
                original = self.hand["cards"][0][field]
                self.hand["cards"][0][field] = "卡" * (limit + 1)
                self.assert_invalid(expected=f"不能超过 {limit} 个字符")
                self.hand["cards"][0][field] = original
        self.hand["turn_id"] = "轮" * 101
        self.assert_invalid(expected="不能超过 100 个字符")

    def test_unknown_fields_ignored_and_cannot_inject_packed_images(self):
        self.hand["extra"] = {"future": True}
        self.hand["cards"][0]["image"] = "https://example.com/untrusted.webp"
        self.hand["cards"][0]["future"] = True
        _, hand = self.read_result(self.run_cli())
        self.assertNotIn("extra", hand)
        self.assertNotIn("future", hand["cards"][0])
        self.assertTrue(hand["cards"][0]["image"].startswith("data:image/webp"))

    def test_invalid_json_duplicates_and_non_finite_numbers_rejected(self):
        for source, expected in (('{"turn_id":"a","turn_id":"b"}', "重复字段"),
                                 ('{"audio":{"volume":NaN}}', "非有限数字"),
                                 ('{"broken":', "格式错误")):
            with self.subTest(source=source):
                path = self.root / "malformed.json"
                path.write_text(source, encoding="utf-8")
                result = subprocess.run([sys.executable, str(self.script), "--input", str(path),
                                         "--output", str(self.root / "hand.html")],
                                        capture_output=True, text=True, check=False)
                self.assertEqual(result.returncode, 2)
                self.assertIn(expected, result.stderr)
                self.assertFalse((self.root / "hand.html").exists())

    def test_help_has_examples(self):
        result = subprocess.run([sys.executable, str(self.script), "--help"],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 0)
        self.assertIn("用例", result.stdout)
        self.assertIn("--standalone", result.stdout)


if __name__ == "__main__":
    unittest.main()
