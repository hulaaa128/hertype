/**
 * HerType · AI 整句重写模块
 * ----------------------------------------------------------------
 * 纯前端、零后端：key / 接口地址 / 模型全部存浏览器 localStorage，
 * 不写死在代码、不上传任何服务器。调用 OpenAI 兼容的 /chat/completions。
 *
 * 暴露 window.HERTYPE_AI = { getConfig, saveConfig, hasKey, rewrite }
 */

(function () {
  // localStorage 存储键
  const LS_KEY = "hertype.apiKey";
  const LS_BASE = "hertype.baseUrl";
  const LS_MODEL = "hertype.model";

  // 中转地址：默认走站长部署的服务器中转(key 藏在服务器端,访客无需填写)。
  // 用户若在「设置」里填了自己的接口地址+key,则用用户自己的,不走中转。
  const PROXY_BASE = "https://hulaai.online/hertype-ai";
  const DEFAULT_BASE = PROXY_BASE;
  const DEFAULT_MODEL = "glm-4-flash";

  // 输出模式 prompt：核心目标不是「消毒脏话」，而是「去掉语言里非必要的性别标注与性别预设」，
  // 让句子回到就事论事——既不制造对立，也不啰嗦地给中性事物贴性别。
  const SYSTEM_PROMPT =
    "你是一个女性主义语言助手。用户会给你一句中文，请把它改写得更平等、更就事论事。\n" +
    "核心原则：去掉一切「非必要的性别标注和性别预设」。\n" +
    "常见情况与处理方式：\n" +
    "1. 给中性职业/身份多加了「女」字（如「女程序员好酷」「女司机」「女博士」）：" +
    "去掉多余的性别标注，夸能力就只夸能力（→「程序员好酷」）；\n" +
    "2. 针对女性的羞辱、规训、刻板印象（如荡妇羞辱、母职羞辱、外貌规训、" +
    "「女生就该顾家」）：去掉羞辱和规训，若原句带愤怒或不满，把火力对准具体的人或事、" +
    "而不是其性别，并保留原本的情绪强度，不要变得温吞客气；\n" +
    "3. 把女性成就归因于身体或性交易的说法：去掉这种揣测，回到就事论事。\n" +
    "通用要求：\n" +
    "- 改写后通顺自然、可以直接发出去；\n" +
    "- 不要制造新的对立，不要说教；\n" +
    "- 如果原句本来就已经平等、没有可改之处，原样返回即可；\n" +
    "- 只输出改写后的那一句话本身，不要加引号、不要解释、不要换行。";

  function getConfig() {
    return {
      key: localStorage.getItem(LS_KEY) || "",
      baseUrl: localStorage.getItem(LS_BASE) || DEFAULT_BASE,
      model: localStorage.getItem(LS_MODEL) || DEFAULT_MODEL,
    };
  }

  function saveConfig({ key, baseUrl, model }) {
    if (key != null) localStorage.setItem(LS_KEY, key.trim());
    localStorage.setItem(LS_BASE, (baseUrl || DEFAULT_BASE).trim());
    localStorage.setItem(LS_MODEL, (model || DEFAULT_MODEL).trim());
  }

  function hasKey() {
    // 填了自己的 key 当然可用;没填 key 但走中转(PROXY_BASE)时也算可用——
    // 中转在服务器端注入 key,访客无需填写。
    if (localStorage.getItem(LS_KEY)) return true;
    const base = (localStorage.getItem(LS_BASE) || DEFAULT_BASE).replace(/\/+$/, "");
    return base === PROXY_BASE;
  }

  // 默认公共中转是访客免填 key 的兜底；它不可达时，要明确告诉用户可切到自有接口。
  function isUsingProxy(baseUrl) {
    return (baseUrl || DEFAULT_BASE).replace(/\/+$/, "") === PROXY_BASE;
  }

  function buildSendError(e, baseUrl) {
    const rawMessage = e && e.message ? e.message : String(e);
    if (isUsingProxy(baseUrl)) {
      return new Error(
        "公共中转暂时不可用:" + rawMessage +
        "。请点右上角「设置」填写自己的 OpenAI 兼容接口地址、API Key 和模型后重试。"
      );
    }
    return new Error("请求发送失败:" + rawMessage + "(可能是接口地址不通或跨域,请检查设置)");
  }

  // 带超时 + 重试的 fetch 包装:免费模型偶发慢/抖动导致 Failed to fetch,
  // 加一层超时控制(默认 30s)和失败自动重试(默认再试 1 次),显著降低偶发失败。
  async function fetchWithRetry(url, opts, timeoutMs = 30000, retries = 1) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(url, { ...opts, signal: ctrl.signal });
        clearTimeout(timer);
        return resp;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        // 最后一次失败就抛出;否则稍等 800ms 再重试
        if (attempt < retries) await new Promise((r) => setTimeout(r, 800));
      }
    }
    throw lastErr;
  }

  /**
   * 调用接口，把整句话重写。
   * 优先走流式（stream:true）：边生成边通过 onDelta(chunk) 回调吐字，
   * 体感更快、能看到进度；结束后 resolve 完整字符串。
   * 若网关不支持流式（返回的不是 text/event-stream，或解析不出增量），
   * 自动降级为一次性读取，保证仍能出结果。
   * 任何失败都 reject(Error)，错误信息原文带出，绝不静默吞。
   *
   * @param {string} text 待重写文本
   * @param {(chunk:string)=>void} [onDelta] 每来一块增量文本就回调一次（可选）
   */
  async function rewrite(text, onDelta) {
    const { key, baseUrl, model } = getConfig();
    // 走中转(PROXY_BASE)时无需 key;只有用户自定义了接口地址却没填 key 才报错。
    const viaProxy = baseUrl.replace(/\/+$/, "") === PROXY_BASE;
    if (!viaProxy && !key) throw new Error("尚未填写 API key,请到右上角「设置」里填入。");
    if (!text.trim()) return "";

    // 去掉 baseUrl 结尾多余的斜杠,再拼路径
    const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

    // 是否请求流式：只有上层传了 onDelta 回调才走流式（要吐字）。
    // 没传回调（如一键 AI 场景）就请求非流式，网关直接返完整 JSON，避免把 SSE 文本当 JSON 解析。
    const wantStream = typeof onDelta === "function";

    let resp;
    try {
      resp = await fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // key 为空(走中转)时不发 Authorization,由中转在服务器端注入。
          ...(key ? { Authorization: "Bearer " + key } : {}),
        },
        body: JSON.stringify({
          model: model,
          stream: wantStream,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: text },
          ],
          // 注意：部分新模型（gpt-5.x 等）只接受默认 temperature=1，
          // 显式传 0.7 会报 400 unsupported_value，故不再传该参数。
        }),
      });
    } catch (e) {
      // 网络层失败(超时/跨域/DNS)——把原始信息带出
      throw buildSendError(e, baseUrl);
    }

    if (!resp.ok) {
      let detail = "";
      try {
        detail = await resp.text();
      } catch (_) {}
      throw new Error("接口返回 " + resp.status + " " + resp.statusText + "\n" + detail.slice(0, 500));
    }

    const ctype = (resp.headers.get("content-type") || "").toLowerCase();
    const canStream = ctype.includes("text/event-stream") && resp.body && typeof onDelta === "function";

    // —— 流式路径：逐块读 SSE，解析 data: 行里的 delta.content ——
    if (canStream) {
      try {
        return await readStream(resp, onDelta);
      } catch (e) {
        // 流读到一半炸了：不静默吞，直接抛给上层（此时可能已吐了部分字）
        throw new Error("流式读取中断:" + e.message);
      }
    }

    // —— 降级路径：网关没给流,一次性解析完整 JSON ——
    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error("返回内容无法解析为 JSON:" + e.message);
    }

    const out = data?.choices?.[0]?.message?.content;
    if (!out) {
      throw new Error("返回里没有找到改写结果,原始返回:" + JSON.stringify(data).slice(0, 500));
    }
    const trimmed = out.trim();
    if (typeof onDelta === "function") onDelta(trimmed); // 降级时也回调一次，让 UI 统一走同一条路
    return trimmed;
  }

  /**
   * 读取 OpenAI 兼容的 SSE 流。逐行解析 `data: {...}`，
   * 抽取 choices[0].delta.content 累加，并通过 onDelta 实时回调增量。
   * 遇到 `data: [DONE]` 结束。返回累加后的完整字符串。
   */
  async function readStream(resp, onDelta) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";  // 跨 chunk 的残行缓冲（一个 SSE 事件可能被切成两半）
    let full = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // 按行切；最后一段可能不完整，留在 buffer 里等下一块
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (let line of lines) {
        line = line.trim();
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let obj;
        try {
          obj = JSON.parse(payload);
        } catch (_) {
          continue; // 半行/心跳等杂音，跳过
        }
        const delta = obj?.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onDelta(full.trim()); // 回调累计到目前为止的全文，UI 直接整体替换即可
        }
      }
    }

    if (!full.trim()) throw new Error("流式返回里没有任何内容");
    return full.trim();
  }

  // 镜像模式 prompt：找出词库没覆盖的性别化表达，给出各自的「男版对应词」供逐词高亮替换
  const MIRROR_PROMPT =
    "你是一个女性主义语言实验助手。用户会给你一段中文文本，请找出其中所有带性别预设的表达，" +
    "并为每一处给出「性别对调」后指向男性的对应说法。\n" +
    "不要只盯着羞辱词——重点也要抓那些「听起来中性、甚至像称赞」但仍暴露性别不对称的说法。\n" +
    "特别注意这一类阳性默认（default_male）：给职业/身份/角色特意加「女」字前缀" +
    "（如女程序员、女司机、女博士、女强人、女老板、女司机、女作家、女科学家），" +
    "这类说法预设了该角色默认是男性、女性需要被特别标注。凡遇到必须命中，" +
    "mirror 给出去掉「女」字后的中性说法（如「女程序员」→「程序员」），" +
    "explain 点破「为什么这个身份要专门分男女、男性从不用加『男』字」。\n" +
    "分类只能从以下十类里选：maternal（母职/亲属羞辱）、sexual（性经验羞辱）、" +
    "feminine（女性气质贬低）、rivalry（女性竞争污名）、appearance（外貌规训）、" +
    "merit（能力性化否定）、prescriptive（性别角色规训，如「女生就该顾家」）、" +
    "derogation（语义贬降）、dehumanize（非人化物化）、default_male（阳性默认/称谓降格，含上面说的「女」前缀）。\n" +
    "要求：\n" +
    "1. 只返回一个 JSON 数组，不要任何额外文字、不要 markdown 代码块；\n" +
    "2. 数组每项格式：{\"fragment\":\"命中的原文片段（必须逐字出现在原文里）\",\"category\":\"十类之一\",\"mirror\":\"性别对调后的男版/中性说法；若这套羞辱根本没有男性对应词，mirror 填空字符串\",\"explain\":\"一句话点破双标或性别预设\"}；\n" +
    "3. fragment 必须是原文里真实存在的连续子串，不要改写、不要加引号；\n" +
    "4. 如果没有发现任何此类表达，返回空数组 []。";

  /**
   * 镜像模式 AI 补充：返回 [{ fragment, category, mirror, explain }]，
   * 供前端在原文上逐词高亮替换（与本地词库命中合并）。失败一律 reject(Error)。
   */
  async function mirrorDetect(text) {
    const { key, baseUrl, model } = getConfig();
    // 走中转(PROXY_BASE)时无需 key;只有用户自定义了接口地址却没填 key 才报错。
    const viaProxy = baseUrl.replace(/\/+$/, "") === PROXY_BASE;
    if (!viaProxy && !key) throw new Error("尚未填写 API key,请到右上角「设置」里填入。");
    if (!text.trim()) return [];

    const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

    let resp;
    try {
      resp = await fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // key 为空(走中转)时不发 Authorization,由中转在服务器端注入。
          ...(key ? { Authorization: "Bearer " + key } : {}),
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: MIRROR_PROMPT },
            { role: "user", content: text },
          ],
        }),
      });
    } catch (e) {
      throw buildSendError(e, baseUrl);
    }

    if (!resp.ok) {
      let detail = "";
      try { detail = await resp.text(); } catch (_) {}
      throw new Error("接口返回 " + resp.status + " " + resp.statusText + "\n" + detail.slice(0, 500));
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error("返回内容无法解析为 JSON:" + e.message);
    }

    let out = data?.choices?.[0]?.message?.content;
    if (!out) throw new Error("返回里没有内容,原始返回:" + JSON.stringify(data).slice(0, 500));

    // 容错：模型可能裹了 ```json 代码块，剥掉再解析
    out = out.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    let arr;
    try {
      arr = JSON.parse(out);
    } catch (e) {
      throw new Error("AI 返回不是合法 JSON:" + out.slice(0, 300));
    }
    if (!Array.isArray(arr)) return [];
    const VALID_CATS = [
      "maternal", "sexual", "feminine", "rivalry", "appearance", "merit",
      "prescriptive", "derogation", "dehumanize", "default_male",
    ];
    return arr
      .filter((it) => it && typeof it.fragment === "string" && it.fragment && VALID_CATS.includes(it.category))
      .map((it) => ({
        fragment: it.fragment,
        category: it.category,
        mirror: typeof it.mirror === "string" ? it.mirror : "",
        explain: typeof it.explain === "string" ? it.explain : "",
      }));
  }

  // ================================================================
  // 机制识别（analyze）：按《Wordslut》7 类机制做整句语义识别。
  // 不同于 mirrorDetect（找词+对调），这里的目标是抓「听着正常、实则规训」
  // 的隐形表达——如「女生就该当贤妻良母」「女孩子读那么多书干嘛」，
  // 这类没有固定「词」，词库匹配不到，只能靠 AI 理解整句。
  // ================================================================
  const ANALYZE_PROMPT =
    "你是一个女性主义语言分析助手，理论框架来自 Amanda Montell 的《Wordslut》。" +
    "用户会给你一段中文文本，请找出其中所有再生产性别不平等的表达。" +
    "不要只盯着脏话或侮辱词——重点也要抓「听起来很正常、甚至像善意」但实际在规训、" +
    "物化或矮化女性的句子（例如「女生就该当贤妻良母」「你一个女孩子家家的」" +
    "「女孩读那么多书没用」「女人开车就是不行」）。\n" +
    "按以下机制判断，category 只能从这十类里选：\n" +
    "- maternal：母职/亲属羞辱（用侵犯对方母亲来攻击）\n" +
    "- sexual：性经验羞辱（拿女性性行为数量定罪，如荡妇/绿茶婊/陪睡上位）\n" +
    "- feminine：女性气质贬低（把「像女人」当侮辱，如娘炮/娘娘腔）\n" +
    "- rivalry：女性竞争污名（给女性野心/能动性贴负面标签，如心机/母老虎）\n" +
    "- appearance：外貌规训（用外貌给女性价值定级）\n" +
    "- merit：能力性化否定（把女性成就归因于身体/性交易）\n" +
    "- prescriptive：性别角色规训（规定女性「就该」如何，如贤妻良母/该做饭/相夫教子/女孩要文静）\n" +
    "- derogation：语义贬降（同一称呼指向女性时才染贬义）\n" +
    "- dehumanize：非人化物化（把女性喻为动物或食物，如母牛/鲜肉/尤物/猎物）\n" +
    "- default_male：阳性默认或称谓降格（默认某角色是男性、需加「女」前缀才成立；或用甜心/小姑娘等降格称呼）\n" +
    "判定核心信号：同一行为若男女用词不对称、或把女性成就归因于身体、" +
    "或性别对调后语义变荒谬，即为命中。\n" +
    "归类按真实攻击点、别看字面：妲己/绿茶/狐狸精/学术妲己=暗示靠色相或性上位，归 sexual 或 merit（换取成就用 merit），别归 feminine；" +
    "feminine 只用于「把『像女人/娘』当侮辱」（娘炮/娘娘腔）；心机/母老虎/女强人=rivalry。\n" +
    "要求：\n" +
    "1. 只返回一个 JSON 数组，不要任何额外文字、不要 markdown 代码块；\n" +
    "2. 数组每项格式：{\"fragment\":\"命中的原文片段（必须逐字出现在原文里）\",\"category\":\"十类之一\",\"severity\":1到5的整数,\"explain\":\"一句话点破它如何再生产性别不平等；若是规训型这类善意包装，语气要冷静点破而非攻击\"}；\n" +
    "3. fragment 必须是原文里真实存在的连续子串，不要改写、不要加引号；\n" +
    "4. 规训型（prescriptive）这类隐蔽表达 severity 一般给 2-3，露骨侮辱给 4-5；\n" +
    "5. 如果没有发现任何此类表达，返回空数组 []。";

  const ANALYZE_CATS = [
    "maternal", "sexual", "feminine", "rivalry", "appearance", "merit",
    "prescriptive", "derogation", "dehumanize", "default_male",
  ];

  /**
   * 机制识别：返回 [{ fragment, category, severity, explain }]，
   * 供学习模式在原文上高亮（与本地词库命中合并）。失败一律 reject(Error)。
   */
  async function analyze(text) {
    const { key, baseUrl, model } = getConfig();
    // 走中转(PROXY_BASE)时无需 key;只有用户自定义了接口地址却没填 key 才报错。
    const viaProxy = baseUrl.replace(/\/+$/, "") === PROXY_BASE;
    if (!viaProxy && !key) throw new Error("尚未填写 API key,请到右上角「设置」里填入。");
    if (!text.trim()) return [];

    const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

    let resp;
    try {
      resp = await fetchWithRetry(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // key 为空(走中转)时不发 Authorization,由中转在服务器端注入。
          ...(key ? { Authorization: "Bearer " + key } : {}),
        },
        body: JSON.stringify({
          model: model,
          messages: [
            { role: "system", content: ANALYZE_PROMPT },
            { role: "user", content: text },
          ],
        }),
      });
    } catch (e) {
      throw buildSendError(e, baseUrl);
    }

    if (!resp.ok) {
      let detail = "";
      try { detail = await resp.text(); } catch (_) {}
      throw new Error("接口返回 " + resp.status + " " + resp.statusText + "\n" + detail.slice(0, 500));
    }

    let data;
    try {
      data = await resp.json();
    } catch (e) {
      throw new Error("返回内容无法解析为 JSON:" + e.message);
    }

    let out = data?.choices?.[0]?.message?.content;
    if (!out) throw new Error("返回里没有内容,原始返回:" + JSON.stringify(data).slice(0, 500));

    // 容错：模型可能裹了 ```json 代码块，剥掉再解析
    out = out.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
    let arr;
    try {
      arr = JSON.parse(out);
    } catch (e) {
      throw new Error("AI 返回不是合法 JSON:" + out.slice(0, 300));
    }
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((it) => it && typeof it.fragment === "string" && it.fragment && ANALYZE_CATS.includes(it.category))
      .map((it) => {
        let sev = parseInt(it.severity, 10);
        if (!(sev >= 1 && sev <= 5)) sev = 3;
        return {
          fragment: it.fragment,
          category: it.category,
          severity: sev,
          explain: typeof it.explain === "string" ? it.explain : "",
        };
      });
  }

  window.HERTYPE_AI = { getConfig, saveConfig, hasKey, rewrite, mirrorDetect, analyze, DEFAULT_BASE, DEFAULT_MODEL };
})();
