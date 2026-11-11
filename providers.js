// One interface for several AI providers. The API key is read from the environment on the server only.
const PRESETS = {
  groq: { base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", keyVar: "GROQ_API_KEY", style: "openai" },
  openai: { base: "https://api.openai.com/v1", model: "gpt-4o-mini", keyVar: "OPENAI_API_KEY", style: "openai" },
  gemini: { base: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-2.0-flash", keyVar: "GEMINI_API_KEY", style: "openai" },
  "openai-compatible": { base: "", model: "", keyVar: "AI_API_KEY", style: "openai" },
  anthropic: { base: "https://api.anthropic.com/v1", model: "claude-haiku-5-5", keyVar: "ANTHROPIC_API_KEY", style: "anthropic" },
  ollama: { base: "http://127.0.0.1:11434", model: "qwen3:4b", keyVar: null, style: "ollama" }
};

export class ModelError extends Error {
  constructor(userMessage, status = 503, detail = "") { super(userMessage); this.userMessage = userMessage; this.status = status; this.detail = detail; }
}

// Providers require alternating roles that start with "user".
export function normalize(messages) {
  const out = [];
  for (const m of messages) {
    if (!out.length && m.role !== "user") continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += "\n\n" + m.content; else out.push({ role: m.role, content: m.content });
  }
  return out;
}

export function makeModel(env = process.env, fetchFn = fetch) {
  const name = (env.AI_PROVIDER || "ollama").toLowerCase();
  const p = PRESETS[name];
  if (!p) return { name, model: "", ok: false, error: `AI_PROVIDER غير مدعوم: ${name} (المتاح: ${Object.keys(PRESETS).join(", ")})`, call: async () => { throw new ModelError("إعداد الذكاء الاصطناعي غير صحيح", 503); } };
  const key = env.AI_API_KEY || (p.keyVar ? env[p.keyVar] : "") || "";
  const base = (env.AI_BASE_URL || (name === "ollama" ? env.OLLAMA_URL : "") || p.base).replace(/\/$/, "");
  const model = env.AI_MODEL || (name === "ollama" ? env.OLLAMA_MODEL : "") || p.model;
  let error = null;
  if (p.keyVar && !key) error = `مفتاح الـ API غير مضبوط. ضعه في ملف chatbot/.env باسم ${p.keyVar}=...`;
  else if (!base || !model) error = "حدد AI_BASE_URL و AI_MODEL في ملف .env";

  async function call(system, messages) {
    if (error) throw new ModelError(error, 503);
    const msgs = normalize(messages);
    const signal = AbortSignal.timeout(name === "ollama" ? 300000 : 60000);
    let res;
    try {
      if (p.style === "anthropic") {
        res = await fetchFn(`${base}/messages`, { method: "POST", signal,
          headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model, max_tokens: 900, temperature: 0.3, system, messages: msgs }) });
      } else if (p.style === "ollama") {
        res = await fetchFn(`${base}/api/chat`, { method: "POST", signal, headers: { "content-type": "application/json" },
          body: JSON.stringify({ model, stream: false, think: false, options: { temperature: 0.3, num_ctx: 8192 }, messages: [{ role: "system", content: system }, ...msgs] }) });
      } else {
        res = await fetchFn(`${base}/chat/completions`, { method: "POST", signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({ model, messages: [{ role: "system", content: system }, ...msgs],
            ...(name === "openai" ? {} : { temperature: 0.3 }), ...(["groq", "openai"].includes(name) ? { max_completion_tokens: 900 } : {}) }) });
      }
    } catch (e) {
      throw new ModelError(name === "ollama" ? `تعذّر الاتصال بـ Ollama. تأكد أنه يعمل وأن ${model} مثبّت.` : "تعذّر الاتصال بخدمة الذكاء الاصطناعي. تحقق من الإنترنت.", 503, String(e.message));
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw new ModelError("مفتاح الـ API غير صحيح أو غير مفعّل.", 502, detail);
      if (res.status === 429) throw new ModelError("تم تجاوز حد الطلبات عند مزوّد الذكاء الاصطناعي، حاول بعد قليل.", 429, detail);
      if (res.status === 404) throw new ModelError(`النموذج ${model} غير موجود عند المزوّد. غيّر AI_MODEL في .env.`, 502, detail);
      throw new ModelError(`خدمة الذكاء الاصطناعي أرجعت خطأ ${res.status}.`, 502, detail);
    }
    const data = await res.json();
    const text = p.style === "anthropic" ? (data.content || []).filter(b => b.type === "text").map(b => b.text).join("")
      : p.style === "ollama" ? data.message?.content : data.choices?.[0]?.message?.content;
    const out = String(text || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
    if (!out) throw new ModelError("رجع النموذج رداً فارغاً.", 502);
    return out;
  }
  return { name, model, ok: !error, error, call };
}
