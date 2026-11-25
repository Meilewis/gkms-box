#!/usr/bin/env python3
"""
本地学马仕卡面图片一键导入、转 WebP 压缩与 asset-manifest.json 清单生成脚本。
支持按游戏资产编号（s_card-* / csprt-* / cidol-*）以及按日文卡名自动识别匹配；
图数分离设计：未导入图片时前后端自动显示高颜值占位卡；放入图片并运行本脚本后立即自动启用高清卡面。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Tuple

from PIL import Image, ImageOps

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}

SUPPORT_RE = re.compile(r"(?:^|[^a-z0-9])(?:s_card|csprt)[-_]([23])[-_](\d{1,4})(?:[^0-9]|$)", re.IGNORECASE)
CIDOL_RE = re.compile(
    r"(?:img_general_)?cidol[-_]([a-z0-9]+)[-_]([123])[-_](\d{1,3})(?:[-_]([01]))?(?:[-_].*)?$",
    re.IGNORECASE,
)

OUT_SUPPORT_RE = re.compile(r"^s_card-([23])-(\d{4})\.webp$")
OUT_CIDOL_RE = re.compile(r"^cidol-([a-z0-9]+-[123]-\d{3})_([01])\.webp$")

LOOSE_STRIP_RE = re.compile(r'[\\/:*?"<>|！？!?,、。・…\s_~～♪「」『』()（）\-－—]+')


def normalize_card_name(name: str) -> Tuple[str, str]:
    """返回 (NFKC 规范名, 去除标点与空白的宽松名)。"""
    s = unicodedata.normalize("NFKC", str(name or "")).replace("\u3000", " ").strip()
    loose = LOOSE_STRIP_RE.sub("", s).lower()
    return s, loose


def build_name_index(catalog_dirs: List[Path]) -> Dict[str, Dict[str, List[Tuple[str, str]]]]:
    """从卡池 JSON 目录构建唯一卡名索引（支持支援卡与 P 卡按卡名匹配）。"""
    support_rows: List[Dict[str, Any]] = []
    cidol_rows: List[Dict[str, Any]] = []

    for d in catalog_dirs:
        sp = d / "data" / "support.json"
        if sp.is_file() and not support_rows:
            support_rows = json.loads(sp.read_text(encoding="utf-8"))
        cp = d / "data" / "cidol.json"
        if cp.is_file() and not cidol_rows:
            cidol_rows = json.loads(cp.read_text(encoding="utf-8"))

    exact_map: Dict[str, List[Tuple[str, str]]] = {}
    loose_map: Dict[str, List[Tuple[str, str]]] = {}

    for c in support_rows:
        rarity = c.get("rarity")
        number = str(c.get("number", "")).zfill(4)
        if not rarity or not number:
            continue
        target = ("support", f"cards/s_card-{rarity}-{number}.webp")
        ex, lo = normalize_card_name(c.get("name", ""))
        if ex:
            exact_map.setdefault(ex, []).append(target)
        if lo:
            loose_map.setdefault(lo, []).append(target)

    for s in cidol_rows:
        key = s.get("key")
        if not key:
            continue
        target = ("cidol", f"cidol/cidol-{key}_1.webp")
        ex, lo = normalize_card_name(s.get("name", ""))
        if ex:
            exact_map.setdefault(ex, []).append(target)
        if lo:
            loose_map.setdefault(lo, []).append(target)

    return {"exact": exact_map, "loose": loose_map}


def classify_image_name(
    stem: str,
    name_index: Dict[str, Dict[str, List[Tuple[str, str]]]] | None = None,
) -> Tuple[str, str] | None:
    """
    识别常见游戏导出文件名（资产编号或日文卡名）并归一化为标准相对路径。
    返回: ('support' | 'cidol', 'cards/s_card-3-0001.webp' | 'cidol/cidol-amao-3-000_1.webp')
    """
    m_sup = SUPPORT_RE.search(stem)
    if m_sup:
        rarity = m_sup.group(1)
        number = m_sup.group(2).zfill(4)
        return ("support", f"cards/s_card-{rarity}-{number}.webp")

    m_cid = CIDOL_RE.search(stem)
    if m_cid:
        char_code = m_cid.group(1).lower()
        rarity = m_cid.group(2)
        number = m_cid.group(3).zfill(3)
        variant = m_cid.group(4) if m_cid.group(4) in ("0", "1") else "1"
        return ("cidol", f"cidol/cidol-{char_code}-{rarity}-{number}_{variant}.webp")

    if name_index:
        ex, lo = normalize_card_name(stem)
        exact_hits = name_index["exact"].get(ex, [])
        if len(exact_hits) == 1:
            return exact_hits[0]
        loose_hits = name_index["loose"].get(lo, [])
        if len(loose_hits) == 1:
            return loose_hits[0]

    return None


def resize_and_encode_webp(
    src_path: Path,
    max_width: int,
    max_height: int,
    quality: int,
) -> bytes:
    """读取图片、修正 EXIF 方向、按上限等比缩放并编码为 WebP 字节。"""
    import io

    with Image.open(src_path) as im:
        im = ImageOps.exif_transpose(im)
        has_alpha = im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info)
        im = im.convert("RGBA" if has_alpha else "RGB")

        w, h = im.size
        scale = 1.0
        if max_width > 0 and w > max_width:
            scale = min(scale, max_width / float(w))
        if max_height > 0 and h > max_height:
            scale = min(scale, max_height / float(h))
        if scale < 1.0:
            new_size = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
            im = im.resize(new_size, Image.Resampling.LANCZOS)

        buf = io.BytesIO()
        im.save(buf, format="WEBP", quality=quality, method=4)
        return buf.getvalue()


def rebuild_manifest(target_dir: Path) -> Dict[str, object]:
    """扫描 target_dir/assets 目录并生成 target_dir/data/asset-manifest.json。"""
    assets_dir = target_dir / "assets"
    cards_dir = assets_dir / "cards"
    cidol_dir = assets_dir / "cidol"

    cards: List[str] = []
    if cards_dir.is_dir():
        for f in cards_dir.iterdir():
            if f.is_file():
                m = OUT_SUPPORT_RE.match(f.name)
                if m:
                    cards.append(f"{m.group(1)}-{m.group(2)}")
    cards.sort(key=lambda k: (-int(k.split("-")[0]), -int(k.split("-")[1])))

    cidol_map: Dict[str, List[str]] = {}
    if cidol_dir.is_dir():
        for f in cidol_dir.iterdir():
            if f.is_file():
                m = OUT_CIDOL_RE.match(f.name)
                if m:
                    key, variant = m.group(1), m.group(2)
                    cidol_map.setdefault(key, [])
                    if variant not in cidol_map[key]:
                        cidol_map[key].append(variant)
    for key in cidol_map:
        cidol_map[key].sort()

    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    manifest = {
        "generatedAt": now_iso,
        "cards": cards,
        "cidol": dict(sorted(cidol_map.items())),
    }
    data_dir = target_dir / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "asset-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return manifest


def import_assets(
    source_dir: Path | None,
    target_dirs: List[Path],
    quality: int = 84,
    max_card_width: int = 640,
    max_cidol_height: int = 640,
    clean: bool = False,
    manifest_only: bool = False,
) -> Dict[str, int]:
    stats = {"scanned": 0, "supportImported": 0, "cidolImported": 0, "skipped": 0}

    if clean and not manifest_only:
        for td in target_dirs:
            for sub in ("cards", "cidol"):
                p = td / "assets" / sub
                if p.exists():
                    shutil.rmtree(p)

    for td in target_dirs:
        (td / "assets" / "cards").mkdir(parents=True, exist_ok=True)
        (td / "assets" / "cidol").mkdir(parents=True, exist_ok=True)

    root_dir = Path(__file__).resolve().parent.parent
    name_index = build_name_index(target_dirs + [root_dir / "web" / "public", root_dir / "koishi-plugin"])

    if not manifest_only:
        if source_dir is None or not source_dir.is_dir():
            raise FileNotFoundError(f"图片源目录不存在: {source_dir}")

        for src in sorted(source_dir.rglob("*")):
            if not src.is_file() or src.suffix.lower() not in IMAGE_EXTS:
                continue
            stats["scanned"] += 1
            classified = classify_image_name(src.stem, name_index=name_index)
            if not classified:
                stats["skipped"] += 1
                continue

            kind, rel_path = classified
            if kind == "support":
                webp_bytes = resize_and_encode_webp(src, max_width=max_card_width, max_height=0, quality=quality)
                stats["supportImported"] += 1
            else:
                webp_bytes = resize_and_encode_webp(src, max_width=0, max_height=max_cidol_height, quality=quality)
                stats["cidolImported"] += 1

            for td in target_dirs:
                dest = td / "assets" / rel_path
                dest.parent.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(webp_bytes)

    for td in target_dirs:
        man = rebuild_manifest(td)
        stats["manifestCards"] = len(man["cards"])
        stats["manifestCidol"] = len(man["cidol"])

    return stats


def main() -> int:
    root_dir = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="导入并压缩学马仕卡面图片生成 WebP 与清单")
    parser.add_argument("--source", type=Path, default=None, help="本地卡面图片源目录")
    parser.add_argument(
        "--web-dir",
        type=Path,
        default=root_dir / "web" / "public",
        help="前端静态目录 (默认: web/public)",
    )
    parser.add_argument(
        "--plugin-dir",
        type=Path,
        default=None,
        help="可选：同时写入一份到 Koishi 插件目录（例如 koishi-plugin）",
    )
    parser.add_argument("--quality", type=int, default=84, help="WebP 压缩质量 1~100（默认 84）")
    parser.add_argument("--max-card-width", type=int, default=640, help="S卡最大宽度 px（默认 640）")
    parser.add_argument("--max-cidol-height", type=int, default=640, help="P卡最大高度 px（默认 640）")
    parser.add_argument("--clean", action="store_true", help="导入前先清空目标 assets/cards 与 assets/cidol")
    parser.add_argument("--manifest-only", action="store_true", help="仅重扫已有 assets 目录并刷新 asset-manifest.json")
    args = parser.parse_args()

    if not args.manifest_only and args.source is None:
        parser.error("请提供 --source <图片目录>，或使用 --manifest-only")

    targets = [args.web_dir]
    if args.plugin_dir is not None and args.plugin_dir.resolve() != args.web_dir.resolve():
        targets.append(args.plugin_dir)

    stats = import_assets(
        source_dir=args.source,
        target_dirs=targets,
        quality=args.quality,
        max_card_width=args.max_card_width,
        max_cidol_height=args.max_cidol_height,
        clean=args.clean,
        manifest_only=args.manifest_only,
    )
    print(
        f"[import_assets] 完成：扫描 {stats['scanned']} 张，"
        f"导入 S卡 {stats['supportImported']} 张、P卡 {stats['cidolImported']} 张、跳过 {stats['skipped']} 张；"
        f"清单现含 S卡 {stats.get('manifestCards', 0)} 张、P卡 {stats.get('manifestCidol', 0)} 组"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
