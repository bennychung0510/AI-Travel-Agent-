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

    // 預設使用 Google 官方最新主力模型 gemini-3.8-flash
    const selectedModel = model || "gemini-3.8-flash";
    const googleUrl = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:generateContent?key=${apiKey}`;

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

    if (!googleRes.ok) {
      return new Response(
        JSON.stringify({
          error: data.error?.message || "Google API 呼叫失敗",
        }),
        { status: googleRes.status, headers: { "Content-Type": "application/json" } }
      );
    }

    const replyText =
      data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

    return new Response(JSON.stringify({ text: replyText, model: selectedModel }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
