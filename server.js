import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const PHOTOS = path.join(DATA, "photos");
fs.mkdirSync(PHOTOS, { recursive: true });

const load = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f))); } catch { return d; } };
const save = (f, o) => { const t = path.join(DATA, f + ".tmp"); fs.writeFileSync(t, JSON.stringify(o)); fs.renameSync(t, path.join(DATA, f)); };
const key = s => String(s || "").trim().toUpperCase().replace(/[^A-Z0-9_-]/g, "_");

const PROMPT = 'Read the product pack label. Return only JSON: {"batch":string|null,"usp":string|null,"mfg":"YYYY-MM-DD"|null,"exp":"YYYY-MM-DD"|null}. If only month/year is printed use the first day for mfg and last day for exp. Use null for anything not clearly readable. Do not guess.';

async function aiRead(image) {
  let t = "{}";
  if (process.env.OPENAI_API_KEY) {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer " + process.env.OPENAI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-4o-mini", response_format: { type: "json_object" },
        messages: [{ role: "user", content: [{ type: "text", text: PROMPT }, { type: "image_url", image_url: { url: "data:image/jpeg;base64," + image } }] }] }),
    });
    t = (await r.json()).choices?.[0]?.message?.content || "{}";
  } else if (process.env.GEMINI_API_KEY) {
    const model = process.env.GEMINI_MODEL || "gemini-3.1-flash-lite";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": process.env.GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ inline_data: { mime_type: "image/jpeg", data: image } }, { text: PROMPT }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 } }),
    });
    t = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  }
  return JSON.parse(t.replace(/```json|```/g, "").trim());
}

async function alertOwner(scan) {
  const msg = `Verification FAILED: batch ${scan.read.batch || "?"} at ${scan.lat ?? "?"},${scan.lng ?? "?"}\n${scan.issues.join("; ")}`;
  const jobs = [];
  if (process.env.ALERT_WEBHOOK_URL)
    jobs.push(fetch(process.env.ALERT_WEBHOOK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: msg, content: msg }) }));
  if (process.env.APPS_SCRIPT_URL)
    jobs.push(fetch(process.env.APPS_SCRIPT_URL, { method: "POST", headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ secret: process.env.APPS_SCRIPT_SECRET, subject: "Batch verification failed: " + (scan.read.batch || "unknown"),
        text: msg + (process.env.SITE_URL ? "\n\nOpen admin: " + process.env.SITE_URL + "/admin.html" : "") }) }));
  await Promise.allSettled(jobs);
}

const hits = new Map();
const limit = (req, res, next) => {
  const now = Date.now(), ip = req.ip;
  const a = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (a.length >= 20) return res.status(429).json({ error: "Too many requests" });
  a.push(now); hits.set(ip, a); next();
};

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/verify", limit, async (req, res) => {
  const { image, lat = null, lng = null, acc = null, ocr = null } = req.body || {};
  if (!image) return res.status(400).json({ error: "No image" });

  let read = {}, source = "ai";
  const isoOk = d => /^\d{4}-\d{2}-\d{2}$/.test(String(d));
  if (ocr && ocr.batch && ocr.usp && isoOk(ocr.mfg) && isoOk(ocr.exp)) {
    read = { batch: String(ocr.batch).slice(0, 60), usp: String(ocr.usp).slice(0, 60), mfg: ocr.mfg, exp: ocr.exp };
    source = "browser-ocr";
  } else { try { read = await aiRead(image); } catch {} }

  const issues = [];
  let status = "ok";
  const miss = ["batch", "usp", "mfg", "exp"].filter(k => !read[k]);
  if (miss.length) { status = "unreadable"; issues.push("Could not read: " + miss.join(", ")); }
  else {
    const rec = load("batches.json", {})[key(read.batch)];
    if (!rec) issues.push("Batch code is not registered");
    else {
      if (String(rec.usp).trim().toUpperCase() !== String(read.usp).trim().toUpperCase()) issues.push("USP code does not match this batch");
      if (rec.mfg !== read.mfg) issues.push(`Manufacture date does not match (${rec.mfg} on record)`);
      if (rec.exp !== read.exp) issues.push(`Expiry date does not match (${rec.exp} on record)`);
    }
    const days = Math.floor((new Date(read.exp) - new Date(new Date().toISOString().slice(0, 10))) / 864e5);
    if (days < 0) issues.push(`Product expired ${-days} day(s) ago`);
    if (new Date(read.exp) <= new Date(read.mfg)) issues.push("Expiry is not after manufacture date");
    if (issues.length) status = "fail";
    else if (days <= 30) { status = "warn"; issues.push(`Expires in ${days} day(s)`); }
  }
  if (lat == null) issues.push("Location was not captured");

  const id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
  const scan = { id, ts: Date.now(), status, issues, read, lat, lng, acc, source };
  fs.writeFileSync(path.join(PHOTOS, id + ".jpg"), Buffer.from(image, "base64"));
  const scans = load("scans.json", []);
  scans.push(scan);
  save("scans.json", scans);
  if (status === "fail") alertOwner(scan);
  res.json({ status, issues, read });
});

const auth = (req, res, next) =>
  process.env.ADMIN_PASSWORD && req.get("x-admin-key") === process.env.ADMIN_PASSWORD ? next() : res.status(401).json({ error: "Unauthorized" });

app.get("/api/admin", auth, (req, res) => {
  const id = req.query.photo;
  if (id) {
    if (!/^[\w-]+$/.test(id)) return res.status(400).end();
    const f = path.join(PHOTOS, id + ".jpg");
    return fs.existsSync(f) ? res.type("jpeg").sendFile(f) : res.status(404).json({ error: "Not found" });
  }
  res.json(load("scans.json", []).sort((a, b) => b.ts - a.ts).slice(0, 200));
});

app.post("/api/admin", auth, (req, res) => {
  const batches = load("batches.json", {});
  let n = 0;
  for (const line of String(req.body?.text || "").split("\n")) {
    const [batch, usp, mfg, exp] = line.split(",").map(s => s.trim());
    if (batch && usp && mfg && exp) { batches[key(batch)] = { batch, usp, mfg, exp }; n++; }
  }
  save("batches.json", batches);
  res.json({ saved: n });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("Running on http://localhost:" + port));
