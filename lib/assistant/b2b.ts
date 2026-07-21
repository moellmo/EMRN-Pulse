const STORE_HASH = process.env.BIGCOMMERCE_ADMIN_STORE_HASH || process.env.BIGCOMMERCE_STORE_HASH;
const ACCESS_TOKEN = process.env.BIGCOMMERCE_B2B_ACCESS_TOKEN || process.env.BIGCOMMERCE_ADMIN_ACCESS_TOKEN || process.env.BIGCOMMERCE_ACCESS_TOKEN;
const B2B_API_BASE = (process.env.BIGCOMMERCE_B2B_API_BASE || "https://api-b2b.bigcommerce.com/api/v3/io").replace(/\/+$/, "");

type UnknownRecord = Record<string, unknown>;

export type B2BQuoteLookupResult = {
  available: boolean;
  found: boolean;
  quoteId?: string;
  quoteNumber?: string;
  status?: string;
  allowCheckout?: boolean;
  createdAt?: string;
  updatedAt?: string;
  expiredAt?: string;
  quoteUrl?: string;
  customerEmail?: string;
  companyName?: string;
  subtotal?: number;
  discount?: number;
  discountType?: string;
  discountValue?: number;
  taxTotal?: number;
  shippingTotal?: number;
  total?: number;
  currencyCode?: string;
  items: Array<{ sku?: string; name: string; quantity: number; price?: number; discount?: number; total?: number; productUrl?: string }>;
  message?: string;
};

export type B2BInvoiceLookupResult = {
  available: boolean;
  found: boolean;
  invoiceId?: string;
  invoiceNumber?: string;
  orderNumber?: string;
  status?: string;
  invoiceUrl?: string;
  pdfUrl?: string;
  total?: number;
  balance?: number;
  currencyCode?: string;
  message?: string;
};

export type B2BQuoteCheckoutResult = {
  available: boolean;
  created: boolean;
  checkoutUrl?: string;
  message?: string;
};

function text(value: unknown) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

function number(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function b2bFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!STORE_HASH || !ACCESS_TOKEN || !B2B_API_BASE) {
    throw new Error("BigCommerce B2B API is not configured.");
  }

  const response = await fetch(`${B2B_API_BASE}${path}`, {
    ...init,
    headers: {
      "X-Auth-Token": ACCESS_TOKEN,
      "X-Store-Hash": STORE_HASH,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`BigCommerce B2B API failed with status ${response.status}`);
  }

  const body = await response.text();
  return (body ? JSON.parse(body) : {}) as T;
}

function recordsFromPayload(payload: unknown) {
  if (Array.isArray(payload)) return payload.filter((item): item is UnknownRecord => Boolean(item && typeof item === "object"));
  const root = payload && typeof payload === "object" ? payload as UnknownRecord : {};
  const data = root.data;
  if (Array.isArray(data)) return data.filter((item): item is UnknownRecord => Boolean(item && typeof item === "object"));
  if (data && typeof data === "object") {
    const record = data as UnknownRecord;
    for (const key of ["list", "items", "quotes", "invoices", "result"]) {
      if (Array.isArray(record[key])) return (record[key] as unknown[]).filter((item): item is UnknownRecord => Boolean(item && typeof item === "object"));
    }
    return [record];
  }
  for (const key of ["list", "items", "quotes", "invoices", "result"]) {
    if (Array.isArray(root[key])) return (root[key] as unknown[]).filter((item): item is UnknownRecord => Boolean(item && typeof item === "object"));
  }
  return [];
}

function moneyValue(value: unknown) {
  if (value && typeof value === "object") {
    const record = value as UnknownRecord;
    return number(record.value || record.amount);
  }
  return number(value);
}

function currencyCode(value: unknown) {
  if (value && typeof value === "object") {
    const record = value as UnknownRecord;
    return text(record.currencyCode || record.code || record.token);
  }
  return text(value);
}

