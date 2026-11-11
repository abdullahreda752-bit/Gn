// Offline tests (no internet, no API key). Run:  node test.mjs
import assert from "node:assert/strict";
import { marsOnly, refusal, missionFrom, imageIntent, buildSystem, relevantItems } from "./mars.js";
import { makeModel, normalize, ModelError } from "./providers.js";
import { handleChat } from "./core.js";
let n = 0; const ok = (name, fn) => Promise.resolve(fn()).then(() => { n++; console.log("ok  ", name); });

await ok("gate allows Mars questions (en/ar)", () => {
  for (const q of ["Why is Jezero crater important?", "ليه المريخ لونه أحمر؟", "tell me about Phobos", "وريني صور كيوريوسيتي", "Is there ice on Mars?"]) assert.equal(marsOnly(q, [], ""), true, q);
});
await ok("gate blocks clearly off-topic first messages", () => {
  for (const q of ["What is the capital of France?", "اكتبلي كود بايثون لترتيب قائمة", "Who won the world cup in 2018?", "give me a recipe for koshary please"]) assert.equal(marsOnly(q, [], ""), false, q);
});
await ok("gate: short follow-up allowed after a real answer, not after a refusal", () => {
  const h = [{ role: "user", content: "tell me about Mars" }, { role: "assistant", content: "Mars is the fourth planet." }];
  assert.equal(marsOnly("and why is it cold?", h, ""), true);
  assert.equal(marsOnly("and why is it cold?", [{ role: "user", content: "x" }, { role: "assistant", content: refusal("x") }], ""), false);
  assert.equal(marsOnly("a very long off topic question about cooking pasta and the history of the roman empire and its emperors in detail", h, ""), false);
});
await ok("gate: page context lets short 'what is this?' through", () => {
  assert.equal(marsOnly("what is this?", [], "الصفحة: x\nالمهمة المفتوحة الآن: Curiosity | y"), true);
  assert.equal(marsOnly("what is this?", [], ""), false);
});
await ok("refusal language follows the question", () => {
  assert.match(refusal("كام الساعة؟"), /المريخ/); assert.match(refusal("what time"), /only cover Mars/);
});
await ok("mission + image intent", () => {
  assert.equal(missionFrom("photos of perseverance", "").name, "Perseverance"); assert.equal(imageIntent("show me photos"), true); assert.equal(imageIntent("why is mars red"), false);
});
await ok("system prompt: Mars-only + knowledge + context capped", () => {
  const s = buildSystem("X-CTX"); assert.match(s, /ONLY about Mars/); assert.match(s, /Jezero crater 18.44/); assert.ok(s.includes("X-CTX"));
});

