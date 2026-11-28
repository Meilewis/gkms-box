#!/usr/bin/env python3
"""验证 gkms_local_exporter.py 生成的代码与 gkms-box/koishi-plugin/codec.js 100% 互通。"""

from __future__ import annotations

import base64
import json
from pathlib import Path
import subprocess
import unittest

import gkms_local_exporter as exp

ROOT = Path(__file__).resolve().parent.parent
CODEC_JS = ROOT / "koishi-plugin" / "codec.js"
NODE_EXE = Path(r"C:\Program Files\nodejs\node.exe")


class LocalExporterCodecTest(unittest.TestCase):
    def test_support_and_cidol_encoding_matches_codec_js(self) -> None:
        support_payload = [
            {"supportCardId": "s_card-3-0117", "levelLimitRank": "SupportCardLevelLimitRank_4"},
            {"supportCardId": "s_card-3-0001"},  # 缺失默认 0 破
            {"supportCardId": "s_card-2-0085", "levelLimitRank": "SupportCardLevelLimitRank_2"},
            {"supportCardId": "s_card-1-0001", "levelLimitRank": "SupportCardLevelLimitRank_4"},  # R 卡应被过滤
            {"supportCardId": "s_card-3-0117", "levelLimitRank": "SupportCardLevelLimitRank_1"},  # 重复保留高破
        ]
        idol_payload = [
            {"idolCardId": "i_card-amao-3-023", "levelLimitRank": "IdolCardLevelLimitRank_5", "potentialRank": "IdolCardPotentialRank_2"},
            {"idolCardId": "i_card-atbm-3-020"},
            {"idolCardId": "i_card-amao-3-023"},  # 重复去重
            {"idolCardId": "i_card-hski-1-000", "potentialRank": "IdolCardPotentialRank_3"},
        ]

        sup_b64, sup_cnt = exp.make_support_code(support_payload)
        cid_b64, cid_cnt = exp.make_cidol_code(idol_payload)

        self.assertEqual(sup_cnt, 3)
        self.assertEqual(base64.b64decode(sup_b64).decode("ascii"), "3-117-4,3-1-0,2-85-2")
        self.assertEqual(cid_cnt, 3)
        self.assertEqual(base64.b64decode(cid_b64).decode("ascii"), "amao-3-023,atbm-3-020,hski-1-000")

        # 用 Node 跑真实 codec.js 解码并回环校验
        node_bin = str(NODE_EXE) if NODE_EXE.is_file() else "node"
        script = f"""
const assert = require('assert');
const codec = require({json.dumps(str(CODEC_JS))});
const supDet = codec.detectCodePayload({json.dumps(sup_b64)});
assert.strictEqual(supDet.kind, 'support');
assert.strictEqual(supDet.decoded.ok, true);
assert.strictEqual(supDet.decoded.b64, {json.dumps(sup_b64)});
assert.deepStrictEqual(supDet.decoded.map, {{ '3-0117': 4, '3-0001': 0, '2-0085': 2 }});

const cidDet = codec.detectCodePayload({json.dumps(cid_b64)});
assert.strictEqual(cidDet.kind, 'cidol');
assert.strictEqual(cidDet.decoded.ok, true);
assert.strictEqual(cidDet.decoded.b64, {json.dumps(cid_b64)});
assert.deepStrictEqual(cidDet.decoded.set, {{ 'amao-3-023': true, 'atbm-3-020': true, 'hski-1-000': true }});
console.log('CROSS_CHECK_OK');
"""
        res = subprocess.run([node_bin, "-e", script], capture_output=True, text=True, check=True)
        self.assertIn("CROSS_CHECK_OK", res.stdout)

    def test_no_network_modules_imported(self) -> None:
        src = (Path(__file__).resolve().parent / "gkms_local_exporter.py").read_text("utf-8")
        for forbidden in ("urllib", "requests", "supabase", "http.client"):
            self.assertNotIn(forbidden, src)

    def test_disclaimer_gate_and_content(self) -> None:
        self.assertEqual(exp.DISCLAIMER_WAIT_SECONDS, 5)
        self.assertFalse(exp.can_accept_disclaimer(5, True))
        self.assertFalse(exp.can_accept_disclaimer(1, True))
        self.assertFalse(exp.can_accept_disclaimer(0, False))
        self.assertTrue(exp.can_accept_disclaimer(0, True))
        for kw in ("风险", "代理 DLL", "使用方法", "停止并还原文件", "病毒佬", "本地离线", "禁止商用", "版权", "侵删"):
            self.assertIn(kw, exp.DISCLAIMER_TEXT)


if __name__ == "__main__":
    unittest.main()