function normalizeQuote(record: UnknownRecord): B2BQuoteLookupResult {
  const quoteId = text(record.quoteId || record.id || record.rfqId);
  const quoteNumber = text(record.quoteNumber || record.referenceNumber || quoteId);
  const contact = record.contactInfo && typeof record.contactInfo === "object" ? record.contactInfo as UnknownRecord : {};
  const company = record.companyInfo && typeof record.companyInfo === "object" ? record.companyInfo as UnknownRecord : {};
  const productList = Array.isArray(record.productList)
    ? record.productList
    : Array.isArray(record.products)
      ? record.products
      : Array.isArray(record.items)
        ? record.items
        : [];
  return {
    available: true,
    found: Boolean(quoteNumber),
    quoteId,
    quoteNumber,
    status: text(record.statusText || record.status || record.quoteStatus),
    allowCheckout: typeof record.allowCheckout === "boolean" ? record.allowCheckout : undefined,
    createdAt: text(record.createdAt || record.created_at || record.createdTime),
    updatedAt: text(record.updatedAt || record.updated_at || record.updatedTime),
    expiredAt: text(record.expiredAt || record.expiresAt || record.expirationDate),
    quoteUrl: text(record.quoteUrl || record.url || record.checkoutUrl),
    customerEmail: text(record.userEmail || record.email || contact.email),
    companyName: text(record.company || record.companyName || company.companyName || company.name),
    subtotal: moneyValue(record.subtotal),
    discount: moneyValue(record.discount || record.discountAmount),
    discountType: text(record.discountType),
    discountValue: moneyValue(record.discountValue),
    taxTotal: moneyValue(record.taxTotal || record.tax),
    shippingTotal: moneyValue(record.shippingTotal || record.shipping),
    total: moneyValue(record.grandTotal || record.totalAmount || record.total || record.subtotal),
    currencyCode: currencyCode(record.currencyCode || record.currency) || "CAD",
    items: productList
      .filter((item): item is UnknownRecord => Boolean(item && typeof item === "object"))
      .map((item) => ({
        sku: text(item.sku),
        name: text(item.productName || item.name || item.sku),
        quantity: number(item.quantity || item.qty) || 1,
        price: moneyValue(item.offeredPrice || item.price || item.salePrice || item.basePrice),
        discount: moneyValue(item.discount || item.discountAmount),
        total: moneyValue(item.total || item.rowTotal || item.extendedPrice),
        productUrl: text(item.productUrl || item.url),
      }))
      .filter((item) => item.name || item.sku),
  };
}

function normalizeInvoice(record: UnknownRecord): B2BInvoiceLookupResult {
  const invoiceId = text(record.id || record.invoiceId);
  const invoiceNumber = text(record.invoiceNumber || record.invoiceNo || invoiceId);
  const originalBalance = record.originalBalance && typeof record.originalBalance === "object" ? record.originalBalance as UnknownRecord : {};
  const openBalance = record.openBalance && typeof record.openBalance === "object" ? record.openBalance as UnknownRecord : {};
  return {
    available: true,
    found: Boolean(invoiceNumber),
    invoiceId,
    invoiceNumber,
    orderNumber: text(record.orderNumber || record.bcOrderId || record.orderId),
    status: text(record.statusText || record.status),
    invoiceUrl: text(record.invoiceUrl || record.url || record.externalPdfUrl),
    pdfUrl: text(record.pdfUrl || record.downloadUrl || record.externalPdfUrl),
    total: moneyValue(record.total || record.amount || record.originalBalance || originalBalance.value),
    balance: moneyValue(record.balance || record.openBalance || openBalance.value),
    currencyCode: text(record.currencyCode || originalBalance.code || openBalance.code || "CAD"),
  };
}

function urlFromPayload(payload: unknown) {
  const records = recordsFromPayload(payload);
  const record = records[0] || (payload && typeof payload === "object" ? payload as UnknownRecord : {});
  return text(
    record.checkoutUrl ||
      record.checkoutURL ||
      record.url ||
      record.redirectUrl ||
      record.redirectURL ||
      record.quoteUrl ||
      record.cartUrl
  );
}

function matches(value: string, query: string) {
  if (!query) return true;
  return value.toLowerCase().includes(query.toLowerCase());
}

