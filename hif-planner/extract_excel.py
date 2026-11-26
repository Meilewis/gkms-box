#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 melon 支援卡表 (.xlsx) 与 gkms-box/web/public/data/support.json 提取全部支援卡
的 0~4 破期望属性计算表达式与路线预设，生成 cards_data.json，并对照 J 列满破公式做全量校验。
"""

import json
import math
import os
import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

DEFAULT_XLSX = r"D:\BaiduNetdiskDownload\chromedownload\支援卡-11.3新卡实装.xlsx"
BASE_DIR = Path(__file__).resolve().parent
SUPPORT_JSON = BASE_DIR.parent / "web" / "public" / "data" / "support.json"
OUT_JSON = BASE_DIR / "cards_data.json"

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships"

# 与 support.json 匹配时已知的细微命名差异别名映射
MANUAL_ALIASES = {
    "キュっと締めて": "2-0024",  # support.json 中为 キュッと締めて
}


def col_to_idx(col: str) -> int:
    n = 0
    for ch in col:
        n = n * 26 + (ord(ch) - 64)
    return n


def idx_to_col(idx: int) -> str:
    res = []
    while idx > 0:
        idx, rem = divmod(idx - 1, 26)
        res.append(chr(65 + rem))
    return "".join(reversed(res))


def parse_cell_ref(ref: str):
    m = re.match(r"^\$?([A-Z]+)\$?(\d+)$", ref.strip())
    if not m:
        return None
    return m.group(1), int(m.group(2))


def norm_name(s: str) -> str:
    return re.sub(r"[\s　・･!！?？♪♡♥〜～\-—「」『』()（）\[\]【】]", "", s).lower()


class WorkbookReader:
    def __init__(self, xlsx_path: str):
        self.sheets = {}
        with zipfile.ZipFile(xlsx_path, "r") as z:
            shared = []
            if "xl/sharedStrings.xml" in z.namelist():
                root = ET.fromstring(z.read("xl/sharedStrings.xml"))
                for si in root.findall(f"{{{NS_MAIN}}}si"):
                    shared.append("".join(t.text or "" for t in si.iter(f"{{{NS_MAIN}}}t")))
            wb = ET.fromstring(z.read("xl/workbook.xml"))
            rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
            r2t = {r.attrib["Id"]: r.attrib["Target"] for r in rels.findall(f"{{{NS_PKG}}}Relationship")}
            for sh in wb.findall(f".//{{{NS_MAIN}}}sheet"):
                name = sh.attrib["name"]
                target = r2t[sh.attrib[f"{{{NS_REL}}}id"]]
                if not target.startswith("xl/"):
                    target = "xl/" + target.lstrip("/")
                root = ET.fromstring(z.read(target))
                rows = {}
                for c in root.iter(f"{{{NS_MAIN}}}c"):
                    ref = c.attrib.get("r", "")
                    m = re.match(r"([A-Z]+)(\d+)", ref)
                    if not m:
                        continue
                    col, ri = m.group(1), int(m.group(2))
                    t = c.attrib.get("t", "")
                    f_el = c.find(f"{{{NS_MAIN}}}f")
                    v_el = c.find(f"{{{NS_MAIN}}}v")
                    is_el = c.find(f"{{{NS_MAIN}}}is")
                    val = None
                    if t == "s" and v_el is not None and v_el.text is not None:
                        idx = int(v_el.text)
                        val = shared[idx] if idx < len(shared) else v_el.text
                    elif t == "inlineStr" and is_el is not None:
                        val = "".join(x.text or "" for x in is_el.iter(f"{{{NS_MAIN}}}t"))
                    elif v_el is not None and v_el.text is not None:
                        raw = v_el.text
                        if t in ("", "n"):
                            try:
                                fv = float(raw)
                                val = int(fv) if fv.is_integer() else fv
                            except ValueError:
                                val = raw
                        else:
                            val = raw
                    ft = f_el.text if f_el is not None and f_el.text else None
                    rows.setdefault(ri, {})[col] = (val, ft)
                self.sheets[name] = rows

    def get(self, sheet: str, col: str, row: int):
        return self.sheets.get(sheet, {}).get(row, {}).get(col, (None, None))


# --- 轻量 Excel 公式词法与递归下降解析器 ---
TOKEN_RE = re.compile(
    r"""
    (?P<SPACE>\s+)
    |(?P<STRING>"[^"]*")
    |(?P<SHEET_RANGE>(?:'[^']+'|[A-Za-z0-9_\u4e00-\u9fff]+)!\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+)
    |(?P<RANGE>\$?[A-Z]+\$?\d+:\$?[A-Z]+\$?\d+)
    |(?P<SHEET_CELL>(?:'[^']+'|[A-Za-z0-9_\u4e00-\u9fff]+)!\$?[A-Z]+\$?\d+)
    |(?P<CELL>\$?[A-Z]+\$?\d+)
    |(?P<FUNC>[A-Za-z_][A-Za-z0-9_]*\s*(?=\())
    |(?P<NUMBER>\d+(?:\.\d+)?)
    |(?P<OP><=|>=|<>|[+\-*/=<>(),])
    """,
    re.VERBOSE,
)


def tokenize(expr: str):
    tokens = []
    pos = 0
    while pos < len(expr):
        m = TOKEN_RE.match(expr, pos)
        if not m:
            raise ValueError(f"无法词法解析公式位置 {pos}: {expr[pos:pos+30]} in {expr}")
        pos = m.end()
        kind = m.lastgroup
        if kind == "SPACE":
            continue
        tokens.append((kind, m.group(0).strip()))
    return tokens


class ASTParser:
    def __init__(self, tokens):
        self.tokens = tokens
        self.i = 0

    def peek(self):
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def consume(self, expected=None):
        tok = self.peek()
        if expected and (not tok or tok[1] != expected):
            raise ValueError(f"期望 {expected}，实际 {tok}")
        self.i += 1
        return tok

    def parse(self):
        node = self.parse_cmp()
        if self.i != len(self.tokens):
            raise ValueError(f"未消费完 token: {self.tokens[self.i:]}")
        return node

    def parse_cmp(self):
        left = self.parse_add()
        while self.peek() and self.peek()[0] == "OP" and self.peek()[1] in ("=", "<>", "<=", ">=", "<", ">"):
            op = self.consume()[1]
            right = self.parse_add()
            left = ("cmp", op, left, right)
        return left

    def parse_add(self):
        left = self.parse_mul()
        while self.peek() and self.peek()[0] == "OP" and self.peek()[1] in ("+", "-"):
            op = self.consume()[1]
            right = self.parse_mul()
            left = ("bin", op, left, right)
        return left

    def parse_mul(self):
        left = self.parse_unary()
        while self.peek() and self.peek()[0] == "OP" and self.peek()[1] in ("*", "/"):
            op = self.consume()[1]
            right = self.parse_unary()
            left = ("bin", op, left, right)
        return left

    def parse_unary(self):
        if self.peek() and self.peek()[0] == "OP" and self.peek()[1] in ("+", "-"):
            op = self.consume()[1]
            return ("unary", op, self.parse_unary())
        return self.parse_primary()

    def parse_primary(self):
        tok = self.peek()
        if not tok:
            raise ValueError("公式意外结束")
        kind, val = tok
        if kind == "OP" and val == "(":
            self.consume("(")
            node = self.parse_cmp()
            self.consume(")")
            return node
        if kind == "FUNC":
            fn = self.consume()[1].upper()
            self.consume("(")
            args = []
            if not (self.peek() and self.peek()[1] == ")"):
                args.append(self.parse_cmp())
                while self.peek() and self.peek()[1] == ",":
                    self.consume(",")
                    args.append(self.parse_cmp())
            self.consume(")")
            return ("call", fn, args)
        self.consume()
        if kind == "NUMBER":
            num = float(val) if "." in val else int(val)
            return ("const", num)
        if kind == "STRING":
            return ("const", val[1:-1])
        if kind in ("SHEET_CELL", "CELL", "SHEET_RANGE", "RANGE"):
            return (kind.lower(), val)
        raise ValueError(f"未知 primary token: {tok}")


def split_sheet_ref(raw: str, current_sheet: str):
    if "!" in raw:
        sh, ref = raw.split("!", 1)
        sh = sh.strip("'")
    else:
        sh, ref = current_sheet, raw
    return sh, ref.replace("$", "")


def expand_range(sheet: str, rng: str):
    start, end = rng.split(":")
    c1, r1 = parse_cell_ref(start)
    c2, r2 = parse_cell_ref(end)
    ci1, ci2 = col_to_idx(c1), col_to_idx(c2)
    cells = []
    for r in range(r1, r2 + 1):
        for ci in range(ci1, ci2 + 1):
            cells.append((sheet, idx_to_col(ci), r))
    return cells


class Val:
    """既可能是已求得的静态常数，也可能是依赖路线变量的 Python 表达式字符串。"""

    def __init__(self, expr: str, is_const: bool = False, const=None):
        self.expr = expr
        self.is_const = is_const
        self.const = const

    @staticmethod
    def from_const(v):
        if isinstance(v, str):
            return Val(repr(v), True, v)
        if isinstance(v, bool):
            return Val("True" if v else "False", True, v)
        if v is None:
            return Val("0", True, 0)
        return Val(str(v), True, v)


class FormulaExpander:
    def __init__(self, wb: WorkbookReader):
        self.wb = wb

    def expand_cell(self, sheet: str, col: str, row: int, lb: int, lb_cell_target: tuple, cur_row_num: int = 2) -> Val:
        if lb_cell_target and (sheet, col, row) == lb_cell_target:
            return Val.from_const(lb)
        if sheet == "路线":
            ref = f"{col}{row}"
            if ref == "C6":
                return Val("('计算' if calc_seika else '不计算')")
            if ref == "B4":
                return Val("('计算' if calc_item else '不计算')")
            # 路线中的动作次数与基础值均作为运行时变量 R['Bxx']
            return Val(f"R[{repr(ref)}]")

        val, formula = self.wb.get(sheet, col, row)
        if formula:
            tokens = tokenize(formula)
            ast = ASTParser(tokens).parse()
            return self.eval_ast(ast, sheet, lb, lb_cell_target, cur_row_num)
        if val is None:
            return Val.from_const(0)
        return Val.from_const(val)

    def eval_ast(self, node, sheet: str, lb: int, lb_cell_target, cur_row_num: int) -> Val:
        kind = node[0]
        if kind == "const":
            return Val.from_const(node[1])
        if kind in ("sheet_cell", "cell"):
            sh, ref = split_sheet_ref(node[1], sheet)
            c, r = parse_cell_ref(ref)
            return self.expand_cell(sh, c, r, lb, lb_cell_target, cur_row_num)
        if kind == "unary":
            op, inner = node[1], self.eval_ast(node[2], sheet, lb, lb_cell_target, cur_row_num)
            if inner.is_const:
                return Val.from_const(-inner.const if op == "-" else +inner.const)
            return Val(f"({op}{inner.expr})")
        if kind == "bin":
            op = node[1]
            a = self.eval_ast(node[2], sheet, lb, lb_cell_target, cur_row_num)
            b = self.eval_ast(node[3], sheet, lb, lb_cell_target, cur_row_num)
            if a.is_const and b.is_const:
                av = 0 if a.const is None else a.const
                bv = 0 if b.const is None else b.const
                if op == "+":
                    res = av + bv
                elif op == "-":
                    res = av - bv
                elif op == "*":
                    res = av * bv
                elif op == "/":
                    res = av / bv
                if isinstance(res, float) and res.is_integer():
                    res = int(res)
                return Val.from_const(res)
            # 简化乘 0 / 加 0
            if op == "*" and ((a.is_const and a.const == 0) or (b.is_const and b.const == 0)):
                return Val.from_const(0)
            if op == "+" and a.is_const and a.const == 0:
                return b
            if op == "+" and b.is_const and b.const == 0:
                return a
            if op == "-" and b.is_const and b.const == 0:
                return a
            return Val(f"({a.expr} {op} {b.expr})")
        if kind == "cmp":
            op, l_ast, r_ast = node[1], node[2], node[3]
            a = self.eval_ast(l_ast, sheet, lb, lb_cell_target, cur_row_num)
            b = self.eval_ast(r_ast, sheet, lb, lb_cell_target, cur_row_num)
            py_op = {"=": "==", "<>": "!="}.get(op, op)
            if a.is_const and b.is_const:
                av, bv = a.const, b.const
                if py_op == "==":
                    res = av == bv
                elif py_op == "!=":
                    res = av != bv
                elif py_op == "<=":
                    res = av <= bv
                elif py_op == ">=":
                    res = av >= bv
                elif py_op == "<":
                    res = av < bv
                elif py_op == ">":
                    res = av > bv
                return Val.from_const(bool(res))
            return Val(f"({a.expr} {py_op} {b.expr})")
        if kind == "call":
            fn, args = node[1], node[2]
            if fn == "ROW":
                return Val.from_const(cur_row_num)
            if fn == "INT":
                v = self.eval_ast(args[0], sheet, lb, lb_cell_target, cur_row_num)
                if v.is_const:
                    return Val.from_const(math.floor(v.const + 1e-9))
                return Val(f"math.floor(({v.expr}) + 1e-9)")
            if fn == "AND":
                vals = [self.eval_ast(x, sheet, lb, lb_cell_target, cur_row_num) for x in args]
                if all(x.is_const for x in vals):
                    return Val.from_const(all(bool(x.const) for x in vals))
                return Val("(" + " and ".join(x.expr for x in vals) + ")")
            if fn == "OR":
                vals = [self.eval_ast(x, sheet, lb, lb_cell_target, cur_row_num) for x in args]
                if all(x.is_const for x in vals):
                    return Val.from_const(any(bool(x.const) for x in vals))
                return Val("(" + " or ".join(x.expr for x in vals) + ")")
            if fn == "IF":
                cond = self.eval_ast(args[0], sheet, lb, lb_cell_target, cur_row_num)
                if cond.is_const:
                    branch = args[1] if cond.const else (args[2] if len(args) > 2 else ("const", 0))
                    return self.eval_ast(branch, sheet, lb, lb_cell_target, cur_row_num)
                t_val = self.eval_ast(args[1], sheet, lb, lb_cell_target, cur_row_num)
                f_val = self.eval_ast(args[2], sheet, lb, lb_cell_target, cur_row_num) if len(args) > 2 else Val.from_const(0)
                return Val(f"({t_val.expr} if {cond.expr} else {f_val.expr})")
            if fn == "CHOOSE":
                idx_v = self.eval_ast(args[0], sheet, lb, lb_cell_target, cur_row_num)
                if not idx_v.is_const:
                    raise ValueError(f"CHOOSE 索引不是常数: {idx_v.expr}")
                pos = int(idx_v.const)
                return self.eval_ast(args[pos], sheet, lb, lb_cell_target, cur_row_num)
            if fn == "INDEX":
                rng_node = args[0]
                if rng_node[0] not in ("sheet_range", "range"):
                    raise ValueError(f"INDEX 首参非区域: {rng_node}")
                sh, rng = split_sheet_ref(rng_node[1], sheet)
                cells = expand_range(sh, rng)
                idx_v = self.eval_ast(args[1], sheet, lb, lb_cell_target, cur_row_num)
                if not idx_v.is_const:
                    raise ValueError(f"INDEX 索引不是常数: {idx_v.expr}")
                pos = int(idx_v.const) - 1
                target_sh, tc, tr = cells[pos]
                return self.expand_cell(target_sh, tc, tr, lb, lb_cell_target, cur_row_num)
            raise ValueError(f"不支持的 Excel 函数: {fn}")
        raise ValueError(f"未知 AST 节点: {node}")


def strip_row_tiebreak(formula: str):
    """剥离比较表公式中的 -ROW()*0.00001 去重微调项（可能在末尾或 IF 分支内）。"""
    return re.sub(r"-\s*ROW\([^)]*\)\s*\*\s*0\.0+\d+", "", formula.strip())


def extract_lb_cell_from_cmp_formula(wb: WorkbookReader, formula: str):
    """顺着比较表 D 列引用链，递归在 持有情况 公式中查找 IF(<cell>=-1, ...) 定位本卡破数单元格。"""
    queue = re.findall(r"'持有情况'!\$?([A-Z]+\$?\d+)", formula)
    visited = set()
    while queue:
        ref = queue.pop(0).replace("$", "")
        if ref in visited:
            continue
        visited.add(ref)
        c, r = parse_cell_ref(ref)
        _, f = wb.get("持有情况", c, r)
        if not f:
            continue
        m = re.search(r"IF\(\s*\$?([A-Z]+\$?\d+)\s*=\s*-1\s*,", f)
        if m:
            tc, tr = parse_cell_ref(m.group(1))
            return ("持有情况", tc, tr)
        # 继续沿着同表单元格引用往下找（过滤掉跨表引用）
        stripped = re.sub(r"'[^']+'!\$?[A-Z]+\$?\d+(?::\$?[A-Z]+\$?\d+)?", "", f)
        for next_ref in re.findall(r"\$?([A-Z]+\$?\d+)", stripped):
            if next_ref.replace("$", "") not in visited:
                queue.append(next_ref)
    return None


def eval_route_defaults(wb: WorkbookReader):
    """读取 路线 表中 HIF 预设参数（用于和 J 列满破公式做精确自检）。"""
    # 直接按 路线 表第 11~50 行 B 列数值/公式求出一份基准 R dict
    d = {}
    for r in range(11, 51):
        val, f = wb.get("路线", "B", r)
        if val is not None:
            d[f"B{r}"] = val
    # 动态求值 B11..B18（这些在 xlsx 里没有缓存 <v>）
    d11 = wb.get("路线", "D", 11)[0] or 90
    d12 = wb.get("路线", "D", 12)[0] or 10
    d13 = wb.get("路线", "D", 13)[0] or 0
    sp_seq = [wb.get("路线", "D", r)[0] for r in range(16, 24)]
    sp_vals_1 = [60, 80, 80, 100, 100, 120, 120, 140]
    sp_vals_2 = [20, 50, 20, 60, 20, 70, 20, 80]

    def calc_b11_or_12(pct, slot_id):
        s = 200 + math.floor(80 * pct / 100) + math.floor(200 * pct / 100) + math.floor(220 * pct / 100)
        for i, pick in enumerate(sp_seq):
            s += sp_vals_1[i] if pick == slot_id else sp_vals_2[i]
        return s

    d["B11"] = calc_b11_or_12(d11, 1)
    d["B12"] = calc_b11_or_12(d12, 2)
    d["B13"] = 200 + math.floor(80 * d13 / 100) + math.floor(200 * d13 / 100) + math.floor(220 * d13 / 100)
    d["B14"] = sum(1 for x in sp_seq if x == 1)
    d["B15"] = d["B14"]
    d["B17"] = sum(1 for x in sp_seq if x == 2)
    d["B18"] = d["B17"]
    # 其余若为 None 置 0
    for r in range(11, 51):
        d.setdefault(f"B{r}", 0)
    return d


def main():
    wb = WorkbookReader(DEFAULT_XLSX)
    sup_raw = json.loads(SUPPORT_JSON.read_text(encoding="utf-8"))
    sup_list = sup_raw["items"] if isinstance(sup_raw, dict) and "items" in sup_raw else sup_raw
    sup_by_key = {x["key"]: x for x in sup_list}
    sup_exact = {x["name"].strip(): x for x in sup_list}
    sup_norm = {norm_name(x["name"]): x for x in sup_list}

    expander = FormulaExpander(wb)

    c1 = wb.sheets["第一属性比较"]
    c2 = wb.sheets["第二属性比较"]
    c3 = wb.sheets["第三属性比较"]

    # 建立 name -> (sheet_rows, row) 映射以对齐二、三属性比较表
    c2_by_name = {c2[r]["A"][0].strip(): r for r in c2 if r > 1 and c2[r].get("A", (None, None))[0]}
    c3_by_name = {c3[r]["A"][0].strip(): r for r in c3 if r > 1 and c3[r].get("A", (None, None))[0]}

    cards = []
    match_ok = 0
    self_check_pass = 0
    self_check_total = 0
    r_test = eval_route_defaults(wb)

    for r in sorted(c1.keys()):
        if r == 1:
            continue
        raw_name = c1[r].get("A", (None, None))[0]
        d1_val, d1_f = c1[r].get("D", (None, None))
        j1_val, j1_f = c1[r].get("J", (None, None))
        if not isinstance(raw_name, str) or not raw_name.strip() or (not d1_f and not j1_f):
            continue
        raw_name = raw_name.strip()
        m_alias = re.match(r"^(.*?)[（(]([^（）()]+)[）)]\s*$", raw_name)
        if m_alias:
            jp_name = m_alias.group(1).strip()
            alias = m_alias.group(2).strip()
        else:
            jp_name = raw_name
            alias = ""

        # 匹配 support.json
        matched_sup = None
        if jp_name in sup_exact:
            matched_sup = sup_exact[jp_name]
        elif norm_name(jp_name) in sup_norm:
            matched_sup = sup_norm[norm_name(jp_name)]
        elif jp_name in MANUAL_ALIASES:
            matched_sup = sup_by_key.get(MANUAL_ALIASES[jp_name])
        if matched_sup:
            match_ok += 1

        plan = int(c1[r].get("E", (0, None))[0] or 0)      # 0通用 1感性 2理性 3非凡
        is_sp = int(c1[r].get("F", (0, None))[0] or 0)     # 0/1
        attr = int(c1[r].get("G", (1, None))[0] or 1)      # 1红Vo 2蓝Da 3黄Vi
        pollution = int(c1[r].get("H", (0, None))[0] or 0) # 0/1
        item_note = c1[r].get("I", (None, None))[0]
        item_note = str(item_note).strip() if item_note is not None else ""

        r2 = c2_by_name[raw_name]
        r3 = c3_by_name[raw_name]
        d_formulas = [
            strip_row_tiebreak(c1[r]["D"][1]),
            strip_row_tiebreak(c2[r2]["D"][1]),
            strip_row_tiebreak(c3[r3]["D"][1]),
        ]
        j_formulas = [
            strip_row_tiebreak(c1[r]["J"][1]),
            strip_row_tiebreak(c2[r2]["J"][1]),
            strip_row_tiebreak(c3[r3]["J"][1]),
        ]

        lb_target = extract_lb_cell_from_cmp_formula(wb, d_formulas[0])
        if not lb_target:
            raise ValueError(f"无法识别破数单元格: R{r} {raw_name} -> {d_formulas[0]}")

        # 分别按 0~4 破展开含道具(withItem)和不含道具(noItem)两种模式表达式
        exprs_no_item = {}
        exprs_with_item = {}
        has_item_bonus = any("路线" in df and "B4" in df for df in d_formulas)

        # 直接对比较表 D 列公式（已剥离 -ROW()*0.00001）分别固定 calc_item=False / True 展开
        for lb in range(5):
            slot_no = []
            slot_yes = []
            for slot_idx, (df, cmp_sh, cmp_r) in enumerate(
                [(d_formulas[0], "第一属性比较", r), (d_formulas[1], "第二属性比较", r2), (d_formulas[2], "第三属性比较", r3)]
            ):
                # 构造两个临时 AST，将 '路线'!B4="计算" 分支静默替换
                tokens = tokenize(df)
                ast = ASTParser(tokens).parse()

                # 用自定义子类把 '路线'!B4 在展开期视作常数，精确分离有/无道具表达式
                class BranchExpander(FormulaExpander):
                    def __init__(self, wb_ref, item_on: bool):
                        super().__init__(wb_ref)
                        self.item_on = item_on

                    def expand_cell(self, sheet, col, row, _lb, _lb_tgt, _cr=2):
                        if sheet == "路线" and f"{col}{row}" == "B4":
                            return Val.from_const("计算" if self.item_on else "不计算")
                        return super().expand_cell(sheet, col, row, _lb, _lb_tgt, _cr)

                v_no = BranchExpander(wb, False).eval_ast(ast, cmp_sh, lb, lb_target, cmp_r)
                v_yes = BranchExpander(wb, True).eval_ast(ast, cmp_sh, lb, lb_target, cmp_r)
                slot_no.append(v_no.expr)
                slot_yes.append(v_yes.expr)
            exprs_no_item[str(lb)] = slot_no
            exprs_with_item[str(lb)] = slot_yes

        # 自检：用 lb=4 的展开公式对比各比较表 J 列满破公式（分别测试 item_on=True 和 item_on=False）
        for slot_idx, (jf, cmp_sh, cmp_r) in enumerate(
            [(j_formulas[0], "第一属性比较", r), (j_formulas[1], "第二属性比较", r2), (j_formulas[2], "第三属性比较", r3)]
        ):
            ast_j = ASTParser(tokenize(jf)).parse()
            for item_on in (False, True):
                class JExpander(FormulaExpander):
                    def __init__(self, wb_ref, _item_on: bool):
                        super().__init__(wb_ref)
                        self.item_on = _item_on

                    def expand_cell(self, sheet, col, row, _lb, _lb_tgt, _cr=2):
                        if sheet == "路线" and f"{col}{row}" == "B4":
                            return Val.from_const("计算" if self.item_on else "不计算")
                        return super().expand_cell(sheet, col, row, _lb, _lb_tgt, _cr)

                j_expr = JExpander(wb, item_on).eval_ast(ast_j, cmp_sh, 4, lb_target, cmp_r).expr
                d_expr = exprs_with_item["4"][slot_idx] if item_on else exprs_no_item["4"][slot_idx]
                for seika_on in (False, True):
                    env = {"R": r_test, "calc_seika": seika_on, "calc_item": item_on, "math": math}
                    val_j = eval(j_expr, {"__builtins__": {}}, env)
                    val_d = eval(d_expr, {"__builtins__": {}}, env)
                    self_check_total += 1
                    if abs(val_j - val_d) <= 1e-6:
                        self_check_pass += 1
                    else:
                        print(f"[偏差警告] R{r} {raw_name} slot={slot_idx+1} item={item_on} seika={seika_on}: D={val_d} vs J={val_j}")

        # 抽取出该卡依赖了哪些 路线 变量，便于分析词条特性
        all_code = " ".join(exprs_with_item["4"])
        deps = sorted(set(re.findall(r"R\['(B\d+)'\]", all_code)))

        cards.append(
            {
                "id": r,
                "rawName": raw_name,
                "jpName": jp_name,
                "alias": alias,
                "supportKey": matched_sup["key"] if matched_sup else None,
                "rarity": int(matched_sup["rarity"]) if matched_sup else None,
                "plan": plan,
                "isSp": is_sp,
                "attr": attr,
                "pollution": pollution,
                "itemNote": item_note,
                "hasItemBonus": has_item_bonus,
                "isMiniDrink": jp_name == "ふわふわでワクワク",
                "deps": deps,
                "exprs": {
                    "noItem": exprs_no_item,
                    "withItem": exprs_with_item,
                },
            }
        )

    out = {
        "source": os.path.basename(DEFAULT_XLSX),
        "cardCount": len(cards),
        "supportMatchCount": match_ok,
        "selfCheckPassed": self_check_pass,
        "selfCheckTotal": self_check_total,
        "cards": cards,
    }
    OUT_JSON.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"成功提取 {len(cards)} 张支援卡 -> {OUT_JSON}")
    print(f"support.json 匹配: {match_ok}/{len(cards)}")
    print(f"满破公式自检 (4破展开 vs J列, 含道具开关×塞卡开关×三槽位): {self_check_pass}/{self_check_total}")


if __name__ == "__main__":
    main()
