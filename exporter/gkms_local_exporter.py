#!/usr/bin/env python3
"""《学园偶像大师》纯本地 BOX 代码导出器（仅适配 gkms-box / Koishi Bot）。

特点：
1. 完全纯离线运行，无任何联网上传或第三方服务请求；
2. 支援卡码严格生成 `{rarity}-{num}-{breakLevel}`（0~4破）的 Base64，
   P 偶像码严格生成 `{char}-{rarity}-{3位num}` 的 Base64，与 gkms-box codec.js 100% 一致；
3. 导出前自动备份游戏目录原有文件至 `.gkms_box_backup`，退出或停止时自动还原。
"""

from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext


APP_TITLE = "学马仕 BOX 本地导出器（gkms-box 专用纯离线版）"
DISCLAIMER_WAIT_SECONDS = 5
DISCLAIMER_TEXT = """【一、使用风险与免责声明】
1. 本工具为 100% 纯本地离线软件，不连接任何第三方网络服务器，也不会上传你的游戏账号或持有数据。
2. 导出过程需要结束当前游戏进程，并在游戏目录临时放置代理 DLL（xinput9_1_0.dll 等）以在本地只读读取持有列表（不修改游戏内存与存档）。尽管不篡改游戏数据，仍属于非官方第三方插件加载行为，存在潜在违反游戏服务条款或触发检测的风险。
3. 使用本软件产生的一切后果与风险均由使用者本人自行承担。导出前会自动将游戏目录原有文件备份至 `.gkms_box_backup`，使用完毕后请务必还原，勿长期保留临时文件进入游戏。

【二、使用方法】
1. 建议右键「以管理员身份运行」本工具，并确认上方「游戏目录」指向包含 gakumas.exe 的路径。
2. 点击「开始导出（重启游戏并抓取）」，等待 DMM Game Player 拉起游戏并登录进入游戏主界面，软件会自动接收持有数据并生成适配 gkms-box / Koishi 机器人的绑定码。
3. 点击支援卡与 P 偶像栏右侧的「复制绑定指令 (绑定 ...)」，直接粘贴发送给 QQ 机器人即可完成绑定。
4. 导出完成后请先退出游戏，再点击「停止并还原文件」（或直接关闭本软件）以恢复游戏目录原状。

【三、来源声明、版权与侵删】
1. 来源说明：本工具底层抓取机制与实现抄袭/借鉴自群友「病毒佬」发布的原版 Box 导出器，此处仅面向个人 gkms-box / Koishi 机器人编码格式做了纯本地离线适配改写，特此致谢并说明。
2. 使用限制：本工具仅供个人本地离线使用与同好交流，禁止商用，严禁用于任何售卖或盈利传播。
3. 版权与侵删：《学园偶像大师》（学園アイドルマスター）游戏及相关内容版权归 © Bandai Namco Entertainment Inc. / QualiArts, Inc. 所有，本工具与官方无关；如原工具作者「病毒佬」或版权方认为存在侵权，请随时联系，第一时间删除（侵删）。"""
PIPE_NAME = r"\\.\pipe\gkms_box_export"
BACKUP_DIR_NAME = ".gkms_box_backup"
MANIFEST_NAME = "manifest.json"
SENTINEL_NAME = "gkms_box_planted.txt"
WINMM_SENTINEL_NAME = "gkms_box_winmm_planted.txt"
CONF_FILE_NAME = "gkms-game-dir.txt"
MAX_PIPE_BYTES = 4 * 1024 * 1024

SUPPORT_ID_RE = re.compile(r"^s_card-([123])-(\d{4})$")
IDOL_ID_RE = re.compile(r"^i_card-([a-z0-9]+)-([123])-(\d{3})$")
RANK_SUFFIX_RE = re.compile(r"_(\d+)$")

DEFAULT_GAME_DIRS = (
    Path(r"E:\GUKUMA\gakumas"),
    Path(r"D:\gakumas"),
    Path(r"D:\Games\gakumas"),
    Path(r"C:\Games\gakumas"),
    Path(r"C:\Program Files\DMMGames\gakumas"),
)

DMM_PLAYER_CANDIDATES = (
    Path(r"C:\Program Files\DMMGamePlayer\DMMGamePlayer.exe"),
    Path(r"C:\Program Files (x86)\DMMGamePlayer\DMMGamePlayer.exe"),
)

SESSION_REL_PATHS = (
    "xinput9_1_0.dll",
    "winmm.dll",
    "winmm_real.dll",
    "version.dll",
    "gakumas-local/config.json",
    "gakumas-local/localizationConfig.json",
    "gakumas-local/version.txt",
)

# ---------------------------------------------------------------------------
# 核心编解码（与 gkms-box/koishi-plugin/codec.js 保持 100% 一致）
# ---------------------------------------------------------------------------


def parse_break_level(raw_rank: object) -> int:
    """将游戏字段 'SupportCardLevelLimitRank_3' 解析为 0~4 整数。"""
    if not raw_rank:
        return 0
    m = RANK_SUFFIX_RE.search(str(raw_rank).strip())
    if not m:
        return 0
    val = int(m.group(1))
    return max(0, min(4, val))


