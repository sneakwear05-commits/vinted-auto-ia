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

// ✅ Simplifié au max : on autorise toutes les origines (évite CORS qui casse sur iPhone).
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

// ✅ Convertit une dataURL (data:image/...;base64,...) en File pour l'API images.edit
async function dataUrlToFile(dataUrl, name = "ref") {
  const m = String(dataUrl || "").match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!m) throw new Error("Image invalide: data URL attendu (data:image/...;base64,...)");

  const mime = m[1].toLowerCase();
  const b64 = m[2];

  // L’API images accepte: jpg/jpeg, png, webp (max 50MB).
  const allowed = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp"]);
  if (!allowed.has(mime)) {
    throw new Error(
      Format image non supporté (${mime}). Essaie de sélectionner des photos en JPEG/PNG/WebP (sur iPhone: Réglages > Appareil photo > Formats > "Le plus compatible").
    );
  }

  const ext = mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
  const buf = Buffer.from(b64, "base64");

  // Sécurité : l’API image a une limite (~50MB)
  if (buf.length > 50 * 1024 * 1024) {
    throw new Error("Image trop lourde (max 50MB).");
  }

  // ✅ IMPORTANT : on passe le MIME, sinon ça part en application/octet-stream
  return await toFile(buf, ${name}.${ext}, { type: mime });
}

// 1) Générer annonce (title/description/prix/prompt mannequin) — AVEC photos en référence
app.post("/api/generate-listing", async (req, res) => {
  try {
    const images = getImagesFromBody(req.body);
    const { extra = "" } = req.body || {};
    requireKey();

    if (images.length === 0) {
      return res.status(400).json({ ok: false, error: "Ajoute au moins 1 photo (images[])." });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const content = [
      {
        type: "input_text",
        text:
          Tu es un expert Vinted. À partir des photos de vêtements, génère une annonce optimisée.\n +
          Réponds STRICTEMENT en JSON (pas de texte autour) avec ces champs :\n +
          - title: titre court (sans majuscules, tout en minuscules)\n +
          - description: description détaillée + état + mesures si possible + matière si identifiable. Termine par une ligne de hashtags pertinents.\n +
          - price: prix conseillé (nombre ou texte court) en euros\n +
          - mannequin_prompt: un court texte décrivant le vêtement pour générer une image mannequin fidèle\n +
          (extra ? \nInfos additionnelles: ${extra} : ""),
      },
    ];

    // Ajoute jusqu’à 6 images
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
    let obj = {};
    try {
      obj = JSON.parse(txt);
    } catch {
      obj = {};
    }

    const title = normalizeLower(obj.title);

    res.json({
      ok: true,
      title: title || "",
      description: obj.description || "",
      price: obj.price ?? "",
      mannequin_prompt: obj.mannequin_prompt || title || "vêtement",
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

    const prompt = À partir des PHOTOS DE RÉFÉRENCE, génère une photo studio réaliste d’un mannequin portant EXACTEMENT le même vêtement.\n\n +
      Contraintes OBLIGATOIRES :\n +
      - Fidélité maximale au vêtement des photos (coupe, matière, texture, coutures, col, manches, bords-côtes).\n +
      - Couleurs IDENTIQUES (ne change pas la teinte / saturation / luminosité).\n +
      - Logos / broderies : identiques en taille et position. Si un détail n’est pas lisible sur les photos, NE PAS l’inventer.\n +
      - Aucun ajout (pas de motifs inventés, pas de texte, pas de marque inventée).\n +
      - Mannequin : SANS VISAGE (cadrage du cou vers le bas, pas de tête).\n +
      - Posture neutre, vue de face, vêtement bien visible et centré.\n +
      - Fond studio neutre (blanc/gris clair), éclairage doux, balance des blancs neutre (pas de dérive).\n +
      - Rendu photo réaliste (pas de style dessin/illustration).\n\n +
      Mannequin: ${gender}.\n +
      Vêtement à porter (rappel): ${description}.\n;

    const img = await client.images.edit({
      model: process.env.IMAGE_MODEL || "gpt-image-1",
      image: refFiles,
      prompt,
      // ✅ maximise la fidélité au vêtement des photos (dispo sur gpt-image-1)
      input_fidelity: "high",
      background: "opaque",
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
