export type AssistantLanguage = "en" | "fr" | "unknown";

export type AssistantRole = "user" | "assistant";

export type AssistantMessage = {
  id?: string;
  role: AssistantRole;
  content: string;
  createdAt?: string;
};

export type CatalogProduct = {
  id: string;
  productId: number;
  variantId: number;
  name: string;
  parentName: string;
  sku: string;
  brand: string;
  manufacturer: string;
  categories: string[];
  description: string;
  price: number;
  image: string;
  url: string;
  inventoryLevel: number;
  availability: string;
  availabilityDescription: string;
  purchasable: boolean;
  quoteOnly: boolean;
  purchaseAction: "cart" | "quote_only";
  purchaseMessage: string;
};

export type ProductSearchInput = {
  query: string;
  language?: AssistantLanguage;
  limit?: number;
  filters?: {
    brand?: string;
    category?: string;
    manufacturer?: string;
  };
};

export type ProductPageContext = {
  url?: string;
  title?: string;
  sku?: string;
  variantId?: number;
  productId?: number;
  currentCart?: {
    cartId?: string;
    cartUrl?: string;
    subtotal?: number;
    items: Array<{
      lineItemId?: string;
      productId?: number;
      variantId?: number;
      sku?: string;
      name: string;
      quantity: number;
      price?: number;
    }>;
  };
};

export type QuoteRequest = {
  name: string;
  company?: string;
  email: string;
  phone?: string;
  products: Array<{
    name: string;
    sku?: string;
    quantity: number;
    url?: string;
    description?: string;
  }>;
  notes?: string;
  conversation: AssistantMessage[];
  language: AssistantLanguage;
};

export type SupportRequest = {
  name: string;
  email: string;
  question: string;
  category?: "product_missing" | "compatibility" | "quote" | "invoice" | "order_status" | "cart" | "other";
  summary?: {
    customerQuestion: string;
    productContext?: string;
    emrnDataFound?: string;
    externalDataFound?: string;
    confidence?: "confirmed" | "not_compatible" | "cant_confirm" | "unknown";
    transcriptSnippet?: string[];
  };
  conversation: AssistantMessage[];
  language: AssistantLanguage;
};

export type OrderStatusRequest = {
  email: string;
  orderNumber: string;
  name?: string;
  conversation: AssistantMessage[];
  language: AssistantLanguage;
};

export type CartRequest = {
  sessionId?: string;
  items: Array<{
    productId: number;
    variantId?: number;
    quantity: number;
  }>;
};

export type CartResult = {
  checkoutUrl?: string;
  cartId?: string;
  blockedItems: string[];
  provider?: "bigcommerce-api" | "bigcommerce-mcp" | "storefront-browser";
  lineItems?: Array<{
    itemId?: string;
    sku?: string;
    productId: number;
    variantId?: number;
    quantity: number;
  }>;
};

export type CommerceToolStatus<T> = {
  available: boolean;
  source: "bigcommerce-mcp" | "buyer-portal" | "bigcommerce-api" | "storefront-browser";
  data?: T;
  message?: string;
};

export type AssistantAnalyticsEvent =
  | {
      type: "conversation_started" | "conversation_completed";
      sessionId: string;
      language: AssistantLanguage;
      messageCount?: number;
      createdAt: string;
    }
  | {
      type:
        | "product_search"
        | "search_failure"
        | "no_result_search"
        | "product_recommended"
        | "knowledge_shadow"
        | "assistant_performance"
        | "admin_reviewed_performance"
        | "external_knowledge_sources"
        | "quote_request"
        | "quote_lookup"
        | "support_escalation"
        | "unanswered_question";
      sessionId: string;
      language: AssistantLanguage;
      query?: string;
      reviewedPerformanceKey?: string;
      productIds?: number[];
      knowledge?: {
        kind: "compatibility" | "product_detail" | "none";
        status: "confirmed" | "not_compatible" | "cant_confirm" | "not_applicable";
        confidence: "high" | "medium" | "low" | "none";
        productSkus: string[];
        relatedTerms: string[];
        evidence: string[];
        internalSourceUrls: string[];
      };
      performance?: {
        totalMs: number;
        searchMs?: number;
        supabaseMs?: number;
        openAiMs?: number;
        knowledgeMs?: number;
        productCount?: number;
        searchQuery?: string;
        answerPath?: string;
        answerPreview?: string;
        deployVersion?: string;
        slow?: boolean;
        openAiUsed?: boolean;
        supabaseUsed?: boolean;
      };
      externalSources?: Array<{
        title?: string;
        url: string;
        domain?: string;
      }>;
      createdAt: string;
    };

export type AssistantAiUsageEvent = {
  createdAt: string;
  feature: "search_translator" | "assistant_response" | "trusted_web_search";
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  sessionId?: string;
  language?: AssistantLanguage;
  query?: string;
  status?: "called" | "error" | "missing_key" | "fallback";
};