// ---- providers: request shape, key handling, error mapping ----
const capture = (status = 200, body = {}) => { const calls = []; const f = async (url, opt) => { calls.push({ url, opt }); return { ok: status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }; }; f.calls = calls; return f; };
await ok("groq: OpenAI-style request, key in header only", async () => {
  const f = capture(200, { choices: [{ message: { content: "مرحبا" } }] });
  const m = makeModel({ AI_PROVIDER: "groq", GROQ_API_KEY: "SECRET123" }, f);
  assert.equal(m.ok, true); assert.equal(await m.call("SYS", [{ role: "user", content: "hi" }]), "مرحبا");
  const c = f.calls[0]; assert.equal(c.url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(c.opt.headers.authorization, "Bearer SECRET123"); assert.ok(!c.opt.body.includes("SECRET123"));
  const b = JSON.parse(c.opt.body); assert.equal(b.messages[0].role, "system"); assert.equal(b.messages[0].content, "SYS");
});
await ok("anthropic: native request shape", async () => {
  const f = capture(200, { content: [{ type: "text", text: "Hello" }] });
  const m = makeModel({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "K" }, f);
  assert.equal(await m.call("SYS", [{ role: "assistant", content: "stray" }, { role: "user", content: "a" }, { role: "user", content: "b" }]), "Hello");
  const c = f.calls[0]; assert.equal(c.url, "https://api.anthropic.com/v1/messages"); assert.equal(c.opt.headers["x-api-key"], "K");
  const b = JSON.parse(c.opt.body); assert.equal(b.system, "SYS"); assert.deepEqual(b.messages, [{ role: "user", content: "a\n\nb" }]);
});
await ok("ollama: no key needed, think:false, strips <think>", async () => {
  const f = capture(200, { message: { content: "<think>hmm</think>الجواب" } });
  const m = makeModel({ AI_PROVIDER: "ollama" }, f); assert.equal(m.ok, true);
  assert.equal(await m.call("S", [{ role: "user", content: "q" }]), "الجواب"); assert.equal(JSON.parse(f.calls[0].opt.body).think, false);
});
await ok("gemini + openai presets", async () => {
  const g = makeModel({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" }, capture()); assert.equal(g.ok, true);
  const o = capture(200, { choices: [{ message: { content: "x" } }] }); await makeModel({ AI_PROVIDER: "openai", OPENAI_API_KEY: "k" }, o).call("s", [{ role: "user", content: "q" }]);
  assert.equal(o.calls[0].url, "https://api.openai.com/v1/chat/completions"); assert.ok(!("temperature" in JSON.parse(o.calls[0].opt.body)));
});
await ok("missing key / bad provider are reported, not crashed", async () => {
  const m = makeModel({ AI_PROVIDER: "groq" }, capture()); assert.equal(m.ok, false); assert.match(m.error, /GROQ_API_KEY/);
  await assert.rejects(() => m.call("s", [{ role: "user", content: "q" }]), ModelError);
  assert.equal(makeModel({ AI_PROVIDER: "nope" }, capture()).ok, false);
});
await ok("HTTP errors map to friendly messages", async () => {
  for (const [st, re] of [[401, /مفتاح/], [429, /حد الطلبات/], [404, /غير موجود/], [500, /خطأ 500/]]) {
    const m = makeModel({ AI_PROVIDER: "groq", GROQ_API_KEY: "k" }, capture(st, { error: "x" }));
    await assert.rejects(() => m.call("s", [{ role: "user", content: "q" }]), e => re.test(e.userMessage) && e.status >= 400);
  }
});

// ---- handleChat ----
const nasa = { collection: { items: [
  { data: [{ title: "Curiosity Self Portrait", description: "<b>Mars</b> selfie", nasa_id: "PIA1" }], links: [{ render: "image", href: "https://img/1.jpg" }] },
  { data: [{ title: "Moon crater", description: "moon" }], links: [{ render: "image", href: "https://img/2.jpg" }] }] } };
await ok("off-topic: refusal returned and the model is NEVER called", async () => {
  let called = 0; const r = await handleChat({ message: "What is the capital of France?" }, { callModel: async () => { called++; return "x"; }, getJson: async () => nasa });
  assert.equal(called, 0); assert.equal(r.json.offTopic, true); assert.match(r.json.text, /Mars/);
});
await ok("Mars photo question: gallery filtered to the mission, model gets data + system prompt", async () => {
  let seen; const r = await handleChat({ message: "show me photos of Curiosity", context: "المهمة المفتوحة الآن: Curiosity" }, { callModel: async (sys, msgs) => { seen = { sys, msgs }; return "هذه صور."; }, getJson: async u => { assert.match(u, /curiosity/i); return nasa; } });
  assert.equal(r.status, 200); assert.equal(r.json.science.items.length, 1); assert.equal(r.json.science.items[0].nasaUrl, "https://images.nasa.gov/details/PIA1");
  assert.match(seen.sys, /ONLY about Mars/); assert.match(seen.sys, /PAGE CONTEXT/); assert.match(seen.msgs.at(-1).content, /SCIENCE DATA/);
});
await ok("NASA library down: still answers, no crash", async () => {
  const r = await handleChat({ message: "show Mars photos" }, { callModel: async () => "ok", getJson: async () => { throw new Error("down"); } });
  assert.equal(r.status, 200); assert.equal(r.json.science, null);
});
await ok("model error: friendly message + status; history sanitized; empty message rejected", async () => {
  const r = await handleChat({ message: "why is Mars red", history: [{ role: "system", content: "evil" }, { role: "user", content: 5 }] }, { callModel: async (s, m) => { assert.equal(m.length, 1); throw new ModelError("مفتاح الـ API غير صحيح أو غير مفعّل.", 502); }, getJson: async () => nasa });
  assert.equal(r.status, 502); assert.match(r.json.error, /مفتاح/);
  assert.equal((await handleChat({ message: "  " }, {})).status, 400);
});
console.log(`\n${n} tests passed`);