def make_support_code(support_cards: list[dict]) -> tuple[str, int]:
    """生成 gkms-box 支援卡 Base64 代码：rarity-num-breakLevel（0~4破），过滤 R 卡。"""
    best_by_key: dict[tuple[int, int], int] = {}
    for item in support_cards or []:
        if not isinstance(item, dict):
            continue
        card_id = str(item.get("supportCardId") or "").strip()
        m = SUPPORT_ID_RE.match(card_id)
        if not m:
            continue
        rarity = int(m.group(1))
        if rarity not in (2, 3):  # R 卡不收录，与网站及插件一致
            continue
        num_int = int(m.group(2))
        break_lv = parse_break_level(item.get("levelLimitRank"))
        key = (rarity, num_int)
        if key not in best_by_key or break_lv > best_by_key[key]:
            best_by_key[key] = break_lv

    if not best_by_key:
        return "", 0

    sorted_items = sorted(best_by_key.items(), key=lambda kv: (-kv[0][0], -kv[0][1]))
    raw = ",".join(f"{r}-{n}-{lv}" for (r, n), lv in sorted_items)
    b64 = base64.b64encode(raw.encode("ascii")).decode("ascii")
    return b64, len(sorted_items)


def make_cidol_code(idol_cards: list[dict]) -> tuple[str, int]:
    """生成 gkms-box P 偶像 Base64 代码：char-rarity-3位num（不带特训/潜能后缀）。"""
    seen: dict[tuple[str, int, str], str] = {}
    for item in idol_cards or []:
        if not isinstance(item, dict):
            continue
        card_id = str(item.get("idolCardId") or "").strip()
        m = IDOL_ID_RE.match(card_id)
        if not m:
            continue
        ch = m.group(1).lower()
        rarity = int(m.group(2))
        num_str = m.group(3)
        full_key = f"{ch}-{rarity}-{num_str}"
        seen[(ch, -rarity, num_str)] = full_key

    if not seen:
        return "", 0

    sorted_keys = sorted(
        seen.items(),
        key=lambda kv: (kv[0][0], kv[0][1], -int(kv[0][2])),
    )
    raw = ",".join(v for _, v in sorted_keys)
    b64 = base64.b64encode(raw.encode("ascii")).decode("ascii")
    return b64, len(sorted_keys)


# ---------------------------------------------------------------------------
# 资源路径、游戏进程管理与 DMM 启动
# ---------------------------------------------------------------------------


