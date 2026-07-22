import type { AssistantLanguage, CatalogProduct } from "./types";
import { assistantFeatureEnabledAsync } from "./admin-config";

export type KnowledgeEvidence = {
  kind: "compatibility" | "product_detail" | "none";
  status: "confirmed" | "not_compatible" | "cant_confirm" | "not_applicable";
  confidence: "high" | "medium" | "low" | "none";
  productSkus: string[];
  relatedTerms: string[];
  evidence: string[];
  internalSourceUrls: string[];
};

const compatibilityQuestionPattern =
  /\b(compatible|compatibility|fit|fits|work with|works with|go with|goes with|for this|for that|replacement for|part for|accessory for|pour|compatible avec|fonctionne avec|va avec)\b/i;

const directCompatibilityPattern =
  /\b(compatible with|for use with|fits|fit for|works with|designed for|replacement for|use with|used with|accessory for|part for|pour|compatible avec|fonctionne avec)\b/i;

const negativeCompatibilityPattern =
  /\b(not compatible|not for|does not fit|doesn't fit|will not fit|not intended for|non compatible|n.est pas compatible|ne convient pas)\b/i;

async function knowledgeEnabled() {
  return assistantFeatureEnabledAsync("siteKnowledgeEnabled");
}

export async function knowledgeShadowEnabled() {
  return (await knowledgeEnabled()) && (await assistantFeatureEnabledAsync("knowledgeShadowMode"));
}

export function shouldCheckKnowledgeEvidence(question: string) {
  return compatibilityQuestionPattern.test(question);
}

function normalizeText(value: string) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9+.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique<T>(values: T[]) {
  return Array.from(new Set(values.filter(Boolean)));
}

function importantTerms(value: string) {
  return normalizeText(value)
    .split(" ")
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .filter(
      (term) =>
        ![
          "and",
          "are",
          "can",
          "does",
          "for",
          "fit",
          "fits",
          "go",
          "goes",
          "item",
          "part",
          "product",
          "this",
          "that",
          "the",
          "use",
          "with",
          "work",
          "works",
        ].includes(term)
    );
}

function relatedTermsFromQuestion(question: string, products: CatalogProduct[]) {
  const afterRelationship =
    question.match(/\b(?:compatible with|fit|fits|work with|works with|go with|goes with|for|replacement for|part for|accessory for)\s+(.+)$/i)?.[1] ||
    question.match(/\b(?:compatible avec|fonctionne avec|va avec|pour)\s+(.+)$/i)?.[1] ||
    "";
  const productTerms = products.flatMap((product) => importantTerms([product.name, product.parentName, product.sku, product.brand, product.manufacturer].join(" ")));
  return unique([...importantTerms(afterRelationship || question), ...productTerms]).slice(0, 18);
}

function productEvidenceText(product: CatalogProduct) {
  return [product.name, product.parentName, product.sku, product.brand, product.manufacturer, product.categories.join(" "), product.description]
    .filter(Boolean)
    .join("\n");
}

function sourceUrls(products: CatalogProduct[]) {
  return unique(products.map((product) => product.url).filter(Boolean)).slice(0, 6);
}

function evidenceSnippets(product: CatalogProduct, terms: string[]) {
  const text = productEvidenceText(product);
  const lines = text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedTerms = terms.map(normalizeText).filter(Boolean);

  return lines
    .filter((line) => {
      const normalized = normalizeText(line);
      const hasRelationship = directCompatibilityPattern.test(line) || negativeCompatibilityPattern.test(line);
      const matchedTerms = normalizedTerms.filter((term) => normalized.includes(term));
      return hasRelationship && matchedTerms.length > 0;
    })
    .slice(0, 4)
    .map((line) => `${product.sku || product.name}: ${line.slice(0, 500)}`);
}

export async function buildKnowledgeEvidence(question: string, products: CatalogProduct[], language: AssistantLanguage): Promise<KnowledgeEvidence> {
  void language;

  if (!(await knowledgeShadowEnabled()) || !shouldCheckKnowledgeEvidence(question)) {
    return {
      kind: "none",
      status: "not_applicable",
      confidence: "none",
      productSkus: [],
      relatedTerms: [],
      evidence: [],
      internalSourceUrls: [],
    };
  }

  const relevantProducts = products.slice(0, 4);
  const relatedTerms = relatedTermsFromQuestion(question, relevantProducts);
  const evidence = relevantProducts.flatMap((product) => evidenceSnippets(product, relatedTerms));
  const combinedEvidence = evidence.join("\n");
  const hasNegative = negativeCompatibilityPattern.test(combinedEvidence);
  const hasDirect = directCompatibilityPattern.test(combinedEvidence);

  const status = hasNegative ? "not_compatible" : hasDirect ? "confirmed" : "cant_confirm";
  const confidence = hasNegative || hasDirect ? "medium" : "low";

  return {
    kind: "compatibility",
    status,
    confidence,
    productSkus: unique(relevantProducts.map((product) => product.sku)).slice(0, 8),
    relatedTerms,
    evidence,
    internalSourceUrls: sourceUrls(relevantProducts),
  };
}
