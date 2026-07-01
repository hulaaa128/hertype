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

  // 默认值（陛下提供的京东云中转）
  const DEFAULT_BASE = "http://ai-api.jdcloud.com/v1";
  const DEFAULT_MODEL = "gpt-5.5";

  // 保留怒气版 prompt：去掉羞辱、留住情绪、输出可直接发的话
  const SYSTEM_PROMPT =
    "你是一个女性主义语言助手。用户会给你一句带情绪的话，里面可能包含针对女性的羞辱" +
    "（母职羞辱、性经验羞辱、外貌规训、女性气质贬低、女性竞争污名、把成就归因于性交易等）。" +
    "请把它改写成一句话，要求：\n" +
    "1. 保留原本的愤怒、不满或强烈情绪，不要变得温吞客气；\n" +
    "2. 去掉所有针对女性的羞辱性表达，攻击对准具体的人或事，而不是其性别；\n" +
    "3. 通顺自然、可以直接发出去；\n" +
    "4. 只输出改写后的那一句话本身，不要加引号、不要解释、不要换行。";

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
    return !!localStorage.getItem(LS_KEY);
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
    if (!key) throw new Error("尚未填写 API key,请到右上角「设置」里填入。");
    if (!text.trim()) return "";

    // 去掉 baseUrl 结尾多余的斜杠,再拼路径
    const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
        },
        body: JSON.stringify({
          model: model,
          stream: true, // 请求流式；网关不认时会照常返完整 JSON，下方据 content-type 判断
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
      throw new Error("请求发送失败:" + e.message + "(可能是接口地址不通或跨域,请检查设置)");
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
    "你是一个女性主义语言实验助手。用户会给你一段中文文本，请找出其中所有针对女性的羞辱、" +
    "规训、刻板印象或外貌/性经验/母职评判的表达（包括谐音、变形、隐晦说法），" +
    "并为每一处给出「性别对调」后指向男性的对应说法。\n" +
    "分类只能从以下六类里选：maternal（母职/亲属羞辱）、sexual（性经验羞辱）、" +
    "feminine（女性气质贬低）、rivalry（女性竞争污名）、appearance（外貌规训）、" +
    "merit（能力性化否定）。\n" +
    "要求：\n" +
    "1. 只返回一个 JSON 数组，不要任何额外文字、不要 markdown 代码块；\n" +
    "2. 数组每项格式：{\"fragment\":\"命中的原文片段（必须逐字出现在原文里）\",\"category\":\"六类之一\",\"mirror\":\"性别对调后的男版说法；若这套羞辱根本没有男性对应词，mirror 填空字符串\",\"explain\":\"一句话点破双标\"}；\n" +
    "3. fragment 必须是原文里真实存在的连续子串，不要改写、不要加引号；\n" +
    "4. 如果没有发现任何此类表达，返回空数组 []。";

  /**
   * 镜像模式 AI 补充：返回 [{ fragment, category, mirror, explain }]，
   * 供前端在原文上逐词高亮替换（与本地词库命中合并）。失败一律 reject(Error)。
   */
  async function mirrorDetect(text) {
    const { key, baseUrl, model } = getConfig();
    if (!key) throw new Error("尚未填写 API key,请到右上角「设置」里填入。");
    if (!text.trim()) return [];

    const url = baseUrl.replace(/\/+$/, "") + "/chat/completions";

    let resp;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + key,
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
      throw new Error("请求发送失败:" + e.message + "(可能是接口地址不通或跨域,请检查设置)");
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
    const VALID_CATS = ["maternal", "sexual", "feminine", "rivalry", "appearance", "merit"];
    return arr
      .filter((it) => it && typeof it.fragment === "string" && it.fragment && VALID_CATS.includes(it.category))
      .map((it) => ({
        fragment: it.fragment,
        category: it.category,
        mirror: typeof it.mirror === "string" ? it.mirror : "",
        explain: typeof it.explain === "string" ? it.explain : "",
      }));
  }

  window.HERTYPE_AI = { getConfig, saveConfig, hasKey, rewrite, mirrorDetect, DEFAULT_BASE, DEFAULT_MODEL };
})();
