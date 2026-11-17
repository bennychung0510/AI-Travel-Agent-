const encoder = new TextEncoder();

async function callGeminiOnce(model, prompt, apiKey, useNoThinking = true) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
  };
  if (useNoThinking) {
    body.generationConfig = {
      thinkingConfig: { thinkingBudget: 0 },
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { ok: res.ok, status: res.status, data };
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
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "伺服器尚未設定 GEMINI_API_KEY 環境變數" }),
      { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  let bodyData;
  try {
    bodyData = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "請求格式錯誤" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const { prompt, model } = bodyData;
  if (!prompt) {
    return new Response(JSON.stringify({ error: "缺少 prompt 內容" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const primaryModel = model || "gemini-3.8-flash";

  // 使用 ReadableStream 啟用 Netlify 串流模式，徹底突破 10 秒同步超時限制
  const stream = new ReadableStream({
    async start(controller) {
      // 每 2 秒送出一個空白字元保活（JSON.parse 會自動忽略前導空白）
      const keepAlive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(" "));
        } catch {}
      }, 2000);

      try {
        // 1. 關閉多餘思考延遲以極速回應
        let result = await callGeminiOnce(primaryModel, prompt, apiKey, true);

        // 2. 若該模型不支援 thinkingConfig 參數，自動改用預設參數重試
        if (!result.ok && result.status === 400) {
          const msg = (result.data?.error?.message || "").toLowerCase();
          if (msg.includes("thinking") || msg.includes("unknown name")) {
            result = await callGeminiOnce(primaryModel, prompt, apiKey, false);
          }
        }

        // 3. 若遇到 503 暫時過載或 429，等待 1 秒後重試
        if (!result.ok && (result.status === 503 || result.status === 429)) {
          await new Promise((r) => setTimeout(r, 1000));
          result = await callGeminiOnce(primaryModel, prompt, apiKey, true);
        }

        // 4. 若型號回傳 404，自動查詢帳號支援的可用 Flash 模型
        if (!result.ok && result.status === 404) {
          const fallback = await findFallbackFlashModel(apiKey, primaryModel);
          if (fallback) {
            result = await callGeminiOnce(fallback, prompt, apiKey, false);
          }
        }

        clearInterval(keepAlive);

        if (result.ok) {
          const replyText =
            result.data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
          controller.enqueue(encoder.encode(JSON.stringify({ text: replyText })));
        } else {
          const errMsg =
            result.status === 503
              ? "Google AI 伺服器目前暫時繁忙，請稍候幾秒再按一次。"
              : result.data?.error?.message || "Google API 呼叫失敗";
          controller.enqueue(
            encoder.encode(JSON.stringify({ text: `⚠️ ${errMsg}` }))
          );
        }
      } catch (err) {
        clearInterval(keepAlive);
        controller.enqueue(
          encoder.encode(JSON.stringify({ text: `⚠️ 發生錯誤：${err.message}` }))
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
};
