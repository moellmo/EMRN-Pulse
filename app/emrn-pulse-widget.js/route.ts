import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const script = `
(function () {
  if (window.__EMRN_PULSE_WIDGET__) return;
  window.__EMRN_PULSE_WIDGET__ = true;

  var origin = ${JSON.stringify(origin)};
  var desiredOpen = false;
  var pendingSearchHelp = null;
  var iframe = document.createElement("iframe");
  iframe.src = origin + "/ai-assistant-widget";
  iframe.title = "EMRN Pulse";
  iframe.setAttribute("aria-label", "EMRN Pulse AI assistant");
  iframe.style.position = "fixed";
  iframe.style.right = "0";
  iframe.style.bottom = "0";
  iframe.style.width = "120px";
  iframe.style.height = "120px";
  iframe.style.border = "0";
  iframe.style.background = "transparent";
  iframe.style.display = "block";
  iframe.style.zIndex = "2147483000";
  iframe.style.colorScheme = "normal";
  iframe.setAttribute("allowtransparency", "true");
  iframe.setAttribute("frameborder", "0");
  iframe.allow = "clipboard-write";

  var launcherProxy = document.createElement("div");
  launcherProxy.setAttribute("role", "button");
  launcherProxy.setAttribute("tabindex", "0");
  launcherProxy.setAttribute("aria-label", "Open EMRN Pulse");
  launcherProxy.style.position = "fixed";
  launcherProxy.style.right = "0";
  launcherProxy.style.bottom = "0";
  launcherProxy.style.width = "120px";
  launcherProxy.style.height = "120px";
  launcherProxy.style.border = "0";
  launcherProxy.style.padding = "0";
  launcherProxy.style.margin = "0";
  launcherProxy.style.background = "transparent";
  launcherProxy.style.boxShadow = "none";
  launcherProxy.style.outline = "0";
  launcherProxy.style.appearance = "none";
  launcherProxy.style.webkitAppearance = "none";
  launcherProxy.style.cursor = "pointer";
  launcherProxy.style.zIndex = "2147483001";
  launcherProxy.style.colorScheme = "normal";

  function text(selector) {
    var node = document.querySelector(selector);
    return node && node.textContent ? node.textContent.trim() : "";
  }

  function numberFrom(value) {
    var parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
  }

  function skuFromPageText() {
    var nodes = document.querySelectorAll("[itemprop='sku'], [data-product-sku], [data-sku], .sku, .productView-info-value, span, div, dd");
    for (var i = 0; i < Math.min(nodes.length, 600); i += 1) {
      var value = nodes[i] && nodes[i].textContent ? nodes[i].textContent.trim() : "";
      var match = value.match(/(?:^|\\b)SKU\\s*[:#]?\\s*([A-Z]{1,8}\\s*-?\\s*\\d{3,}(?:-[A-Z0-9]+)*\\+?|[A-Z0-9-]{3,}\\+?)\\b/i);
      if (match && match[1]) return match[1];
      if (/^[A-Z]{1,8}\\s*-?\\s*\\d{3,}(?:-[A-Z0-9]+)*\\+?$/i.test(value)) return value;
      if (/^\\d{3,}(?:-[A-Z0-9]+)*\\+?$/i.test(value)) return value;
    }
    return "";
  }

  function collectPageContext() {
    var params = new URLSearchParams(window.location.search);
    var skuText =
      params.get("sku") ||
      text("[data-product-sku]") ||
      text("[itemprop='sku']") ||
      text("[data-sku]") ||
      text(".productView-info-value") ||
      skuFromPageText() ||
      "";
    var skuMatch = skuText.match(/[A-Z]{1,8}\\s*-?\\s*\\d{3,}(?:-[A-Z0-9]+)*\\+?|[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})*\\+?|\\b\\d{4,}\\+?\\b/i);

    var productIdNode = document.querySelector("[data-product-id]");
    return {
      url: window.location.href,
      title:
        text("h1.productView-title") ||
        text("h1") ||
        document.title ||
        "",
      sku: skuMatch ? skuMatch[0].replace(/\\s+/g, "").toUpperCase() : "",
      productId: numberFrom(params.get("product_id") || (productIdNode ? productIdNode.getAttribute("data-product-id") : "")),
      variantId: numberFrom(params.get("variant_id") || params.get("variant"))
    };
  }

  function normalizeCartSnapshot(cart) {
    var items = allPhysicalCartItems(cart).map(function (item) {
      return {
        lineItemId: cartLineItemId(item),
        productId: Number(item.productId || item.product_id || item.productEntityId || 0) || undefined,
        variantId: Number(item.variantId || item.variant_id || item.variantEntityId || 0) || undefined,
        sku: item.sku || item.variantSku || item.productSku || "",
        name: item.name || item.productName || "",
        quantity: Number(item.quantity || 1),
        price: Number(item.salePrice || item.listPrice || item.extendedSalePrice || item.extendedListPrice || 0) || undefined
      };
    }).filter(function (item) {
      return item.name || item.sku || item.productId;
    });
    return {
      cartId: cart && cart.id ? cart.id : "",
      cartUrl: "https://emrn.ca/cart.php",
      subtotal: Number(cart && (cart.baseAmount || cart.cartAmount || cart.subtotal || 0)) || undefined,
      items: items
    };
  }

  async function collectCurrentCartSnapshot() {
    var cart = await getStorefrontCart();
    if (!cart || !cart.id) return { cartUrl: "https://emrn.ca/cart.php", items: [] };
    return normalizeCartSnapshot(cart);
  }

  async function sendPageContext() {
    if (!iframe.contentWindow) return;
    var context = collectPageContext();
    context.currentCart = await collectCurrentCartSnapshot();
    iframe.contentWindow.postMessage(
      { type: "emrn-pulse:page-context", pageContext: context },
      origin
    );
  }

  var lastContextKey = "";
  async function sendPageContextIfChanged() {
    var context = collectPageContext();
    var key = [context.url, context.title, context.sku, context.productId, context.variantId].join("|");
    if (key === lastContextKey) return;
    lastContextKey = key;
    if (!iframe.contentWindow) return;
    context.currentCart = await collectCurrentCartSnapshot();
    iframe.contentWindow.postMessage(
      { type: "emrn-pulse:page-context", pageContext: context },
      origin
    );
  }

  async function storefrontJson(url, options) {
    var response = await fetch(url, Object.assign({
      credentials: "same-origin",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json"
      }
    }, options || {}));
    if (!response.ok) throw new Error("Storefront cart request failed: " + response.status);
    var text = await response.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      return {};
    }
  }

  async function getStorefrontCartId() {
    var cart = await getStorefrontCart();
    return cart && cart.id ? cart.id : "";
  }

  async function getStorefrontCart() {
    try {
      var payload = await storefrontJson("/api/storefront/carts");
      var carts = payload && payload.data ? payload.data : payload;
      if (Array.isArray(carts) && carts[0] && carts[0].id) return carts[0];
      if (carts && carts.id) return carts;
    } catch (error) {
      return null;
    }
    return null;
  }

  function cartPayload(items) {
    return {
      lineItems: (items || []).map(function (item) {
        var lineItem = {
          quantity: Number(item.quantity || 1),
          productId: Number(item.productId)
        };
        if (item.variantId) lineItem.variantId = Number(item.variantId);
        return lineItem;
      }).filter(function (item) {
        return item.productId && item.quantity > 0;
      })
    };
  }

  async function addItemsToStorefrontCart(items) {
    var payload = cartPayload(items);
    if (!payload.lineItems.length) throw new Error("No cart items");
    var cartId = await getStorefrontCartId();
    if (cartId) {
      return storefrontJson("/api/storefront/carts/" + encodeURIComponent(cartId) + "/items", {
        method: "POST",
        body: JSON.stringify(payload)
      });
    }
    return storefrontJson("/api/storefront/carts", {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }

  function allPhysicalCartItems(cart) {
    var lineItems = cart && (cart.lineItems || cart.line_items) ? (cart.lineItems || cart.line_items) : {};
    return lineItems.physicalItems || lineItems.physical_items || cart.physicalItems || cart.physical_items || [];
  }

  function cartLineItemId(item) {
    return item && (item.id || item.entityId || item.lineItemId || item.itemId || item.line_item_id);
  }

  function normalizeSku(value) {
    return String(value || "").replace(/[^a-z0-9+]/gi, "").toUpperCase();
  }

  function matchesCartActionItem(item, action) {
    var productId = Number(item.productId || item.product_id || item.productEntityId || item.entityId);
    var variantId = Number(item.variantId || item.variant_id || item.variantEntityId || 0);
    var sku = normalizeSku(item.sku || item.variantSku || item.productSku);
    var actionSku = normalizeSku(action.sku);
    var actionVariantId = Number(action.variantId || 0);
    if (actionSku || actionVariantId) {
      if (actionSku && sku && sku === actionSku) return true;
      return Boolean(actionVariantId && variantId && variantId === actionVariantId);
    }
    return Number(action.productId || 0) && productId && productId === Number(action.productId);
  }

  async function deleteStorefrontCartItem(cartId, item) {
    var itemId = cartLineItemId(item);
    if (!itemId) throw new Error("Could not identify cart line item");
    return storefrontJson("/api/storefront/carts/" + encodeURIComponent(cartId) + "/items/" + encodeURIComponent(itemId), {
      method: "DELETE"
    });
  }

  async function updateStorefrontCartItem(cartId, item, quantity) {
    var itemId = cartLineItemId(item);
    if (!itemId) throw new Error("Could not identify cart line item");
    var productId = Number(item.productId || item.product_id || item.productEntityId);
    var variantId = Number(item.variantId || item.variant_id || item.variantEntityId || 0);
    var lineItem = {
      productId: productId,
      quantity: Number(quantity || 1)
    };
    if (variantId) lineItem.variantId = variantId;
    return storefrontJson("/api/storefront/carts/" + encodeURIComponent(cartId) + "/items/" + encodeURIComponent(itemId), {
      method: "PUT",
      body: JSON.stringify({ lineItem: lineItem })
    });
  }

  async function applyStorefrontCartAction(action) {
    var cart = await getStorefrontCart();
    if (!cart || !cart.id) throw new Error("No active cart found");
    var items = allPhysicalCartItems(cart);

    if (action.action === "clear") {
      for (var i = 0; i < items.length; i += 1) {
        await deleteStorefrontCartItem(cart.id, items[i]);
      }
      return { ok: true };
    }

    var matched = null;
    for (var j = 0; j < items.length; j += 1) {
      if (matchesCartActionItem(items[j], action)) {
        matched = items[j];
        break;
      }
    }
    if (!matched) throw new Error("Could not find that item in the cart");

    if (action.action === "remove") return deleteStorefrontCartItem(cart.id, matched);
    if (action.action === "set_quantity") return updateStorefrontCartItem(cart.id, matched, action.quantity);
    throw new Error("Unknown cart action");
  }

  function applySize(open, nudge) {
    iframe.style.width = open ? "430px" : nudge ? "350px" : "120px";
    iframe.style.height = open ? "780px" : nudge ? "150px" : "120px";
    iframe.style.maxWidth = "100vw";
    iframe.style.maxHeight = "100dvh";
    launcherProxy.style.display = open ? "none" : "block";
    launcherProxy.style.width = nudge ? "350px" : "120px";
    launcherProxy.style.height = nudge ? "150px" : "120px";
  }

  function postToPulse(message) {
    if (!iframe.contentWindow) return;
    iframe.contentWindow.postMessage(message, origin);
  }

  function openPulse() {
    desiredOpen = true;
    postToPulse({ type: "emrn-pulse:open" });
    applySize(true, false);
  }

  function openWithSearchHelp(query) {
    var cleanQuery = String(query || "").replace(/\\s+/g, " ").trim();
    if (!cleanQuery) {
      openPulse();
      return;
    }
    desiredOpen = true;
    pendingSearchHelp = {
      type: "emrn-pulse:search-help",
      query: cleanQuery,
      requestId: String(Date.now()) + "-" + Math.random().toString(36).slice(2)
    };
    postToPulse(pendingSearchHelp);
    applySize(true, false);
  }

  function closePulse() {
    desiredOpen = false;
    postToPulse({ type: "emrn-pulse:close" });
    applySize(false, false);
  }

  window.EMRNPulse = Object.assign(window.EMRNPulse || {}, {
    open: openPulse,
    openWithSearchHelp: openWithSearchHelp,
    close: closePulse,
    sendPageContext: sendPageContext
  });

  window.addEventListener("emrn-pulse:open", openPulse);
  window.addEventListener("emrn-pulse:search-help", function (event) {
    openWithSearchHelp(event && event.detail ? event.detail.query : "");
  });
  window.addEventListener("emrn-pulse:close", closePulse);
  launcherProxy.addEventListener("click", openPulse);
  launcherProxy.addEventListener("keydown", function (event) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPulse();
    }
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== origin) return;
    if (!event.data || event.data.type !== "emrn-pulse:ready") return;
    if (pendingSearchHelp) {
      postToPulse(pendingSearchHelp);
    } else if (desiredOpen) {
      postToPulse({ type: "emrn-pulse:open" });
    }
    applySize(Boolean(event.data.open) || desiredOpen, Boolean(event.data.nudge));
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== origin) return;
    if (!event.data || event.data.type !== "emrn-pulse:resize") return;
    desiredOpen = Boolean(event.data.open);
    applySize(desiredOpen, Boolean(event.data.nudge));
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== origin) return;
    if (!event.data || event.data.type !== "emrn-pulse:cart-action") return;
    applyStorefrontCartAction(event.data.action || {})
      .then(function () {
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: "emrn-pulse:cart-action-result", ok: true }, origin);
        }
      })
      .catch(function (error) {
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage({
            type: "emrn-pulse:cart-action-result",
            ok: false,
            message: error && error.message ? error.message : "Could not update cart"
          }, origin);
        }
      });
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== origin) return;
    if (!event.data || event.data.type !== "emrn-pulse:request-page-context") return;
    sendPageContext();
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== origin) return;
    if (!event.data || event.data.type !== "emrn-pulse:add-to-cart") return;
    addItemsToStorefrontCart(event.data.items || [])
      .then(function () {
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: "emrn-pulse:add-to-cart-result", ok: true }, origin);
        }
      })
      .catch(function (error) {
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage({
            type: "emrn-pulse:add-to-cart-result",
            ok: false,
            message: error && error.message ? error.message : "Could not add to cart"
          }, origin);
        }
      });
  });

  iframe.addEventListener("load", function () {
    sendPageContext();
    if (pendingSearchHelp) {
      window.setTimeout(function () {
        postToPulse(pendingSearchHelp);
      }, 50);
    } else if (desiredOpen) {
      window.setTimeout(openPulse, 50);
    }
  });
  window.addEventListener("popstate", function () {
    window.setTimeout(sendPageContextIfChanged, 250);
  });
  document.addEventListener("click", function () {
    window.setTimeout(sendPageContextIfChanged, 450);
  });
  window.setInterval(sendPageContextIfChanged, 1500);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      document.body.appendChild(iframe);
      document.body.appendChild(launcherProxy);
    });
  } else {
    document.body.appendChild(iframe);
    document.body.appendChild(launcherProxy);
  }
})();
`;

  return new NextResponse(script, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}
