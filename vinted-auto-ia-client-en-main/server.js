import express from "express";
import cors from "cors";
import OpenAI from "openai";
import path from "path";
import { fileURLToPath } from "url";
import { File } from "node:buffer";

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
function requireKey() {
  if (!process.env.OPENAI_API_KEY) {
    const err = new Error(
      "OPENAI_API_KEY manquante (ajoute-la dans Render > Environment)."
    );
    err.status = 400;
    throw err;
  }
}

function normalizeLower(s) {
  return (s || "").trim().toLowerCase();
}

function dataUrlToFile(dataUrl, fallbackName = "image.png") {
  // Accepts: data:image/png;base64,AAAA...
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:")) return null;

  const firstComma = dataUrl.indexOf(",");
  if (firstComma === -1) return null;

  const meta = dataUrl.slice(5, firstComma); // "image/png;base64"
  const b64 = dataUrl.slice(firstComma + 1);

  const [mimeRaw] = meta.split(";");
  const mime = mimeRaw || "image/png";

  const ext =
    mime === "image/jpeg" ? "jpg" :
    mime === "image/webp" ? "webp" :
    "png";

  const name = fallbackName.includes(".") ? fallbackName : `${fallbackName}.${ext}`;
  const buf = Buffer.from(b64, "base64");
  return new File([buf], name, { type: mime });
}

async function openaiFetchJson(url, options) {
  const resp = await fetch(url, options);
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!resp.ok) {
    const msg =
      (json && (json.error?.message || json.message)) ||
      `OpenAI HTTP ${resp.status}`;
    const err = new Error(msg);
    err.status = resp.status;
    err.details = json || text;
    throw err;
  }
  return json || {};
}

// 1) Générer l'annonce
app.post("/api/generate-listing", async (req, res) => {
  try {
    const { images = [], extra = "", useAi = true } = req.body || {};
    if (!useAi) {
      return res.json({
        title: "titre en minuscules (mode démo)",
        description:
          "description en mode démo. active l’ia pour générer automatiquement.",
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
    for (const dataUrl of (images || []).slice(0, 6)) {
      content.push({ type: "input_image", image_url: dataUrl });
    }

    const r = await client.responses.create({
      model: process.env.TEXT_MODEL || "gpt-5",
      reasoning: { effort: "low" },
      input: [{ role: "user", content }],
      text: { format: { type: "json_object" } },
    });

    // output_text should contain JSON
    const txt = r.output_text || "{}";
    let obj;
    try {
      obj = JSON.parse(txt);
    } catch {
      obj = {};
    }

    // safety normalizations
    obj.title = normalizeLower(obj.title);

    res.json({
      title: obj.title || "",
      description: obj.description || "",
      price: obj.price || "",
      mannequin_prompt: obj.mannequin_prompt || obj.title || "vêtement",
    });
  } catch (e) {
    res
      .status(e.status || 500)
      .json({ ok: false, error: String(e?.message || e) });
  }
});

// 2) Générer photo mannequin (sans visage)
app.post("/api/generate-mannequin", async (req, res) => {
  try {
    const { images = [], description = "vêtement", gender = "homme" } =
      req.body || {};

    requireKey();

    const prompt = `
Tu dois reproduire au mieux le vêtement des photos de référence (si elles sont fournies).
Contraintes OBLIGATOIRES :
- Couleur : IDENTIQUE (ne change pas la teinte, saturation, ni luminosité). Ne pas rendre plus foncé ou plus clair.
- Logo : IDENTIQUE (même logo, même taille, même position). N’invente JAMAIS un logo. Si le logo n’est pas parfaitement visible, n’en mets pas.
- Coupe & détails : IDENTIQUES (col, maille, texture, bords-côtes, couture, longueur, manches).
- Aucun ajout : pas de motifs, pas de texte, pas de marques, pas d’étiquettes visibles.
- Mannequin : sans visage (cou coupé/masqué), posture neutre.
- Fond studio neutre, éclairage doux et réaliste (balance des blancs neutre, pas de dérive de couleur).

Mannequin ${gender}, SANS VISAGE (buste/cou coupé, aucune partie du visage visible).
Le mannequin porte : ${description}.
`.trim();

    // Si le client envoie des photos (data URLs), on utilise l'endpoint "images/edits" pour mieux coller au vêtement.
    // Sinon, on génère juste depuis le prompt.
    let b64 = null;

    if (Array.isArray(images) && images.length > 0) {
      const form = new FormData();
      form.append("model", process.env.IMAGE_MODEL || "gpt-image-1");
      form.append("prompt", prompt);
      form.append("size", "1024x1024");
      form.append("quality", "high");
      form.append("output_format", "png");
      // NOTE: pour gpt-image-1, tu peux régler input_fidelity si tu veux plus de "respect" de l'image source.
      form.append("input_fidelity", "high");

      let added = 0;
      for (const [i, dataUrl] of (images || []).slice(0, 8).entries()) {
        const file = dataUrlToFile(dataUrl, `ref_${i + 1}.png`);
        if (!file) continue;
        form.append("image[]", file);
        added++;
      }

      if (added === 0) {
        throw new Error("Aucune image valide reçue pour le mannequin.");
      }

      const json = await openaiFetchJson("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
      });

      b64 = json?.data?.[0]?.b64_json || null;
    } else {
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const img = await client.images.generate({
        model: process.env.IMAGE_MODEL || "gpt-image-1",
        prompt,
        size: "1024x1024",
        quality: "high",
        output_format: "png",
      });
      b64 = img?.data?.[0]?.b64_json || null;
    }

    if (!b64) throw new Error("Aucune image renvoyée par l’API.");
    res.json({ ok: true, image_data_url: `data:image/png;base64,${b64}` });
  } catch (e) {
    res
      .status(e.status || 500)
      .json({ ok: false, error: String(e?.message || e) });
  }
});

// SPA fallback (si jamais)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log("Server listening on", PORT));
