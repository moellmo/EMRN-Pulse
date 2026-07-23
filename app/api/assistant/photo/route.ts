import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { searchBySKU, searchProducts } from "@/lib/assistant/catalog";
import { logAnalyticsEvent, logSupportRequest } from "@/lib/assistant/analytics";
import { sendSupportEmail } from "@/lib/assistant/email";
import { lookupExternalKnowledge } from "@/lib/assistant/openai";
import { uploadSupabaseAssistantPhoto } from "@/lib/assistant/supabase-admin";
import type { AssistantLanguage, AssistantMessage, CatalogProduct, SupportRequest } from "@/lib/assistant/types";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const redoReturnUrl = process.env.EMRN_REDO_RETURNS_URL || process.env.NEXT_PUBLIC_EMRN_REDO_RETURNS_URL || "https://returns.getredo.com/widget_id/y1cij5e1r309vaq/returns-portal/login?referralId=699c9248ecb6ce99fca4e162";

type PhotoFlow = "product_lookup" | "return_problem";

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Image file is required." }, { status: 400 });
    }

    const flow = cleanFlow(form.get("flow"));
    const language = cleanLanguage(form.get("language"));
    const sessionId = cleanText(form.get("sessionId"), 120) || crypto.randomUUID();
    const note = cleanText(form.get("note"), 700);
    const messages = safeMessages(form.get("messages"));

    if (!allowedImageTypes.has(file.type)) {
      return NextResponse.json({ error: "Please upload a JPG, PNG, WebP, HEIC, or HEIF image." }, { status: 400 });
    }
    if (file.size > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: "Please upload an image smaller than 8 MB." }, { status: 400 });
    }

    const arrayBuffer = await file.arrayBuffer();
    const upload = await storeAssistantPhoto({
      arrayBuffer,
      contentType: file.type,
      fileName: file.name,
      sessionId,
      flow,
    });

    if (flow === "return_problem") {
      const supportRequest = buildPhotoSupportRequest({
        language,
        messages,
        note,
        upload,
        sessionId,
        question: note || "Customer uploaded a return/problem photo.",
      });
      const missing = missingReturnSupportFields(supportRequest);
      const answer = returnPhotoAnswer(language, missing);
      if (!missing.length) {
        await Promise.allSettled([
          logSupportRequest(supportRequest),
          sendSupportEmail(supportRequest),
          logAnalyticsEvent({
            type: "support_escalation",
            sessionId,
            language,
            query: "return/problem photo upload",
            createdAt: new Date().toISOString(),
          }),
        ]);
      } else {
        await logAnalyticsEvent({
          type: "support_escalation",
          sessionId,
          language,
          query: `return/problem photo upload missing ${missing.join(", ")}`,
          createdAt: new Date().toISOString(),
        });
      }
      return NextResponse.json({ answer, upload });
    }

    const analysis = await analyzeProductPhoto(arrayBuffer, file.type);
    const answer = await productPhotoAnswer(analysis, language);
    await logAnalyticsEvent({
      type: "product_search",
      sessionId,
      language,
      query: analysis.searchTerms.join(", ") || note || "product photo upload",
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({ answer, upload, analysis });
  } catch (error) {
    console.error("[EMRN Pulse] photo upload failed", error);
    return NextResponse.json({ error: "Photo upload failed." }, { status: 500 });
  }
}

function cleanFlow(value: FormDataEntryValue | null): PhotoFlow {
  return value === "return_problem" ? "return_problem" : "product_lookup";
}

function cleanLanguage(value: FormDataEntryValue | null): AssistantLanguage {
  return value === "fr" ? "fr" : "en";
}

function cleanText(value: FormDataEntryValue | null, max: number) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

function safeMessages(value: FormDataEntryValue | null): AssistantMessage[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as AssistantMessage[];
    return Array.isArray(parsed)
      ? parsed
          .filter((message) => message && (message.role === "user" || message.role === "assistant") && typeof message.content === "string")
          .slice(-12)
      : [];
  } catch {
    return [];
  }
}

