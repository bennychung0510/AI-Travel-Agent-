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

    // 僅使用高速 Flash 系列，確保在 Netlify 10 秒限制內完成
    const candidateModels = model
      ? [model, "gemini-3.8-flash", "gemini-3.8-flash-lite"]
      : ["gemini-3.8-flash", "gemini-3.8-flash-lite"];

    const modelsToTry = [...new Set(candidateModels)];
    let lastErrorMessage = "Google API 暫時無法回應";
    let lastStatus = 500;

    for (let i = 0; i < modelsToTry.length; i++) {
      const currentModel = modelsToTry[i];
      const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`;

      // 首次嘗試設為 4.5 秒逾時，留足時間給備援模型；最後一次設為 4.8 秒
      const timeoutMs = i === 0 ? 4500 : 4800;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const googleRes = await fetch(googleUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: prompt }],
              },
            ],
          }),
        });

        clearTimeout(timeoutId);
        const data = await googleRes.json();

        if (googleRes.ok) {
          const replyText =
            data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
          return new Response(
            JSON.stringify({ text: replyText, model: currentModel }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }
          );
        }

        lastStatus = googleRes.status;
        lastErrorMessage = data.error?.message || lastErrorMessage;

        // 若為暫時過載 (503)、請求過於頻繁 (429) 或模型暫不可用 (404)，立即切換下一個模型
        if ([503, 429, 404].includes(googleRes.status) && i < modelsToTry.length - 1) {
          continue;
        }
        break;
      } catch (fetchErr) {
        clearTimeout(timeoutId);
        if (fetchErr.name === "AbortError") {
          lastStatus = 504;
          lastErrorMessage = "Google 模型回應超時，請再按一次重試";
          if (i < modelsToTry.length - 1) continue;
        } else {
          throw fetchErr;
        }
      }
    }

    return new Response(
      JSON.stringify({ error: lastErrorMessage }),
      { status: lastStatus, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
