import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const origin = new URL(req.url).origin;
  const script = `
(function () {
  if (window.__EMRN_PULSE_WIDGET__) return;
  window.__EMRN_PULSE_WIDGET__ = true;

  var origin = ${JSON.stringify(origin)};
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
      var match = value.match(/(?:^|\\b)SKU\\s*[:#]?\\s*([A-Z]{1,6}\\s*-?\\s*\\d{3,}(?:-[A-Z0-9]+)*|[A-Z0-9-]{3,})\\b/i);
      if (match && match[1]) return match[1];
      if (/^[A-Z]{1,6}\\s*-?\\s*\\d{3,}(?:-[A-Z0-9]+)*$/i.test(value)) return value;
      if (/^\\d{3,}(?:-[A-Z0-9]+)*$/i.test(value)) return value;
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
    var skuMatch = skuText.match(/[A-Z]{1,6}\\s*-?\\s*\\d{3,}(?:-[A-Z0-9]+)*|[A-Z0-9]{2,}(?:-[A-Z0-9]{2,})*|\\b\\d{4,}\\b/i);

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

  function sendPageContext() {
    if (!iframe.contentWindow) return;
    iframe.contentWindow.postMessage(
      { type: "emrn-pulse:page-context", pageContext: collectPageContext() },
      origin
    );
  }

  var lastContextKey = "";
  function sendPageContextIfChanged() {
    var context = collectPageContext();
    var key = [context.url, context.title, context.sku, context.productId, context.variantId].join("|");
    if (key === lastContextKey) return;
    lastContextKey = key;
    if (!iframe.contentWindow) return;
    iframe.contentWindow.postMessage(
      { type: "emrn-pulse:page-context", pageContext: context },
      origin
    );
  }

  function applySize(open, nudge) {
    iframe.style.width = open ? "430px" : nudge ? "350px" : "120px";
    iframe.style.height = open ? "780px" : nudge ? "150px" : "120px";
    iframe.style.maxWidth = "100vw";
    iframe.style.maxHeight = "100dvh";
  }

  window.addEventListener("message", function (event) {
    if (event.origin !== origin) return;
    if (!event.data || event.data.type !== "emrn-pulse:resize") return;
    applySize(Boolean(event.data.open), Boolean(event.data.nudge));
  });

  window.addEventListener("message", function (event) {
    if (event.origin !== origin) return;
    if (!event.data || event.data.type !== "emrn-pulse:request-page-context") return;
    sendPageContext();
  });

  iframe.addEventListener("load", sendPageContext);
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
    });
  } else {
    document.body.appendChild(iframe);
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