function extensionForContentType(contentType: string, fileName: string) {
  const fromName = fileName.match(/\.(jpe?g|png|webp|heic|heif)$/i)?.[1]?.toLowerCase();
  if (fromName) return fromName === "jpeg" ? "jpg" : fromName;
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/heic") return "heic";
  if (contentType === "image/heif") return "heif";
  return "jpg";
}

async function storeAssistantPhoto(input: {
  arrayBuffer: ArrayBuffer;
  contentType: string;
  fileName: string;
  sessionId: string;
  flow: PhotoFlow;
}) {
  const ext = extensionForContentType(input.contentType, input.fileName);
  const safeSession = input.sessionId.replace(/[^a-z0-9-]/gi, "").slice(0, 80) || "session";
  const storagePath = `${input.flow}/${new Date().toISOString().slice(0, 10)}/${safeSession}/${crypto.randomUUID()}.${ext}`;
  const supabaseUpload = await uploadSupabaseAssistantPhoto({
    path: storagePath,
    contentType: input.contentType,
    body: input.arrayBuffer,
  }).catch((error) => {
    console.warn("[EMRN Pulse] Supabase photo upload skipped", error);
    return null;
  });
  if (supabaseUpload) {
    return {
      url: supabaseUpload.url,
      storagePath: `${supabaseUpload.bucket}/${supabaseUpload.path}`,
      fileName: input.fileName,
      contentType: input.contentType,
    };
  }

  const localDir = path.join(process.cwd(), ".data", "assistant", "uploads", path.dirname(storagePath));
  await mkdir(localDir, { recursive: true });
  const localPath = path.join(localDir, path.basename(storagePath));
  await writeFile(localPath, Buffer.from(input.arrayBuffer));
  return {
    url: `/api/assistant/photo/local/${storagePath}`,
    storagePath,
    fileName: input.fileName,
    contentType: input.contentType,
  };
}

async function analyzeProductPhoto(arrayBuffer: ArrayBuffer, contentType: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      visibleText: "",
      brand: "",
      model: "",
      upcCandidates: [] as string[],
      skuCandidates: [] as string[],
      manufacturerPartNumbers: [] as string[],
      productType: "",
      searchTerms: [] as string[],
      confidence: "low" as const,
    };
  }

  const model = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
  const dataUrl = `data:${contentType};base64,${Buffer.from(arrayBuffer).toString("base64")}`;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Extract only visible product-identification clues from this image for EMRN medical supply search. Return strict JSON with visibleText, brand, model, upcCandidates, skuCandidates, manufacturerPartNumbers, productType, searchTerms, confidence. Read UPC/barcode numbers when visible. Do not diagnose, do not identify people, and do not guess beyond visible labels/packaging/product shape.",
            },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "photo_product_clues",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              visibleText: { type: "string" },
              brand: { type: "string" },
              model: { type: "string" },
              upcCandidates: { type: "array", items: { type: "string" } },
              skuCandidates: { type: "array", items: { type: "string" } },
              manufacturerPartNumbers: { type: "array", items: { type: "string" } },
              productType: { type: "string" },
              searchTerms: { type: "array", items: { type: "string" } },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
            },
            required: ["visibleText", "brand", "model", "upcCandidates", "skuCandidates", "manufacturerPartNumbers", "productType", "searchTerms", "confidence"],
          },
        },
      },
      max_output_tokens: 500,
    }),
  });

  if (!response.ok) {
    console.warn("[EMRN Pulse] photo vision failed", response.status, await response.text());
    return {
      visibleText: "",
      brand: "",
      model: "",
      upcCandidates: [] as string[],
      skuCandidates: [] as string[],
      manufacturerPartNumbers: [] as string[],
      productType: "",
      searchTerms: [] as string[],
      confidence: "low" as const,
    };
  }
  return normalizePhotoAnalysis(await response.json());
}

