import express from "express";
import cors from "cors";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: "30mb" }));

// Simplifié au max : on autorise toutes les origines (évite CORS qui casse sur iPhone).
app.use(cors({ origin: true }));

// Servir la PWA
app.use(express.static(path.join(__dirname, "public")));

// Healthcheck
app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.OPENAI_API_KEY) });
});

// Helpers
function requireKey(){
  if(!process.env.OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY manquante (ajoute-la dans Render > Environment).");
    err.status = 400;
    throw err;
  }
}

function normalizeLower(s){
  return (s || "").trim().toLowerCase();
}

// 1) Générer l'annonce
app.post("/api/generate-listing", async (req, res) => {
  try{
    const { images = [], extra = "", useAi = true } = req.body || {};
    if(!useAi) {
      return res.json({
        title: "titre en minuscules (mode démo)",
        description: "description en mode démo. active l’ia pour générer automatiquement.",
        price: "—",
        mannequin_prompt: "un vêtement"
      });
    }

    requireKey();
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const content = [
      { type: "input_text", text:
`Tu es un expert Vinted (Belgique). À partir des photos fournies, génère une annonce Vinted en FR.
Contraintes:
- titre entièrement en minuscules
- description détaillée, claire, vendeuse, honnête
- mentionner matière(s), taille, coupe, couleurs, état, défauts si visibles
- terminer par une ligne de hashtags pertinents (10-20 max)
- proposer un prix conseillé sous forme: "xx€ (fourchette: aa–bb€)".
- retourner en JSON STRICT avec clés: title, description, price, mannequin_prompt.
Infos supplémentaires de l’utilisateur (optionnel): ${extra}` }
    ];

    // Add up to 6 images
    for(const dataUrl of (images || []).slice(0, 6)){
      content.push({ type: "input_image", image_url: dataUrl });
    }

    const r = await client.responses.create({
      model: process.env.TEXT_MODEL || "gpt-5",
      reasoning: { effort: "low" },
      input: [{ role: "user", content }],
      response_format: { type: "json_object" }
    });

    // output_text should contain JSON
    const txt = r.output_text || "{}";
    let obj;
    try { obj = JSON.parse(txt); } catch { obj = {}; }

    // safety normalizations
    obj.title = normalizeLower(obj.title);
    res.json({
      title: obj.title || "",
      description: obj.description || "",
      price: obj.price || "",
      mannequin_prompt: obj.mannequin_prompt || obj.title || "vêtement"
    });

  }catch(e){
    res.status(e.status || 500).json({ ok:false, error: String(e?.message || e) });
  }
});

// 2) Générer photo mannequin (sans visage)
app.post("/api/generate-mannequin", async (req, res) => {
  try{
    const { description = "vêtement", gender = "homme" } = req.body || {};
    requireKey();
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const prompt =
`Photo studio type Vinted, fond blanc, rendu photo réaliste.
Mannequin ${gender}, SANS VISAGE (buste/cou coupé, aucune partie du visage visible).
Le mannequin porte: ${description}.
Respecter la couleur et le style décrits.`;

    const img = await client.images.generate({
      model: process.env.IMAGE_MODEL || "gpt-image-1",
      prompt,
      size: "1024x1024"
    });

    const b64 = img.data?.[0]?.b64_json;
    if(!b64) throw new Error("Aucune image renvoyée par l’API.");
    res.json({ ok:true, image_data_url: `data:image/png;base64,${b64}` });
  }catch(e){
    res.status(e.status || 500).json({ ok:false, error: String(e?.message || e) });
  }
});

// SPA fallback (si jamais)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
