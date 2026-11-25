#!/usr/bin/env python3
"""
离线提取全部支援卡的多视角轻量图像指纹，生成前端本地识别专用的
web/public/data/support-fingerprints.json。
"""

import base64
import json
import math
from pathlib import Path
from PIL import Image

FEAT_W = 14
FEAT_H = 9
QUANT_SCALE = 4.5

# 覆盖标准构图与游戏列表缩略图可能出现的轻度放大/微偏移视角
CROPS = [
    [0.05, 0.06, 0.95, 0.62],  # standard 1:1
    [0.08, 0.02, 0.92, 0.56],  # shifted up
    [0.10, 0.12, 0.90, 0.68],  # zoomed center
    [0.02, 0.08, 0.82, 0.62],  # zoomed left
    [0.18, 0.08, 0.98, 0.62],  # zoomed right
    [0.14, 0.04, 0.86, 0.52],  # tighter zoom upper
    [0.14, 0.18, 0.86, 0.66],  # tighter zoom lower
]


def extract_quantized_vector(im_crop: Image.Image) -> list[int]:
    small = im_crop.resize((FEAT_W, FEAT_H), Image.Resampling.BILINEAR).convert("RGB")
    px = list(small.get_flattened_data()) if hasattr(small, "get_flattened_data") else list(small.getdata())
    vec: list[float] = []
    for r, g, b in px:
        vec.extend((r / 255.0, g / 255.0, b / 255.0))
    mean = sum(vec) / len(vec)
    centered = [v - mean for v in vec]
    norm = math.sqrt(sum(v * v for v in centered)) or 1.0
    return [
        max(-127, min(127, int(round((v / norm) * 127.0 * QUANT_SCALE))))
        for v in centered
    ]


def main() -> None:
    repo_root = Path(__file__).resolve().parent.parent
    public_dir = repo_root / "web" / "public"
    support_json_path = public_dir / "data" / "support.json"
    out_path = public_dir / "data" / "support-fingerprints.json"

    with support_json_path.open("r", encoding="utf-8") as f:
        catalog = json.load(f)

    keys: list[str] = []
    attrs: list[str] = []
    raw_int8 = bytearray()
    missing: list[str] = []

    for card in catalog:
        img_path = public_dir / "assets" / "cards" / f"s_card-{card['rarity']}-{card['number']}.webp"
        if not img_path.exists():
            missing.append(card["key"])
            continue
        keys.append(card["key"])
        attrs.append(card["attr"])
        with Image.open(img_path) as im:
            w, h = im.size
            for x1, y1, x2, y2 in CROPS:
                crop = im.crop((int(w * x1), int(h * y1), int(w * x2), int(h * y2)))
                qvec = extract_quantized_vector(crop)
                for q in qvec:
                    raw_int8.append(q & 0xFF)

    payload = {
        "version": 1,
        "featW": FEAT_W,
        "featH": FEAT_H,
        "variantsPerCard": len(CROPS),
        "crops": CROPS,
        "keys": keys,
        "attrs": attrs,
        "dataB64": base64.b64encode(bytes(raw_int8)).decode("ascii"),
    }

    with out_path.open("w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    print(
        f"Generated {out_path.relative_to(repo_root)}: "
        f"{len(keys)}/{len(catalog)} cards, {len(raw_int8)} raw bytes, "
        f"{out_path.stat().st_size} json bytes, missing={missing}"
    )


if __name__ == "__main__":
    main()
