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
   * 成功 resolve 改写后的字符串；任何失败都 reject(Error)，错误信息原文带出，绝不静默吞。
   */
  async function rewrite(text) {
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
    return out.trim();
  }

  window.HERTYPE_AI = { getConfig, saveConfig, hasKey, rewrite, DEFAULT_BASE, DEFAULT_MODEL };
})();