def app_base_dir() -> Path:
    """返回 exe 所在目录（开发环境返回脚本所在目录）。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def find_bundled_resource(rel_path: str) -> Path | None:
    """优先查找 PyInstaller 解包目录 _MEIPASS，其次查找同级目录。"""
    roots: list[Path] = []
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        roots.append(Path(meipass))
    roots.append(app_base_dir())
    for root in roots:
        cand = root / rel_path
        if cand.exists():
            return cand
    return None


def find_game_dir() -> Path | None:
    """自动探测游戏安装目录（优先读取上次保存的配置）。"""
    conf_file = app_base_dir() / CONF_FILE_NAME
    if conf_file.is_file():
        saved = conf_file.read_text("utf-8", errors="ignore").strip()
        if saved and (Path(saved) / "gakumas.exe").is_file():
            return Path(saved)

    for d in DEFAULT_GAME_DIRS:
        if (d / "gakumas.exe").is_file():
            return d

    # 尝试从 DMM Game Player 配置读取安装路径
    appdata = os.environ.get("APPDATA")
    if appdata:
        cnf = Path(appdata) / "dmmgameplayer5" / "dmmgame.cnf"
        if cnf.is_file():
            try:
                cfg = json.loads(cnf.read_text("utf-8", errors="ignore"))
                for item in cfg.get("contents") or []:
                    if item.get("productId") == "gakumas":
                        detail = item.get("detail") or {}
                        path_str = detail.get("path")
                        if path_str and (Path(path_str) / "gakumas.exe").is_file():
                            return Path(path_str)
            except Exception:
                pass
    return None


def save_game_dir(game_dir: Path) -> None:
    try:
        (app_base_dir() / CONF_FILE_NAME).write_text(str(game_dir), encoding="utf-8")
    except Exception:
        pass


def is_admin() -> bool:
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def list_gakumas_pids() -> list[int]:
    """枚举当前运行中的 gakumas.exe PID。"""
    TH32CS_SNAPPROCESS = 0x00000002

    class PROCESSENTRY32W(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD),
            ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD),
            ("th32DefaultHeapID", ctypes.c_void_p),
            ("th32ModuleID", wintypes.DWORD),
            ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD),
            ("pcPriClassBase", ctypes.c_long),
            ("dwFlags", wintypes.DWORD),
            ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap == wintypes.HANDLE(-1).value:
        return []
    pids: list[int] = []
    try:
        entry = PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            if entry.szExeFile.lower() == "gakumas.exe":
                pids.append(int(entry.th32ProcessID))
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return pids


def kill_game(timeout_ms: int = 8000) -> int:
    """结束所有 gakumas.exe 并等待退出以释放 DLL 锁。"""
    pids = list_gakumas_pids()
    if not pids:
        return 0
    PROCESS_TERMINATE = 0x0001
    SYNCHRONIZE = 0x00100000
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handles = []
    killed = 0
    for pid in pids:
        h = kernel32.OpenProcess(PROCESS_TERMINATE | SYNCHRONIZE, False, pid)
        if h:
            if kernel32.TerminateProcess(h, 0):
                killed += 1
            handles.append(h)
    deadline = time.monotonic() + timeout_ms / 1000.0
    for h in handles:
        remain = max(0, int((deadline - time.monotonic()) * 1000))
        kernel32.WaitForSingleObject(h, remain)
        kernel32.CloseHandle(h)
    if list_gakumas_pids():
        raise RuntimeError("游戏进程未能完全退出，请在任务管理器结束 gakumas.exe 后再试")
    return killed


def _dmm_launch_info() -> tuple[str, str]:
    appdata = os.environ.get("APPDATA")
    if appdata:
        cnf = Path(appdata) / "dmmgameplayer5" / "dmmgame.cnf"
        if cnf.is_file():
            try:
                cfg = json.loads(cnf.read_text("utf-8", errors="ignore"))
                for item in cfg.get("contents") or []:
                    if item.get("productId") == "gakumas":
                        gt = str(item.get("gameType") or "GCL").upper()
                        pid = str(item.get("productId") or "gakumas")
                        return gt, pid
            except Exception:
                pass
    return "GCL", "gakumas"


def launch_game() -> None:
    """通过 DMM Game Player URI 启动《学园偶像大师》。"""
    gt, pid = _dmm_launch_info()
    uri = f"dmmgameplayer://play/{gt}/{pid}/cl/win"
    try:
        os.startfile(uri)  # type: ignore[attr-defined]
        return
    except OSError:
        pass

    player = next((p for p in DMM_PLAYER_CANDIDATES if p.is_file()), None)
    if player is None:
        raise RuntimeError("无法通过 dmmgameplayer:// 协议启动，也未找到 DMMGamePlayer.exe，请先手动从 DMM 启动一次游戏。")
    rc = subprocess.run([str(player), uri], check=False).returncode
    if rc != 0:
        raise RuntimeError(f"DMM Game Player 启动失败（返回码 {rc}），请手动打开 DMM 后重试。")


# ---------------------------------------------------------------------------
# 临时 DLL 部署、备份与还原
# ---------------------------------------------------------------------------


def plant_session_files(game_dir: Path) -> list[str]:
    """将随包 game_env 组件临时部署到游戏目录，原文件备份进 .gkms_box_backup。"""
    backup_root = game_dir / BACKUP_DIR_NAME
    manifest_path = backup_root / MANIFEST_NAME
    backup_root.mkdir(parents=True, exist_ok=True)

    manifest: dict = {"files": {}}
    if manifest_path.is_file():
        try:
            loaded = json.loads(manifest_path.read_text("utf-8"))
            if isinstance(loaded, dict) and isinstance(loaded.get("files"), dict):
                manifest = loaded
        except Exception:
            pass

    notes: list[str] = []
    for rel in SESSION_REL_PATHS:
        src = find_bundled_resource(f"game_env/{rel}")
        if src is None or not src.is_file():
            continue
        dst = game_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)

        if rel not in manifest["files"]:
            bak_file = backup_root / rel
            if dst.exists():
                bak_file.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(dst, bak_file)
                manifest["files"][rel] = {"existed": True}
                notes.append(f"{rel}=已备份")
            else:
                manifest["files"][rel] = {"existed": False}
                notes.append(f"{rel}=新增临时文件")

        if not dst.exists() or dst.read_bytes() != src.read_bytes():
            shutil.copy2(src, dst)

    (game_dir / SENTINEL_NAME).write_text("session by GkmsBoxLocalExporter\n", encoding="utf-8")
    (game_dir / WINMM_SENTINEL_NAME).write_text("session by GkmsBoxLocalExporter\n", encoding="utf-8")
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return notes


def restore_session_files(game_dir: Path) -> bool:
    """还原游戏目录原有文件并清理 .gkms_box_backup；返回 True 表示仍有文件被游戏占用。"""
    backup_root = game_dir / BACKUP_DIR_NAME
    manifest_path = backup_root / MANIFEST_NAME
    busy = False

    for marker in (SENTINEL_NAME, WINMM_SENTINEL_NAME):
        mp = game_dir / marker
        if mp.exists():
            try:
                mp.unlink()
            except OSError:
                busy = True

    if not manifest_path.is_file():
        return busy

    try:
        manifest = json.loads(manifest_path.read_text("utf-8"))
    except Exception:
        manifest = {"files": {}}

    files_meta: dict = manifest.get("files") or {}
    remaining: dict = {}
    for rel, meta in files_meta.items():
        dst = game_dir / rel
        bak_file = backup_root / rel
        existed = bool((meta or {}).get("existed"))
        try:
            if existed and bak_file.is_file():
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(bak_file, dst)
            elif not existed and dst.exists():
                dst.unlink()
        except OSError:
            busy = True
            remaining[rel] = meta

    if busy and remaining:
        manifest_path.write_text(json.dumps({"files": remaining}, ensure_ascii=False, indent=2), encoding="utf-8")
        return True

    # 清理备份目录
    try:
        shutil.rmtree(backup_root)
    except OSError:
        busy = True
    return busy


# ---------------------------------------------------------------------------
# 命名管道服务端（接收游戏发来的 JSON）
# ---------------------------------------------------------------------------


def _pipe_security_attributes():
    """构造允许低完整性游戏进程连接的命名管道安全属性。"""
    advapi32 = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [
            ("nLength", wintypes.DWORD),
            ("lpSecurityDescriptor", ctypes.c_void_p),
            ("bInheritHandle", wintypes.BOOL),
        ]

    sddl = "D:(A;;GA;;;WD)S:(ML;;NW;;;LW)"
    sd = ctypes.c_void_p()
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.c_void_p),
        ctypes.POINTER(wintypes.ULONG),
    ]
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    ok = advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(sd), None)
    if not ok:
        raise ctypes.WinError(ctypes.get_last_error())
    sa = SECURITY_ATTRIBUTES()
    sa.nLength = ctypes.sizeof(SECURITY_ATTRIBUTES)
    sa.lpSecurityDescriptor = sd.value
    sa.bInheritHandle = False
    return sa, sd, kernel32.LocalFree


def listen_pipe_once(stop_event: threading.Event, on_payload, on_log) -> None:
    """等待一次来自游戏 DLL 的命名管道连接并读取完整 JSON。"""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    PIPE_ACCESS_INBOUND = 0x00000001
    FILE_FLAG_FIRST_PIPE_INSTANCE = 0x00080000
    PIPE_TYPE_BYTE = 0x00000000
    PIPE_REJECT_REMOTE_CLIENTS = 0x00000008
    INVALID_HANDLE_VALUE = wintypes.HANDLE(-1).value
    ERROR_BROKEN_PIPE = 109
    ERROR_PIPE_CONNECTED = 535

    sa, sd, local_free = _pipe_security_attributes()
    pipe = INVALID_HANDLE_VALUE
    try:
        pipe = kernel32.CreateNamedPipeW(
            PIPE_NAME,
            PIPE_ACCESS_INBOUND | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            0,
            65536,
            0,
            ctypes.byref(sa),
        )
        if pipe == INVALID_HANDLE_VALUE:
            raise ctypes.WinError(ctypes.get_last_error())
    finally:
        if sd.value:
            local_free(sd)

    try:
        on_log("命名管道已就绪，等待游戏启动并登录主页…")
        connected = bool(kernel32.ConnectNamedPipe(pipe, None))
        err = ctypes.get_last_error()
        if not connected and err != ERROR_PIPE_CONNECTED:
            if stop_event.is_set():
                return
            raise ctypes.WinError(err)

        if stop_event.is_set():
            return

        chunks: list[bytes] = []
        total = 0
        buf = ctypes.create_string_buffer(65536)
        bytes_read = wintypes.DWORD(0)
        while True:
            ok = kernel32.ReadFile(pipe, buf, 65536, ctypes.byref(bytes_read), None)
            if ok and bytes_read.value > 0:
                total += bytes_read.value
                if total > MAX_PIPE_BYTES:
                    raise RuntimeError("游戏发来的 JSON 超过 4 MiB 限制")
                chunks.append(buf.raw[: bytes_read.value])
                continue
            rerr = ctypes.get_last_error()
            if rerr == ERROR_BROKEN_PIPE or bytes_read.value == 0:
                break
            raise ctypes.WinError(rerr)

        raw_text = b"".join(chunks).decode("utf-8", errors="replace").strip()
        if not raw_text:
            raise RuntimeError("命名管道未收到任何数据")
        payload = json.loads(raw_text)
        on_payload(payload)
    finally:
        if pipe != INVALID_HANDLE_VALUE:
            kernel32.CloseHandle(pipe)


# ---------------------------------------------------------------------------
# GUI 界面
# ---------------------------------------------------------------------------


def get_dpi_scale() -> float:
    """获取当前系统 DPI 缩放比（96dpi=1.0）。"""
    try:
        dc = ctypes.windll.user32.GetDC(0)
        dpi = ctypes.windll.gdi32.GetDeviceCaps(dc, 88)  # LOGPIXELSX
        ctypes.windll.user32.ReleaseDC(0, dc)
        if dpi > 0:
            return max(1.0, min(2.5, float(dpi) / 96.0))
    except Exception:
        pass
    return 1.0


def enable_dpi_awareness() -> float:
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass
    return get_dpi_scale()


def scaled_geometry(win: tk.Misc, base_w: int, base_h: int, scale: float) -> tuple[int, int]:
    """按 DPI 缩放比例居中摆放窗口并避免超出屏幕边界。"""
    win.update_idletasks()
    sw = win.winfo_screenwidth()
    sh = win.winfo_screenheight()
    w = min(int(round(base_w * scale)), max(480, int(sw * 0.90)))
    h = min(int(round(base_h * scale)), max(400, int(sh * 0.88)))
    x = max(0, (sw - w) // 2)
    y = max(0, (sh - h) // 2)
    win.geometry(f"{w}x{h}+{x}+{y}")
    return w, h


def can_accept_disclaimer(remaining_seconds: int, agreed: bool) -> bool:
    """仅当 5 秒倒计时归零且用户已勾选同意时才允许继续使用。"""
    return int(remaining_seconds) <= 0 and bool(agreed)


class DisclaimerDialog(tk.Toplevel):
    """启动时弹出的 5 秒强制使用须知与风险提示模态弹窗。"""

    def __init__(self, master: tk.Misc, scale: float = 1.0) -> None:
        super().__init__(master)
        self.title("使用须知与风险提示")
        self.configure(bg="#F7F6F4")
        self.resizable(True, True)

        ico = find_bundled_resource("icon.ico")
        if ico and ico.is_file():
            try:
                self.iconbitmap(str(ico))
            except Exception:
                pass

        self.scale = scale
        self.accepted = False
        self._remaining = DISCLAIMER_WAIT_SECONDS
        self.agreed_var = tk.BooleanVar(value=False)

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_reject)
        w, h = scaled_geometry(self, 680, 540, scale)
        self.minsize(min(w, int(round(580 * scale))), min(h, int(round(460 * scale))))

        self.transient(master)
        self.grab_set()
        self.lift()
        self.focus_force()
        self.after(1000, self._tick)

    def _build_ui(self) -> None:
        pad = int(round(16 * self.scale))
        hdr = tk.Frame(self, bg="#F7F6F4")
        hdr.pack(side="top", fill="x", padx=pad, pady=(int(round(14 * self.scale)), 6))
        tk.Label(
            hdr,
            text="使用前请仔细阅读：使用须知与风险提示",
            font=("Microsoft YaHei UI", 12, "bold"),
            bg="#F7F6F4",
            fg="#C0392B",
        ).pack(anchor="w")
        tk.Label(
            hdr,
            text="请阅读下方风险说明与操作步骤，等待倒计时结束并勾选同意后方可继续。",
            font=("Microsoft YaHei UI", 9),
            bg="#F7F6F4",
            fg="#6E6A66",
        ).pack(anchor="w", pady=(2, 0))

        # 先自底向上锚定按钮与复选框，确保高 DPI 下永不被中部文本框挤出屏幕
        btn_row = tk.Frame(self, bg="#F7F6F4")
        btn_row.pack(side="bottom", fill="x", padx=pad, pady=(4, int(round(14 * self.scale))))
        tk.Button(
            btn_row,
            text="退出软件",
            command=self._on_reject,
            font=("Microsoft YaHei UI", 9),
            padx=14,
            pady=5,
        ).pack(side="left")

        self.btn_accept = tk.Button(
            btn_row,
            text=f"同意并继续 ({self._remaining}s)",
            command=self._on_accept,
            font=("Microsoft YaHei UI", 9, "bold"),
            padx=16,
            pady=5,
            relief="flat",
            state="disabled",
            bg="#D9D5CF",
            fg="#6E6A66",
        )
        self.btn_accept.pack(side="right")

        agree_row = tk.Frame(self, bg="#F7F6F4")
        agree_row.pack(side="bottom", fill="x", padx=pad, pady=(6, 4))
        tk.Checkbutton(
            agree_row,
            text="我已完整阅读并知悉上述使用风险与使用方法，自愿承担使用后果",
            variable=self.agreed_var,
            command=self._refresh_accept_btn,
            font=("Microsoft YaHei UI", 9, "bold"),
            bg="#F7F6F4",
            activebackground="#F7F6F4",
            fg="#1A1918",
            wraplength=int(round(610 * self.scale)),
            justify="left",
            cursor="hand2",
        ).pack(anchor="w")

        body = scrolledtext.ScrolledText(
            self,
            font=("Microsoft YaHei UI", 9),
            wrap="char",
            bg="#FFFFFF",
            fg="#1A1918",
            bd=1,
            relief="solid",
            padx=10,
            pady=8,
            height=10,
        )
        body.pack(side="top", fill="both", expand=True, padx=pad, pady=6)
        body.insert("1.0", DISCLAIMER_TEXT)
        body.see("1.0")
        body.configure(state="disabled")

    def _tick(self) -> None:
        if not self.winfo_exists():
            return
        if self._remaining > 0:
            self._remaining -= 1
            self._refresh_accept_btn()
            if self._remaining > 0:
                self.after(1000, self._tick)

    def _refresh_accept_btn(self) -> None:
        if self._remaining > 0:
            self.btn_accept.configure(
                text=f"同意并继续 ({self._remaining}s)",
                state="disabled",
                bg="#D9D5CF",
                fg="#6E6A66",
                cursor="arrow",
            )
            return
        if can_accept_disclaimer(self._remaining, self.agreed_var.get()):
            self.btn_accept.configure(
                text="同意并继续",
                state="normal",
                bg="#C44D63",
                fg="#FFFFFF",
                cursor="hand2",
            )
        else:
            self.btn_accept.configure(
                text="同意并继续",
                state="disabled",
                bg="#D9D5CF",
                fg="#6E6A66",
                cursor="arrow",
            )

    def _on_accept(self) -> None:
        if not can_accept_disclaimer(self._remaining, self.agreed_var.get()):
            return
        self.accepted = True
        self.grab_release()
        self.destroy()

    def _on_reject(self) -> None:
        self.accepted = False
        try:
            self.grab_release()
        except Exception:
            pass
        self.destroy()


class ExporterApp(tk.Tk):
    def __init__(self, scale: float = 1.0) -> None:
        super().__init__()
        self.scale = scale
        self.title(APP_TITLE)
        w, h = scaled_geometry(self, 860, 720, scale)
        self.minsize(min(w, int(round(720 * scale))), min(h, int(round(580 * scale))))
        self.configure(bg="#F7F6F4")

        ico = find_bundled_resource("icon.ico")
        if ico and ico.is_file():
            try:
                self.iconbitmap(str(ico))
            except Exception:
                pass

        self.stop_event = threading.Event()
        self.last_payload: dict | None = None
        self.support_code = ""
        self.cidol_code = ""

        detected = find_game_dir()
        self.game_dir_var = tk.StringVar(value=str(detected) if detected else "")
        self.status_var = tk.StringVar(value="就绪（纯离线模式：仅生成 gkms-box / Koishi Bot 兼容码）")
        self.sup_info_var = tk.StringVar(value="支援卡代码（尚未抓取）")
        self.cid_info_var = tk.StringVar(value="P 偶像代码（尚未抓取）")

        self._build_ui()
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        if detected and (detected / SENTINEL_NAME).exists():
            self.log("检测到上次未还原的临时文件，正在检查还原…")
            if not list_gakumas_pids():
                restore_session_files(detected)
                self.log("已自动还原游戏目录原有文件。")
            else:
                self.log("提示：游戏当前正在运行，请先退出游戏后再还原或重新导出。")

    def _build_ui(self) -> None:
        pad = 14
        hdr = tk.Frame(self, bg="#F7F6F4")
        hdr.pack(fill="x", padx=pad, pady=(14, 8))
        tk.Label(
            hdr,
            text="学园偶像大师 · 本地 BOX 代码导出器（纯离线版）",
            font=("Microsoft YaHei UI", 14, "bold"),
            bg="#F7F6F4",
            fg="#1A1918",
        ).pack(anchor="w")
        tk.Label(
            hdr,
            text="直接生成适配你自己的 gkms-box 与 Koishi 机器人的绑定码，绝不上传任何第三方服务器。",
            font=("Microsoft YaHei UI", 9),
            bg="#F7F6F4",
            fg="#6E6A66",
        ).pack(anchor="w", pady=(2, 0))

        # 目录与操作区
        top_card = tk.Frame(self, bg="#FFFFFF", bd=1, relief="solid")
        top_card.pack(fill="x", padx=pad, pady=6)

        row_dir = tk.Frame(top_card, bg="#FFFFFF")
        row_dir.pack(fill="x", padx=12, pady=(10, 6))
        tk.Label(row_dir, text="游戏目录：", font=("Microsoft YaHei UI", 9, "bold"), bg="#FFFFFF").pack(side="left")
        tk.Entry(row_dir, textvariable=self.game_dir_var, font=("Consolas", 9)).pack(
            side="left", fill="x", expand=True, padx=6
        )
        tk.Button(row_dir, text="浏览…", command=self._browse_dir, width=8).pack(side="left")

        row_btn = tk.Frame(top_card, bg="#FFFFFF")
        row_btn.pack(fill="x", padx=12, pady=(4, 10))
        self.btn_start = tk.Button(
            row_btn,
            text="开始导出（重启游戏并抓取）",
            command=self._start_export,
            bg="#C44D63",
            fg="#FFFFFF",
            font=("Microsoft YaHei UI", 9, "bold"),
            padx=12,
            pady=4,
            relief="flat",
            cursor="hand2",
        )
        self.btn_start.pack(side="left")
        tk.Button(row_btn, text="停止并还原文件", command=self._restore_only, padx=10, pady=4).pack(side="left", padx=8)
        tk.Button(row_btn, text="保存 JSON", command=self._save_json, padx=10, pady=4).pack(side="left")
        tk.Label(row_btn, textvariable=self.status_var, font=("Microsoft YaHei UI", 9), bg="#FFFFFF", fg="#2F7A4E").pack(
            side="right"
        )

        # 支援卡结果区
        sup_card = tk.Frame(self, bg="#FFFFFF", bd=1, relief="solid")
        sup_card.pack(fill="x", padx=pad, pady=6)
        sup_hdr = tk.Frame(sup_card, bg="#FFFFFF")
        sup_hdr.pack(fill="x", padx=12, pady=(8, 4))
        tk.Label(sup_hdr, textvariable=self.sup_info_var, font=("Microsoft YaHei UI", 9, "bold"), bg="#FFFFFF").pack(
            side="left"
        )
        tk.Button(sup_hdr, text="复制绑定指令 (绑定 ...)", command=lambda: self._copy_cmd("support"), padx=8).pack(
            side="right"
        )
        tk.Button(sup_hdr, text="复制纯代码", command=lambda: self._copy_raw("support"), padx=8).pack(
            side="right", padx=6
        )
        self.sup_text = tk.Text(sup_card, height=3, font=("Consolas", 9), wrap="char", bd=1, relief="sunken")
        self.sup_text.pack(fill="x", padx=12, pady=(0, 10))

        # P 卡结果区
        cid_card = tk.Frame(self, bg="#FFFFFF", bd=1, relief="solid")
        cid_card.pack(fill="x", padx=pad, pady=6)
        cid_hdr = tk.Frame(cid_card, bg="#FFFFFF")
        cid_hdr.pack(fill="x", padx=12, pady=(8, 4))
        tk.Label(cid_hdr, textvariable=self.cid_info_var, font=("Microsoft YaHei UI", 9, "bold"), bg="#FFFFFF").pack(
            side="left"
        )
        tk.Button(cid_hdr, text="复制绑定指令 (绑定 ...)", command=lambda: self._copy_cmd("cidol"), padx=8).pack(
            side="right"
        )
        tk.Button(cid_hdr, text="复制纯代码", command=lambda: self._copy_raw("cidol"), padx=8).pack(
            side="right", padx=6
        )
        self.cid_text = tk.Text(cid_card, height=3, font=("Consolas", 9), wrap="char", bd=1, relief="sunken")
        self.cid_text.pack(fill="x", padx=12, pady=(0, 10))

        # 日志区
        log_card = tk.Frame(self, bg="#FFFFFF", bd=1, relief="solid")
        log_card.pack(fill="both", expand=True, padx=pad, pady=(6, 14))
        tk.Label(log_card, text="运行日志", font=("Microsoft YaHei UI", 9, "bold"), bg="#FFFFFF").pack(
            anchor="w", padx=12, pady=(8, 2)
        )
        self.log_box = scrolledtext.ScrolledText(log_card, font=("Consolas", 9), state="disabled", height=6)
        self.log_box.pack(fill="both", expand=True, padx=12, pady=(0, 10))

    def log(self, msg: str) -> None:
        ts = time.strftime("%H:%M:%S")
        line = f"[{ts}] {msg}\n"

        def _append():
            self.log_box.configure(state="normal")
            self.log_box.insert("end", line)
            self.log_box.see("end")
            self.log_box.configure(state="disabled")

        self.after(0, _append)

    def _browse_dir(self) -> None:
        chosen = filedialog.askdirectory(title="选择包含 gakumas.exe 的游戏目录")
        if chosen:
            self.game_dir_var.set(chosen)
            save_game_dir(Path(chosen))

    def _start_export(self) -> None:
        gdir = Path(self.game_dir_var.get().strip())
        if not (gdir / "gakumas.exe").is_file():
            messagebox.showerror("目录无效", "请选择包含 gakumas.exe 的游戏目录。")
            return
        save_game_dir(gdir)
        self.stop_event.clear()
        self.btn_start.configure(state="disabled")
        self.status_var.set("正在部署组件并启动游戏…")
        threading.Thread(target=self._worker_export, args=(gdir,), daemon=True).start()

    def _worker_export(self, game_dir: Path) -> None:
        try:
            killed = kill_game()
            if killed:
                self.log(f"已结束 {killed} 个运行中的游戏进程。")
            notes = plant_session_files(game_dir)
            self.log("临时组件就位：" + (", ".join(notes) if notes else "已使用当前会话文件"))
            launch_game()
            self.log("已请求 DMM 启动游戏，请在游戏进入主页后自动抓取…")
            listen_pipe_once(self.stop_event, lambda p: self.after(0, self._on_payload, p), self.log)
        except Exception as exc:
            self.log(f"错误：{exc}")
            self.after(0, lambda: self.status_var.set("导出失败（请看日志）"))
            self.after(0, lambda e=str(exc): messagebox.showerror("导出失败", e))
        finally:
            self.after(0, lambda: self.btn_start.configure(state="normal"))

    def _on_payload(self, payload: dict) -> None:
        self.last_payload = payload
        support_list = payload.get("support") or []
        idol_list = payload.get("idol") or []

        sup_b64, sup_cnt = make_support_code(support_list)
        cid_b64, cid_cnt = make_cidol_code(idol_list)

        self.support_code = sup_b64
        self.cidol_code = cid_b64

        self.sup_info_var.set(f"支援卡代码（共 {sup_cnt} 张非 R 卡 · 可直接用于「绑定 <代码>」）")
        self.cid_info_var.set(f"P 偶像代码（共 {cid_cnt} 张 · 可直接用于「绑定 <代码>」）")

        self.sup_text.delete("1.0", "end")
        self.sup_text.insert("1.0", sup_b64)
        self.cid_text.delete("1.0", "end")
        self.cid_text.insert("1.0", cid_b64)

        self.status_var.set(f"抓取完成：S 卡 {sup_cnt} 张 / P 卡 {cid_cnt} 张")
        self.log(f"抓取成功：原始 support={len(support_list)}, idol={len(idol_list)}；有效 S={sup_cnt}, P={cid_cnt}")

    def _copy_raw(self, kind: str) -> None:
        val = self.support_code if kind == "support" else self.cidol_code
        if not val:
            messagebox.showinfo("提示", "还没有导出代码。")
            return
        self.clipboard_clear()
        self.clipboard_append(val)
        self.status_var.set("已复制纯代码到剪贴板")

    def _copy_cmd(self, kind: str) -> None:
        val = self.support_code if kind == "support" else self.cidol_code
        if not val:
            messagebox.showinfo("提示", "还没有导出代码。")
            return
        self.clipboard_clear()
        self.clipboard_append(f"绑定 {val}")
        self.status_var.set("已复制「绑定 ...」指令，可直接粘贴发给 QQ 机器人")

    def _save_json(self) -> None:
        if not self.last_payload:
            messagebox.showinfo("提示", "还没有抓取到数据。")
            return
        dst = filedialog.asksaveasfilename(
            title="保存原始抓取 JSON",
            defaultextension=".json",
            initialfile="gkms-box.json",
            filetypes=[("JSON 文件", "*.json")],
        )
        if dst:
            Path(dst).write_text(json.dumps(self.last_payload, ensure_ascii=False, indent=2), encoding="utf-8")
            self.log(f"已保存 JSON 到：{dst}")

    def _restore_only(self) -> None:
        self.stop_event.set()
        gdir = Path(self.game_dir_var.get().strip())
        if not gdir.is_dir():
            return
        if list_gakumas_pids():
            if messagebox.askyesno("游戏仍在运行", "需要先关闭 gakumas.exe 才能还原临时 DLL，是否立即关闭？"):
                kill_game()
            else:
                return
        busy = restore_session_files(gdir)
        if busy:
            messagebox.showwarning("部分文件仍被占用", "请确认游戏完全退出后再点一次还原。")
        else:
            self.status_var.set("已还原游戏目录原文件")
            self.log("已还原游戏目录原有文件并清理临时备份。")

    def _on_close(self) -> None:
        self.stop_event.set()
        gdir = Path(self.game_dir_var.get().strip())
        if gdir.is_dir() and (gdir / BACKUP_DIR_NAME).exists():
            if not list_gakumas_pids():
                restore_session_files(gdir)
        self.destroy()


def run_selftest() -> int:
    sup_sample = [
        {"supportCardId": "s_card-3-0100", "levelLimitRank": "SupportCardLevelLimitRank_1"},
        {"supportCardId": "s_card-1-0000", "levelLimitRank": "SupportCardLevelLimitRank_4"},
        {"supportCardId": "s_card-2-0071", "levelLimitRank": "SupportCardLevelLimitRank_2"},
        {"supportCardId": "s_card-3-0001"},  # 缺失默认为 0 破
    ]
    sup_b64, sup_cnt = make_support_code(sup_sample)
    sup_raw = base64.b64decode(sup_b64).decode("ascii")
    assert sup_cnt == 3
    assert sup_raw == "3-100-1,3-1-0,2-71-2", f"unexpected support raw: {sup_raw}"

    idol_sample = [
        {"idolCardId": "i_card-amao-3-002", "levelLimitRank": "IdolCardLevelLimitRank_5", "potentialRank": "IdolCardPotentialRank_1"},
        {"idolCardId": "i_card-hski-1-000", "potentialRank": "IdolCardPotentialRank_3"},
    ]
    cid_b64, cid_cnt = make_cidol_code(idol_sample)
    cid_raw = base64.b64decode(cid_b64).decode("ascii")
    assert cid_cnt == 2
    assert cid_raw == "amao-3-002,hski-1-000", f"unexpected cidol raw: {cid_raw}"
    print("selftest ok:", sup_raw, "|", cid_raw)
    return 0


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if "--selftest" in args:
        return run_selftest()
    scale = enable_dpi_awareness()
    app = ExporterApp(scale=scale)
    app.withdraw()
    dlg = DisclaimerDialog(app, scale=scale)
    app.wait_window(dlg)
    if not dlg.accepted:
        app.destroy()
        return 0
    app.deiconify()
    app.lift()
    app.focus_force()
    app.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
