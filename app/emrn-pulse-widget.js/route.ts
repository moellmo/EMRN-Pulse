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