export async function lookupB2BQuote(input: { quoteNumber?: string; email?: string; company?: string }): Promise<B2BQuoteLookupResult> {
  try {
    const quoteNumber = text(input.quoteNumber).replace(/^#/, "");
    const query = new URLSearchParams();
    query.set("limit", "20");
    if (quoteNumber) {
      if (/^\d+$/.test(quoteNumber)) query.set("quoteId", quoteNumber);
      else query.set("quoteNumber", quoteNumber);
    }
    if (input.company) query.set("company", input.company);
    const payload = await b2bFetch<unknown>(`/rfq?${query.toString()}`);
    const records = recordsFromPayload(payload)
      .map(normalizeQuote)
      .filter((quote) =>
        (!quoteNumber ||
          quote.quoteId === quoteNumber ||
          quote.quoteNumber === quoteNumber ||
          matches(quote.quoteNumber || "", quoteNumber) ||
          matches(quote.quoteId || "", quoteNumber)) &&
        (!input.email || !quote.customerEmail || quote.customerEmail.toLowerCase() === input.email.toLowerCase())
      );
    const quote = records[0];
    if (!quote) return { available: true, found: false, items: [] };

    if (quote.quoteId) {
      try {
        const detailPayload = await b2bFetch<unknown>(`/rfq/${encodeURIComponent(quote.quoteId)}`);
        const detailRecord = recordsFromPayload(detailPayload)[0] || (detailPayload && typeof detailPayload === "object" ? detailPayload as UnknownRecord : {});
        const detailedQuote = normalizeQuote({ ...detailRecord, quoteId: quote.quoteId });
        return {
          ...quote,
          ...detailedQuote,
          quoteId: quote.quoteId,
          quoteNumber: detailedQuote.quoteNumber || quote.quoteNumber,
        };
      } catch {
        return quote;
      }
    }

    return quote;
  } catch (error) {
    return {
      available: false,
      found: false,
      items: [],
      message: error instanceof Error ? error.message : "Unable to look up quote.",
    };
  }
}

export async function lookupB2BInvoice(input: { orderNumber?: string; invoiceNumber?: string }): Promise<B2BInvoiceLookupResult> {
  try {
    const invoiceNumber = text(input.invoiceNumber).replace(/^#/, "");
    const orderNumber = text(input.orderNumber).replace(/^#/, "");
    const query = new URLSearchParams();
    query.set("limit", "20");
    if (invoiceNumber) query.set("invoiceNumber", invoiceNumber);
    if (orderNumber) query.set("orderNumber", orderNumber);
    const payload = await b2bFetch<unknown>(`/ip/invoices?${query.toString()}`);
    const invoices = recordsFromPayload(payload)
      .map(normalizeInvoice)
      .filter((invoice) =>
        (!invoiceNumber || matches(invoice.invoiceNumber || "", invoiceNumber)) &&
        (!orderNumber || matches(invoice.orderNumber || "", orderNumber))
      );
    const invoice = invoices[0];
    if (!invoice?.invoiceNumber) return { available: true, found: false };

    try {
      const pdf = await b2bFetch<unknown>(`/ip/invoices/${encodeURIComponent(invoice.invoiceId || invoice.invoiceNumber)}/download-pdf`);
      const records = recordsFromPayload(pdf);
      const pdfRecord = records[0] || (pdf && typeof pdf === "object" ? pdf as UnknownRecord : {});
      invoice.pdfUrl = text(pdfRecord.url || pdfRecord.pdfUrl || pdfRecord.downloadUrl || invoice.pdfUrl);
    } catch {
      // Some stores use invoice IDs instead of invoice numbers for PDF export. The lookup result is still useful.
    }

    return invoice;
  } catch (error) {
    return {
      available: false,
      found: false,
      message: error instanceof Error ? error.message : "Unable to look up invoice.",
    };
  }
}

export async function createB2BQuoteCheckout(quoteId: string): Promise<B2BQuoteCheckoutResult> {
  try {
    const cleanQuoteId = text(quoteId).replace(/^#/, "").trim();
    if (!cleanQuoteId) {
      return {
        available: true,
        created: false,
        message: "Quote number is required.",
      };
    }

    const payload = await b2bFetch<unknown>(`/rfq/${encodeURIComponent(cleanQuoteId)}/checkout`, {
      method: "POST",
    });
    const checkoutUrl = urlFromPayload(payload);
    return {
      available: true,
      created: Boolean(checkoutUrl),
      checkoutUrl,
      message: checkoutUrl ? undefined : "Quote checkout link was not returned.",
    };
  } catch (error) {
    return {
      available: false,
      created: false,
      message: error instanceof Error ? error.message : "Unable to create quote checkout link.",
    };
  }
}
