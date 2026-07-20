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
  provider?: "bigcommerce-api" | "bigcommerce-mcp";
};

export type CommerceToolStatus<T> = {
  available: boolean;
  source: "bigcommerce-mcp" | "buyer-portal" | "bigcommerce-api";
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
        | "quote_request"
        | "support_escalation"
        | "unanswered_question";
      sessionId: string;
      language: AssistantLanguage;
      query?: string;
      productIds?: number[];
      createdAt: string;
    };
