async function callGemini(model, prompt, apiKey, genConfig, timeoutMs = 8500) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
  };
  if (genConfig) {
    payload.generationConfig = genConfig;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(payload),
    });
    clearTimeout(timer);
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    clearTimeout(timer);
    if (err.name === "AbortError") {
      return {
        ok: false,
        status: 504,
        data: { error: { message: "模型回應逾時，請再按一次重試" } },
      };
    }
    throw err;
  }
}

export default async (req) => {
  const jsonHeaders = { "Content-Type": "application/json; charset=utf-8" };

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: jsonHeaders,
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "伺服器尚未設定 GEMINI_API_KEY 環境變數" }),
      { status: 500, headers: jsonHeaders }
    );
  }

  try {
    const { prompt, model } = await req.json();
    if (!prompt) {
      return new Response(JSON.stringify({ error: "缺少 prompt 內容" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const primaryModel = model || "gemini-3.8-flash";
    const optimizedPrompt = `${prompt}\n\n（請以繁體中文精簡重點條列回覆，控制於 350 字以內以確保快速載入。）`;

    // 1. 優先關閉思考延遲以極速回應
    let result = await callGemini(
      primaryModel,
      optimizedPrompt,
      apiKey,
      { thinkingConfig: { thinkingBudget: 0 }, maxOutputTokens: 1024 },
      8500
    );

    // 2. 若該型號不支援 thinkingBudget 參數 (HTTP 400)，改用標準參數重試
    if (!result.ok && result.status === 400) {
      result = await callGemini(
        primaryModel,
        optimizedPrompt,
        apiKey,
        { maxOutputTokens: 1024 },
        8000
      );
    }

    // 3. 若遇到 503 暫時過載或 429，短暫等待後重試一次
    if (!result.ok && (result.status === 503 || result.status === 429)) {
      await new Promise((r) => setTimeout(r, 600));
      result = await callGemini(
        primaryModel,
        optimizedPrompt,
        apiKey,
        { maxOutputTokens: 1024 },
        7500
      );
    }

    if (result.ok) {
      const replyText =
        result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return new Response(JSON.stringify({ text: replyText }), {
        status: 200,
        headers: jsonHeaders,
      });
    }

    const errMsg =
      result.status === 503
        ? "Google AI 伺服器目前暫時繁忙，請稍候幾秒再按一次。"
        : result.data?.error?.message || "Google API 呼叫失敗";

    return new Response(JSON.stringify({ error: errMsg }), {
      status: result.status,
      headers: jsonHeaders,
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
};
