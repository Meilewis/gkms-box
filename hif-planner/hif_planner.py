#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
HIF 支援卡配卡与路线规划本地原型工具（纯标准库，精准版 v2）。

核心机制：
1. 内置 13 位角色实测初始三维与成长率（暂不考虑开花/特训变动），同一角色 P 卡共享；
2. 自由日路线约束：严格遵守每日可选图标，且除一选前(5日)允许外出外，二选后尽量避免外出、优先支给；
3. 8 次 SP 训练具体日期(2/4/9/11/15/18/本战2/本战5)自由分配与排序寻优；
4. 选拔 1/2/3 固定全属(20/80/100) + 可分配(80/200/220) 自由控分到任意属性吃百分比；
5. 8 次 SP + 3 次选拔共 11 次蓝字事件按 (角色%+回忆%+支援卡%) 逐次 floor 舍去小数；
   S 卡固值与 6 次营业红字(900)不受百分比影响；3200 单属性溢出记为 0 收益。
"""

import argparse
import ast
import itertools
import json
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

BASE_DIR = Path(__file__).resolve().parent
CARDS_JSON = BASE_DIR / "cards_data.json"
CIDOL_JSON = BASE_DIR.parent / "web" / "public" / "data" / "cidol.json"

ATTR_NAMES = {1: "红(Vo)", 2: "蓝(Da)", 3: "黄(Vi)"}
ATTR_SHORT = {1: "红", 2: "蓝", 3: "黄"}
ATTR_KEYS = {1: "vo", 2: "da", 3: "vi"}
PLAN_NAMES = {0: "通用", 1: "感性", 2: "理性", 3: "非凡"}
PLAN_MAP = {"Sense": 1, "Logic": 2, "Anomaly": 3}

STAT_CAP = 3200
HIF_EXAM_LINES = (1960, 1307, 1089)
HIF_GLOBAL_PCT_BONUS = 10.0
HIF_GLOBAL_FLAT_BONUS = 100

CHAR_BASE_STATS = {
    "hume": {"vo": 115, "da": 120, "vi": 125, "voRate": 20.0, "daRate": 23.0, "viRate": 18.0},
    "hmsz": {"vo": 95,  "da": 125, "vi": 140, "voRate": 27.0, "daRate": 13.0, "viRate": 20.0},
    "hski": {"vo": 120, "da": 125, "vi": 135, "voRate": 16.5, "daRate": 16.5, "viRate": 20.5},
    "ttmr": {"vo": 120, "da": 100, "vi": 80,  "voRate": 27.0, "daRate": 22.5, "viRate": 11.5},
    "fktn": {"vo": 95,  "da": 105, "vi": 135, "voRate": 11.0, "daRate": 24.5, "viRate": 22.5},
    "atbm": {"vo": 115, "da": 140, "vi": 110, "voRate": 17.0, "daRate": 20.0, "viRate": 13.0},
    "amao": {"vo": 125, "da": 90,  "vi": 115, "voRate": 23.0, "daRate": 11.0, "viRate": 24.0},
    "kllj": {"vo": 60,  "da": 80,  "vi": 95,  "voRate": 18.0, "daRate": 20.0, "viRate": 18.0},
    "kcna": {"vo": 95,  "da": 125, "vi": 135, "voRate": 13.0, "daRate": 24.0, "viRate": 21.5},
    "ssmk": {"vo": 105, "da": 115, "vi": 95,  "voRate": 12.0, "daRate": 25.0, "viRate": 24.0},
    "shro": {"vo": 130, "da": 125, "vi": 95,  "voRate": 25.0, "daRate": 19.5, "viRate": 13.0},
    "jsna": {"vo": 175, "da": 125, "vi": 140, "voRate": 16.0, "daRate": 13.0, "viRate": 22.5},
    "hrnm": {"vo": 85,  "da": 120, "vi": 125, "voRate": 13.0, "daRate": 21.5, "viRate": 25.5},
}

CHAR_ALIASES = {
    "amao": ["amao", "有村麻央", "有村", "麻央"],
    "atbm": ["atbm", "雨夜燕", "雨夜", "燕"],
    "fktn": ["fktn", "藤田琴音", "藤田", "琴音"],
    "hkne": ["hkne", "冰渡香名江", "冰渡", "香名江"],
    "hmsz": ["hmsz", "秦谷美铃", "秦谷", "美铃"],
    "hrnm": ["hrnm", "姬崎莉波", "姬崎", "莉波"],
    "hski": ["hski", "花海咲季", "咲季", "大佑芽"],
    "hume": ["hume", "花海佑芽", "佑芽"],
    "jsna": ["jsna", "十王星南", "十王", "星南", "会长"],
    "kcna": ["kcna", "仓本千奈", "仓本", "千奈"],
    "kllj": ["kllj", "葛城莉莉娅", "葛城", "莉莉娅"],
    "shro": ["shro", "筱泽广", "篠澤広", "筱泽", "广", "hiro"],
    "ssmk": ["ssmk", "紫云清夏", "紫云", "清夏"],
    "ttmr": ["ttmr", "月村手毬", "月村", "手毬", "手球"],
}

# 全量生成所有合理 6 卡配比 (n1+n2+n3=6, n3<=3, 共 22 种)，不再漏掉 4/2、4/1/1、5/1 等配比
DECK_RATIOS: List[Tuple[str, Tuple[int, int, int]]] = [
    (f"{n1} / {n2}" if n3 == 0 else f"{n1} / {n2} / {n3}", (n1, n2, n3))
    for n3 in range(4)
    for n1 in range(6 - n3, -1, -1)
    for n2 in [6 - n3 - n1]
]

# 严格实战日程树（默认）：能支就支，能进商店(相谈)就不特指，仅5日可选相谈/外出
HIF_ACTION_NODES_STRICT: List[Tuple[str, Tuple[str, ...]]] = [
    ("1日", ("支给",)),
    ("5日", ("相谈", "外出")),
    ("8日", ("支给",)),
    ("12日", ("相谈",)),
    ("14日", ("支给",)),
    ("16日", ("支给",)),
    ("19日", ("相谈",)),
    ("本战3日", ("支给",)),
    ("本战6日", ("相谈",)),
]

# 仅避二选后外出日程树（可通过 --route-mode no-late-outing 开启）
HIF_ACTION_NODES_NO_LATE_OUTING: List[Tuple[str, Tuple[str, ...]]] = [
    ("1日", ("相谈", "支给", "特别指导")),
    ("5日", ("外出", "相谈")),
    ("8日", ("支给",)),
    ("12日", ("相谈", "特别指导")),
    ("14日", ("支给",)),
    ("16日", ("相谈", "支给")),
    ("19日", ("相谈", "特别指导")),
    ("本战3日", ("支给",)),
    ("本战6日", ("相谈",)),
]

# 全量日程树（可通过 --route-mode full 或 --allow-late-outing 开启）
HIF_ACTION_NODES_FULL: List[Tuple[str, Tuple[str, ...]]] = [
    ("1日", ("相谈", "支给", "特别指导")),
    ("5日", ("外出", "相谈")),
    ("8日", ("外出", "支给")),
    ("12日", ("相谈", "特别指导")),
    ("14日", ("外出", "支给")),
    ("16日", ("外出", "相谈", "支给")),
    ("19日", ("相谈", "特别指导")),
    ("本战3日", ("外出", "支给")),
    ("本战6日", ("相谈",)),
]

SP_DAYS = ["2日", "4日", "9日", "11日", "15日", "18日", "本战2日", "本战5日"]
SP_PRIMARY_BONUS = [60, 80, 80, 100, 100, 120, 120, 140]
SP_OTHER_BONUS = [20, 50, 20, 60, 20, 70, 20, 80]

EXAM_FIXED = (20, 80, 100)
EXAM_ALLOC_VALS = (80, 200, 220)

BIZ_DAYS = ["3日", "6日", "10日", "17日", "本战1日", "本战4日"]
BIZ_VALUES = [120, 120, 150, 150, 180, 180]  # 合计 900

ROUND1_SEGMENTS = [(30, 70, 100), (70, 100, 30), (100, 120, 20), (120, 140, 10)]
ROUND2_SEGMENTS = [(60, 90, 40), (90, 150, 80), (150, 200, 20), (200, 240, 10)]

BASE_HIF_ACTIONS = {
    "B23": 6,   # 抓a卡
    "B24": 12,  # 抓m卡
    "B25": 10,  # 抓好调卡
    "B26": 10,  # 抓温存卡
    "B27": 12,  # 抓好印象卡
    "B28": 2,   # a强化
    "B29": 2,   # m强化
    "B30": 6,   # 营业（固定6次）
    "B31": 2,   # 外出
    "B32": 0,   # 休息
    "B33": 2,   # 相谈
    "B34": 4,   # 支给
    "B35": 6,   # 删卡
    "B36": 3,   # 删m卡
    "B37": 3,   # 删a卡
    "B38": 3,   # 变卡
    "B39": 0,   # 相谈饮料（默认0，可选）
    "B40": 20,  # 饮料（基础获取，仅叠加小饮料）
    "B41": 4,   # 指导（联动特别指导）
    "B42": 10,  # 抓集中卡
    "B43": 12,  # 抓元气卡
    "B44": 10,  # 抓彩卡(SSR卡，默认按10张)
    "B45": 12,  # 抓干劲卡
    "B46": 1,   # 进特别指导
    "B47": 6,   # 道具获得
    "B48": 2,   # 试验结束
    "B49": 4,   # 20sp（默认吃满4次）
    "B50": 5,   # 买卡
}


def _precompute_biz_splits():
    splits: Dict[Tuple[int, int, int], Tuple[int, ...]] = {}
    for choices in itertools.product((0, 1, 2), repeat=len(BIZ_VALUES)):
        sums = [0, 0, 0]
        for day_i, slot_i in enumerate(choices):
            sums[slot_i] += BIZ_VALUES[day_i]
        key = tuple(sums)
        if key not in splits:
            splits[key] = choices
    return list(splits.items())


def _precompute_sp_seqs():
    """枚举 2^8=256 种一/二属 8 天 SP 排列，按 (sp1_count, 一属SP总白值) 去重保留代表序列。"""
    by_count: Dict[int, List[dict]] = {k: [] for k in range(9)}
    seen = set()
    for seq in itertools.product((1, 2), repeat=8):
        sp1_count = sum(1 for x in seq if x == 1)
        ev0 = []
        ev1 = []
        for w, pick in enumerate(seq):
            if pick == 1:
                ev0.append(SP_PRIMARY_BONUS[w])
                ev1.append(SP_OTHER_BONUS[w])
            else:
                ev1.append(SP_PRIMARY_BONUS[w])
                ev0.append(SP_OTHER_BONUS[w])
        key = (sp1_count, sum(ev0))
        if key not in seen:
            seen.add(key)
            by_count[sp1_count].append({
                "seq": seq,
                "sp1_count": sp1_count,
                "sp2_count": 8 - sp1_count,
                "events": (tuple(ev0), tuple(ev1), ()),
                "sum0": sum(ev0),
                "sum1": sum(ev1),
            })
    return by_count


def _precompute_exam_allocs():
    """枚举选拔 1(80) / 选拔 2(200) / 选拔 3(220) 各自整场控分给一/二/三属的全部 27 种分配。"""
    cands = []
    for c1, c2, c3 in itertools.product((0, 1, 2), repeat=3):
        ev = [[20, 80, 100], [20, 80, 100], [20, 80, 100]]
        ev[c1][0] += 80
        ev[c2][1] += 200
        ev[c3][2] += 220
        cands.append({
            "targets": (c1, c2, c3),
            "events": (tuple(ev[0]), tuple(ev[1]), tuple(ev[2])),
        })
    return cands


UNIQUE_BIZ_SPLITS = _precompute_biz_splits()
UNIQUE_SP_SEQS_BY_COUNT = _precompute_sp_seqs()
EXAM_ALLOC_CANDIDATES = _precompute_exam_allocs()


def enumerate_valid_hif_action_counts(route_mode: str = "strict") -> List[dict]:
    if route_mode == "full":
        nodes = HIF_ACTION_NODES_FULL
    elif route_mode == "no-late-outing":
        nodes = HIF_ACTION_NODES_NO_LATE_OUTING
    else:
        nodes = HIF_ACTION_NODES_STRICT
    seen = {}
    node_names = [n for n, _ in nodes]
    node_opts = [opts for _, opts in nodes]
    for combo in itertools.product(*node_opts):
        consult = sum(1 for x in combo if x == "相谈")
        supply = sum(1 for x in combo if x == "支给")
        outing = sum(1 for x in combo if x == "外出")
        special = sum(1 for x in combo if x == "特别指导")
        key = (consult, supply, outing, special)
        if key not in seen:
            path_str = "/".join(f"{day}{act}" for day, act in zip(node_names, combo))
            seen[key] = {
                "consult": consult,
                "supply": supply,
                "outing": outing,
                "special": special,
                "path_example": path_str,
            }
    return list(seen.values())


def calc_segmented_score(score_wan: float, segments: list) -> float:
    if score_wan <= 0:
        return 0.0
    total = 0.0
    for mn, mx, rate in segments:
        if score_wan <= mn:
            break
        overlap = round(min(score_wan, mx) - mn, 6)
        if overlap > 0:
            total = round(total + round(overlap * rate, 6), 6)
    return total


def calc_hif_rating(effective_stat_sum: int, round1_wan: float, round2_wan: float, star: int = 1335) -> dict:
    stat_score = effective_stat_sum * 2
    star_score = round(star * 7.5, 6)
    r1_score = calc_segmented_score(round1_wan, ROUND1_SEGMENTS)
    r2_score = calc_segmented_score(round2_wan, ROUND2_SEGMENTS)
    raw = round(stat_score + star_score + r1_score + r2_score - 2000, 6)
    return {
        "finalRating": math.floor(raw),
        "statScore": stat_score,
        "starScore": star_score,
        "round1Score": r1_score,
        "round2Score": r2_score,
    }


_BIZ_CACHE: Dict[Tuple[int, int, int], dict] = {}
_BLUE_GAIN_CACHE: Dict[tuple, int] = {}


def allocate_business_stats(pre_stats: Tuple[int, int, int]) -> dict:
    cached = _BIZ_CACHE.get(pre_stats)
    if cached is not None:
        return cached
    p0, p1, p2 = pre_stats
    best_key = None
    best_split = (0, 0, 0)
    best_choices = (0, 0, 0, 0, 0, 0)
    best_capped = (0, 0, 0)
    best_raw = (0, 0, 0)

    for (b0, b1, b2), choices in UNIQUE_BIZ_SPLITS:
        r0, r1, r2 = p0 + b0, p1 + b1, p2 + b2
        c0 = STAT_CAP if r0 > STAT_CAP else r0
        c1 = STAT_CAP if r1 > STAT_CAP else r1
        c2 = STAT_CAP if r2 > STAT_CAP else r2
        eff_sum = c0 + c1 + c2
        overflow = (r0 - c0) + (r1 - c1) + (r2 - c2)
        shortfall = (
            max(0, HIF_EXAM_LINES[0] - c0)
            + max(0, HIF_EXAM_LINES[1] - c1)
            + max(0, HIF_EXAM_LINES[2] - c2)
        )
        rank_key = (eff_sum, -overflow, -shortfall, c0, c1, c2)
        if best_key is None or rank_key > best_key:
            best_key = rank_key
            best_split = (b0, b1, b2)
            best_choices = choices
            best_capped = (c0, c1, c2)
            best_raw = (r0, r1, r2)

    res = {
        "biz_split": best_split,
        "biz_choices": best_choices,
        "capped_stats": best_capped,
        "raw_stats": best_raw,
        "effective_total": sum(best_capped),
        "overflow_loss": sum(best_raw[i] - best_capped[i] for i in range(3)),
    }
    _BIZ_CACHE[pre_stats] = res
    return res


def compile_and_verify_cards(cards: list):
    """预编译全部卡片公式，提取各破数百分比 pct 并验证对 B11/B12/B13 为纯线性关系。"""
    compiled = {}
    pct_table = {}
    rv_zero = {f"B{i}": (4 if i == 49 else 10) for i in range(11, 51)}
    rv_zero["B11"] = rv_zero["B12"] = rv_zero["B13"] = 0
    rv_1000 = dict(rv_zero)
    rv_1000["B11"] = rv_1000["B12"] = rv_1000["B13"] = 1000

    verified = 0
    total = 0
    for c in cards:
        cid = c["id"]
        compiled[cid] = {}
        pct_table[cid] = {}
        for mode in ("noItem", "withItem"):
            compiled[cid][mode] = {}
            for lb in range(5):
                codes = [
                    compile(expr, f"<card_{cid}_{mode}_{lb}_s{i}>", "eval")
                    for i, expr in enumerate(c["exprs"][mode][str(lb)])
                ]
                compiled[cid][mode][lb] = codes
                if mode == "noItem":
                    pcts = []
                    for si, expr in enumerate(c["exprs"]["noItem"][str(lb)]):
                        m = re.search(r"([0-9.]+)\s*\*\s*R\['B1[123]'\]", expr)
                        pct = round(float(m.group(1)) * 100.0, 4) if m else 0.0
                        pcts.append(pct)
                        # 验证线性性
                        env0 = {"R": rv_zero, "calc_seika": False, "calc_item": False, "math": math}
                        env1 = {"R": rv_1000, "calc_seika": False, "calc_item": False, "math": math}
                        v0 = int(eval(codes[si], {"__builtins__": {}}, env0))
                        v1 = int(eval(codes[si], {"__builtins__": {}}, env1))
                        total += 1
                        if abs((v1 - v0) - round(pct * 10.0)) <= 1:
                            verified += 1
                        else:
                            raise ValueError(f"卡片百分比非线性校验失败: {c['rawName']} lb={lb} slot={si+1}: diff={v1-v0}, pct={pct}")
                    pct_table[cid][lb] = tuple(pcts)
    return compiled, pct_table, verified, total


@dataclass
class HIFRouteConfig:
    name: str
    slot_attrs: Tuple[int, int, int]
    idol_plan: int
    sp_seq: Tuple[int, ...] = (1, 1, 1, 1, 1, 1, 2, 2)
    exam_targets: Tuple[int, int, int] = (0, 0, 0)  # (选拔1, 选拔2, 选拔3) 分配给 0/1/2 属
    exam1_ratio: Optional[Tuple[float, float, float]] = None
    exam2_ratio: Optional[Tuple[float, float, float]] = None
    exam3_ratio: Optional[Tuple[float, float, float]] = None
    normal_trains: Tuple[int, int, int] = (0, 0, 0)
    ssr_pick: int = 10
    consult_count: int = 3
    supply_count: int = 2
    outing_count: int = 3
    special_count: int = 1
    business_count: int = 6
    delete_count: int = 6
    rest_count: int = 0
    consult_drinks: int = 0
    sp20_count: int = 4
    base_drinks: int = 20
    calc_item: bool = True
    calc_seika: bool = False
    path_example: str = ""
    extra_actions: Dict[str, int] = field(default_factory=dict)

    def build_base_route_vars(self, extra_drinks: int = 0, b11: float = 0, b12: float = 0, b13: float = 0) -> Dict[str, float]:
        r = dict(BASE_HIF_ACTIONS)
        r["B44"] = self.ssr_pick
        r["B33"] = self.consult_count
        r["B34"] = self.supply_count
        r["B31"] = self.outing_count
        r["B46"] = self.special_count
        r["B41"] = self.special_count * 4
        r["B30"] = self.business_count
        r["B35"] = self.delete_count
        r["B32"] = self.rest_count
        r["B39"] = self.consult_drinks
        r["B49"] = self.sp20_count
        r["B40"] = self.base_drinks + extra_drinks
        r.update(self.extra_actions)

        r["B11"], r["B12"], r["B13"] = b11, b12, b13
        sp1 = sum(1 for x in self.sp_seq[:8] if x == 1)
        sp2 = sum(1 for x in self.sp_seq[:8] if x == 2)
        sp3 = sum(1 for x in self.sp_seq[:8] if x == 3)
        n1, n2, n3 = self.normal_trains
        r["B15"], r["B16"], r["B14"] = sp1, n1, sp1 + n1
        r["B18"], r["B19"], r["B17"] = sp2, n2, sp2 + n2
        r["B21"], r["B22"], r["B20"] = sp3, n3, sp3 + n3
        return r


def get_exam_events_from_cfg(cfg: HIFRouteConfig) -> Tuple[Tuple[int, ...], Tuple[int, ...], Tuple[int, ...]]:
    """构造选拔 1/2/3 对三属的 3 次蓝字事件列表。"""
    ev = [[20, 80, 100], [20, 80, 100], [20, 80, 100]]
    ratios = [cfg.exam1_ratio, cfg.exam2_ratio, cfg.exam3_ratio]
    for idx in range(3):
        alloc_val = EXAM_ALLOC_VALS[idx]
        if ratios[idx] is not None:
            for s in range(3):
                ev[s][idx] += math.floor(alloc_val * ratios[idx][s] / 100.0)
        else:
            t = cfg.exam_targets[idx]
            ev[t][idx] += alloc_val
    return (tuple(ev[0]), tuple(ev[1]), tuple(ev[2]))


def get_sp_events_from_seq(sp_seq: Tuple[int, ...]) -> Tuple[Tuple[int, ...], Tuple[int, ...], Tuple[int, ...]]:
    ev = [[], [], []]
    for w, pick in enumerate(sp_seq[:8]):
        pri, sec = SP_PRIMARY_BONUS[w], SP_OTHER_BONUS[w]
        if pick == 1:
            ev[0].append(pri)
            ev[1].append(sec)
        elif pick == 2:
            ev[1].append(pri)
            ev[0].append(sec)
        else:
            ev[2].append(pri)
            ev[1].append(sec)
    return (tuple(ev[0]), tuple(ev[1]), tuple(ev[2]))


def estimate_final_stats_exact(
    real_stats: dict,
    slot_attrs: Tuple[int, int, int],
    sp_events: Tuple[Tuple[int, ...], Tuple[int, ...], Tuple[int, ...]],
    exam_events: Tuple[Tuple[int, ...], Tuple[int, ...], Tuple[int, ...]],
    sup_pct_sum: Tuple[float, float, float],
    sup_flat_sum: Tuple[int, int, int],
    round1_wan: float,
    round2_wan: float,
    star: int,
    mem_pct: Tuple[float, float, float],
    mem_flat: Tuple[int, int, int],
    min_eff_prune: int = -1,
    hif_global_pct: float = HIF_GLOBAL_PCT_BONUS,
    hif_global_flat: int = HIF_GLOBAL_FLAT_BONUS,
) -> Optional[dict]:
    """
    11 次蓝字事件（8 次 SP + 3 次选拔）逐次 floor 舍去小数结算 + 营业 900 红字精确分配 + 3200 截断。
    当预估最大可能有效三维 < min_eff_prune 时提前剪枝返回 None。
    """
    pre_list = [0, 0, 0]
    blue_gain_list = [0, 0, 0]
    total_pct_list = [0.0, 0.0, 0.0]

    for s in range(3):
        attr = slot_attrs[s]
        k = ATTR_KEYS[attr]
        total_pct = round(real_stats[f"{k}Rate"] + hif_global_pct + mem_pct[s] + sup_pct_sum[s], 4)
        total_pct_list[s] = round(total_pct, 2)
        cache_key = (exam_events[s], sp_events[s], total_pct)
        bg = _BLUE_GAIN_CACHE.get(cache_key)
        if bg is None:
            mult = 1.0 + total_pct / 100.0
            bg = 0
            for ev in exam_events[s]:
                if ev > 0:
                    bg += math.floor(ev * mult + 1e-9)
            for ev in sp_events[s]:
                if ev > 0:
                    bg += math.floor(ev * mult + 1e-9)
            _BLUE_GAIN_CACHE[cache_key] = bg
        blue_gain_list[s] = bg
        pre_list[s] = real_stats[k] + hif_global_flat + mem_flat[s] + bg + sup_flat_sum[s]

    pre_stats = tuple(pre_list)
    if min_eff_prune > 0:
        c0 = STAT_CAP if pre_stats[0] > STAT_CAP else pre_stats[0]
        c1 = STAT_CAP if pre_stats[1] > STAT_CAP else pre_stats[1]
        c2 = STAT_CAP if pre_stats[2] > STAT_CAP else pre_stats[2]
        rem_cap = (STAT_CAP - c0) + (STAT_CAP - c1) + (STAT_CAP - c2)
        upper_bound = c0 + c1 + c2 + (900 if rem_cap >= 900 else rem_cap)
        if upper_bound < min_eff_prune:
            return None

    biz = allocate_business_stats(pre_stats)
    rating = calc_hif_rating(biz["effective_total"], round1_wan, round2_wan, star)
    return {
        "pre_stats": pre_stats,
        "blue_gain": tuple(blue_gain_list),
        "total_pct": tuple(total_pct_list),
        "sup_pct_sum": sup_pct_sum,
        "sup_flat_sum": sup_flat_sum,
        "biz_split": biz["biz_split"],
        "biz_choices": biz["biz_choices"],
        "raw_stats": biz["raw_stats"],
        "capped_stats": biz["capped_stats"],
        "effective_total": biz["effective_total"],
        "overflow_loss": biz["overflow_loss"],
        "rating": rating,
    }


def eval_cards_flat_and_pct(
    cards: list,
    compiled,
    pct_table,
    cfg: HIFRouteConfig,
    box_lbs: Optional[Dict[str, int]],
    no_pollution: bool,
    locked_ids: set,
    banned_ids: set,
    extra_drinks: int,
):
    """在固定 (行动组合, sp1_count, extra_drinks) 下预计算每张卡不受 B11..B13 影响的纯固值 flat_score 与 pct。"""
    rv_zero = cfg.build_base_route_vars(extra_drinks=extra_drinks, b11=0, b12=0, b13=0)
    by_attr_pool: Dict[int, List[dict]] = {1: [], 2: [], 3: []}
    attr_to_slot = {cfg.slot_attrs[s]: s for s in range(3)}
    mini_card = None

    for c in cards:
        if c["isMiniDrink"]:
            mini_card = c
        if c["id"] in banned_ids:
            continue
        if c["plan"] != 0 and c["plan"] != cfg.idol_plan:
            continue
        if no_pollution and c["pollution"] == 1 and c["id"] not in locked_ids:
            continue
        s_idx = attr_to_slot[c["attr"]]
        lb = box_lbs.get(c["supportKey"], -1) if box_lbs is not None else 4
        use_item = False if c["isMiniDrink"] else cfg.calc_item
        mode = "withItem" if use_item else "noItem"

        env_zero = {"R": rv_zero, "calc_seika": cfg.calc_seika, "calc_item": use_item, "math": math}
        self_flat = int(eval(compiled[c["id"]][mode][lb][s_idx], {"__builtins__": {}}, env_zero)) if lb >= 0 else 0
        max_flat = int(eval(compiled[c["id"]][mode][4][s_idx], {"__builtins__": {}}, env_zero))
        self_pct = pct_table[c["id"]][lb][s_idx] if lb >= 0 else 0.0
        max_pct = pct_table[c["id"]][4][s_idx]

        by_attr_pool[c["attr"]].append({
            "card": c,
            "lb": lb,
            "use_item": use_item,
            "owned": lb >= 0,
            "is_sp": c["isSp"] == 1,
            "locked": c["id"] in locked_ids,
            "self_flat": self_flat,
            "max_flat": max_flat,
            "self_pct": self_pct,
            "max_pct": max_pct,
        })
    return rv_zero, by_attr_pool, mini_card


def pick_best_color_at_blue(
    pool: List[dict],
    need: int,
    min_sp: int,
    allow_borrow: bool,
    extra_must_ids: set,
    blue_approx: float,
):
    if need < min_sp:
        return None
    if need == 0:
        return [] if not extra_must_ids else None
    locked_items = [x for x in pool if x["locked"]]
    extra_must_items = [x for x in pool if x["card"]["id"] in extra_must_ids]
    if len(extra_must_items) != len(extra_must_ids):
        return None
    required_ids = {x["card"]["id"] for x in locked_items} | set(extra_must_ids)

    best_total = -1
    best_picks = None

    borrow_candidates: List[Optional[int]] = [None]
    if allow_borrow:
        top_borrow = sorted(
            pool, key=lambda x: x["max_flat"] + blue_approx * x["max_pct"] / 100.0, reverse=True
        )[: need + 6]
        borrow_ids = (
            {x["card"]["id"] for x in top_borrow}
            | {x["card"]["id"] for x in locked_items}
            | set(extra_must_ids)
        )
        borrow_candidates = sorted(borrow_ids)

    for b_id in borrow_candidates:
        entries = []
        for x in pool:
            is_b = (x["card"]["id"] == b_id)
            if not is_b and not x["owned"]:
                continue
            fl = x["max_flat"] if is_b else x["self_flat"]
            pc = x["max_pct"] if is_b else x["self_pct"]
            approx_val = fl + blue_approx * pc / 100.0
            must = x["locked"] or (x["card"]["id"] in extra_must_ids)
            entries.append((approx_val, fl, pc, x["is_sp"], must, x, is_b))

        must_list = [e for e in entries if e[4]]
        if {e[5]["card"]["id"] for e in must_list} != required_ids or len(must_list) > need:
            continue
        rem_need = need - len(must_list)
        must_sp = sum(1 for e in must_list if e[3])
        need_more_sp = max(0, min_sp - must_sp)

        opt_sp = sorted([e for e in entries if not e[4] and e[3]], key=lambda z: z[0], reverse=True)
        opt_non = sorted([e for e in entries if not e[4] and not e[3]], key=lambda z: z[0], reverse=True)

        if len(opt_sp) < need_more_sp or len(opt_sp) + len(opt_non) < rem_need:
            continue

        chosen = list(must_list) + opt_sp[:need_more_sp]
        rest_pool = sorted(opt_sp[need_more_sp:] + opt_non, key=lambda z: z[0], reverse=True)
        chosen.extend(rest_pool[: (rem_need - need_more_sp)])

        if b_id is not None and not any(e[6] for e in chosen):
            continue

        total = sum(e[0] for e in chosen)
        if total > best_total:
            best_total = total
            best_picks = chosen

    return best_picks


def generate_candidate_decks_for_ratio(
    cfg: HIFRouteConfig,
    ratio_name: str,
    slot_counts: Tuple[int, int, int],
    by_attr_pool: Dict[int, List[dict]],
    mini_card: Optional[dict],
    trifold_card: Optional[dict],
    min_sp_by_slot: Tuple[int, int, int],
    banned_ids: set,
    force_mini_drink: bool,
    force_trifold_drink: bool = False,
    color_pick_cache: Optional[dict] = None,
):
    """在多个蓝字基准档位提取不重复的最优候选卡组，覆盖高百分比与高固值权衡。"""
    da_slot = cfg.slot_attrs.index(2)
    need_blue_special = (1 if force_mini_drink else 0) + (1 if force_trifold_drink else 0)
    if slot_counts[da_slot] < need_blue_special:
        return []
    if force_mini_drink and (not mini_card or mini_card["id"] in banned_ids or mini_card not in [x["card"] for x in by_attr_pool[2]]):
        return []
    if force_trifold_drink and (not trifold_card or trifold_card["id"] in banned_ids or trifold_card not in [x["card"] for x in by_attr_pool[2]]):
        return []

    blue_extra_must = set()
    if force_mini_drink and mini_card:
        blue_extra_must.add(mini_card["id"])
    if force_trifold_drink and trifold_card:
        blue_extra_must.add(trifold_card["id"])

    for s_idx, cnt in enumerate(slot_counts):
        attr = cfg.slot_attrs[s_idx]
        if sum(1 for item in by_attr_pool[attr] if item["locked"]) > cnt:
            return []

    # 覆盖二属歪分/均衡/主属偏高/极高蓝字四个典型参考档位
    blue_probes = [
        (450.0, 1200.0, 200.0),
        (850.0, 850.0, 200.0),
        (1350.0, 550.0, 200.0),
        (1750.0, 350.0, 420.0),
    ]
    borrow_attr_choices: List[Optional[int]] = [None] + [cfg.slot_attrs[s] for s in range(3) if slot_counts[s] > 0]
    seen_decks = {}

    for blues in blue_probes:
        for b_attr in borrow_attr_choices:
            slot_results = []
            sup_pct = [0.0, 0.0, 0.0]
            sup_flat = [0, 0, 0]
            borrowed_info = None
            ok = True

            for s_idx, cnt in enumerate(slot_counts):
                attr = cfg.slot_attrs[s_idx]
                ex_must = blue_extra_must if attr == 2 else set()
                ckey = (s_idx, cnt, b_attr == attr, frozenset(ex_must), blues[s_idx])
                if color_pick_cache is not None and ckey in color_pick_cache:
                    picks = color_pick_cache[ckey]
                else:
                    picks = pick_best_color_at_blue(
                        pool=by_attr_pool[attr],
                        need=cnt,
                        min_sp=min_sp_by_slot[s_idx],
                        allow_borrow=(b_attr == attr),
                        extra_must_ids=ex_must,
                        blue_approx=blues[s_idx],
                    )
                    if color_pick_cache is not None:
                        color_pick_cache[ckey] = picks
                if picks is None:
                    ok = False
                    break
                for _, fl, pc, is_sp, _, x, is_b in picks:
                    sup_flat[s_idx] += fl
                    sup_pct[s_idx] = round(sup_pct[s_idx] + pc, 4)
                    slot_results.append({
                        "id": x["card"]["id"],
                        "slot": s_idx + 1,
                        "attr": attr,
                        "rawName": x["card"]["rawName"],
                        "jpName": x["card"]["jpName"],
                        "isSp": is_sp,
                        "lb": 4 if is_b else x["lb"],
                        "use_item": x["use_item"],
                        "flat": fl,
                        "pct": pc,
                        "borrowed": is_b,
                        "isMiniDrink": x["card"]["isMiniDrink"],
                        "isTrifold": x["card"]["jpName"] == "自分と向き合う時間だ",
                        "itemNote": x["card"]["itemNote"],
                    })
                    if is_b:
                        borrowed_info = f"【借】{x['card']['rawName']} (放{ATTR_SHORT[attr]}/第{s_idx+1}属)"
            if not ok:
                continue

            deck_key = tuple(sorted((it["slot"], it["id"], it["borrowed"]) for it in slot_results))
            if deck_key not in seen_decks:
                seen_decks[deck_key] = {
                    "ratio": ratio_name,
                    "slot_counts": slot_counts,
                    "cards": slot_results,
                    "sup_pct": tuple(sup_pct),
                    "sup_flat": tuple(sup_flat),
                    "borrowed": borrowed_info or "无(自持最优)",
                    "mini_drink_active": force_mini_drink,
                    "trifold_drink_active": force_trifold_drink,
                }
    return list(seen_decks.values())


def get_idol_real_stats(idol: dict) -> dict:
    ch = idol.get("character", "")
    if ch in CHAR_BASE_STATS:
        return dict(CHAR_BASE_STATS[ch])
    return dict(idol["stats"])


def resolve_idol(cidol_items: list, query: str, pick_idx: Optional[int] = None):
    q = query.strip().lower()
    matched_chars = set()
    for ch, aliases in CHAR_ALIASES.items():
        if any(q == a.lower() or q in a.lower() for a in aliases):
            matched_chars.add(ch)

    hits = []
    for it in cidol_items:
        if it["character"] in matched_chars or q in it["name"].lower() or q in it["key"].lower():
            hits.append(it)

    if not hits:
        raise SystemExit(f"未在 cidol.json 中找到匹配 '{query}' 的 P 卡。")
    if len(hits) > 1 and pick_idx is None:
        exact = [x for x in hits if x["name"].lower() == q or x["key"].lower() == q]
        if len(exact) == 1:
            return exact[0], hits
        ssr_hits = [x for x in hits if str(x.get("rarity")) == "3"]
        chosen = ssr_hits[-1] if ssr_hits else hits[0]
        return chosen, hits
    if pick_idx is not None:
        return hits[pick_idx], hits
    return hits[0], hits


def idol_attr_order(stats: dict) -> Tuple[int, int, int]:
    pairs = [
        (stats["voRate"], stats["vo"], 1),
        (stats["daRate"], stats["da"], 2),
        (stats["viRate"], stats["vi"], 3),
    ]
    pairs.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return tuple(p[2] for p in pairs)


VAR_LABELS = {
    "B14": "一属训练", "B15": "一属SP", "B16": "一属通常",
    "B17": "二属训练", "B18": "二属SP", "B19": "二属通常",
    "B20": "三属训练", "B21": "三属SP", "B22": "三属通常",
    "B23": "抓A卡", "B24": "抓M卡", "B25": "抓好调卡", "B26": "抓温存卡", "B27": "抓好印象卡",
    "B28": "A强化", "B29": "M强化", "B30": "营业", "B31": "外出", "B32": "休息",
    "B33": "相谈", "B34": "支给", "B35": "删卡", "B36": "删M卡", "B37": "删A卡",
    "B38": "变卡", "B39": "相谈饮料", "B40": "饮料", "B41": "指导",
    "B42": "抓集中卡", "B43": "抓元气卡", "B44": "抓SSR", "B45": "抓干劲卡",
    "B46": "进特指", "B47": "道具获得", "B48": "试验结束", "B49": "20SP", "B50": "买卡",
}


def explain_card_flat_breakdown(card: dict, lb: int, slot_idx: int, use_item: bool, calc_seika: bool, rv_zero: dict) -> str:
    """利用 AST 拆解卡片不含百分比时的纯固值词条组成 + 卡片百分比。"""
    try:
        env = {"R": rv_zero, "calc_seika": calc_seika, "calc_item": use_item, "math": math}
        ex_no = card["exprs"]["noItem"][str(lb)][slot_idx]
        ex_yes = card["exprs"]["withItem"][str(lb)][slot_idx]
        v_no = int(eval(ex_no, {"__builtins__": {}}, env))
        v_yes = int(eval(ex_yes, {"__builtins__": {}}, env)) if use_item else v_no
        item_delta = v_yes - v_no

        def collect_add_terms(node):
            if isinstance(node, ast.IfExp):
                cond_val = eval(ast.unparse(node.test), {"__builtins__": {}}, env)
                return collect_add_terms(node.body if cond_val else node.orelse)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "floor":
                return collect_add_terms(node.args[0])
            if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
                r_str = ast.unparse(node.right).strip()
                if r_str in ("1e-09", "1e-9"):
                    return collect_add_terms(node.left)
                return collect_add_terms(node.left) + collect_add_terms(node.right)
            return [node]

        tree = ast.parse(ex_no, mode="eval").body
        terms = collect_add_terms(tree)
        parts = []
        const_vals = []
        pct_str = None
        for t in terms:
            src = ast.unparse(t)
            b_keys = sorted(set(re.findall(r"R\['(B\d+)'\]", src)))
            if any(k in ("B11", "B12", "B13") for k in b_keys):
                m = re.search(r"([0-9.]+)\s*\*\s*R\['B1[123]'\]", src)
                if m:
                    pct_str = f"吃蓝字+{round(float(m.group(1))*100, 2)}%"
                continue
            val = float(eval(src, {"__builtins__": {}}, env))
            if abs(val) < 1e-9:
                continue
            if not b_keys:
                const_vals.append(val)
            else:
                label = "+".join(f"{VAR_LABELS.get(k, k)}({rv_zero[k]})" for k in b_keys)
                parts.append(f"{label}={int(val) if val.is_integer() else round(val, 1)}")
        if len(const_vals) >= 2:
            parts.insert(0, f"基础={int(const_vals[0])}")
            for cv in const_vals[1:]:
                parts.append(f"事件/固定={int(cv)}")
        elif len(const_vals) == 1:
            parts.append(f"事件/基础={int(const_vals[0])}")
        if item_delta:
            parts.append(f"道具=+{item_delta}")
        elif card["isMiniDrink"]:
            parts.append("道具=Da SP后+2饮料")
        if pct_str:
            parts.append(pct_str)
        return " | ".join(parts)
    except Exception:
        return ""


def print_solution(
    idx: int,
    sol: dict,
    real_stats: dict,
    slot_attrs: Tuple[int, int, int],
    mem_pct: Tuple[float, float, float],
    cards_by_id: dict,
    calc_seika: bool,
    show_detail: bool = False,
    hif_global_pct: float = HIF_GLOBAL_PCT_BONUS,
    hif_global_flat: int = HIF_GLOBAL_FLAT_BONUS,
):
    deck = sol["deck"]
    est = sol["est"]
    rat = est["rating"]
    cfg = sol["cfg"]
    sp_seq = sol["sp_seq"]
    exam_targets = sol["exam_targets"]
    tags = []
    if deck["mini_drink_active"]:
        tags.append(f"小饮料+{sol['mini_drinks']}瓶")
    if deck.get("trifold_drink_active"):
        tags.append("三折叠+2瓶")
    tag = f" [{' / '.join(tags)}]" if tags else ""

    sp1 = sum(1 for x in sp_seq if x == 1)
    sp2 = sum(1 for x in sp_seq if x == 2)
    print(f"\n[{idx}] 路线: {ATTR_SHORT[slot_attrs[0]]}{sp1}+{ATTR_SHORT[slot_attrs[1]]}{sp2} SP | {sol['act_label']} | 配比: {deck['ratio']}{tag}")
    print(
        f"    HIF总评分: {rat['finalRating']} (属性分{rat['statScore']} + 星耀{rat['starScore']:.1f} + 本战1:{rat['round1Score']:.0f} + 本战2:{rat['round2Score']:.0f} - 2000)"
    )
    print(
        f"    有效三维总和(截断{STAT_CAP}): {est['effective_total']} | "
        f"S卡固值 {sum(est['sup_flat_sum'])} + 蓝字逐次舍去增益 {sum(est['blue_gain'])} | 营业红字 900 | 溢出浪费 {est['overflow_loss']}"
    )

    sp_plan = "/".join(f"{day}{ATTR_SHORT[slot_attrs[p - 1]]}" for day, p in zip(SP_DAYS, sp_seq))
    print(f"    8天SP具体走法: {sp_plan}")
    if cfg.exam1_ratio is None:
        exam_plan = (
            f"一测(80)→{ATTR_SHORT[slot_attrs[exam_targets[0]]]} / "
            f"二测(200)→{ATTR_SHORT[slot_attrs[exam_targets[1]]]} / "
            f"三测(220)→{ATTR_SHORT[slot_attrs[exam_targets[2]]]}"
        )
        print(f"    3次选拔控分分配: {exam_plan}")
    else:
        print(f"    3次选拔控分分配: 自定义比例")

    biz_plan = "/".join(f"{day}{ATTR_SHORT[slot_attrs[s]]}" for day, s in zip(BIZ_DAYS, est["biz_choices"]))
    print(f"    营业6天建议选色: {biz_plan}  (分属累计: " + "/".join(f"{ATTR_SHORT[slot_attrs[i]]}+{est['biz_split'][i]}" for i in range(3)) + ")")
    if cfg.path_example:
        print(f"    自由日走法示例: {cfg.path_example}")
    print(f"    借卡推荐: {deck['borrowed']}")

    print("    三属性面板与百分比构成（已按11次蓝字逐次floor舍去小数）:")
    for s_idx, attr in enumerate(slot_attrs):
        k = ATTR_KEYS[attr]
        ch_r = real_stats[f"{k}Rate"]
        sup_r = round(est["sup_pct_sum"][s_idx], 2)
        tot_r = est["total_pct"][s_idx]
        raw_v = est["raw_stats"][s_idx]
        cap_v = est["capped_stats"][s_idx]
        line = HIF_EXAM_LINES[s_idx]
        warn = " ⚠️溢出归0!" if raw_v > STAT_CAP else (" ⚠️未达单极线" if cap_v < line else "")
        print(
            f"      · {ATTR_NAMES[attr]}={cap_v}({raw_v}){warn} | "
            f"总%={tot_r}% (角色{ch_r}%+全局{hif_global_pct}%+回忆{mem_pct[s_idx]}%+卡{sup_r}%) | "
            f"开局全局+{hif_global_flat} / 蓝字逐次+{est['blue_gain'][s_idx]} / 卡固值+{est['sup_flat_sum'][s_idx]} / 营+{est['biz_split'][s_idx]}"
        )

    for item in deck["cards"]:
        sp_s = "SP" if item["isSp"] else "  "
        b_s = "【借满破】" if item["borrowed"] else f"[{item['lb']}破]    "
        note_s = f" ({item['itemNote']})" if item["itemNote"] else ""
        pct_s = f" +{item['pct']}%" if item["pct"] > 0 else ""
        print(f"      · 第{item['slot']}属 {ATTR_SHORT[item['attr']]} {sp_s} {b_s} 固值{item['flat']:>3d}{pct_s:<6s} | {item['rawName']}{note_s}")
        if show_detail:
            det = explain_card_flat_breakdown(
                cards_by_id[item["id"]], item["lb"], item["slot"] - 1, item["use_item"], calc_seika, sol["rv_zero"]
            )
            if det:
                print(f"          └ 组成: {det}")


def main():
    parser = argparse.ArgumentParser(description="HIF 支援卡配卡与路线规划原型（精准版 v2）")
    parser.add_argument("--idol", required=True, help="角色中文名/拼音或P卡名称（如 琴音 / 自己肯定感爆上げ）")
    parser.add_argument("--pick", type=int, default=None, help="当匹配多张P卡时指定序号(0起)")
    parser.add_argument("--order", default=None, help="手动覆盖第一/二/三属性顺序，如 2,3,1 (1红Vo 2蓝Da 3黄Vi)")
    parser.add_argument("--exam1", default=None, help="可选：手动固定选拔1分配比例(如 100,0,0)")
    parser.add_argument("--exam2", default=None, help="可选：手动固定选拔2分配比例(如 0,100,0)")
    parser.add_argument("--exam3", default=None, help="可选：手动固定选拔3分配比例(如 0,100,0)")
    parser.add_argument("--round1", type=float, default=140.0, help="本战1打分(万)，默认满分 140")
    parser.add_argument("--round2", type=float, default=240.0, help="本战2打分(万)，默认满分 240")
    parser.add_argument("--star", type=int, default=1335, help="总星耀值，默认满值 1335")
    parser.add_argument("--mem-pct", default="11.2,11.2,0", help="回忆百分比(一,二,三属)，默认 11.2,11.2,0")
    parser.add_argument("--mem-flat", default="0,0,80", help="回忆固定白值(一,二,三属)，默认 0,0,80")
    parser.add_argument("--hif-global-pct", type=float, default=HIF_GLOBAL_PCT_BONUS, help="HIF全局三属性开局百分比加成(%%)，默认 10.0")
    parser.add_argument("--hif-global-flat", type=int, default=HIF_GLOBAL_FLAT_BONUS, help="HIF全局三属性开局固值加成，默认 100")
    parser.add_argument("--sp-seq", default=None, help="固定路线时手动指定8天SP分配(1/2/3)")
    parser.add_argument("--ssr-pick", type=int, default=10, help="抓SSR卡次数(B44)，默认 10")
    parser.add_argument("--sp20", type=int, default=4, help="20SP触发次数(B49)，默认吃满 4 次")
    parser.add_argument("--consult-drinks", type=int, default=0, help="相谈买饮料总数(B39)，默认 0（可选）")
    parser.add_argument("--min-sp", default="0,0,0", help="一,二,三属性槽位最低SP卡数，默认 0,0,0（默认满SP）")
    parser.add_argument(
        "--route-mode",
        choices=["strict", "no-late-outing", "full"],
        default="strict",
        help="自由日模式: strict(能支就支/优先商店不特指, 默认) | no-late-outing(避二选后外出) | full(全量74种)",
    )
    parser.add_argument("--allow-late-outing", action="store_true", help="兼容参数：等价于 --route-mode full")
    parser.add_argument("--trifold-drink", action="store_true", help="可选：计入三折叠道具+2瓶饮料联动(默认关闭)")
    parser.add_argument("--no-item", action="store_true", help="关闭S卡道具数值全发（默认开启）")
    parser.add_argument("--seika", action="store_true", help="开启塞卡等效+20属性（默认关闭）")
    parser.add_argument("--no-pollution", action="store_true", help="过滤特定卡(按原表H列标记)")
    parser.add_argument("--detail", action="store_true", help="输出所有展示方案的每张卡明细(默认仅Top1输出)")
    parser.add_argument("--lock", default="", help="必带支援卡关键词(逗号分隔)")
    parser.add_argument("--ban", default="", help="禁用支援卡关键词(逗号分隔)")
    parser.add_argument("--box", default=None, help="可选：用户BOX JSON文件（key->突破数，不传默认全4破）")
    parser.add_argument("--scan-routes", action="store_true", help="开启联合规划（自由日×8天SP顺序×选拔3次分配×5配比）")
    args = parser.parse_args()

    cards_data = json.loads(CARDS_JSON.read_text(encoding="utf-8"))
    cards = cards_data["cards"]
    cards_by_id = {c["id"]: c for c in cards}
    compiled, pct_table, ver_ok, ver_tot = compile_and_verify_cards(cards)

    cidol_raw = json.loads(CIDOL_JSON.read_text(encoding="utf-8"))
    cidol_items = cidol_raw["items"] if isinstance(cidol_raw, dict) and "items" in cidol_raw else cidol_raw

    idol, all_hits = resolve_idol(cidol_items, args.idol, args.pick)
    idol_plan = PLAN_MAP[idol["plan"]]
    real_stats = get_idol_real_stats(idol)
    slot_attrs = tuple(int(x) for x in args.order.split(",")) if args.order else idol_attr_order(real_stats)
    min_sp = tuple(int(x) for x in args.min_sp.split(","))
    mem_pct = tuple(float(x) for x in args.mem_pct.split(","))
    mem_flat = tuple(int(x) for x in args.mem_flat.split(","))

    box_lbs = json.loads(Path(args.box).read_text(encoding="utf-8")) if args.box else None

    locked_ids, banned_ids = set(), set()
    for kw in [x.strip() for x in args.lock.split(",") if x.strip()]:
        for c in cards:
            if kw in c["rawName"]:
                locked_ids.add(c["id"])
    for kw in [x.strip() for x in args.ban.split(",") if x.strip()]:
        for c in cards:
            if kw in c["rawName"]:
                banned_ids.add(c["id"])

    ex1 = tuple(float(x) for x in args.exam1.split(",")) if args.exam1 else None
    ex2 = tuple(float(x) for x in args.exam2.split(",")) if args.exam2 else None
    ex3 = tuple(float(x) for x in args.exam3.split(",")) if args.exam3 else None
    custom_exam_mode = any(x is not None for x in (ex1, ex2, ex3))

    route_mode = "full" if args.allow_late_outing else args.route_mode
    print("=" * 78)
    print(f"P卡: {idol['name']} ({idol['key']}) | 流派: {PLAN_NAMES[idol_plan]} | 卡表线性百分比校验: {ver_ok}/{ver_tot}")
    src_note = "实测角色三维" if idol.get("character") in CHAR_BASE_STATS else "cidol.json回退"
    print(f"初始三维({src_note}): Vo={real_stats['vo']}({real_stats['voRate']}%), Da={real_stats['da']}({real_stats['daRate']}%), Vi={real_stats['vi']}({real_stats['viRate']}%)")
    print(f"自动推导槽位: 一属={ATTR_NAMES[slot_attrs[0]]} | 二属={ATTR_NAMES[slot_attrs[1]]} | 三属={ATTR_NAMES[slot_attrs[2]]}")
    print(
        f"参数: 本战1={args.round1}万 | 本战2={args.round2}万 | 星耀={args.star} | HIF全局=+{args.hif_global_pct}%/+{args.hif_global_flat} | 回忆%={args.mem_pct} 固值={args.mem_flat}\n"
        f"      抓SSR={args.ssr_pick} | 20SP={args.sp20} | 相谈饮料={args.consult_drinks} | 日程={route_mode} | 三折叠+2饮料={args.trifold_drink} | 最低SP={min_sp}"
    )
    print("=" * 78)

    da_slot = slot_attrs.index(2)
    trifold_card = next((c for c in cards if c["jpName"] == "自分と向き合う時間だ"), None)

    if not args.scan_routes:
        sp_seq = tuple(int(x) for x in (args.sp_seq or "1,1,1,1,1,1,2,2").split(","))
        action_list = [enumerate_valid_hif_action_counts(route_mode)[0]]
        sp1_range = [sum(1 for x in sp_seq if x == 1)]
        fixed_sp_seq = sp_seq
    else:
        action_list = enumerate_valid_hif_action_counts(route_mode)
        sp1_range = list(range(8, -1, -1))
        fixed_sp_seq = None

    top_results = []
    best_by_ratio: Dict[str, dict] = {}
    best_eff_by_ratio: Dict[str, int] = {}

    for act in action_list:
        act_label = f"{act['consult']}相谈/{act['supply']}支给/{act['outing']}外出/{act['special']}特指"
        for sp1_count in sp1_range:
            sp_variants = (
                [{"seq": fixed_sp_seq, "events": get_sp_events_from_seq(fixed_sp_seq)}]
                if fixed_sp_seq is not None
                else UNIQUE_SP_SEQS_BY_COUNT[sp1_count]
            )
            rep_seq = sp_variants[0]["seq"]
            da_sp_count = sum(1 for x in rep_seq if x == da_slot + 1)

            cfg = HIFRouteConfig(
                name=act_label,
                slot_attrs=slot_attrs,
                idol_plan=idol_plan,
                sp_seq=rep_seq,
                exam1_ratio=ex1 if ex1 else ((100.0, 0.0, 0.0) if custom_exam_mode else None),
                exam2_ratio=ex2 if ex2 else ((100.0, 0.0, 0.0) if custom_exam_mode else None),
                exam3_ratio=ex3 if ex3 else ((100.0, 0.0, 0.0) if custom_exam_mode else None),
                ssr_pick=args.ssr_pick,
                sp20_count=args.sp20,
                consult_drinks=args.consult_drinks,
                consult_count=act["consult"],
                supply_count=act["supply"],
                outing_count=act["outing"],
                special_count=act["special"],
                path_example=act["path_example"],
                calc_item=not args.no_item,
                calc_seika=args.seika,
            )

            exam_variants = (
                [{"targets": (0, 0, 0), "events": get_exam_events_from_cfg(cfg)}]
                if (custom_exam_mode or not args.scan_routes)
                else EXAM_ALLOC_CANDIDATES
            )

            drink_modes = [(False, False, 0, 0), (True, False, da_sp_count * 2, da_sp_count * 2)]
            if args.trifold_drink:
                drink_modes.extend([
                    (False, True, 0, 2),
                    (True, True, da_sp_count * 2, da_sp_count * 2 + 2),
                ])

            for force_mini, force_tri, mini_drinks, ex_drinks in drink_modes:
                rv_zero, pool, mini_c = eval_cards_flat_and_pct(
                    cards, compiled, pct_table, cfg, box_lbs, args.no_pollution, locked_ids, banned_ids, extra_drinks=ex_drinks
                )
                color_pick_cache = {}
                for rname, sc in DECK_RATIOS:
                    cand_decks = generate_candidate_decks_for_ratio(
                        cfg, rname, sc, pool, mini_c, trifold_card, min_sp, banned_ids,
                        force_mini, force_tri, color_pick_cache
                    )
                    for deck in cand_decks:
                        # 未开启对应联动时如自然选中对应卡则由带联动分支覆盖
                        if not force_mini and any(c["isMiniDrink"] for c in deck["cards"]):
                            continue
                        if args.trifold_drink and not force_tri and any(c["isTrifold"] for c in deck["cards"]):
                            continue
                        prune_floor = best_eff_by_ratio.get(rname, -1)
                        for sp_info in sp_variants:
                            for ex_info in exam_variants:
                                est = estimate_final_stats_exact(
                                    real_stats=real_stats,
                                    slot_attrs=slot_attrs,
                                    sp_events=sp_info["events"],
                                    exam_events=ex_info["events"],
                                    sup_pct_sum=deck["sup_pct"],
                                    sup_flat_sum=deck["sup_flat"],
                                    round1_wan=args.round1,
                                    round2_wan=args.round2,
                                    star=args.star,
                                    mem_pct=mem_pct,
                                    mem_flat=mem_flat,
                                    min_eff_prune=prune_floor,
                                    hif_global_pct=args.hif_global_pct,
                                    hif_global_flat=args.hif_global_flat,
                                )
                                if est is None:
                                    continue
                                sort_key = (
                                    est["rating"]["finalRating"],
                                    est["effective_total"],
                                    -est["overflow_loss"],
                                    -act["outing"],
                                    sum(est["sup_flat_sum"]),
                                )
                                rec = {
                                    "sort_key": sort_key,
                                    "deck": deck,
                                    "est": est,
                                    "cfg": cfg,
                                    "act_label": act_label,
                                    "sp_seq": sp_info["seq"],
                                    "exam_targets": ex_info["targets"],
                                    "mini_drinks": mini_drinks,
                                    "extra_drinks": ex_drinks,
                                    "rv_zero": rv_zero,
                                }
                                if rname not in best_by_ratio or sort_key > best_by_ratio[rname]["sort_key"]:
                                    best_by_ratio[rname] = rec
                                    best_eff_by_ratio[rname] = est["effective_total"]
                                    prune_floor = est["effective_total"]
                                top_results.append(rec)
                                if len(top_results) > 80:
                                    top_results.sort(key=lambda x: x["sort_key"], reverse=True)
                                    top_results = top_results[:30]

    top_results.sort(key=lambda x: x["sort_key"], reverse=True)

    # 展示时按 (配比 + 6张卡组成) 去重，确保前 5 名体现不同配比/阵容实力
    shown = []
    seen_sig = set()
    for rec in top_results:
        sig = (
            rec["deck"]["ratio"],
            tuple(sorted(c["id"] for c in rec["deck"]["cards"])),
        )
        if sig in seen_sig:
            continue
        seen_sig.add(sig)
        shown.append(rec)
        if len(shown) >= 5:
            break

    print(
        f"\n>>> 精确联合规划 Top {len(shown)} 最优解 "
        f"(合法行动 {len(action_list)} 种 × 8天SP排列 {sum(len(v) for v in UNIQUE_SP_SEQS_BY_COUNT.values())} 种 × "
        f"选拔分配 {27 if (args.scan_routes and not custom_exam_mode) else 1} 种 × {len(DECK_RATIOS)}种全配比):"
    )
    for idx, rec in enumerate(shown, 1):
        print_solution(
            idx, rec, real_stats, slot_attrs, mem_pct, cards_by_id, args.seika,
            show_detail=(args.detail or idx == 1),
            hif_global_pct=args.hif_global_pct,
            hif_global_flat=args.hif_global_flat,
        )

    # 额外输出各主流配比最佳分数榜，方便直观对比 4/2、4/1/1、3/3、3/2/1 等配比差异
    ratio_board = sorted(best_by_ratio.values(), key=lambda x: x["sort_key"], reverse=True)
    print("\n>>> 各配比最高分排行榜 (Top 10):")
    for rk, rec in enumerate(ratio_board[:10], 1):
        est = rec["est"]
        rat = est["rating"]
        sp_seq = rec["sp_seq"]
        sp1 = sum(1 for x in sp_seq if x == 1)
        sp2 = sum(1 for x in sp_seq if x == 2)
        ex_t = rec["exam_targets"]
        ex_s = f"{ATTR_SHORT[slot_attrs[ex_t[0]]]}/{ATTR_SHORT[slot_attrs[ex_t[1]]]}/{ATTR_SHORT[slot_attrs[ex_t[2]]]}"
        tag = f"[小饮料+{rec['extra_drinks']}瓶]" if rec["deck"]["mini_drink_active"] else ""
        print(
            f"  {rk:2d}. {rec['deck']['ratio']:<9s} | 总评 {rat['finalRating']} (有效三维 {est['effective_total']}, 溢{est['overflow_loss']}) | "
            f"{ATTR_SHORT[slot_attrs[0]]}{sp1}+{ATTR_SHORT[slot_attrs[1]]}{sp2}SP 选拔[{ex_s}] | {rec['act_label']} {tag}"
        )


if __name__ == "__main__":
    main()
