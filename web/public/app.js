(function () {
  'use strict';

  const STORAGE_SUPPORT_KEY = 'gkms_box_support_v1';
  const STORAGE_CIDOL_KEY = 'gkms_box_cidol_v1';
  const LEGACY_SUPPORT_KEY = 'gakuen_box_data_v5';
  const LEGACY_CIDOL_KEY = 'gakuen_cidol_box_data_v1';

  const Codec = window.GkmsCodec;
  const CanvasExport = window.GkmsCanvasExport;

  const state = {
    activeTab: 'support',
    characters: {},
    supportCatalog: [],
    supportByKey: {},
    cidolCatalog: [],
    cidolByKey: {},
    meta: null,
    manifest: { cards: [], cidol: {} },
    manifestCardSet: new Set(),
    supportOwned: {}, // key -> breakLevel (0..4)
    cidolOwned: {},   // key -> true
    filters: {
      supportRarity: [],
      supportAttr: [],
      supportPlan: [],
      supportOwnedMode: 'all', // all | owned | unowned
      supportQuery: '',
      cidolCharacter: 'all',
      cidolVariant: '1',
      cidolPlan: [],
      cidolOwnedMode: 'all',
      cidolQuery: '',
    },
    shortBusy: false,
    toastTimer: null,
  };

  function el(id) {
    return document.getElementById(id);
  }

  function showToast(msg, duration = 2600) {
    const t = el('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      t.classList.add('hidden');
    }, duration);
  }

  async function copyClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fallback below
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }

  function loadLocalState() {
    try {
      const savedSup = localStorage.getItem(STORAGE_SUPPORT_KEY) || localStorage.getItem(LEGACY_SUPPORT_KEY);
      if (savedSup) {
        const parsed = JSON.parse(savedSup);
        if (parsed && typeof parsed === 'object') {
          Object.entries(parsed).forEach(([k, v]) => {
            if (state.supportByKey[k] && Number.isInteger(v) && v >= 0 && v <= 4) {
              state.supportOwned[k] = v;
            }
          });
        }
      }
    } catch { /* ignore */ }

    try {
      const savedCid = localStorage.getItem(STORAGE_CIDOL_KEY) || localStorage.getItem(LEGACY_CIDOL_KEY);
      if (savedCid) {
        const parsed = JSON.parse(savedCid);
        if (parsed && typeof parsed === 'object') {
          Object.entries(parsed).forEach(([k, v]) => {
            if (state.cidolByKey[k] && v) {
              state.cidolOwned[k] = true;
            }
          });
        }
      }
    } catch { /* ignore */ }
  }

  function saveSupportState() {
    localStorage.setItem(STORAGE_SUPPORT_KEY, JSON.stringify(state.supportOwned));
  }

  function saveCidolState() {
    localStorage.setItem(STORAGE_CIDOL_KEY, JSON.stringify(state.cidolOwned));
  }

  function getSupportExportString() {
    const entries = Object.entries(state.supportOwned)
      .map(([key, breakLevel]) => {
        const card = state.supportByKey[key];
        return card ? { rarity: card.rarity, number: card.number, breakLevel } : null;
      })
      .filter(Boolean);
    return Codec.encodeSupportBox(entries);
  }

  function getCidolExportString() {
    const entries = Object.keys(state.cidolOwned)
      .map((key) => state.cidolByKey[key])
      .filter(Boolean);
    return Codec.encodeCidolBox(entries);
  }

  function getFilteredSupportCards() {
    const f = state.filters;
    const q = f.supportQuery.trim().toLowerCase();
    return state.supportCatalog.filter((c) => {
      if (f.supportRarity.length && !f.supportRarity.includes(c.rarity)) return false;
      if (f.supportAttr.length && !f.supportAttr.includes(c.attr)) return false;
      if (f.supportPlan.length && !f.supportPlan.includes(c.plan)) return false;
      const owned = Object.prototype.hasOwnProperty.call(state.supportOwned, c.key);
      if (f.supportOwnedMode === 'owned' && !owned) return false;
      if (f.supportOwnedMode === 'unowned' && owned) return false;
      if (q) {
        const matchName = (c.name || '').toLowerCase().includes(q);
        const matchId = c.key.includes(q) || c.id.toLowerCase().includes(q);
        if (!matchName && !matchId) return false;
      }
      return true;
    });
  }

  function getFilteredCidolSkins() {
    const f = state.filters;
    const q = f.cidolQuery.trim().toLowerCase();
    const charOrder = Object.keys(state.characters);
    return state.cidolCatalog
      .filter((s) => {
        if (f.cidolCharacter !== 'all' && s.character !== f.cidolCharacter) return false;
        if (f.cidolPlan.length && !f.cidolPlan.includes(s.plan)) return false;
        const owned = !!state.cidolOwned[s.key];
        if (f.cidolOwnedMode === 'owned' && !owned) return false;
        if (f.cidolOwnedMode === 'unowned' && owned) return false;
        if (q) {
          const charName = (state.characters[s.character] || '').toLowerCase();
          const hit =
            (s.name || '').toLowerCase().includes(q) ||
            (s.baseName || '').toLowerCase().includes(q) ||
            charName.includes(q) ||
            s.key.includes(q);
          if (!hit) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const ia = charOrder.indexOf(a.character);
        const ib = charOrder.indexOf(b.character);
        return (
          (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) ||
          Number(b.rarity) - Number(a.rarity) ||
          b.number.localeCompare(a.number)
        );
      });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderHeaderActions() {
    const supCode = getSupportExportString();
    const cidCode = getCidolExportString();
    const supCount = Object.keys(state.supportOwned).length;
    const cidCount = Object.keys(state.cidolOwned).length;

    el('tabCountSupport').textContent = `${supCount}/${state.supportCatalog.length}`;
    el('tabCountCidol').textContent = `${cidCount}/${state.cidolCatalog.length}`;

    el('supportCodePreview').textContent = supCode || '暂无持有支援卡';
    el('cidolCodePreview').textContent = cidCode || '暂无持有角色皮肤';

    const curCount = state.activeTab === 'support' ? supCount : cidCount;
    el('btnExportCurrentImg').disabled = curCount === 0;
    el('btnExportCurrentLabel').textContent =
      state.activeTab === 'support' ? '生成 S卡汇总长图' : '生成 P卡汇总长图';
    el('btnExportAllImg').disabled = supCount === 0 && cidCount === 0;
    el('btnShortCode').disabled = state.shortBusy || (!supCode && !cidCode);
  }

  function renderStatsPanel() {
    const summary = Codec.summarizeBox({
      supportMap: state.supportOwned,
      cidolSet: state.cidolOwned,
      supportCatalog: state.supportCatalog,
      cidolCatalog: state.cidolCatalog,
      characters: state.characters,
    });

    const panel = el('statsPanel');
    if (state.activeTab === 'support') {
      const s = summary.support;
      const attrTitles = { vo: 'VOCAL 声乐', da: 'DANCE 舞蹈', vi: 'VISUAL 视觉', as: 'ASSIST 辅助' };
      const chips = [
        { name: 'SSR 支援卡', owned: s.ssrOwned, total: s.ssrTotal, pct: s.ssrTotal ? Math.round((s.ssrOwned / s.ssrTotal) * 100) : 0, extra: `满破 ${s.maxBreakSsr}` },
        { name: 'SR 支援卡', owned: s.srOwned, total: s.srTotal, pct: s.srTotal ? Math.round((s.srOwned / s.srTotal) * 100) : 0, extra: `满破 ${s.maxBreakSr}` },
        ...['vo', 'da', 'vi', 'as'].map((k) => ({
          name: attrTitles[k],
          owned: s.byAttr[k].owned,
          total: s.byAttr[k].total,
          pct: s.byAttr[k].percent,
          extra: `满破 ${s.byAttr[k].maxBreak}`,
        })),
      ];

      panel.innerHTML = `
        <div class="stats-layout">
          <div class="stat-main-card">
            <div class="stat-main-top">
              <div>
                <div class="stat-label">支援卡总收集率</div>
                <div class="stat-big">${s.owned}<span style="font-size:15px;color:#94a3b8">/${s.total}</span></div>
              </div>
              <div class="stat-pct">${s.percent}%</div>
            </div>
            <div class="stat-subline">其中满破共 <strong>${s.maxBreakTotal}</strong> 张（SSR ${s.maxBreakSsr} / SR ${s.maxBreakSr}）</div>
            <div class="meter-track"><div class="meter-fill" style="width:${s.percent}%"></div></div>
          </div>
          <div class="stat-sub-grid">
            ${chips
              .map(
                (ch) => `
              <div class="stat-chip">
                <div class="stat-chip-row">
                  <span class="stat-chip-name">${ch.name}</span>
                  <span class="stat-chip-pct">${ch.pct}%</span>
                </div>
                <div class="stat-chip-num">${ch.owned}/${ch.total} · ${ch.extra}</div>
                <div class="meter-track"><div class="meter-fill" style="width:${ch.pct}%"></div></div>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `;
    } else {
      const c = summary.cidol;
      panel.innerHTML = `
        <div class="stats-layout">
          <div class="stat-main-card">
            <div class="stat-main-top">
              <div>
                <div class="stat-label">P卡与皮肤总收集</div>
                <div class="stat-big">${c.owned}<span style="font-size:15px;color:#94a3b8">/${c.total}</span></div>
              </div>
              <div class="stat-pct">${c.percent}%</div>
            </div>
            <div class="stat-subline">SSR ${c.ssrOwned}/${c.ssrTotal} · SR ${c.srOwned}/${c.srTotal} · R ${c.rOwned}/${c.rTotal}</div>
            <div class="meter-track"><div class="meter-fill" style="width:${c.percent}%"></div></div>
          </div>
          <div class="stat-sub-grid">
            ${c.byCharacter
              .map(
                (ch) => `
              <div class="stat-chip clickable ${state.filters.cidolCharacter === ch.code ? 'active-char' : ''}" data-stat-char="${ch.code}">
                <div class="stat-chip-row">
                  <span class="stat-chip-name">${escapeHtml(ch.name)}</span>
                  <span class="stat-chip-pct">${ch.percent}%</span>
                </div>
                <div class="stat-chip-num">${ch.owned}/${ch.total}（点按筛选）</div>
                <div class="meter-track"><div class="meter-fill" style="width:${ch.percent}%"></div></div>
              </div>
            `
              )
              .join('')}
          </div>
        </div>
      `;
      panel.querySelectorAll('[data-stat-char]').forEach((node) => {
        node.addEventListener('click', () => {
          const code = node.getAttribute('data-stat-char');
          state.filters.cidolCharacter = state.filters.cidolCharacter === code ? 'all' : code;
          renderAll();
        });
      });
    }
  }

  function toggleArrayItem(arr, val) {
    const idx = arr.indexOf(val);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(val);
  }

  function renderFilterBar() {
    const bar = el('filterBar');
    const f = state.filters;

    if (state.activeTab === 'support') {
      bar.innerHTML = `
        <div class="filter-row">
          <div class="filter-group">
            <span class="filter-group-label">稀有度</span>
            <button class="f-btn ${f.supportRarity.includes('3') ? 'active-ssr' : ''}" data-s-rarity="3">SSR</button>
            <button class="f-btn ${f.supportRarity.includes('2') ? 'active-sr' : ''}" data-s-rarity="2">SR</button>
          </div>
          <div class="filter-group">
            <span class="filter-group-label">属性</span>
            <button class="f-btn ${f.supportAttr.includes('vo') ? 'active-vo' : ''}" data-s-attr="vo">VOCAL</button>
            <button class="f-btn ${f.supportAttr.includes('da') ? 'active-da' : ''}" data-s-attr="da">DANCE</button>
            <button class="f-btn ${f.supportAttr.includes('vi') ? 'active-vi' : ''}" data-s-attr="vi">VISUAL</button>
            <button class="f-btn ${f.supportAttr.includes('as') ? 'active-as' : ''}" data-s-attr="as">ASSIST</button>
          </div>
          <div class="filter-group">
            <span class="filter-group-label">流派</span>
            <button class="f-btn ${f.supportPlan.includes('Sense') ? 'active-sense' : ''}" data-s-plan="Sense">感性 Sense</button>
            <button class="f-btn ${f.supportPlan.includes('Logic') ? 'active-logic' : ''}" data-s-plan="Logic">理性 Logic</button>
            <button class="f-btn ${f.supportPlan.includes('Anomaly') ? 'active-anomaly' : ''}" data-s-plan="Anomaly">非凡 Anomaly</button>
            <button class="f-btn ${f.supportPlan.includes('Common') ? 'active-common' : ''}" data-s-plan="Common">通用</button>
          </div>
        </div>
        <div class="filter-row">
          <div class="filter-group">
            <span class="filter-group-label">持有</span>
            <button class="f-btn ${f.supportOwnedMode === 'all' ? 'active' : ''}" data-s-owned="all">全部</button>
            <button class="f-btn ${f.supportOwnedMode === 'owned' ? 'active' : ''}" data-s-owned="owned">已持有</button>
            <button class="f-btn ${f.supportOwnedMode === 'unowned' ? 'active' : ''}" data-s-owned="unowned">未持有</button>
          </div>
          <input id="supportSearchInput" class="search-input" type="search" placeholder="搜索卡名或编号..." value="${escapeHtml(f.supportQuery)}">
          <button id="btnResetSupportFilter" class="f-btn">重置筛选</button>
        </div>
      `;

      bar.querySelectorAll('[data-s-rarity]').forEach((b) =>
        b.addEventListener('click', () => {
          toggleArrayItem(f.supportRarity, b.getAttribute('data-s-rarity'));
          renderFilterBar();
          renderCardGrid();
        })
      );
      bar.querySelectorAll('[data-s-attr]').forEach((b) =>
        b.addEventListener('click', () => {
          toggleArrayItem(f.supportAttr, b.getAttribute('data-s-attr'));
          renderFilterBar();
          renderCardGrid();
        })
      );
      bar.querySelectorAll('[data-s-plan]').forEach((b) =>
        b.addEventListener('click', () => {
          toggleArrayItem(f.supportPlan, b.getAttribute('data-s-plan'));
          renderFilterBar();
          renderCardGrid();
        })
      );
      bar.querySelectorAll('[data-s-owned]').forEach((b) =>
        b.addEventListener('click', () => {
          f.supportOwnedMode = b.getAttribute('data-s-owned');
          renderFilterBar();
          renderCardGrid();
        })
      );
      el('supportSearchInput').addEventListener('input', (e) => {
        f.supportQuery = e.target.value;
        renderCardGrid();
      });
      el('btnResetSupportFilter').addEventListener('click', () => {
        f.supportRarity = [];
        f.supportAttr = [];
        f.supportPlan = [];
        f.supportOwnedMode = 'all';
        f.supportQuery = '';
        renderFilterBar();
        renderCardGrid();
      });
    } else {
      const chars = Object.entries(state.characters);
      bar.innerHTML = `
        <div class="filter-row">
          <div class="filter-group" style="flex:1">
            <span class="filter-group-label">偶像</span>
            <button class="f-btn ${f.cidolCharacter === 'all' ? 'active' : ''}" data-c-char="all">全部角色</button>
            ${chars
              .map(
                ([code, name]) =>
                  `<button class="f-btn ${f.cidolCharacter === code ? 'active' : ''}" data-c-char="${code}">${escapeHtml(name)}</button>`
              )
              .join('')}
          </div>
        </div>
        <div class="filter-row">
          <div class="filter-group">
            <span class="filter-group-label">立绘</span>
            <button class="f-btn ${f.cidolVariant === '1' ? 'active-ssr' : ''}" data-c-var="1">特训后</button>
            <button class="f-btn ${f.cidolVariant === '0' ? 'active-ssr' : ''}" data-c-var="0">特训前</button>
          </div>
          <div class="filter-group">
            <span class="filter-group-label">流派</span>
            <button class="f-btn ${f.cidolPlan.includes('Sense') ? 'active-sense' : ''}" data-c-plan="Sense">感性</button>
            <button class="f-btn ${f.cidolPlan.includes('Logic') ? 'active-logic' : ''}" data-c-plan="Logic">理性</button>
            <button class="f-btn ${f.cidolPlan.includes('Anomaly') ? 'active-anomaly' : ''}" data-c-plan="Anomaly">非凡</button>
          </div>
          <div class="filter-group">
            <span class="filter-group-label">持有</span>
            <button class="f-btn ${f.cidolOwnedMode === 'all' ? 'active' : ''}" data-c-owned="all">全部</button>
            <button class="f-btn ${f.cidolOwnedMode === 'owned' ? 'active' : ''}" data-c-owned="owned">已持有</button>
            <button class="f-btn ${f.cidolOwnedMode === 'unowned' ? 'active' : ''}" data-c-owned="unowned">未持有</button>
          </div>
          <input id="cidolSearchInput" class="search-input" type="search" placeholder="搜索皮肤名或偶像..." value="${escapeHtml(f.cidolQuery)}">
          <button id="btnResetCidolFilter" class="f-btn">重置筛选</button>
        </div>
      `;

      bar.querySelectorAll('[data-c-char]').forEach((b) =>
        b.addEventListener('click', () => {
          f.cidolCharacter = b.getAttribute('data-c-char');
          renderStatsPanel();
          renderFilterBar();
          renderCardGrid();
        })
      );
      bar.querySelectorAll('[data-c-var]').forEach((b) =>
        b.addEventListener('click', () => {
          f.cidolVariant = b.getAttribute('data-c-var');
          renderFilterBar();
          renderCardGrid();
        })
      );
      bar.querySelectorAll('[data-c-plan]').forEach((b) =>
        b.addEventListener('click', () => {
          toggleArrayItem(f.cidolPlan, b.getAttribute('data-c-plan'));
          renderFilterBar();
          renderCardGrid();
        })
      );
      bar.querySelectorAll('[data-c-owned]').forEach((b) =>
        b.addEventListener('click', () => {
          f.cidolOwnedMode = b.getAttribute('data-c-owned');
          renderFilterBar();
          renderCardGrid();
        })
      );
      el('cidolSearchInput').addEventListener('input', (e) => {
        f.cidolQuery = e.target.value;
        renderCardGrid();
      });
      el('btnResetCidolFilter').addEventListener('click', () => {
        f.cidolCharacter = 'all';
        f.cidolPlan = [];
        f.cidolOwnedMode = 'all';
        f.cidolQuery = '';
        renderStatsPanel();
        renderFilterBar();
        renderCardGrid();
      });
    }
  }

  function renderTipBanner() {
    const tip = el('tipBanner');
    const hasSupImg = state.manifestCardSet.size > 0;
    const hasCidImg = Object.keys(state.manifest.cidol || {}).length > 0;
    const imgStatus =
      hasSupImg || hasCidImg
        ? `已检测到本地卡面图资源（S卡 ${state.manifestCardSet.size} 张 / P卡 ${Object.keys(state.manifest.cidol || {}).length} 组）。`
        : '当前运行于无图轻量模式（未放入卡面图，自动显示流派渐变卡片）；后续使用 scripts/import_assets.py 导入图包后会自动切换高清卡面。';

    if (state.activeTab === 'support') {
      tip.innerHTML =
        `操作提示：点击卡片 <strong>左半边</strong> 降级，<strong>右半边</strong> 升级；或点卡片下方快捷等级按钮（再点一次已激活等级可取消持有）。${imgStatus}`;
    } else {
      tip.innerHTML = `操作提示：点击角色卡即可切换持有状态，点顶部统计条中的偶像名可快速筛出该角色。${imgStatus}`;
    }
  }

  function setSupportBreakLevel(key, nextLv) {
    if (nextLv < 0 || nextLv > 4) {
      delete state.supportOwned[key];
    } else {
      state.supportOwned[key] = nextLv;
    }
    saveSupportState();
    renderHeaderActions();
    renderStatsPanel();
    renderCardGrid();
  }

  function renderCardGrid() {
    const grid = el('cardGrid');
    grid.className = `card-grid mode-${state.activeTab}`;

    if (state.activeTab === 'support') {
      const list = getFilteredSupportCards();
      if (list.length === 0) {
        grid.innerHTML = '<div class="empty-state">没有符合筛选条件的支援卡</div>';
        return;
      }

      grid.innerHTML = list
        .map((c) => {
          const hasLevel = Object.prototype.hasOwnProperty.call(state.supportOwned, c.key);
          const lv = hasLevel ? state.supportOwned[c.key] : -1;
          const base = c.rarity === '3' ? 40 : 30;
          const lvLabel = lv === -1 ? '未持有' : `LV.${base + lv * 5}`;
          const quickLevels = [0, 1, 2, 3, 4];
          const hasImg = state.manifestCardSet.has(c.key);
          const attrUpper = (c.attr || '').toUpperCase();

          const mediaHtml = hasImg
            ? `<img class="card-real-img" loading="lazy" src="./${c.image}" alt="${escapeHtml(c.name)}">`
            : `<div class="vector-card-art plan-${escapeHtml(c.plan)}">
                 <div class="vector-stripe"></div>
                 <div class="vector-card-title">${escapeHtml(c.name)}</div>
                 <div class="vector-card-sub">${escapeHtml(c.plan)} · #${c.number}</div>
               </div>`;

          return `
            <div class="s-card-wrap" data-s-card="${c.key}">
              <div class="s-card-box rarity-${c.rarity} ${lv >= 0 ? 'is-owned' : 'is-unowned'} ${lv === 4 ? 'is-max' : ''}">
                ${mediaHtml}
                <div class="card-badges-top">
                  <span class="rarity-pill r-${c.rarity}">${c.rarity === '3' ? 'SSR' : 'SR'}</span>
                  <span class="attr-pill attr-${c.attr}">${attrUpper}</span>
                </div>
                <div class="card-bottom-overlay">
                  <span class="lv-badge ${lv === -1 ? 'off' : lv === 4 ? 'max' : 'on'}">${lvLabel}</span>
                  <span class="card-mini-meta">${escapeHtml(c.name)}</span>
                </div>
                <div class="tap-zones">
                  <div class="tap-zone" data-step="-1" title="降级"></div>
                  <div class="tap-zone" data-step="1" title="升级"></div>
                </div>
              </div>
              <div class="quick-lv-bar">
                ${quickLevels
                  .map(
                    (idx) =>
                      `<button class="quick-lv-btn ${lv === idx ? 'active' : ''}" data-quick-lv="${idx}">${base + idx * 5}</button>`
                  )
                  .join('')}
              </div>
            </div>
          `;
        })
        .join('');

      grid.querySelectorAll('[data-s-card]').forEach((wrap) => {
        const key = wrap.getAttribute('data-s-card');
        wrap.querySelectorAll('.tap-zone').forEach((zone) => {
          zone.addEventListener('click', () => {
            const cur = Object.prototype.hasOwnProperty.call(state.supportOwned, key)
              ? state.supportOwned[key]
              : -1;
            const step = Number(zone.getAttribute('data-step'));
            const next = Math.max(-1, Math.min(4, cur + step));
            if (next !== cur) setSupportBreakLevel(key, next);
          });
        });
        wrap.querySelectorAll('[data-quick-lv]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const target = Number(btn.getAttribute('data-quick-lv'));
            const cur = Object.prototype.hasOwnProperty.call(state.supportOwned, key)
              ? state.supportOwned[key]
              : -1;
            setSupportBreakLevel(key, cur === target ? -1 : target);
          });
        });
      });
    } else {
      const list = getFilteredCidolSkins();
      if (list.length === 0) {
        grid.innerHTML = '<div class="empty-state">没有符合筛选条件的角色或皮肤</div>';
        return;
      }

      grid.innerHTML = list
        .map((s) => {
          const owned = !!state.cidolOwned[s.key];
          const charName = state.characters[s.character] || s.character.toUpperCase();
          const availVariants = (state.manifest.cidol && state.manifest.cidol[s.key]) || [];
          const chosenVar = availVariants.includes(state.filters.cidolVariant)
            ? state.filters.cidolVariant
            : availVariants[0] || '';
          const hasImg = Boolean(chosenVar && s.images && s.images[chosenVar]);

          const mediaHtml = hasImg
            ? `<img loading="lazy" src="./${s.images[chosenVar]}" alt="${escapeHtml(s.name)}">`
            : `<div class="vector-card-art plan-${escapeHtml(s.plan)}">
                 <div class="vector-stripe"></div>
                 <div class="vector-card-title">${escapeHtml(s.name)}</div>
                 <div class="vector-card-sub">${escapeHtml(charName)} · ${escapeHtml(s.plan)}</div>
               </div>`;

          return `
            <div class="c-card ${owned ? 'is-owned' : 'is-unowned'}" data-c-card="${s.key}">
              <div class="c-card-media">
                ${mediaHtml}
                <div class="card-badges-top">
                  <span class="rarity-pill r-${s.rarity}">${s.rarity === '3' ? 'SSR' : s.rarity === '2' ? 'SR' : 'R'}</span>
                </div>
                ${owned ? '<span class="owned-flag">已拥有</span>' : ''}
              </div>
              <div class="c-card-footer">
                <div class="c-card-top">
                  <span class="c-char-name">${escapeHtml(charName)}</span>
                  <span class="c-plan-tag plan-badge-${escapeHtml(s.plan)}">${escapeHtml(s.plan)}</span>
                </div>
                <div class="c-skin-name" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</div>
              </div>
            </div>
          `;
        })
        .join('');

      grid.querySelectorAll('[data-c-card]').forEach((cardEl) => {
        cardEl.addEventListener('click', () => {
          const key = cardEl.getAttribute('data-c-card');
          if (state.cidolOwned[key]) delete state.cidolOwned[key];
          else state.cidolOwned[key] = true;
          saveCidolState();
          renderHeaderActions();
          renderStatsPanel();
          renderCardGrid();
        });
      });
    }
  }

  function renderAll() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === state.activeTab);
    });
    renderHeaderActions();
    renderStatsPanel();
    renderFilterBar();
    renderTipBanner();
    renderCardGrid();
  }

  async function publishShortCode() {
    const box = getSupportExportString();
    const cidol = getCidolExportString();
    if (!box && !cidol) return;

    state.shortBusy = true;
    el('btnShortCode').textContent = '正在写入云端短码...';
    renderHeaderActions();

    try {
      const res = await fetch('./api/binds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ box, cidol }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 503 || res.status === 404 || res.status === 405) {
          throw new Error(
            data.message ||
              '短码云端服务尚未启用（需先部署到 Cloudflare Pages 并绑定 BOX_BINDS KV）；现在可先直接复制下方的 Base64 代码发给机器人绑定！'
          );
        }
        throw new Error(data.message || `请求失败 (${res.status})`);
      }

      const code = data.code;
      const botCmd = `@机器人 绑定box ${code}`;
      el('shortCodeValue').textContent = code;
      el('botCmdPreview').textContent = botCmd;
      el('shortCodeBanner').classList.remove('hidden');

      await copyClipboard(code);
      showToast(`短码 ${code} 已生成并复制到剪贴板！`, 3400);
    } catch (err) {
      alert(err && err.message ? err.message : String(err));
    } finally {
      state.shortBusy = false;
      el('btnShortCode').textContent = '生成并复制 9 位短码 (g########)';
      renderHeaderActions();
    }
  }

  async function handleImport() {
    const raw = el('importTextarea').value.trim();
    const errEl = el('importError');
    errEl.classList.add('hidden');
    if (!raw) {
      errEl.textContent = '请先粘贴代码或短码';
      errEl.classList.remove('hidden');
      return;
    }

    try {
      const detected = Codec.detectCodePayload(raw, state.supportByKey, state.cidolByKey);
      if (detected.kind === 'short') {
        const res = await fetch(`./api/binds/${encodeURIComponent(detected.code)}`, { cache: 'no-store' });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(payload.message || `短码读取失败 (${res.status})`);
        }
        let msgs = [];
        if (payload.box) {
          const decSup = Codec.decodeSupportBox(payload.box, state.supportByKey);
          if (!decSup.ok) throw new Error(decSup.error);
          state.supportOwned = decSup.map;
          saveSupportState();
          msgs.push(`S卡 ${decSup.items.length} 张`);
        }
        if (payload.cidol) {
          const decCid = Codec.decodeCidolBox(payload.cidol, state.cidolByKey);
          if (!decCid.ok) throw new Error(decCid.error);
          state.cidolOwned = decCid.set;
          saveCidolState();
          msgs.push(`P卡 ${decCid.items.length} 项`);
        }
        el('importModal').classList.add('hidden');
        renderAll();
        showToast(`短码导入成功：${msgs.join('、') || '完成'}`);
        return;
      }

      if (detected.kind === 'support') {
        state.supportOwned = detected.decoded.map;
        saveSupportState();
        state.activeTab = 'support';
        el('importModal').classList.add('hidden');
        renderAll();
        showToast(`支援卡导入成功：共 ${detected.decoded.items.length} 张`);
        return;
      }

      if (detected.kind === 'cidol') {
        state.cidolOwned = detected.decoded.set;
        saveCidolState();
        state.activeTab = 'cidol';
        el('importModal').classList.add('hidden');
        renderAll();
        showToast(`角色皮肤导入成功：共 ${detected.decoded.items.length} 项`);
        return;
      }

      throw new Error(detected.error || '无法识别的代码格式');
    } catch (err) {
      errEl.textContent = err && err.message ? err.message : String(err);
      errEl.classList.remove('hidden');
    }
  }

  async function handleExportImage(mode) {
    const btn = mode === 'all' ? el('btnExportAllImg') : el('btnExportCurrentImg');
    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = '正在生成长图...';

    try {
      const supportList = getFilteredSupportCards().filter((c) =>
        Object.prototype.hasOwnProperty.call(state.supportOwned, c.key)
      );
      const cidolList = getFilteredCidolSkins().filter((s) => !!state.cidolOwned[s.key]);
      const summary = Codec.summarizeBox({
        supportMap: state.supportOwned,
        cidolSet: state.cidolOwned,
        supportCatalog: state.supportCatalog,
        cidolCatalog: state.cidolCatalog,
        characters: state.characters,
      });

      const dataUrl = await CanvasExport.renderSummaryCanvas({
        mode,
        supportList: mode === 'cidol' ? [] : supportList.length ? supportList : state.supportCatalog.filter((c) => Object.prototype.hasOwnProperty.call(state.supportOwned, c.key)),
        supportMap: state.supportOwned,
        cidolList: mode === 'support' ? [] : cidolList.length ? cidolList : state.cidolCatalog.filter((s) => !!state.cidolOwned[s.key]),
        characters: state.characters,
        cidolVariant: state.filters.cidolVariant,
        manifest: state.manifest,
        summary,
      });

      el('generatedPreviewImg').src = dataUrl;
      el('btnDownloadImage').href = dataUrl;
      el('btnDownloadImage').download = `gkms_box_${mode}_${Date.now()}.jpg`;
      el('imageModal').classList.remove('hidden');
    } catch (err) {
      alert(err && err.message ? err.message : String(err));
    } finally {
      btn.innerHTML = oldHtml;
      renderHeaderActions();
    }
  }

  function bindGlobalEvents() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.activeTab = btn.getAttribute('data-tab');
        renderAll();
      });
    });

    el('chipCopySupport').addEventListener('click', async () => {
      const code = getSupportExportString();
      if (!code) return showToast('请先至少勾选 1 张支援卡');
      await copyClipboard(code);
      showToast('已复制支援卡 Base64 代码');
    });

    el('chipCopyCidol').addEventListener('click', async () => {
      const code = getCidolExportString();
      if (!code) return showToast('请先至少勾选 1 张角色卡');
      await copyClipboard(code);
      showToast('已复制角色皮肤 Base64 代码');
    });

    el('btnCopyBotCmd').addEventListener('click', async () => {
      const cmd = el('botCmdPreview').textContent;
      if (cmd) {
        await copyClipboard(cmd);
        showToast('已复制 QQ 机器人绑定指令');
      }
    });

    el('btnShortCode').addEventListener('click', publishShortCode);
    el('btnExportCurrentImg').addEventListener('click', () => handleExportImage(state.activeTab));
    el('btnExportAllImg').addEventListener('click', () => handleExportImage('all'));

    el('btnOpenImport').addEventListener('click', () => {
      el('importError').classList.add('hidden');
      el('importTextarea').value = '';
      el('importModal').classList.remove('hidden');
      el('importTextarea').focus();
    });
    el('btnConfirmImport').addEventListener('click', handleImport);

    el('btnResetCurrent').addEventListener('click', () => {
      if (state.activeTab === 'support') {
        if (!confirm('确定要清空当前所有已勾选的支援卡吗？')) return;
        state.supportOwned = {};
        saveSupportState();
      } else {
        if (!confirm('确定要清空当前所有已勾选的角色与皮肤吗？')) return;
        state.cidolOwned = {};
        saveCidolState();
      }
      renderAll();
      showToast('当前页数据已清空');
    });

    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => {
        el(btn.getAttribute('data-close-modal')).classList.add('hidden');
      });
    });
    document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
      backdrop.addEventListener('click', (e) => {
        if (e.target === backdrop) backdrop.classList.add('hidden');
      });
    });
  }

  async function fetchJsonSafe(path, fallback) {
    const res = await fetch(path);
    if (!res.ok) {
      if (fallback !== undefined) return fallback;
      throw new Error(`${path} HTTP ${res.status}`);
    }
    return res.json();
  }

  async function init() {
    bindGlobalEvents();
    try {
      const [meta, characters, support, cidol, manifest] = await Promise.all([
        fetchJsonSafe('./data/meta.json', null),
        fetchJsonSafe('./data/characters.json'),
        fetchJsonSafe('./data/support.json'),
        fetchJsonSafe('./data/cidol.json'),
        fetchJsonSafe('./data/asset-manifest.json', { cards: [], cidol: {} }),
      ]);

      state.meta = meta;
      state.characters = characters || {};
      state.supportCatalog = support || [];
      state.cidolCatalog = cidol || [];
      state.manifest = manifest || { cards: [], cidol: {} };
      state.manifestCardSet = new Set(state.manifest.cards || []);

      state.supportByKey = {};
      state.supportCatalog.forEach((c) => {
        state.supportByKey[c.key] = c;
      });
      state.cidolByKey = {};
      state.cidolCatalog.forEach((s) => {
        state.cidolByKey[s.key] = s;
      });

      if (meta && meta.counts) {
        const genDate = meta.generatedAt ? meta.generatedAt.slice(0, 10) : '';
        el('metaSummary').textContent = `收录 S卡 ${meta.counts.support} / P卡 ${meta.counts.cidol}（更新于 ${genDate}）`;
      }

      loadLocalState();
      renderAll();
    } catch (err) {
      el('metaSummary').textContent = '目录加载失败';
      el('cardGrid').innerHTML = `<div class="empty-state">加载卡池数据失败：${escapeHtml(
        err && err.message ? err.message : String(err)
      )}<br>请勿用 file:// 直接双击打开，请通过 HTTP 服务器访问（如 python -m http.server 或 Cloudflare Pages）。</div>`;
    }
  }

  init();
})();
