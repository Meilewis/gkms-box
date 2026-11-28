#!/usr/bin/env python3
"""生成《学园偶像大师》S 卡黑话对照长图（1856px 极简日系 Wiki 6 列白底排版）。"""

from __future__ import annotations

import json
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
HIF_JSON = ROOT / "koishi-plugin" / "data" / "hif_cards.json"
SUP_JSON = ROOT / "web" / "public" / "data" / "support.json"
ASSETS_DIR = ROOT / "web" / "public"
OUT_DIR = ROOT / "output"
OUT_PATH = OUT_DIR / "gkms_s_card_slang_sheet.jpg"
PLUGIN_IMG_PATH = ROOT / "koishi-plugin" / "data" / "s_card_slang_sheet.jpg"

# 极简日系 Wiki / 攻略站表格风参数
W = 1856
PAD_X = 28
TABLE_W = W - PAD_X * 2  # 1800
COLS = 6
CELL_W = TABLE_W // COLS  # 300
CELL_PAD = 8
IMG_W = CELL_W - CELL_PAD * 2  # 284
IMG_H = 159                    # 16:9 干净原图比例
CELL_H = 268
HEADER_H = 172
SECTION_HEADER_H = 42
SECTION_GAP = 18
FOOTER_H = 24

BG_COLOR = (255, 255, 255)
BORDER_COLOR = (212, 219, 228)
EMPTY_CELL_BG = (250, 251, 253)

TEXT_MAIN = (15, 23, 42)
TEXT_SUB = (100, 116, 139)
TEXT_MUTED = (120, 132, 150)

ATTR_META = {
    1: {"code": "Vo", "accent": (225, 29, 72), "tint": (255, 241, 242), "bd": (253, 164, 175), "fg": (190, 18, 60)},
    2: {"code": "Da", "accent": (2, 132, 199), "tint": (240, 249, 255), "bd": (125, 211, 252), "fg": (3, 105, 161)},
    3: {"code": "Vi", "accent": (217, 119, 6), "tint": (255, 251, 235), "bd": (252, 211, 77), "fg": (180, 83, 9)},
}

RARITY_META = {
    3: {"name": "SSR", "bg": (254, 243, 199), "bd": (245, 158, 11), "fg": (180, 83, 9)},
    2: {"name": "SR", "bg": (241, 245, 249), "bd": (203, 213, 225), "fg": (71, 85, 105)},
}

PLAN_META = {
    0: {"name": "通用", "bg": (241, 245, 249), "bd": (203, 213, 225), "fg": (71, 85, 105)},
    1: {"name": "感性", "bg": (255, 241, 242), "bd": (253, 164, 175), "fg": (190, 18, 60)},
    2: {"name": "理性", "bg": (239, 246, 255), "bd": (147, 197, 253), "fg": (29, 78, 216)},
    3: {"name": "非凡", "bg": (250, 245, 255), "bd": (216, 180, 254), "fg": (126, 34, 206)},
}

FONT_ZH_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
FONT_ZH_REG = r"C:\Windows\Fonts\msyh.ttc"
FONT_JP = r"C:\Windows\Fonts\YuGothM.ttc"


def get_font(path: str, size: int):
    return ImageFont.truetype(path, size=size)


def text_width(draw: ImageDraw.ImageDraw, txt: str, font) -> float:
    if not txt:
        return 0.0
    box = draw.textbbox((0, 0), txt, font=font)
    return float(box[2] - box[0])


def wrap_lines(draw: ImageDraw.ImageDraw, txt: str, font, max_w: int, max_lines: int = 2):
    lines = []
    cur = ""
    i = 0
    while i < len(txt):
        ch = txt[i]
        cand = cur + ch
        if text_width(draw, cand, font) <= max_w or not cur:
            cur = cand
            i += 1
        else:
            lines.append(cur)
            cur = ""
            if len(lines) >= max_lines:
                break
    if cur and len(lines) < max_lines:
        lines.append(cur)
    elif i < len(txt) and lines:
        last = lines[-1]
        while last and text_width(draw, last + "…", font) > max_w:
            last = last[:-1]
        lines[-1] = last + "…"
    return lines