function normalizePhotoAnalysis(value: unknown) {
  const raw = outputTextFromResponse(value).match(/\{[\s\S]*\}/)?.[0] || "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const array = (input: unknown, max = 8) =>
      Array.isArray(input) ? input.map((item) => String(item || "").trim()).filter(Boolean).slice(0, max) : [];
    return {
      visibleText: String(parsed.visibleText || "").trim().slice(0, 500),
      brand: String(parsed.brand || "").trim().slice(0, 120),
      model: String(parsed.model || "").trim().slice(0, 120),
      upcCandidates: array(parsed.upcCandidates),
      skuCandidates: array(parsed.skuCandidates),
      manufacturerPartNumbers: array(parsed.manufacturerPartNumbers),
      productType: String(parsed.productType || "").trim().slice(0, 160),
      searchTerms: array(parsed.searchTerms),
      confidence: parsed.confidence === "high" || parsed.confidence === "medium" ? parsed.confidence : "low",
    };
  } catch {
    return {
      visibleText: "",
      brand: "",
      model: "",
      upcCandidates: [] as string[],
      skuCandidates: [] as string[],
      manufacturerPartNumbers: [] as string[],
      productType: "",
      searchTerms: [] as string[],
      confidence: "low" as const,
    };
  }
}

function outputTextFromResponse(value: unknown) {
  const record = value as { output_text?: unknown; output?: unknown };
  if (typeof record.output_text === "string") return record.output_text;
  const chunks: string[] = [];
  const visit = (item: unknown) => {
    if (!item) return;
    if (Array.isArray(item)) return item.forEach(visit);
    if (typeof item !== "object") return;
    const current = item as Record<string, unknown>;
    for (const key of ["text", "content"]) {
      if (typeof current[key] === "string") chunks.push(current[key]);
    }
    Object.values(current).forEach(visit);
  };
  visit(value);
  return chunks.join("\n").trim();
}

