#!/usr/bin/env python3
"""
同步 vertesan/gakumasu-diff 上游 YAML 数据为前端与 Koishi 插件共用的 JSON 目录。
仅使用 Python 标准库（不依赖 PyYAML），通过 curl.exe 拉取避免本机证书链差异。
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Any

UPSTREAM_REPO = "vertesan/gakumasu-diff"
UPSTREAM_BRANCH = "main"
RAW_BASE = f"https://raw.githubusercontent.com/{UPSTREAM_REPO}/{UPSTREAM_BRANCH}"

# 已知角色简体中文常用译名映射（上游新增未知角色时自动回退为日文原名拼接）
ZH_CHAR_NAMES: Dict[str, str] = {
    "amao": "有村麻央",
    "atbm": "雨夜燕",
    "fktn": "藤田琴音",
    "hkne": "冰渡香名江",
    "hmsz": "秦谷美铃",
    "hrnm": "姬崎莉波",
    "hski": "花海咲季",
    "hume": "花海佑芽",
    "jsna": "十王星南",
    "kcna": "仓本千奈",
    "kllj": "葛城莉莉娅",
    "shro": "筱泽广",
    "ssmk": "紫云清夏",
    "ttmr": "月村手毬",
}

ATTR_MAP: Dict[str, str] = {
    "SupportCardType_Vocal": "vo",
    "SupportCardType_Dance": "da",
    "SupportCardType_Visual": "vi",
    "SupportCardType_Assist": "as",
}

PLAN_MAP: Dict[str, str] = {
    "ProducePlanType_Plan1": "Sense",
    "ProducePlanType_Plan2": "Logic",
    "ProducePlanType_Plan3": "Anomaly",
    "ProducePlanType_Common": "Common",
}

SUPPORT_RARITY_MAP: Dict[str, str] = {
    "SupportCardRarity_Ssr": "3",
    "SupportCardRarity_Sr": "2",
}

IDOL_RARITY_MAP: Dict[str, str] = {
    "IdolCardRarity_Ssr": "3",
    "IdolCardRarity_Sr": "2",
    "IdolCardRarity_R": "1",
}


def unquote_yaml_scalar(raw: str) -> str:
    """剥离 YAML 标量最外层成对引号并还原常见转义。"""
    s = raw.strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"':
        inner = s[1:-1]
        return (
            inner.replace('\\"', '"')
            .replace("\\\\", "\\")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
        )
    if len(s) >= 2 and s[0] == "'" and s[-1] == "'":
        return s[1:-1].replace("''", "'")
    return s


def parse_yaml_top_items(text: str) -> List[Dict[str, str]]:
    """
    解析 vertesan/gakumasu-diff 风格的顶层 YAML 对象数组：
      - id: xxx
        key: val
    仅提取顶层标量键值，忽略嵌套子对象与子列表。
    """
    items: List[Dict[str, str]] = []
    current: Dict[str, str] | None = None

    for raw_line in text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if raw_line.startswith("- "):
            if current is not None:
                items.append(current)
            current = {}
            rest = raw_line[2:]
            if ":" in rest:
                k, v = rest.split(":", 1)
                current[k.strip()] = unquote_yaml_scalar(v)
            continue

        if (
            current is not None
            and raw_line.startswith("  ")
            and not raw_line.startswith("    ")
            and not raw_line.startswith("  -")
            and ":" in raw_line
        ):
            k, v = raw_line[2:].split(":", 1)
            current[k.strip()] = unquote_yaml_scalar(v)

    if current is not None:
        items.append(current)
    return items


def load_yaml_file(filename: str, local_dir: Path | None) -> str:
    """从本地目录或上游 GitHub Raw 拉取指定 YAML 文件文本。"""
    if local_dir is not None:
        target = local_dir / filename
        if not target.is_file():
            raise FileNotFoundError(f"本地 YAML 文件不存在: {target}")
        return target.read_text(encoding="utf-8")

    url = f"{RAW_BASE}/{filename}"
    curl_bin = "curl.exe" if os.name == "nt" else "curl"
    proc = subprocess.run(
        [curl_bin, "-fsSL", "--retry", "3", "--connect-timeout", "15", url],
        capture_output=True,
    )
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"拉取 {url} 失败 (code={proc.returncode}): {err}")
    return proc.stdout.decode("utf-8")


def to_int(val: Any, default: int = 0) -> int:
    try:
        return int(float(str(val)))
    except (TypeError, ValueError):
        return default


def build_characters(raw_chars: List[Dict[str, str]]) -> Dict[str, str]:
    """构建可游玩角色代号 -> 中文名映射表。"""
    result: Dict[str, str] = {}
    for row in raw_chars:
        if row.get("isPlayable") != "true":
            continue
        cid = row.get("id", "").strip()
        if not cid:
            continue
        fallback = (row.get("lastName", "") + row.get("firstName", "")).strip() or cid.upper()
        result[cid] = ZH_CHAR_NAMES.get(cid, fallback)
    # 稳定按常用顺序/代号排序
    ordered_keys = [k for k in ZH_CHAR_NAMES if k in result] + sorted(
        k for k in result if k not in ZH_CHAR_NAMES
    )
    return {k: result[k] for k in ordered_keys}


def build_support_cards(raw_support: List[Dict[str, str]]) -> List[Dict[str, Any]]:
    """构建 SSR + SR 支援卡目录。"""
    cards: List[Dict[str, Any]] = []
    for row in raw_support:
        rarity = SUPPORT_RARITY_MAP.get(row.get("rarity", ""))
        if not rarity:
            continue
        card_id = row.get("id", "")
        m = re.match(r"^s_card-[23]-(\d{1,4})$", card_id)
        if not m:
            continue
        number = m.group(1).zfill(4)
        attr = ATTR_MAP.get(row.get("type", ""), "vo")
        plan = PLAN_MAP.get(row.get("planType", ""), "Common")
        cards.append(
            {
                "id": card_id,
                "key": f"{rarity}-{number}",
                "rarity": rarity,
                "number": number,
                "attr": attr,
                "plan": plan,
                "name": row.get("name", "") or card_id,
                "isLimited": row.get("isLimited") == "true",
                "order": to_int(row.get("order"), 0),
                "image": f"assets/cards/s_card-{rarity}-{number}.webp",
            }
        )

    cards.sort(key=lambda c: (-int(c["rarity"]), -int(c["number"])))
    return cards


def build_cidol_cards(
    raw_idol_cards: List[Dict[str, str]],
    raw_skins: List[Dict[str, str]],
) -> List[Dict[str, Any]]:
    """关联 IdolCard 与 IdolCardSkin 构建角色 P 卡 / 皮肤目录。"""
    idol_map: Dict[str, Dict[str, str]] = {
        row["id"]: row for row in raw_idol_cards if row.get("id")
    }
    skins: List[Dict[str, Any]] = []
    seen_keys = set()

    for skin in raw_skins:
        asset_id = skin.get("assetId", "")
        m = re.match(r"^cidol-([a-z0-9]+)-([123])-(\d{1,3})$", asset_id)
        if not m:
            continue
        character, rarity, num_raw = m.group(1), m.group(2), m.group(3)
        number = num_raw.zfill(3)
        key = f"{character}-{rarity}-{number}"
        if key in seen_keys:
            continue
        seen_keys.add(key)

        card = idol_map.get(skin.get("idolCardId", ""), {})
        card_rarity = IDOL_RARITY_MAP.get(card.get("rarity", ""), rarity)
        plan = PLAN_MAP.get(card.get("planType", ""), "Common")
        skin_name = (skin.get("name") or "").strip()
        card_name = (card.get("name") or "").strip()
        display_name = skin_name or card_name or key

        skins.append(
            {
                "key": key,
                "id": skin.get("id", f"i_card-skin-{key}"),
                "idolCardId": skin.get("idolCardId", ""),
                "character": character,
                "rarity": str(card_rarity),
                "number": number,
                "name": display_name,
                "baseName": card_name,
                "isSkinVariant": bool(skin_name),
                "isLimited": card.get("isLimited") == "true",
                "plan": plan,
                "variants": ["0", "1"],
                "images": {
                    "0": f"assets/cidol/cidol-{key}_0.webp",
                    "1": f"assets/cidol/cidol-{key}_1.webp",
                },
                "stats": {
                    "vo": to_int(card.get("produceVocal"), 0),
                    "da": to_int(card.get("produceDance"), 0),
                    "vi": to_int(card.get("produceVisual"), 0),
                    "voRate": round(to_int(card.get("produceVocalGrowthRatePermil"), 0) / 10.0, 1),
                    "daRate": round(to_int(card.get("produceDanceGrowthRatePermil"), 0) / 10.0, 1),
                    "viRate": round(to_int(card.get("produceVisualGrowthRatePermil"), 0) / 10.0, 1),
                },
            }
        )

    skins.sort(key=lambda s: (s["character"], -int(s["rarity"]), s["number"]))
    return skins


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def sync_all(local_dir: Path | None, out_dirs: List[Path]) -> Dict[str, Any]:
    raw_chars = parse_yaml_top_items(load_yaml_file("Character.yaml", local_dir))
    raw_support = parse_yaml_top_items(load_yaml_file("SupportCard.yaml", local_dir))
    raw_idol = parse_yaml_top_items(load_yaml_file("IdolCard.yaml", local_dir))
    raw_skins = parse_yaml_top_items(load_yaml_file("IdolCardSkin.yaml", local_dir))

    characters = build_characters(raw_chars)
    support = build_support_cards(raw_support)
    cidol = build_cidol_cards(raw_idol, raw_skins)

    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    ssr_count = sum(1 for c in support if c["rarity"] == "3")
    sr_count = sum(1 for c in support if c["rarity"] == "2")

    meta = {
        "schema": 1,
        "generatedAt": now_iso,
        "source": {
            "repo": UPSTREAM_REPO,
            "branch": UPSTREAM_BRANCH,
        },
        "counts": {
            "characters": len(characters),
            "support": len(support),
            "supportSsr": ssr_count,
            "supportSr": sr_count,
            "cidol": len(cidol),
        },
    }

    for out_dir in out_dirs:
        write_json(out_dir / "characters.json", characters)
        write_json(out_dir / "support.json", support)
        write_json(out_dir / "cidol.json", cidol)
        write_json(out_dir / "meta.json", meta)
        manifest_path = out_dir / "asset-manifest.json"
        if not manifest_path.exists():
            write_json(
                manifest_path,
                {
                    "generatedAt": now_iso,
                    "cards": [],
                    "cidol": {},
                },
            )

    return meta


def main() -> int:
    root_dir = Path(__file__).resolve().parent.parent
    default_outs = [
        root_dir / "web" / "public" / "data",
        root_dir / "koishi-plugin" / "data",
    ]

    parser = argparse.ArgumentParser(description="同步 gakumasu-diff 卡池数据为 JSON 目录")
    parser.add_argument(
        "--local-dir",
        type=Path,
        default=None,
        help="离线模式：从本地目录读取 4 个 YAML 文件",
    )
    parser.add_argument(
        "--out",
        type=Path,
        action="append",
        default=None,
        help="指定输出目录（可传多次；默认同时写入 web/public/data 与 koishi-plugin/data）",
    )
    args = parser.parse_args()

    out_dirs = args.out if args.out else default_outs
    meta = sync_all(args.local_dir, out_dirs)
    print(
        f"[sync_catalog] 同步完成: 角色 {meta['counts']['characters']} 名, "
        f"支援卡 {meta['counts']['support']} 张 (SSR {meta['counts']['supportSsr']} / SR {meta['counts']['supportSr']}), "
        f"P卡与皮肤 {meta['counts']['cidol']} 项"
    )
    for d in out_dirs:
        print(f"  -> {d}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
