import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";
import { makeModel } from "./providers.js";
import { handleChat } from "./core.js";

dotenv.config();
const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const ai = makeModel(process.env);

app.use(express.json({ limit: "20kb" }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN ? process.env.ALLOWED_ORIGIN.split(",").map(x => x.trim()) : true }));
app.use("/api/", rateLimit({ windowMs: 60_000, limit: 35, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));

async function getJson(url) {
  const r = await fetch(url, { headers: { "User-Agent": "MarsGuide/1.0" }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`Source service returned ${r.status}`);
  return r.json();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: ai.ok, service: "Mars Guide", scope: "mars-only", aiProvider: ai.name, model: ai.model, error: ai.error });
});

app.post("/api/chat", async (req, res) => {
  const out = await handleChat(req.body, { callModel: ai.call, getJson, log: (...a) => console.error(...a) });
  res.status(out.status).json(out.json);
});

app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => {
  console.log(`Mars Guide chatbot on http://localhost:${PORT}  (Mars-only)`);
  console.log(`AI provider: ${ai.name} | model: ${ai.model || "-"} | ready: ${ai.ok}`);
  if (!ai.ok) console.log(`WARNING: ${ai.error}`);
});