def cover_crop(im: Image.Image, target_w: int, target_h: int) -> Image.Image:
    sw, sh = im.size
    scale = max(target_w / sw, target_h / sh)
    nw, nh = max(1, round(sw * scale)), max(1, round(sh * scale))
    resized = im.resize((nw, nh), Image.Resampling.LANCZOS)
    x0 = (nw - target_w) // 2
    y0 = (nh - target_h) // 2
    return resized.crop((x0, y0, x0 + target_w, y0 + target_h))


def draw_badge(draw: ImageDraw.ImageDraw, x: int, y: int, label: str, font, bg, fg, bd=None, pad_x=5, h=19):
    bw = int(text_width(draw, label, font)) + pad_x * 2
    draw.rectangle((x, y, x + bw, y + h), fill=bg, outline=bd, width=1 if bd else 0)
    draw.text((x + pad_x, y + 2), label, font=font, fill=fg)
    return x + bw + 4


def release_sort_key(card, sup_by_key):
    sup = sup_by_key.get(card["supportKey"])
    order = int(sup["order"]) if sup and sup.get("order") is not None else 9999999999
    batch = (order % 1_000_000_000) // 10000
    num = int(card["supportKey"].split("-")[1])
    return (-int(card["rarity"]), batch, -num)


def build_ranked_cards():
    hif_cards = json.loads(HIF_JSON.read_text(encoding="utf-8"))["cards"]
    sup_list = json.loads(SUP_JSON.read_text(encoding="utf-8"))
    sup_by_key = {c["key"]: c for c in sup_list}

    valid = [c for c in hif_cards if (c.get("alias") or "").strip()]
    ranked_cards = sorted(valid, key=lambda c: release_sort_key(c, sup_by_key))
    return ranked_cards, sup_by_key


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    ranked_cards, sup_by_key = build_ranked_cards()
    card_total = len(ranked_cards)
    ssr_cards = [c for c in ranked_cards if int(c["rarity"]) == 3]
    sr_cards = [c for c in ranked_cards if int(c["rarity"]) != 3]

    sections = [
        sec
        for sec in (
            {
                "title": "SSR 支援卡",
                "cards": ssr_cards,
                "accent": (245, 158, 11),
            },
            {
                "title": "SR 支援卡",
                "cards": sr_cards,
                "accent": (100, 116, 139),
            },
        )
        if sec["cards"]
    ]

    grid_body_h = sum(
        SECTION_HEADER_H + math.ceil(len(sec["cards"]) / COLS) * CELL_H for sec in sections
    )
    total_h = HEADER_H + grid_body_h + SECTION_GAP * max(0, len(sections) - 1) + FOOTER_H

    print(
        f"Ranked Sheet Canvas: {W}x{total_h}, sections={len(sections)}, "
        f"SSR={len(ssr_cards)}, SR={len(sr_cards)}, total_cards={card_total}"
    )
    if ssr_cards:
        print(
            f"  SSR range: first={ssr_cards[0]['supportKey']}({ssr_cards[0]['alias']}) -> "
            f"last={ssr_cards[-1]['supportKey']}({ssr_cards[-1]['alias']})"
        )
    if sr_cards:
        print(
            f"  SR  range: first={sr_cards[0]['supportKey']}({sr_cards[0]['alias']}) -> "
            f"last={sr_cards[-1]['supportKey']}({sr_cards[-1]['alias']})"
        )

    canvas = Image.new("RGB", (W, total_h), BG_COLOR)
    draw = ImageDraw.Draw(canvas)

    f_title = get_font(FONT_ZH_BOLD, 30)
    f_sec_title = get_font(FONT_ZH_BOLD, 18)
    f_count = get_font(FONT_ZH_REG, 15)
    f_notice_b = get_font(FONT_ZH_BOLD, 13)
    f_notice = get_font(FONT_ZH_REG, 13)
    f_tag = get_font(FONT_ZH_BOLD, 11)
    f_key = get_font(FONT_ZH_REG, 12)
    f_jp = get_font(FONT_JP, 13)

    # 1. 顶部标题、动态总数统计与来源/免责声明框
    draw.rectangle((PAD_X, 20, PAD_X + 6, 56), fill=(234, 88, 12))
    draw.text((PAD_X + 16, 17), "学园偶像大师 · S 卡黑话对照表", font=f_title, fill=TEXT_MAIN)

    count_text = f"共收录 {card_total} 张 S 卡（SSR {len(ssr_cards)} / SR {len(sr_cards)} · 最新实装在前）"
    count_w = int(text_width(draw, count_text, f_count))
    draw.text((W - PAD_X - count_w, 29), count_text, font=f_count, fill=TEXT_SUB)

    notice_y1, notice_y2 = 66, 160
    draw.rectangle((PAD_X, notice_y1, W - PAD_X, notice_y2), fill=(248, 250, 252), outline=BORDER_COLOR, width=1)
    draw.rectangle((PAD_X, notice_y1, PAD_X + 4, notice_y2), fill=(234, 88, 12))
    notice_rows = [
        (
            "黑话来源：",
            "原《学园偶像大师》支援卡算分表（支援卡-11.3新卡实装.xlsx，原作者：melon）及后续新实装卡补充",
            (15, 23, 42),
        ),
        (
            "卡面版权：",
            "卡池目录与卡面同步自 vertesan/gakumasu-diff；游戏及素材版权归 © Bandai Namco Entertainment Inc. / QualiArts, Inc. 所有",
            (51, 65, 85),
        ),
        (
            "免责声明：",
            "由同好工具 gkms-box（gkms.134491.xyz）整理排版，仅供非营利交流速查，俗称随社区习惯可能存在差异，与官方无关，如有侵权请联系删除",
            (180, 83, 9),
        ),
    ]
    for idx, (lbl, body, lbl_col) in enumerate(notice_rows):
        ry = notice_y1 + 13 + idx * 25
        draw.text((PAD_X + 16, ry), lbl, font=f_notice_b, fill=lbl_col)
        lw = int(text_width(draw, lbl, f_notice_b))
        body_col = (51, 65, 85) if idx < 2 else (71, 85, 105)
        draw.text((PAD_X + 16 + lw + 2, ry), body, font=f_notice, fill=body_col)

    # 2. 按 SSR / SR 分区绘制 6 列网格（组内按实装批次倒序：最新在前）
    cur_y = HEADER_H
    for sec in sections:
        sec_cards = sec["cards"]
        sec_count = len(sec_cards)
        sec_rows = math.ceil(sec_count / COLS)
        sec_slots = sec_rows * COLS

        # 分区标题栏
        draw.rectangle(
            (PAD_X, cur_y, W - PAD_X, cur_y + SECTION_HEADER_H),
            fill=(248, 250, 252),
            outline=BORDER_COLOR,
            width=1,
        )
        draw.rectangle((PAD_X, cur_y, PAD_X + 5, cur_y + SECTION_HEADER_H), fill=sec["accent"])
        draw.text((PAD_X + 16, cur_y + 9), sec["title"], font=f_sec_title, fill=TEXT_MAIN)

        sec_sub = f"共 {sec_count} 张 · 最新实装在前"
        sec_sub_w = int(text_width(draw, sec_sub, f_count))
        draw.text((W - PAD_X - 14 - sec_sub_w, cur_y + 11), sec_sub, font=f_count, fill=TEXT_SUB)

        grid_y0 = cur_y + SECTION_HEADER_H
        grid_y1 = grid_y0 + sec_rows * CELL_H

        for idx in range(sec_slots):
            r = idx // COLS
            c = idx % COLS
            cx1 = PAD_X + c * CELL_W
            cy1 = grid_y0 + r * CELL_H
            cx2 = cx1 + CELL_W
            cy2 = cy1 + CELL_H

            if idx >= sec_count:
                draw.rectangle((cx1, cy1, cx2, cy2), fill=EMPTY_CELL_BG)
                continue

            card = sec_cards[idx]
            am = ATTR_META[card["attr"]]
            rm = RARITY_META.get(card["rarity"], RARITY_META[2])
            pm = PLAN_META[card["plan"]]

            draw.rectangle((cx1, cy1, cx2, cy2), fill=BG_COLOR)
            draw.rectangle((cx1 + 1, cy1 + 1, cx2 - 1, cy1 + 2), fill=am["accent"])

            img_x = cx1 + CELL_PAD
            img_y = cy1 + 9
            sup_meta = sup_by_key.get(card["supportKey"])
            if sup_meta:
                img_path = ASSETS_DIR / sup_meta["image"]
                if img_path.is_file():
                    with Image.open(img_path) as raw_im:
                        cropped = cover_crop(raw_im.convert("RGB"), IMG_W, IMG_H)
                    canvas.paste(cropped, (img_x, img_y))
            draw.rectangle((img_x, img_y, img_x + IMG_W - 1, img_y + IMG_H - 1), outline=(226, 232, 240), width=1)

            # 元数据行：SSR/SR + Vo/Da/Vi + 流派 + SP + 右侧卡号
            meta_y = img_y + IMG_H + 6
            bx = img_x
            bx = draw_badge(draw, bx, meta_y, rm["name"], f_tag, rm["bg"], rm["fg"], bd=rm["bd"], pad_x=5)
            bx = draw_badge(draw, bx, meta_y, am["code"], f_tag, am["tint"], am["fg"], bd=am["bd"], pad_x=5)
            bx = draw_badge(draw, bx, meta_y, pm["name"], f_tag, pm["bg"], pm["fg"], bd=pm["bd"], pad_x=5)
            if card.get("isSp") == 1:
                draw_badge(draw, bx, meta_y, "SP", f_tag, (234, 88, 12), (255, 255, 255), bd=None, pad_x=5)

            key_str = card["supportKey"]
            kw = int(text_width(draw, key_str, f_key))
            draw.text((cx2 - CELL_PAD - kw, meta_y + 2), key_str, font=f_key, fill=TEXT_MUTED)

            # 黑话主标题与日文原名
            alias = card["alias"].strip()
            jp = card["jpName"].strip()
            alias_y = meta_y + 25
            alias_font = None
            for sz in (20, 18, 16, 15):
                ft = get_font(FONT_ZH_BOLD, sz)
                if text_width(draw, alias, ft) <= IMG_W:
                    alias_font = ft
                    break

            if alias_font is None:
                alias_font = get_font(FONT_ZH_BOLD, 15)
                alines = wrap_lines(draw, alias, alias_font, IMG_W, 2)
                for li, al in enumerate(alines):
                    draw.text((img_x, alias_y + li * 19), al, font=alias_font, fill=TEXT_MAIN)
                jp_y = alias_y + len(alines) * 19 + 4
                jlines = wrap_lines(draw, jp, f_jp, IMG_W, 1)
            else:
                draw.text((img_x, alias_y), alias, font=alias_font, fill=TEXT_MAIN)
                jp_y = alias_y + 27
                jlines = wrap_lines(draw, jp, f_jp, IMG_W, 2)

            for li, jl in enumerate(jlines):
                draw.text((img_x, jp_y + li * 17), jl, font=f_jp, fill=TEXT_SUB)

        # 绘制本分区共享 1px Wiki 表格网格线
        for r in range(sec_rows + 1):
            ly = grid_y0 + r * CELL_H
            draw.line([(PAD_X, ly), (W - PAD_X, ly)], fill=BORDER_COLOR, width=1)
        for c in range(COLS + 1):
            lx = PAD_X + c * CELL_W
            draw.line([(lx, grid_y0), (lx, grid_y1)], fill=BORDER_COLOR, width=1)

        cur_y = grid_y1 + SECTION_GAP

    # 3. 压缩保存与双份输出
    PLUGIN_IMG_PATH.parent.mkdir(parents=True, exist_ok=True)
    saved_q = 85
    for q in (85, 82, 78):
        canvas.save(OUT_PATH, format="JPEG", quality=q, subsampling=2, optimize=True)
        saved_q = q
        if OUT_PATH.stat().st_size <= 4 * 1024 * 1024:
            break

    PLUGIN_IMG_PATH.write_bytes(OUT_PATH.read_bytes())
    size_mb = OUT_PATH.stat().st_size / (1024 * 1024)
    print(f"Saved (q={saved_q}): {OUT_PATH} ({size_mb:.2f} MB) & {PLUGIN_IMG_PATH}")


if __name__ == "__main__":
    main()
