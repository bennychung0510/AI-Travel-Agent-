const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callGenerateContent(model, prompt, apiKey, timeoutMs) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
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

async function findFallbackFlashModel(apiKey, excludeModel) {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
    );
    if (!res.ok) return null;
    const data = await res.json();
    const models = data.models || [];
    const alt = models.find(
      (m) =>
        m.name &&
        !m.name.endsWith(`/${excludeModel}`) &&
        m.name.toLowerCase().includes("flash") &&
        Array.isArray(m.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent")
    );
    return alt ? alt.name.replace(/^models\//, "") : null;
  } catch {
    return null;
  }
}

export default async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "伺服器尚未設定 GEMINI_API_KEY 環境變數" }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const { prompt, model } = await req.json();
    if (!prompt) {
      return new Response(JSON.stringify({ error: "缺少 prompt 內容" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const primaryModel = model || "gemini-3.8-flash";

    // 1. 呼叫已驗證可用的 gemini-3.8-flash（給予 7.5 秒充足時間生成完整行程建議）
    let result = await callGenerateContent(primaryModel, prompt, apiKey, 7500);

    // 2. 若遇到 503 暫時過載或 429，短暫等待 500ms 後重試同模型
    if (!result.ok && (result.status === 503 || result.status === 429)) {
      await sleep(500);
      result = await callGenerateContent(primaryModel, prompt, apiKey, 2000);
    }

    // 3. 若型號回傳 404，自動向 Google ListModels 取得帳號支援的可用 Flash 模型
    if (!result.ok && result.status === 404) {
      const fallbackModel = await findFallbackFlashModel(apiKey, primaryModel);
      if (fallbackModel) {
        result = await callGenerateContent(fallbackModel, prompt, apiKey, 7500);
      }
    }

    if (result.ok) {
      const replyText =
        result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      return new Response(JSON.stringify({ text: replyText }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const errMsg =
      result.status === 503
        ? "Google AI 伺服器目前暫時繁忙，請稍候幾秒再按一次。"
        : result.data?.error?.message || "Google API 呼叫失敗";

    return new Response(JSON.stringify({ error: errMsg }), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
