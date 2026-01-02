import express from "express";
import cors from "cors";
import OpenAI, { toFile } from "openai";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ✅ Plus large pour les photos iPhone en base64 (évite 413 / body tronqué)
app.use(express.json({ limit: process.env.JSON_LIMIT || "80mb" }));

// Simplifié au max : on autorise toutes les origines (évite CORS qui casse sur iPhone).
app.use(cors({ origin: true }));

// Servir la PWA
app.use(express.static(path.join(__dirname, "public")));

// Healthcheck
app.get("/api/health", (req, res) => {
  res.json({ ok: true, hasKey: Boolean(process.env.OPENAI_API_KEY) });
});

// Helpers
function requireKey() {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error("OPENAI_API_KEY manquante (ajoute-la dans Render > Environment).");
    err.status = 400;
    throw err;
  }
}

function normalizeLower(s) {
  return (s || "").trim().toLowerCase();
}

// ✅ Accepte images OU "images[]" + gère le cas string au lieu de tableau
function getImagesFromBody(body) {
  const raw = body?.images ?? body?.["images[]"] ?? [];
  if (Array.isArray(raw)) return raw.filter(Boolean);
  if (typeof raw === "string" && raw.trim()) return [raw];
  return [];
}

// Convertit une dataURL (data:image/...;base64,...) en File pour l'API images.edits
async function dataUrlToFile(dataUrl, name = "ref") {
  const m = String(dataUrl || "").match(/^data:(image\/\w+);base64,(.+)$/);
  if (!m) throw new Error("Image invalide: data URL attendu (data:image/...;base64,...)");

  const mime = m[1];
  const b64 = m[2];
  const ext = mime === "image/jpeg" ? "jpg" : mime.split("/")[1];
  const buf = Buffer.from(b64, "base64");

  return await toFile(buf, name + "." + ext);
}

// 1) Générer l'annonce
app.post("/api/generate-listing", async (req, res) => {
  try {
    const { extra = "", useAi = true } = req.body || {};
    const images = getImagesFromBody(req.body);

    if (!useAi) {
      return res.json({
        title: "titre en minuscules (mode démo)",
        description: "description en mode démo. active l’ia pour générer automatiquement.",
        price: "—",
        mannequin_prompt: "un vêtement",
      });
    }

    requireKey();
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const content = [
      {
        type: "input_text",
        text: `Tu es un expert Vinted (Belgique). À partir des photos fournies, génère une annonce Vinted en FR.
Contraintes:
- titre entièrement en minuscules
- description détaillée, claire, vendeuse, honnête
- mentionner matière(s), taille, coupe, couleurs, état, défauts si visibles
- terminer par une ligne de hashtags pertinents (10-20 max)
- proposer un prix conseillé sous forme: "xx€ (fourchette: aa–bb€)".
- retourner en JSON STRICT avec clés: title, description, price, mannequin_prompt.
Infos supplémentaires de l’utilisateur (optionnel): ${extra}`,
      },
    ];

    // Add up to 6 images
    for (const dataUrl of images.slice(0, 6)) {
      content.push({ type: "input_image", image_url: dataUrl });
    }

    const r = await client.responses.create({
      model: process.env.TEXT_MODEL || "gpt-5",
      reasoning: { effort: "low" },
      input: [{ role: "user", content }],
      text: { format: { type: "json_object" } },
    });

    const txt = r.output_text || "{}";
    let obj;
    try {
      obj = JSON.parse(txt);
    } catch {
      obj = {};
    }

    obj.title = normalizeLower(obj.title);

    res.json({
      title: obj.title || "",
      description: obj.description || "",
      price: obj.price || "",
      mannequin_prompt: obj.mannequin_prompt || obj.title || "vêtement",
    });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: String(e?.message || e) });
  }
});

// 2) Générer photo mannequin (sans visage) — AVEC photos en référence
app.post("/api/generate-mannequin", async (req, res) => {
  try {
    const images = getImagesFromBody(req.body);
    const { description = "vêtement", gender = "homme" } = req.body || {};
    requireKey();

    // ✅ Logs activables si besoin (Render > Environment: DEBUG_IMAGES=1)
    if (process.env.DEBUG_IMAGES === "1") {
      console.log("BODY keys:", Object.keys(req.body || {}));
      console.log("images count:", images.length);
    }

    if (images.length === 0) {
      return res.status(400).json({ ok: false, error: "Ajoute au moins 1 photo (images[])." });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    // Convertit les images dataURL en "fichiers" envoyables à l’API (max 6)
    const refFiles = [];
    for (let i = 0; i < Math.min(images.length, 6); i++) {
      refFiles.push(await dataUrlToFile(images[i], "ref_" + (i + 1)));
    }

    const prompt = `
À partir des PHOTOS DE RÉFÉRENCE fournies, crée une image studio d’un mannequin portant EXACTEMENT le même vêtement.

Contraintes OBLIGATOIRES :
- Reproduire EXACTEMENT le vêtement des photos (forme, matière, texture, coutures, col, manches, bords-côtes).
- Couleur IDENTIQUE (ne change pas la teinte / saturation / luminosité).
- Logos / broderies : IDENTIQUES en taille et position. Si un logo n’est pas parfaitement lisible sur les photos, NE PAS en inventer.
- Aucun ajout (pas de motifs, pas de texte, pas de marque inventée).
- Mannequin : sans visage (cou coupé/masqué), posture neutre.
- Fond studio neutre, éclairage doux, balance des blancs neutre (pas de dérive).
- Rendu réaliste, cadrage centré.

Mannequin ${gender}, SANS VISAGE.
Le mannequin porte : ${description}.
Vue souhaitée : face (centrée, vêtement bien visible).
`;

    const img = await client.images.edits({
      model: process.env.IMAGE_MODEL || "gpt-image-1",
      image: refFiles,
      prompt,
      size: "1024x1024",
      quality: "high",
      output_format: "png",
    });

    const b64 = img.data?.[0]?.b64_json;
    if (!b64) throw new Error("Aucune image renvoyée par l’API.");

    res.json({ ok: true, image_data_url: "data:image/png;base64," + b64 });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: String(e?.message || e) });
  }
});

// SPA fallback (si jamais)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