async function productPhotoAnswer(
  analysis: Awaited<ReturnType<typeof analyzeProductPhoto>>,
  language: AssistantLanguage
) {
  const directPartCandidates = Array.from(new Set([
    ...analysis.skuCandidates,
    ...analysis.manufacturerPartNumbers,
    ...analysis.upcCandidates,
  ].map((value) => value.trim()).filter(Boolean)));
  const skuProducts = (await Promise.all(directPartCandidates.map((sku) => searchBySKU(sku)))).flat();
  const query = [
    analysis.brand,
    analysis.model,
    analysis.productType,
    ...analysis.searchTerms,
    ...analysis.upcCandidates,
    analysis.visibleText,
  ].filter(Boolean).join(" ");
  const searchProductsResult = skuProducts.length || !query
    ? []
    : (await searchProducts({ query, language, limit: 5 })).products;
  const products = dedupeProducts([...skuProducts, ...searchProductsResult]).slice(0, 5);

  if (products.length) {
    const intro = language === "fr"
      ? `J’ai analysé la photo et trouvé ${analysis.confidence === "high" ? "une correspondance probable" : "des correspondances possibles"} dans EMRN.`
      : `I checked the photo and found ${analysis.confidence === "high" ? "a likely match" : "possible matches"} in EMRN.`;
    return `${intro}\n\n${productLines(products, language).join("\n")}\n\n${language === "fr" ? "Veuillez vérifier le SKU/modèle avant d’acheter ou d’utiliser l’article." : "Please verify the SKU/model before purchase or use."}`;
  }

  const externalLookup = query
    ? await lookupExternalKnowledge({
        messages: [
          {
            role: "user",
            content: [
              "Identify this medical supply product from photo clues and find exact manufacturer product/part numbers if possible.",
              analysis.brand ? `Brand: ${analysis.brand}` : "",
              analysis.model ? `Model: ${analysis.model}` : "",
              analysis.productType ? `Product type: ${analysis.productType}` : "",
              analysis.upcCandidates.length ? `UPC/barcode candidates: ${analysis.upcCandidates.join(", ")}` : "",
              analysis.skuCandidates.length ? `Visible SKU candidates: ${analysis.skuCandidates.join(", ")}` : "",
              analysis.manufacturerPartNumbers.length ? `Visible part numbers: ${analysis.manufacturerPartNumbers.join(", ")}` : "",
              analysis.visibleText ? `Visible text: ${analysis.visibleText}` : "",
              "If a UPC/barcode is visible, use trusted manufacturer/supplier/catalog/manual sources to map that UPC to the exact manufacturer part number, model, or product name before deciding EMRN does not carry it.",
            ].filter(Boolean).join("\n"),
          },
        ],
        products: [],
        language,
        query,
      })
    : null;
  if (externalLookup && externalLookup.status === "confirmed") {
    const recoveryTerms = Array.from(new Set([
      ...externalLookup.manufacturerPartNumbers,
      ...externalLookup.searchTerms,
      externalLookup.exactProductName,
    ].map((value) => value.trim()).filter(Boolean)));
    const recoveredProducts = await finalEmrnRecoverySearch(recoveryTerms, language);
    if (recoveredProducts.length) {
      return `${language === "fr" ? "J’ai identifié l’article avec une source approuvée, puis trouvé des correspondances EMRN possibles:" : "I identified the item using approved product information, then found possible EMRN matches:"}\n\n${productLines(recoveredProducts, language).join("\n")}\n\n${language === "fr" ? "Veuillez vérifier le SKU/modèle avant d’acheter ou d’utiliser l’article." : "Please verify the SKU/model before purchase or use."}`;
    }
    const exact = externalLookup.exactProductName || externalLookup.manufacturerPartNumbers.join(", ") || analysis.productType || "this item";
    return language === "fr"
      ? `J’ai identifié l’article comme **${exact}** à partir d’une source approuvée, mais je n’ai pas trouvé de correspondance EMRN claire.\n\nEMRN peut vérifier ou sourcer cet article. Envoyez votre nom, courriel, quantité et délai souhaité, et je l’enverrai à l’équipe des devis.`
      : `I identified the item as **${exact}** using approved product information, but I did not find a clear EMRN catalog match.\n\nEMRN can check/source this item. Send your name, email, quantity, and any deadline, and I’ll send it to the quote team.`;
  }

  const clues = [
    analysis.brand ? `Brand: ${analysis.brand}` : "",
    analysis.model ? `Model: ${analysis.model}` : "",
    analysis.upcCandidates.length ? `UPC/barcode candidates: ${analysis.upcCandidates.join(", ")}` : "",
    analysis.skuCandidates.length ? `Visible SKU/part candidates: ${analysis.skuCandidates.join(", ")}` : "",
    analysis.manufacturerPartNumbers.length ? `Manufacturer part candidates: ${analysis.manufacturerPartNumbers.join(", ")}` : "",
    analysis.productType ? `Product type: ${analysis.productType}` : "",
  ].filter(Boolean);
  return language === "fr"
    ? `Je n’ai pas trouvé de correspondance EMRN claire à partir de cette photo.${clues.length ? `\n\nCe que j’ai pu lire: ${clues.join("; ")}.` : ""}\n\nJe peux envoyer cette photo à l’équipe EMRN pour vérifier ou préparer un devis.`
    : `I did not find a clear EMRN match from this photo.${clues.length ? `\n\nWhat I could read: ${clues.join("; ")}.` : ""}\n\nI can send this photo to the EMRN team to check/source the item or prepare a quote.`;
}

async function finalEmrnRecoverySearch(terms: string[], language: AssistantLanguage) {
  const cleanTerms = Array.from(new Set(terms.map((term) => term.trim()).filter(Boolean))).slice(0, 12);
  const exactPartTerms = cleanTerms.filter((term) => /\b(?=[A-Z0-9+.-]*\d)[A-Z0-9]{3,}(?:[-+.][A-Z0-9]{1,})*\b/i.test(term));
  const exactProducts = (await Promise.all(exactPartTerms.map((term) => searchBySKU(term)))).flat();
  if (exactProducts.length) return dedupeProducts(exactProducts).slice(0, 5);

  const searchedProducts = (
    await Promise.all(cleanTerms.map((term) => searchProducts({ query: term, language, limit: 5 }).then((result) => result.products)))
  ).flat();
  return dedupeProducts(searchedProducts).slice(0, 5);
}

