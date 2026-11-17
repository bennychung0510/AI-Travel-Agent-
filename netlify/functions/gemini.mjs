const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    // 主模型優先，若遇到 503 伺服器過載或 429 額度限制，自動切換至備援模型
    const candidateModels = model
      ? [model, "gemini-3.8-flash", "gemini-3.8-flash-lite", "gemini-3.8-pro"]
      : ["gemini-3.8-flash", "gemini-3.8-flash-lite", "gemini-3.8-pro"];

    // 去除重複模型名稱
    const modelsToTry = [...new Set(candidateModels)];
    let lastErrorMessage = "Google API 暫時無法回應";
    let lastStatus = 500;

    for (let i = 0; i < modelsToTry.length; i++) {
      const currentModel = modelsToTry[i];
      const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${currentModel}:generateContent?key=${apiKey}`;

      const googleRes = await fetch(googleUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
        }),
      });

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

      // 若為暫時過載 (503)、請求過於頻繁 (429) 或模型暫不可用 (404)，等待 1 秒後自動嘗試下一個備援模型
      if ([503, 429, 404].includes(googleRes.status) && i < modelsToTry.length - 1) {
        await sleep(1000);
        continue;
      }

      break;
    }

    return new Response(
      JSON.stringify({
        error:
          lastStatus === 503
            ? "Google AI 伺服器目前極度繁忙，已自動重試但仍過載，請稍候 10 秒再試一次。"
            : lastErrorMessage,
      }),
      { status: lastStatus, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
