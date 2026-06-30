/**
 * HerType 批注引擎
 * ----------------------------------------------------------------
 * 核心技术：textarea 无法内部渲染富文本，采用「镜像层叠」方案——
 * 底层 backdrop（div）与上层 textarea 逐字对齐，命中词在 backdrop 里
 * 用 <mark> 包裹画波浪线；textarea 文字透明、只负责接收输入和光标。
 */

(function () {
  const { CATEGORIES, LEXICON } = window.HERTYPE;

  // ---- DOM 引用 ----
  const input      = document.getElementById("input");
  const backdrop   = document.getElementById("backdrop");
  const card       = document.getElementById("critiqueCard");
  const critWord   = document.getElementById("critWord");
  const critCat    = document.getElementById("critCat");
  const critBody   = document.getElementById("critBody");
  const critFoot   = document.getElementById("critFoot");
  const statsBox   = document.getElementById("stats");
  const statsTotal = document.getElementById("statsTotal");
  const statsBars  = document.getElementById("statsBars");
  const modeBtns   = document.querySelectorAll(".mode-btn");

  // 设置区
  const settingsToggle = document.getElementById("settingsToggle");
  const settingsPanel  = document.getElementById("settingsPanel");
  const apiKeyInput    = document.getElementById("apiKeyInput");
  const apiKeyEye      = document.getElementById("apiKeyEye");
  const baseUrlInput   = document.getElementById("baseUrlInput");
  const modelInput     = document.getElementById("modelInput");
  const settingsSave   = document.getElementById("settingsSave");
  const settingsStatus = document.getElementById("settingsStatus");

  // AI 重写结果区
  const rewriteBox    = document.getElementById("rewriteBox");
  const rewriteState  = document.getElementById("rewriteState");
  const rewriteCopy   = document.getElementById("rewriteCopy");

  let currentMode = "learning"; // learning | output | mirror

  // ---- 构建匹配索引：按 trigger 长度降序，保证长词优先（如「妈卖批」先于「妈」）----
  // 用 Map 去重，避免词库里万一有重复 trigger
  const triggerMap = new Map();
  for (const entry of LEXICON) {
    if (!triggerMap.has(entry.trigger)) triggerMap.set(entry.trigger, entry);
  }
  const sortedTriggers = [...triggerMap.keys()].sort((a, b) => b.length - a.length);

  // ---- HTML 转义，防止用户输入里的 < > & 破坏镜像层 ----
  function escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /**
   * 扫描文本，找出所有命中区间。
   * 返回 [{ start, end, entry }]，区间互不重叠（长词优先、左到右）。
   */
  function scan(text) {
    const hits = [];
    const occupied = new Array(text.length).fill(false);

    for (const trigger of sortedTriggers) {
      let from = 0;
      while (true) {
        const idx = text.indexOf(trigger, from);
        if (idx === -1) break;
        const end = idx + trigger.length;
        // 检查这段区间是否已被更长的词占用
        let free = true;
        for (let i = idx; i < end; i++) {
          if (occupied[i]) { free = false; break; }
        }
        if (free) {
          for (let i = idx; i < end; i++) occupied[i] = true;
          hits.push({ start: idx, end, entry: triggerMap.get(trigger) });
        }
        from = idx + trigger.length;
      }
    }
    hits.sort((a, b) => a.start - b.start);
    return hits;
  }

  /**
   * 根据命中结果与当前模式，渲染镜像层 HTML。
   * - mirror   ：把原词替换成性别对调版，并标注
   * - output   ：原词替换成得体改写（保留情绪、去掉羞辱），可直接发出
   * - learning ：保留原词，画波浪线（悬停才解释）
   */
  function render() {
    const text = input.value;
    const hits = scan(text);
    let html = "";
    let cursor = 0;

    hits.forEach((hit, i) => {
      html += escapeHtml(text.slice(cursor, hit.start));
      const e = hit.entry;
      const cat = CATEGORIES[e.category];

      let shown;
      let extraClass = "";
      if (currentMode === "mirror") {
        if (e.mirror === "") {
          // 无男版对应词：留刺眼空白，本身说明「这套羞辱只为女性而造」
          shown = "　　"; // 全角空格占位
          extraClass = " hit--blank";
        } else {
          shown = e.mirror;
        }
      } else {
        // learning 和 output 都保留原词画波浪线；
        // output 模式的整句改写由下方 AI 结果区完成，不在镜像层逐词替换
        shown = text.slice(hit.start, hit.end);
      }

      html +=
        `<mark class="hit hit--${e.category}${extraClass}" ` +
        `data-idx="${i}" ` +
        `style="--cat-color:${cat.color}">` +
        escapeHtml(shown) +
        `</mark>`;
      cursor = hit.end;
    });
    html += escapeHtml(text.slice(cursor));
    // 末尾补一个换行符，保证 textarea 最后一行有换行时镜像层高度跟得上
    backdrop.innerHTML = html + "\n";

    bindHitEvents(hits);
    renderStats(hits);
  }

  // ---- 命中标记：事件改挂在 textarea 上做坐标反查 ----
  // 原因：textarea（z-index:2）整层盖在 backdrop（z-index:1）之上，
  // 鼠标在「视觉上的 mark」位置，实际命中的永远是上层 textarea，
  // 给 .hit 设 pointer-events:auto 对被覆盖元素无效，hover/click 收不到事件。
  // 解法：在 textarea 上监听鼠标坐标，反查落在哪个 mark 的几何区间内。
  let lastHoverMark = null; // 当前悬停的 mark，避免重复弹卡片

  // 给定屏幕坐标，返回命中的 mark 元素（落在其任一行 rect 内）；否则 null
  function markAtPoint(x, y) {
    const marks = backdrop.querySelectorAll(".hit");
    for (const mark of marks) {
      // 命中词可能跨行，getClientRects 返回每行一个矩形
      const rects = mark.getClientRects();
      for (const r of rects) {
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          return mark;
        }
      }
    }
    return null;
  }

  function bindHitEvents(hits) {
    // 把 hits 缓存到闭包，供坐标反查时取 entry
    currentHits = hits;
  }

  let currentHits = [];

  // ---- 弹出批判卡片（mark：命中词元素；用于定位）----
  function showCard(mark, entry) {
    const cat = CATEGORIES[entry.category];
    critWord.textContent = entry.trigger;
    critCat.textContent = cat.label;
    critCat.style.background = cat.color;

    if (currentMode === "learning") {
      critBody.textContent = entry.explain;
      critFoot.textContent = "严重度 " + "●".repeat(entry.severity) + "○".repeat(5 - entry.severity);
    } else if (currentMode === "mirror") {
      if (entry.mirror === "") {
        critBody.textContent = "「" + entry.trigger + "」性别对调后……找不到对应的词。男性几乎没有被这样羞辱的说法——这套词，是专为羞辱女性而造的。";
        critFoot.textContent = cat.label + " · 无男版对应词";
      } else {
        critBody.textContent = "性别对调后：「" + entry.trigger + "」→「" + entry.mirror + "」。觉得别扭吗？这份别扭，正是双标的证据。";
        critFoot.textContent = cat.label;
      }
    } else {
      // 输出模式：命中词只负责「指出问题」，整句改写在下方 AI 结果区
      critBody.textContent =
        "「" + entry.trigger + "」是" + cat.label +
        "。整句的得体改写见下方「AI 重写」——会保留你的情绪、去掉羞辱。";
      critFoot.textContent = "输出模式 · AI 整句重写";
    }

    card.hidden = false;
    // 定位到命中词附近（跨行时取首行矩形）
    const rect = mark.getClientRects()[0] || mark.getBoundingClientRect();
    const cardW = 320;
    let left = rect.left + window.scrollX;
    if (left + cardW > window.innerWidth) left = window.innerWidth - cardW - 16;
    card.style.left = Math.max(16, left) + "px";
    card.style.top = rect.bottom + window.scrollY + 8 + "px";
  }

  function hideCard() {
    card.hidden = true;
  }

  // 点空白处关卡片
  document.addEventListener("click", hideCard);
  card.addEventListener("click", (e) => e.stopPropagation());

  // ---- 统计条 ----
  function renderStats(hits) {
    if (hits.length === 0) {
      statsBox.hidden = true;
      return;
    }
    statsBox.hidden = false;

    const counts = {};
    for (const h of hits) {
      counts[h.entry.category] = (counts[h.entry.category] || 0) + 1;
    }
    statsTotal.textContent = `本段共触发 ${hits.length} 处性别化表达`;

    statsBars.innerHTML = "";
    Object.keys(CATEGORIES).forEach((key) => {
      const n = counts[key] || 0;
      if (n === 0) return;
      const cat = CATEGORIES[key];
      const bar = document.createElement("div");
      bar.className = "stats-bar";
      bar.innerHTML =
        `<span class="stats-dot" style="background:${cat.color}"></span>` +
        `<span class="stats-label">${cat.label}</span>` +
        `<span class="stats-count">${n}</span>`;
      statsBars.appendChild(bar);
    });
  }

  // ---- 同步滚动：textarea 滚动时，镜像层跟着滚 ----
  function syncScroll() {
    backdrop.scrollTop = input.scrollTop;
    backdrop.scrollLeft = input.scrollLeft;
  }

  // ---- 事件绑定 ----
  input.addEventListener("input", () => {
    render();
    if (applyingRewrite) return; // 这次 input 来自重写结果写回，不要再排一次重写
    scheduleRewrite(); // 输出模式下，停止输入 800ms 后自动重写
  });
  input.addEventListener("scroll", syncScroll);

  // 鼠标在 textarea 上移动时，反查是否悬停在某个命中词上
  // 用 rAF 合并高频 mousemove，避免每次都触发 getClientRects 引发的 layout 抖动
  let mmRaf = 0;
  let mmX = 0, mmY = 0;
  input.addEventListener("mousemove", (ev) => {
    mmX = ev.clientX;
    mmY = ev.clientY;
    if (mmRaf) return;
    mmRaf = requestAnimationFrame(() => {
      mmRaf = 0;
      const mark = markAtPoint(mmX, mmY);
      if (mark) {
        input.style.cursor = "help";
        if (mark !== lastHoverMark) {
          lastHoverMark = mark;
          const hit = currentHits[Number(mark.dataset.idx)];
          if (hit) showCard(mark, hit.entry);
        }
      } else {
        input.style.cursor = "";
        if (lastHoverMark) {
          lastHoverMark = null;
          hideCard();
        }
      }
    });
  });
  // 鼠标移出编辑区，关卡片
  input.addEventListener("mouseleave", () => {
    lastHoverMark = null;
    hideCard();
  });
  // 触屏/点击：点在命中词上也弹卡片
  input.addEventListener("click", (ev) => {
    const mark = markAtPoint(ev.clientX, ev.clientY);
    if (mark) {
      ev.stopPropagation();
      const hit = currentHits[Number(mark.dataset.idx)];
      if (hit) showCard(mark, hit.entry);
    }
  });

  modeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      modeBtns.forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      currentMode = btn.dataset.mode;
      hideCard();
      render();
      syncRewriteBox(); // 切到/离开输出模式时，决定是否显示 AI 重写区
    });
  });

  // ================================================================
  // 设置区：填 / 存 API key、接口地址、模型（全部 localStorage）
  // ================================================================
  const AI = window.HERTYPE_AI;

  function loadSettingsIntoForm() {
    const cfg = AI.getConfig();
    apiKeyInput.value = cfg.key;
    baseUrlInput.value = cfg.baseUrl;
    modelInput.value = cfg.model;
  }
  loadSettingsIntoForm();

  settingsToggle.addEventListener("click", () => {
    const willShow = settingsPanel.hidden;
    settingsPanel.hidden = !willShow;
    settingsToggle.setAttribute("aria-expanded", String(willShow));
  });

  apiKeyEye.addEventListener("click", () => {
    apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  });

  settingsSave.addEventListener("click", () => {
    AI.saveConfig({
      key: apiKeyInput.value,
      baseUrl: baseUrlInput.value,
      model: modelInput.value,
    });
    settingsStatus.textContent = "已保存 ✓";
    settingsStatus.style.color = "var(--accent)";
    // 保存后若正处于输出模式，立即重写一次
    if (currentMode === "output") triggerRewrite();
    // 让"已保存 ✓"短暂可见后，自动收起设置面板
    setTimeout(() => {
      settingsStatus.textContent = "";
      settingsPanel.hidden = true;
      settingsToggle.setAttribute("aria-expanded", "false");
    }, 600);
  });

  // ================================================================
  // 输出模式：AI 整句重写（停止输入 800ms 防抖，仅输出模式触发）
  // ================================================================
  let rewriteTimer = null;
  let rewriteSeq = 0; // 防止旧请求覆盖新结果的竞态序号
  let applyingRewrite = false; // 程序化写回 textarea 时置真，跳过那一次自动重写

  // 根据当前模式显示 / 隐藏 AI 重写区
  function syncRewriteBox() {
    if (currentMode === "output") {
      rewriteBox.hidden = false;
      triggerRewrite();
    } else {
      rewriteBox.hidden = true;
      if (rewriteTimer) clearTimeout(rewriteTimer);
    }
  }

  // 防抖入口：每次输入排一个 800ms 后的重写
  function scheduleRewrite() {
    if (currentMode !== "output") return;
    if (rewriteTimer) clearTimeout(rewriteTimer);
    rewriteTimer = setTimeout(triggerRewrite, 800);
  }

  // 真正发起重写
  async function triggerRewrite() {
    const text = input.value.trim();
    if (!text) {
      setRewriteState("", "");
      rewriteCopy.hidden = true;
      return;
    }
    if (!AI.hasKey()) {
      setRewriteState("缺少 key — 请点右上角「设置」填入 API key", "warn");
      rewriteCopy.hidden = true;
      return;
    }

    const seq = ++rewriteSeq;
    setRewriteState("正在重写…", "loading");
    rewriteCopy.hidden = true;

    try {
      const out = await AI.rewrite(text);
      if (seq !== rewriteSeq) return; // 已有更新的请求，丢弃这次旧结果
      if (out && out !== input.value) {
        // 把框内原文整体替换为重写结果，原文不留；可继续编辑
        applyingRewrite = true;
        input.value = out;
        input.dispatchEvent(new Event("input", { bubbles: true })); // 触发 render 刷新镜像层/统计
        applyingRewrite = false;
      }
      setRewriteState("已重写", "ok");
      rewriteCopy.hidden = !input.value;
    } catch (err) {
      if (seq !== rewriteSeq) return;
      setRewriteState("失败：" + err.message, "error"); // 错误贴进状态条，不静默吞
      rewriteCopy.hidden = true;
    }
  }

  function setRewriteState(txt, kind) {
    rewriteState.textContent = txt;
    rewriteState.className = "rewrite-state" + (kind ? " is-" + kind : "");
  }

  rewriteCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(input.value);
      rewriteCopy.textContent = "已复制 ✓";
      setTimeout(() => (rewriteCopy.textContent = "复制"), 1500);
    } catch (_) {
      rewriteCopy.textContent = "复制失败";
    }
  });

  // ---- 初始示例：让首屏就有东西可看 ----
  input.value = "他妈的这个绿茶婊真恶心，肯定是陪睡上位的。";
  render();
})();