function dedupeProducts(products: CatalogProduct[]) {
  const seen = new Set<string>();
  return products.filter((product) => {
    const key = `${product.productId}:${product.variantId}:${product.sku}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function productLines(products: CatalogProduct[], language: AssistantLanguage) {
  return products.map((product, index) => {
    const price = product.price ? `$${product.price.toFixed(2)}` : language === "fr" ? "prix non disponible" : "price unavailable";
    const availability = product.availabilityDescription || product.availability || (language === "fr" ? "disponibilité à confirmer" : "availability to confirm");
    const link = language === "fr" ? "Voir le produit" : "View product";
    return `${index + 1}. **${product.name}** — SKU: ${product.sku || "N/A"} — ${price}. ${availability}. [${link}](${product.url})`;
  });
}

function returnPhotoAnswer(language: AssistantLanguage, missing: string[]) {
  if (language === "fr") {
    const missingText = missing.length ? `\n\nPour une révision par EMRN, envoyez aussi: ${missing.join(", ")}.` : "\n\nJ’ai envoyé la photo et les détails à l’équipe EMRN pour révision.";
    return [
      "Merci, j’ai reçu la photo.",
      "",
      `Pour les retours admissibles de moins de 500 $, utilisez le portail de retours: ${redoReturnUrl}`,
      "",
      `Pour une commande de plus de 500 $, un article endommagé, un problème de garantie, un article spécial ou un cas incertain, EMRN doit réviser la demande.${missingText}`,
    ].join("\n");
  }
  const missingText = missing.length ? `\n\nFor EMRN review, please also send: ${missing.join(", ")}.` : "\n\nI sent the photo and details to the EMRN team for review.";
  return [
    "Thanks, I received the photo.",
    "",
    `For eligible returns under $500, please use the return portal: ${redoReturnUrl}`,
    "",
    `For orders over $500, damaged shipments, warranty issues, special items, or anything unclear, EMRN needs to review the request.${missingText}`,
  ].join("\n");
}

function missingReturnSupportFields(request: SupportRequest) {
  const missing: string[] = [];
  if (!request.name || request.name === "Photo upload customer") missing.push("name");
  if (!request.email || request.email === "photo-upload@emrn-pulse.local") missing.push("email");
  if (!request.phone) missing.push("phone");
  if (!/\b(?:order|commande)\s*(?:number|#|no\.?|num[eé]ro)?\s*[:#-]?\s*[A-Z0-9-]{4,30}\b/i.test(request.question) &&
      !request.conversation.some((message) => /\b(?:order|commande)\s*(?:number|#|no\.?|num[eé]ro)?\s*[:#-]?\s*[A-Z0-9-]{4,30}\b/i.test(message.content))) {
    missing.push("order number");
  }
  return missing;
}

function buildPhotoSupportRequest(input: {
  language: AssistantLanguage;
  messages: AssistantMessage[];
  note: string;
  upload: { url: string; storagePath?: string; fileName?: string; contentType?: string };
  sessionId: string;
  question: string;
}): SupportRequest {
  const allText = [input.note, ...input.messages.map((message) => message.content)].join("\n");
  const email =
    allText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || "photo-upload@emrn-pulse.local";
  const name = allText.match(/\b(?:name is|my name is|je m'appelle|mon nom est)\s+([A-Za-zÀ-ÿ' -]{2,60})/i)?.[1]?.trim() || "Photo upload customer";
  const phone = allText.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/)?.[0]?.trim();
  return {
    name,
    email,
    phone,
    question: input.question,
    category: "other",
    attachments: [
      {
        url: input.upload.url,
        storagePath: input.upload.storagePath,
        fileName: input.upload.fileName,
        contentType: input.upload.contentType,
        kind: "return_photo",
      },
    ],
    summary: {
      customerQuestion: input.note || "Customer uploaded a return/problem photo.",
      productContext: "Photo uploaded through EMRN Pulse",
      confidence: "unknown",
      transcriptSnippet: input.messages.slice(-6).map((message) => `${message.role}: ${message.content}`),
    },
    conversation: input.messages,
    language: input.language,
  };
}
