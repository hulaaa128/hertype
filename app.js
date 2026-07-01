/**
 * HerType 批注引擎
 * ----------------------------------------------------------------
 * 核心技术：textarea 无法内部渲染富文本，采用「镜像层叠」方案——
 * 底层 backdrop（div）与上层 textarea 逐字对齐，命中词在 backdrop 里
 * 用 <mark> 包裹画波浪线；textarea 文字透明、只负责接收输入和光标。
 */

(function () {
  const { CATEGORIES, LEXICON } = window.HERTYPE;

  // 各攻击机制对应的一句话诊断（女性主义视角，点破「攻击通道」而非只报数字）
  const CAT_DIAGNOSIS = {
    maternal:   "把攻击通道指向对方的母亲——预设女性是男性的所有物，这是父权语言的默认设置。",
    sexual:     "拿女性的性经验当武器——用「贞洁」给女性的身体标价，男人从不受这套约束。",
    feminine:   "把「像女人」当成侮辱本身——这句话贬低的不是某个人，是整个女性。",
    rivalry:    "给女性的野心和能动性贴上污名——她有企图心就成了「心机」，男人则叫「有魄力」。",
    appearance: "用外貌给女性的价值定级——同一张评判表，从来不拿去量男性。",
    merit:      "把她的成就归因于身体交易——这是最隐蔽的否定：连她挣来的都不算她的。",
  };

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
  const rewriteRun    = document.getElementById("rewriteRun");
  const rewriteCopy   = document.getElementById("rewriteCopy");
  const mirrorBox     = document.getElementById("mirrorBox");
  const mirrorState   = document.getElementById("mirrorState");
  const mirrorRun     = document.getElementById("mirrorRun");

  let currentMode = "learning"; // learning | output | mirror

  // 单向同步方案：学习模式是唯一「输入源」，只标注不改字。
  // 切到输出/镜像模式时，自动从 sourceText 载入学习模式的当前原文。
  // - 输出模式的 AI 重写结果只写进 outputText（临时、可复制），绝不回写 sourceText；
  // - 镜像模式在 sourceText 上做词库对调 + AI 补充，也不改 sourceText。
  const SAMPLE = "他妈的这个绿茶婊真恶心，肯定是陪睡上位的。";
  let sourceText = SAMPLE; // 学习模式原文，唯一输入源
  let outputText = SAMPLE; // 输出模式当前展示文本（重写前=原文，重写后=AI 结果）

  // 镜像模式的 AI 补充命中（词库没覆盖、AI 找出的性别化表达）。
  // mirrorAiHitsForText 记录这批命中对应的文本，文本一变就作废，防止画错位置。
  let mirrorAiHits = [];
  let mirrorAiHitsForText = null;
  let mirrorSeq = 0;

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
   * 文本归一化：把"拆字加空格、全角、大小写"这类伪装抹平，
   * 同时维护位置映射，保证归一化串上的命中能精确反查回原文区间。
   *
   * 返回 { norm, map }：
   *   norm   归一化后的字符串
   *   map[i] norm 第 i 个字符对应原文中的起始索引（用于反查 start）
   *   另返回 mapEnd[i]：该 norm 字符覆盖到原文的结束索引（用于反查 end）
   *
   * 归一化操作（全部保持「单字符 → 单字符 或 丢弃」，不做多对一变长，避免位置错乱）：
   *   - 丢弃空白字符（半角/全角空格、制表符）——伪装手段「绿 茶 婊」
   *   - 全角 ASCII（！－～ 区）转半角——伪装手段「ＮＭＳＬ」
   *   - 英文统一小写——「TMD / Tmd」归一到「tmd」
   */
  function normalize(text) {
    let norm = "";
    const map = [];
    const mapEnd = [];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      // 丢弃空白（含全角空格 　）
      if (/\s|　/.test(ch)) continue;
      let c = ch;
      const code = ch.charCodeAt(0);
      // 全角 ASCII（！-～）转半角
      if (code >= 0xff01 && code <= 0xff5e) {
        c = String.fromCharCode(code - 0xfee0);
      }
      // 英文小写
      c = c.toLowerCase();
      norm += c;
      map.push(i);
      mapEnd.push(i + 1);
    }
    return { norm, map, mapEnd };
  }

  /**
   * 扫描文本，找出所有命中区间。
   * 返回 [{ start, end, entry }]，区间互不重叠（长词优先、左到右）。
   *
   * 两趟匹配：
   *   第一趟在原文上精确 indexOf —— 零误差，位置百分百准；
   *   第二趟在归一化串上补充匹配 —— 抓住拆字/全角/大小写伪装，
   *   命中位置经 map 反查回原文，跳过已被第一趟占用的字符。
   */
  function scan(text) {
    const hits = [];
    const occupied = new Array(text.length).fill(false);

    const claim = (start, end, entry) => {
      for (let i = start; i < end; i++) {
        if (occupied[i]) return false;
      }
      for (let i = start; i < end; i++) occupied[i] = true;
      hits.push({ start, end, entry });
      return true;
    };

    // —— 第一趟：原文精确匹配（长词优先）——
    for (const trigger of sortedTriggers) {
      let from = 0;
      while (true) {
        const idx = text.indexOf(trigger, from);
        if (idx === -1) break;
        claim(idx, idx + trigger.length, triggerMap.get(trigger));
        from = idx + trigger.length;
      }
    }

    // —— 第二趟：归一化串补充匹配（trigger 也归一化后比对）——
    const { norm, map, mapEnd } = normalize(text);
    for (const trigger of sortedTriggers) {
      const nTrigger = normalize(trigger).norm;
      if (!nTrigger) continue;
      let from = 0;
      while (true) {
        const nIdx = norm.indexOf(nTrigger, from);
        if (nIdx === -1) break;
        // 反查回原文区间：起点取首字符的 map，终点取末字符的 mapEnd
        const start = map[nIdx];
        const end = mapEnd[nIdx + nTrigger.length - 1];
        claim(start, end, triggerMap.get(trigger));
        from = nIdx + nTrigger.length;
      }
    }

    hits.sort((a, b) => a.start - b.start);
    return hits;
  }

  /**
   * 把镜像模式 AI 补出的片段并进本地命中数组。
   * 仅收本地词库没占用的区间（本地优先，AI 只补漏），并按 start 重新排序。
   * mirrorAiHits 里每项是构造好的 { start, end, entry }，entry._ai 标记为 AI 补充。
   */
  function mergeMirrorAiHits(hits, text) {
    const occupied = new Array(text.length).fill(false);
    for (const h of hits) {
      for (let i = h.start; i < h.end; i++) occupied[i] = true;
    }
    for (const ai of mirrorAiHits) {
      if (ai.start < 0 || ai.end > text.length || ai.start >= ai.end) continue;
      let free = true;
      for (let i = ai.start; i < ai.end; i++) {
        if (occupied[i]) { free = false; break; }
      }
      if (!free) continue;
      for (let i = ai.start; i < ai.end; i++) occupied[i] = true;
      hits.push(ai);
    }
    hits.sort((a, b) => a.start - b.start);
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
    // 镜像模式：把 AI 补出的、词库没覆盖的性别化片段并进来一起画
    // （只在文本没变时有效，文本一改这批命中就作废，避免画错位置）
    if (currentMode === "mirror" && mirrorAiHitsForText === text && mirrorAiHits.length) {
      mergeMirrorAiHits(hits, text);
    }
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
        // AI 补充命中：在镜像模式额外加高亮标记，让「点 AI 补充对调后新抓的词」一眼可见
        if (e._ai) extraClass += " hit--ai";
      } else {
        // learning 和 output 都保留原词画波浪线；
        // output 模式的整句改写由下方 AI 结果区完成，不在镜像层逐词替换
        shown = text.slice(hit.start, hit.end);
      }

      const sev = e.severity || 3;
      html +=
        `<mark class="hit hit--${e.category}${extraClass}" ` +
        `data-idx="${i}" ` +
        `data-sev="${sev}" ` +
        `style="--cat-color:${cat.color}; --sev:${sev}">` +
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
      const src = entry._ai ? "（词库未收录，AI 补充识别）" : "";
      if (entry.mirror === "") {
        critBody.textContent = "「" + entry.trigger + "」性别对调后……找不到对应的词。男性几乎没有被这样羞辱的说法——这套词，是专为羞辱女性而造的。" + src;
        critFoot.textContent = cat.label + " · 无男版对应词" + (entry._ai ? " · AI 补充" : "");
      } else {
        critBody.textContent = "性别对调后：「" + entry.trigger + "」→「" + entry.mirror + "」。觉得别扭吗？这份别扭，正是双标的证据。" + src;
        critFoot.textContent = cat.label + (entry._ai ? " · AI 补充" : "");
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

    // 找出主导的攻击机制（命中最多的类别；并列时按 CATEGORIES 声明顺序取先者）
    let topCat = null;
    let topN = 0;
    for (const key of Object.keys(CATEGORIES)) {
      const n = counts[key] || 0;
      if (n > topN) { topN = n; topCat = key; }
    }

    // 一句话诊断：先报总数，再点破主导通道。单一类别时省去「其中最多」的措辞。
    const catKinds = Object.keys(counts).length;
    let diag = `本段共触发 ${hits.length} 处性别化表达`;
    if (topCat && CAT_DIAGNOSIS[topCat]) {
      const label = CATEGORIES[topCat].label;
      if (catKinds === 1) {
        diag += `，全部是「${label}」。` + CAT_DIAGNOSIS[topCat];
      } else {
        diag += `，其中「${label}」最多（${topN} 处）。` + CAT_DIAGNOSIS[topCat];
      }
    } else {
      diag += "。";
    }
    statsTotal.textContent = diag;

    statsBars.innerHTML = "";
    // 分类条按命中数降序，重的排前面
    Object.keys(CATEGORIES)
      .filter((key) => (counts[key] || 0) > 0)
      .sort((a, b) => counts[b] - counts[a])
      .forEach((key) => {
        const n = counts[key];
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
    if (applyingRewrite) return; // 这次 input 来自重写结果写回，不重置状态
    // 用户手动编辑：按当前模式存回对应的文本。
    // 学习模式改的是唯一输入源 sourceText；输出模式改的是临时文本 outputText；
    // 镜像模式基于 sourceText 呈现，用户在镜像框里的手动编辑视作改原文。
    if (currentMode === "output") {
      outputText = input.value;
    } else {
      sourceText = input.value; // learning / mirror 都写回原文
    }
    // 输出模式改为「点按钮才重写」，不再自动触发；内容变了就把状态清一下
    if (currentMode === "output") {
      setRewriteState("", "");
      rewriteCopy.hidden = true;
    }
    // 镜像模式：文本一改，之前那批 AI 补充命中就作废（位置会错），提示重新补充
    if (currentMode === "mirror" && mirrorAiHitsForText !== input.value) {
      setMirrorState("文本已改，点「AI 补充对调」重新识别", "");
    }
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
      // 离开前，把当前框内容存回对应的文本源
      if (currentMode === "output") outputText = input.value;
      else sourceText = input.value;

      modeBtns.forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      currentMode = btn.dataset.mode;

      // 单向同步：输出/镜像模式都以学习模式的原文 sourceText 为准载入。
      // 输出模式载入原文作为「待重写」初值（重写后才变成 AI 结果）；
      // 镜像模式载入原文做词库对调。学习模式本就展示 sourceText。
      if (currentMode === "output") {
        outputText = sourceText;   // 切进来先跟原文对齐，等用户点「重写」
        input.value = outputText;
      } else {
        input.value = sourceText;
      }
      // 换文本了，镜像的 AI 补充命中作废（位置会错）
      mirrorAiHits = [];
      mirrorAiHitsForText = null;

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
    // 让"已保存 ✓"短暂可见后，自动收起设置面板
    setTimeout(() => {
      settingsStatus.textContent = "";
      settingsPanel.hidden = true;
      settingsToggle.setAttribute("aria-expanded", "false");
    }, 600);
  });

  // ================================================================
  // 输出模式：AI 整句重写（点「重写这段」按钮触发，仅输出模式）
  // ================================================================
  let rewriteSeq = 0; // 防止旧请求覆盖新结果的竞态序号
  let applyingRewrite = false; // 程序化写回 textarea 时置真，跳过那一次状态重置

  // 根据当前模式显示 / 隐藏 AI 重写区、镜像补充区（不自动触发，等用户点按钮）
  function syncRewriteBox() {
    if (currentMode === "output") {
      rewriteBox.hidden = false;
      setRewriteState("点「重写这段」，AI 会去掉羞辱、留住情绪", "");
      rewriteCopy.hidden = true;
    } else {
      rewriteBox.hidden = true;
    }

    if (currentMode === "mirror") {
      mirrorBox.hidden = false;
      // 若这批 AI 补充命中已不属于当前文本，提示可重新补充
      if (mirrorAiHitsForText === input.value && mirrorAiHits.length) {
        setMirrorState("已补充 " + mirrorAiHits.length + " 处词库外表达", "ok");
      } else {
        setMirrorState("本地已逐词对调；点「AI 补充对调」抓词库没覆盖的表达", "");
      }
    } else {
      mirrorBox.hidden = true;
    }
  }

  function setMirrorState(txt, kind) {
    mirrorState.textContent = txt;
    mirrorState.className = "rewrite-state" + (kind ? " is-" + kind : "");
  }

  // 镜像模式 AI 补充：点按钮触发，找出词库没覆盖的性别化片段，定位后并入命中重画
  async function triggerMirrorDetect() {
    const text = input.value;
    if (!text.trim()) {
      setMirrorState("框里还没内容", "");
      return;
    }
    if (!AI.hasKey()) {
      setMirrorState("缺少 key — 请点右上角「设置」填入 API key", "warn");
      return;
    }

    const seq = ++mirrorSeq;
    setMirrorState("AI 正在找词库外的表达…", "loading");
    mirrorRun.disabled = true;

    try {
      const list = await AI.mirrorDetect(text);
      if (seq !== mirrorSeq) return; // 有更新的请求，丢弃旧结果
      // 把 AI 返回的片段在原文里定位成 { start, end, entry }
      const built = [];
      const used = new Array(text.length).fill(false);
      for (const it of list) {
        // 同一 fragment 可能出现多次，逐个 indexOf 定位、跳过已占用
        let from = 0;
        while (true) {
          const idx = text.indexOf(it.fragment, from);
          if (idx === -1) break;
          const end = idx + it.fragment.length;
          let free = true;
          for (let i = idx; i < end; i++) { if (used[i]) { free = false; break; } }
          if (free) {
            for (let i = idx; i < end; i++) used[i] = true;
            built.push({
              start: idx,
              end,
              entry: {
                trigger: it.fragment,
                category: it.category,
                mirror: it.mirror,
                explain: it.explain,
                severity: 3,
                _ai: true,
              },
            });
          }
          from = end;
        }
      }
      mirrorAiHits = built;
      mirrorAiHitsForText = text;
      render();
      if (currentMode === "mirror") {
        if (built.length) setMirrorState("已补充 " + built.length + " 处词库外表达", "ok");
        else setMirrorState("AI 没找到词库以外的性别化表达", "ok");
      }
    } catch (err) {
      if (seq !== mirrorSeq) return;
      setMirrorState("失败：" + err.message, "error"); // 原文贴出，不静默吞
    } finally {
      mirrorRun.disabled = false;
    }
  }

  mirrorRun.addEventListener("click", () => {
    if (currentMode === "mirror") triggerMirrorDetect();
  });

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
    rewriteRun.disabled = true;

    // 流式回调：AI 每吐一块就把「累计全文」实时写回框里，像打字机一样。
    // onDelta 收到的是「到目前为止的完整字符串」（见 ai.js readStream），直接整体替换即可。
    const onDelta = (partial) => {
      if (seq !== rewriteSeq) return; // 已有更新的请求，丢弃这次旧结果的吐字
      outputText = partial; // 边生成边写进输出模式的临时文本，不碰 sourceText
      if (currentMode === "output" && partial !== input.value) {
        applyingRewrite = true;
        input.value = partial;
        input.dispatchEvent(new Event("input", { bubbles: true })); // 触发 render 刷新镜像层/统计
        applyingRewrite = false;
      }
      setRewriteState("正在重写…", "loading");
    };

    try {
      const out = await AI.rewrite(text, onDelta);
      if (seq !== rewriteSeq) return; // 已有更新的请求，丢弃这次旧结果
      if (out) {
        outputText = out; // 以最终完整结果为准（兜底：流式未触发时这里补齐），只归输出模式
        // 仅当用户此刻仍停留在输出模式时，才把结果写回可见的框（途中切走则只更新数据）
        if (currentMode === "output" && out !== input.value) {
          applyingRewrite = true;
          input.value = out;
          input.dispatchEvent(new Event("input", { bubbles: true })); // 触发 render 刷新镜像层/统计
          applyingRewrite = false;
        }
      }
      setRewriteState("已重写", "ok");
      rewriteCopy.hidden = !outputText;
    } catch (err) {
      if (seq !== rewriteSeq) return;
      setRewriteState("失败：" + err.message, "error"); // 错误贴进状态条，不静默吞
      rewriteCopy.hidden = true;
    } finally {
      rewriteRun.disabled = false;
    }
  }

  function setRewriteState(txt, kind) {
    rewriteState.textContent = txt;
    rewriteState.className = "rewrite-state" + (kind ? " is-" + kind : "");
  }

  rewriteRun.addEventListener("click", () => {
    if (currentMode === "output") triggerRewrite();
  });

  rewriteCopy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(outputText);
      rewriteCopy.textContent = "已复制 ✓";
      setTimeout(() => (rewriteCopy.textContent = "复制"), 1500);
    } catch (_) {
      rewriteCopy.textContent = "复制失败";
    }
  });

  // ---- 初始示例：首屏即学习模式，载入原文 ----
  input.value = sourceText;
  render();
  syncRewriteBox(); // 首屏学习模式：隐藏重写区 / 镜像补充区
})();
