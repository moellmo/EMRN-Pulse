"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { AssistantLanguage, AssistantMessage, ProductPageContext } from "@/lib/assistant/types";

type AssistantChatProps = {
  mode?: "embedded" | "floating";
};

type UiText = {
  greeting: string;
  placeholder: string;
  online: string;
  openLabel: string;
  closeLabel: string;
  minimizeLabel: string;
  menuLabel: string;
  resetLabel: string;
  sendLabel: string;
  typing: string;
  retry: string;
  error: string;
  proactivePrompt: string;
  proactiveDismiss: string;
  quickActions: Array<{ label: string; prompt: string; icon: "search" | "quote" | "box" | "truck" | "mail" }>;
};

const brand = "#c34d50";
const SESSION_KEY = "emrn-pulse-session-id";
const STORAGE_PREFIX = "emrn-pulse-chat";
const NUDGE_DISMISSED_KEY = "emrn-pulse-nudge-dismissed";

function storedLanguage() {
  if (typeof window === "undefined") return "en";
  const savedLanguage = localStorage.getItem(`${STORAGE_PREFIX}:language`);
  return savedLanguage === "fr" ? "fr" : "en";
}

function storedMessages(mode: "embedded" | "floating", language: "en" | "fr") {
  if (typeof window === "undefined") return initialMessages(mode, language);
  const savedMessages = localStorage.getItem(`${STORAGE_PREFIX}:messages`);
  if (!savedMessages) return initialMessages(mode, language);

  try {
    const parsed = JSON.parse(savedMessages) as AssistantMessage[];
    if (isOldDemoConversation(parsed)) return initialMessages(mode, language);
    return Array.isArray(parsed) && parsed.length ? parsed : initialMessages(mode, language);
  } catch {
    localStorage.removeItem(`${STORAGE_PREFIX}:messages`);
    return initialMessages(mode, language);
  }
}

function isOldDemoConversation(messages: AssistantMessage[]) {
  return messages.some((message) =>
    /I need a quote for 10 CPR manikins for training|J’ai besoin d’un devis pour 10 mannequins de RCR/i.test(
      message.content
    )
  );
}

const ui: Record<"en" | "fr", UiText> = {
  en: {
    greeting:
      "Hi! I’m Meri 👋\nI can help you find products, compare options, check availability, request a quote, or connect you with our team. What can I help you with today?",
    placeholder: "Type your message...",
    online: "Meri is online",
    openLabel: "Open EMRN Pulse",
    closeLabel: "Close EMRN Pulse",
    minimizeLabel: "Minimize EMRN Pulse",
    menuLabel: "Start over",
    resetLabel: "Start over",
    sendLabel: "Send message",
    typing: "Meri is checking EMRN data...",
    retry: "Retry",
    error: "I’m sorry, I could not complete that request. Would you like me to send this to our support team?",
    proactivePrompt: "Need help finding a product? I can help.",
    proactiveDismiss: "Dismiss help message",
    quickActions: [
      { label: "Find a Product", prompt: "Find a product", icon: "search" },
      { label: "Request a Quote", prompt: "I need a quote", icon: "quote" },
      { label: "Check Availability", prompt: "Can you check availability?", icon: "box" },
      { label: "Check Order Status", prompt: "Check order status", icon: "truck" },
      { label: "Contact Us", prompt: "Contact support", icon: "mail" },
    ],
  },
  fr: {
    greeting:
      "Bonjour! Je suis Meri 👋\nJe peux vous aider à trouver des produits, comparer des options, vérifier la disponibilité, demander un devis ou communiquer avec notre équipe. Comment puis-je vous aider aujourd’hui?",
    placeholder: "Tapez votre message...",
    online: "Meri est en ligne",
    openLabel: "Ouvrir EMRN Pulse",
    closeLabel: "Fermer EMRN Pulse",
    minimizeLabel: "Réduire EMRN Pulse",
    menuLabel: "Recommencer",
    resetLabel: "Recommencer",
    sendLabel: "Envoyer le message",
    typing: "Meri vérifie les données EMRN...",
    retry: "Réessayer",
    error:
      "Je suis désolée, je n’ai pas pu compléter cette demande. Voulez-vous que je l’envoie à notre équipe de support?",
    proactivePrompt: "Besoin d’aide pour trouver un produit? Je peux vous aider.",
    proactiveDismiss: "Masquer le message d’aide",
    quickActions: [
      { label: "Trouver un produit", prompt: "Je cherche un produit", icon: "search" },
      { label: "Demander un devis", prompt: "J’ai besoin d’un devis", icon: "quote" },
      { label: "Vérifier la disponibilité", prompt: "Pouvez-vous vérifier la disponibilité?", icon: "box" },
      { label: "Suivi de commande", prompt: "Je veux vérifier le statut de ma commande", icon: "truck" },
      { label: "Nous contacter", prompt: "Contacter le support", icon: "mail" },
    ],
  },
};

export function AssistantChat({ mode = "embedded" }: AssistantChatProps) {
  const [language, setLanguage] = useState<AssistantLanguage>(() => storedLanguage());
  const [messages, setMessages] = useState<AssistantMessage[]>(() => storedMessages(mode, storedLanguage()));
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [isOpen, setIsOpen] = useState(mode === "embedded");
  const [showNudge, setShowNudge] = useState(false);
  const [pageContext, setPageContext] = useState<ProductPageContext>({});
  const [lastPrompt, setLastPrompt] = useState("");
  const [hasError, setHasError] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const postedCartTokensRef = useRef<Set<string>>(new Set());
  const handledExternalRequestsRef = useRef<Set<string>>(new Set());
  const [pendingExternalPrompt, setPendingExternalPrompt] = useState("");
  const currentLanguage = language === "fr" ? "fr" : "en";
  const text = ui[currentLanguage];

  const [sessionId, setSessionId] = useState(() => {
    if (typeof window === "undefined") return "server";
    const existing = localStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
    return id;
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  useEffect(() => {
    if (typeof window === "undefined" || sessionId === "server") return;
    localStorage.setItem(`${STORAGE_PREFIX}:language`, currentLanguage);
    localStorage.setItem(`${STORAGE_PREFIX}:messages`, JSON.stringify(messages.slice(-40)));
  }, [currentLanguage, messages, sessionId]);

  useEffect(() => {
    if (mode !== "floating" || !isOpen || typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      setShowNudge(false);
      textareaRef.current?.focus();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [isOpen, mode]);

  useEffect(() => {
    if (mode !== "floating" || typeof window === "undefined") return;
    window.parent?.postMessage({ type: "emrn-pulse:resize", open: isOpen, nudge: showNudge }, "*");
  }, [isOpen, mode, showNudge]);

  useEffect(() => {
    if (mode !== "floating" || isOpen || typeof window === "undefined") return;
    if (localStorage.getItem(NUDGE_DISMISSED_KEY) === "true") return;

    const timer = window.setTimeout(() => {
      if (!isOpen) setShowNudge(true);
    }, 12000);

    return () => window.clearTimeout(timer);
  }, [isOpen, mode]);

  useEffect(() => {
    if (mode !== "floating" || typeof window === "undefined") return;

    function handleMessage(event: MessageEvent) {
      if (!event.data) return;
      if (event.data.type === "emrn-pulse:open") {
        localStorage.setItem(NUDGE_DISMISSED_KEY, "true");
        setShowNudge(false);
        setIsOpen(true);
        return;
      }
      if (event.data.type === "emrn-pulse:search-help") {
        const requestId = String(event.data.requestId || event.data.query || "");
        const query = String(event.data.query || "").replace(/\s+/g, " ").trim();
        if (!query || handledExternalRequestsRef.current.has(requestId)) return;
        handledExternalRequestsRef.current.add(requestId);
        localStorage.setItem(NUDGE_DISMISSED_KEY, "true");
        setShowNudge(false);
        setIsOpen(true);
        setPendingExternalPrompt(
          currentLanguage === "fr"
            ? `La recherche intelligente n’a pas trouvé « ${query} ». Est-ce qu’EMRN peut vérifier cet article, le trouver ou préparer un devis?`
            : `Smart Search could not find “${query}”. Can EMRN check this item, source it, or prepare a quote?`
        );
        return;
      }
      if (event.data.type === "emrn-pulse:close") {
        setShowNudge(false);
        setIsOpen(false);
        return;
      }
      if (event.data.type !== "emrn-pulse:page-context") return;
      setPageContext(event.data.pageContext || {});
    }

    window.addEventListener("message", handleMessage);
    window.parent?.postMessage({ type: "emrn-pulse:request-page-context" }, "*");
    return () => window.removeEventListener("message", handleMessage);
  }, [currentLanguage, mode]);

  function switchLanguage(nextLanguage: "en" | "fr") {
    setLanguage(nextLanguage);
    setMessages((current) => {
      if (mode === "embedded" && current.length <= 3) {
        return initialMessages(mode, nextLanguage);
      }

      if (current.length === 1 && current[0].role === "assistant") {
        return [{ role: "assistant", content: ui[nextLanguage].greeting, createdAt: new Date().toISOString() }];
      }

      return [
        ...current,
        {
          role: "assistant",
          content:
            nextLanguage === "fr"
              ? "Bien sûr. Je vais continuer en français."
              : "Of course. I’ll continue in English.",
          createdAt: new Date().toISOString(),
        },
      ];
    });
  }

  function resetConversation(nextLanguage: "en" | "fr" = currentLanguage) {
    const nextSessionId = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, nextSessionId);
    localStorage.removeItem(`${STORAGE_PREFIX}:messages`);
    localStorage.setItem(`${STORAGE_PREFIX}:language`, nextLanguage);
    setSessionId(nextSessionId);
    setLanguage(nextLanguage);
    setMessages(initialMessages(mode, nextLanguage));
    setInput("");
    setLastPrompt("");
    setHasError(false);
    setBusy(false);
  }

  async function sendMessage(textToSend: string, options: { freshContext?: boolean } = {}) {
    const clean = textToSend.trim();
    if (!clean || busy) return;

    setLastPrompt(clean);
    setHasError(false);
    const baseMessages = options.freshContext ? initialMessages(mode, currentLanguage) : messages;
    const nextMessages = [...baseMessages, { role: "user" as const, content: clean, createdAt: new Date().toISOString() }];
    setMessages([...nextMessages, { role: "assistant", content: "", createdAt: new Date().toISOString() }]);
    setInput("");
    setBusy(true);

    try {
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, sessionId, language: currentLanguage, pageContext }),
      });

      if (!response.ok || !response.body) throw new Error("Assistant request failed");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let answer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        setMessages([...nextMessages, { role: "assistant", content: stripCartItemsToken(answer), createdAt: new Date().toISOString() }]);
      }

      const cartPayload = extractCartItemsToken(answer);
      if (cartPayload && mode === "floating" && typeof window !== "undefined") {
        const tokenKey = JSON.stringify(cartPayload.items);
        if (!postedCartTokensRef.current.has(tokenKey)) {
          postedCartTokensRef.current.add(tokenKey);
          window.parent?.postMessage({ type: "emrn-pulse:add-to-cart", items: cartPayload.items }, "*");
        }
      }
      const cartAction = extractCartActionToken(answer);
      if (cartAction && mode === "floating" && typeof window !== "undefined") {
        const tokenKey = JSON.stringify(cartAction);
        if (!postedCartTokensRef.current.has(tokenKey)) {
          postedCartTokensRef.current.add(tokenKey);
          window.parent?.postMessage({ type: "emrn-pulse:cart-action", action: cartAction }, "*");
        }
      }
    } catch {
      setHasError(true);
      setMessages([
        ...nextMessages,
        {
          role: "assistant",
          content: text.error,
          createdAt: new Date().toISOString(),
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!pendingExternalPrompt || busy) return;
    const prompt = pendingExternalPrompt;
    const timer = window.setTimeout(() => {
      setPendingExternalPrompt("");
      void sendMessage(prompt, { freshContext: true });
    }, 0);
    return () => window.clearTimeout(timer);
    // sendMessage intentionally reads the latest chat state when the queued prompt fires.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, pendingExternalPrompt]);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(input);
  }

  function onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage(input);
    }
  }

  const panel = (
    <section
      className={[
        "emrn-chat-panel emrn-pulse-panel flex min-h-0 flex-col overflow-hidden border bg-white shadow-[0_18px_55px_rgba(23,28,38,0.14)]",
        mode === "floating"
          ? "fixed bottom-[calc(env(safe-area-inset-bottom)+86px)] right-[calc(env(safe-area-inset-right)+18px)] z-[99998] h-[min(680px,calc(100dvh-118px))] w-[390px] max-w-[calc(100vw-20px)] rounded-[18px] max-sm:bottom-[calc(env(safe-area-inset-bottom)+76px)] max-sm:left-[10px] max-sm:right-[10px] max-sm:w-auto"
          : "h-[640px] w-full rounded-[18px] sm:h-[680px] lg:w-[520px]",
      ].join(" ")}
      style={{ borderColor: "#eadfdd" }}
      aria-label="EMRN Pulse chat"
    >
      <header className="emrn-pulse-header flex items-center justify-between px-4 py-3 text-white" style={{ backgroundColor: brand }}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="emrn-pulse-avatar emrn-pulse-avatar--header" aria-hidden="true">
            <img
              src="/emrn-pulse/meri-avatar.png"
              alt=""
              draggable={false}
            />
          </div>
          <div className="emrn-pulse-header-copy min-w-0">
            <h2 className="emrn-pulse-title truncate text-[22px] font-bold leading-tight tracking-normal">EMRN Pulse</h2>
            <div className="emrn-pulse-status mt-0.5 flex items-center gap-1.5 text-[13px] text-white/95">
              <span className="emrn-pulse-status-dot h-2.5 w-2.5 rounded-full bg-[#32c56c]" aria-hidden="true" />
              <span>{text.online}</span>
            </div>
          </div>
        </div>
        <div className="emrn-pulse-header-actions flex items-center gap-1.5">
          <IconButton label={text.resetLabel} onClick={() => resetConversation()}>
            <Icon name="refresh" />
          </IconButton>
          {mode === "floating" ? (
            <IconButton label={text.minimizeLabel} onClick={() => setIsOpen(false)}>
              <Icon name="minus" />
            </IconButton>
          ) : (
            <IconButton label={text.minimizeLabel}>
              <Icon name="minus" />
            </IconButton>
          )}
        </div>
      </header>

      <div className="emrn-pulse-body flex-1 overflow-y-auto bg-white px-4 py-5 sm:px-5" aria-live="polite">
        <div className="space-y-4">
          {messages.map((message, index) => (
            <MessageBubble key={`${message.role}-${index}`} message={message} />
          ))}
          {busy ? (
            <div className="flex items-center gap-2 pl-[52px] text-xs font-medium" style={{ color: "#7a7371" }}>
              <span className="emrn-typing-dot" />
              {text.typing}
            </div>
          ) : null}
          {hasError && lastPrompt ? (
            <button
              type="button"
              onClick={() => void sendMessage(lastPrompt)}
              className="ml-[52px] rounded-full border px-3 py-1.5 text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ borderColor: brand, color: brand, outlineColor: brand }}
            >
              {text.retry}
            </button>
          ) : null}
          <div ref={bottomRef} />
        </div>
      </div>

      <div className="emrn-pulse-composer border-t bg-white px-4 py-3" style={{ borderColor: "#eadfdd" }}>
        <div className="emrn-pulse-quick-actions mb-3 flex flex-wrap gap-2">
          {text.quickActions.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => void sendMessage(action.prompt, { freshContext: true })}
              className="emrn-pulse-quick-action inline-flex min-h-9 items-center gap-2 rounded-full border bg-white px-3 text-[13px] font-semibold transition hover:bg-[#faf7f6] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
              style={{ borderColor: brand, color: brand, outlineColor: brand }}
            >
              <Icon name={action.icon} />
              <span>{action.label}</span>
            </button>
          ))}
        </div>

        <form onSubmit={onSubmit} className="emrn-pulse-input-wrap flex items-end gap-2">
          <label className="sr-only" htmlFor={`${mode}-emrn-pulse-input`}>
            {text.placeholder}
          </label>
          <textarea
            ref={textareaRef}
            id={`${mode}-emrn-pulse-input`}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onComposerKeyDown}
            placeholder={text.placeholder}
            rows={1}
            className="emrn-pulse-input"
            style={{ borderColor: "#eadfdd" }}
          />
          <button
            type="submit"
            disabled={!input.trim() || busy}
            aria-label={text.sendLabel}
            className="emrn-pulse-send flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full text-white shadow-[0_8px_18px_rgba(195,77,80,0.28)] transition hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-45"
            style={{ backgroundColor: brand, outlineColor: brand }}
          >
            <Icon name="send" />
          </button>
        </form>

        <div className="emrn-pulse-language mt-3 flex items-center justify-center gap-5 text-sm text-[#171c26]">
          <button
            type="button"
            onClick={() => switchLanguage("en")}
            className="rounded px-2 py-1 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ color: currentLanguage === "en" ? brand : "#171c26", outlineColor: brand }}
            aria-pressed={currentLanguage === "en"}
          >
            <Icon name="globe" />
            <span>English</span>
          </button>
          <span className="h-6 w-px bg-[#d8cecb]" aria-hidden="true" />
          <button
            type="button"
            onClick={() => switchLanguage("fr")}
            className="rounded px-2 py-1 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ color: currentLanguage === "fr" ? brand : "#171c26", outlineColor: brand }}
            aria-pressed={currentLanguage === "fr"}
          >
            <Icon name="fleur" />
            <span>Français</span>
          </button>
        </div>
      </div>
    </section>
  );

  if (mode === "embedded") return panel;

  const openChat = () => {
    localStorage.setItem(NUDGE_DISMISSED_KEY, "true");
    setShowNudge(false);
    setIsOpen(true);
  };

  const dismissNudge = () => {
    localStorage.setItem(NUDGE_DISMISSED_KEY, "true");
    setShowNudge(false);
  };

  return (
    <>
      {isOpen ? panel : null}
      {!isOpen && showNudge ? (
        <div className="emrn-pulse-nudge" role="status">
          <button type="button" className="emrn-pulse-nudge-main" onClick={openChat}>
            {text.proactivePrompt}
          </button>
          <button
            type="button"
            className="emrn-pulse-nudge-close"
            onClick={dismissNudge}
            aria-label={text.proactiveDismiss}
          >
            ×
          </button>
        </div>
      ) : null}
      <button
        type="button"
        aria-label={isOpen ? text.closeLabel : text.openLabel}
        onClick={() => {
          localStorage.setItem(NUDGE_DISMISSED_KEY, "true");
          setShowNudge(false);
          setIsOpen((current) => !current);
        }}
        className="emrn-pulse-launcher"
        style={{ outlineColor: brand }}
      >
        <img
          src="/emrn-pulse/meri-mascot-transparent.png"
          alt=""
          draggable={false}
        />
      </button>
    </>
  );
}

function initialMessages(mode: "embedded" | "floating", language: "en" | "fr"): AssistantMessage[] {
  const createdAt = new Date().toISOString();

  return [{ role: "assistant", content: ui[language].greeting, createdAt }];
}

function MessageBubble({ message }: { message: AssistantMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`emrn-pulse-message-row flex items-start gap-3 ${isUser ? "emrn-pulse-message-row--customer justify-end" : "justify-start"}`}>
      {!isUser ? (
        <div className="emrn-pulse-avatar emrn-pulse-avatar--message mt-1" aria-hidden="true">
          <img
            src="/emrn-pulse/meri-avatar.png"
            alt=""
            draggable={false}
          />
        </div>
      ) : null}
      <div
        className={[
          "emrn-pulse-message whitespace-pre-line rounded-[18px] px-4 py-3 text-[15px] leading-6 shadow-sm",
          isUser
            ? "emrn-pulse-message--customer rounded-br-md text-white"
            : "emrn-pulse-message--assistant rounded-bl-md border text-[#171c26]",
        ].join(" ")}
        style={{
          backgroundColor: isUser ? brand : "#f4f2f1",
          borderColor: isUser ? brand : "#ece6e4",
        }}
      >
        <FormattedMessage content={message.content || " "} isUser={isUser} />
      </div>
    </div>
  );
}

function FormattedMessage({ content, isUser }: { content: string; isUser: boolean }) {
  const lines = content.split("\n");

  return (
    <div className="emrn-pulse-message-content">
      {lines.map((line, index) => {
        const cleanLine = line.trim();
        if (!cleanLine) return <div key={index} className="h-2" aria-hidden="true" />;

        const bullet = cleanLine.match(/^[-*]\s+(.+)$/);
        if (bullet) {
          return (
            <div key={index} className="emrn-pulse-message-bullet">
              <span aria-hidden="true">•</span>
              <span>{renderInlineMessage(bullet[1], isUser)}</span>
            </div>
          );
        }

        return <p key={index}>{renderInlineMessage(cleanLine, isUser)}</p>;
      })}
    </div>
  );
}

function renderInlineMessage(text: string, isUser: boolean) {
  const parts = text.replace(/\*\*(.*?)\*\*/g, "$1").split(/(https?:\/\/[^\s)]+)/g);

  return parts.map((part, index) => {
    if (/^https?:\/\//.test(part)) {
      const normalizedPart = normalizeDisplayedUrl(part);
      const label = normalizedPart.includes("/checkout")
        ? "Checkout"
        : /\/cart(?:\.php)?(?:[?#]|$)/i.test(normalizedPart)
          ? "Cart"
          : "View product";
      return (
        <a
          key={`${part}-${index}`}
          href={normalizedPart}
          target="_blank"
          rel="noreferrer"
          className={isUser ? "underline decoration-white/70 underline-offset-2" : "emrn-pulse-message-link"}
        >
          {label}
        </a>
      );
    }

    return <span key={`${part}-${index}`}>{part}</span>;
  });
}

function stripCartItemsToken(value: string) {
  return value.replace(/\s*\[\[EMRN_CART_(?:ITEMS|ACTION):[A-Za-z0-9+/=]+]]\s*/g, "").trimEnd();
}

function extractCartItemsToken(value: string) {
  const match = value.match(/\[\[EMRN_CART_ITEMS:([A-Za-z0-9+/=]+)]]/);
  if (!match?.[1] || typeof window === "undefined") return null;

  try {
    const items = JSON.parse(window.atob(match[1])) as Array<{
      productId: number;
      variantId?: number;
      quantity: number;
    }>;
    const cleanItems = items
      .map((item) => ({
        productId: Number(item.productId),
        variantId: item.variantId ? Number(item.variantId) : undefined,
        quantity: Math.max(1, Number(item.quantity || 1)),
      }))
      .filter((item) => item.productId && item.quantity > 0);
    return cleanItems.length ? { items: cleanItems } : null;
  } catch {
    return null;
  }
}

function extractCartActionToken(value: string) {
  const match = value.match(/\[\[EMRN_CART_ACTION:([A-Za-z0-9+/=]+)]]/);
  if (!match?.[1] || typeof window === "undefined") return null;

  try {
    const action = JSON.parse(window.atob(match[1])) as {
      action?: string;
      sku?: string;
      productId?: number;
      variantId?: number;
      quantity?: number;
    };
    const actionType = String(action.action || "");
    if (!/^(remove|set_quantity|clear)$/.test(actionType)) return null;
    return {
      action: actionType,
      sku: action.sku ? String(action.sku) : undefined,
      productId: action.productId ? Number(action.productId) : undefined,
      variantId: action.variantId ? Number(action.variantId) : undefined,
      quantity: action.quantity ? Math.max(1, Number(action.quantity)) : undefined,
    };
  } catch {
    return null;
  }
}

function normalizeDisplayedUrl(value: string) {
  try {
    const url = new URL(value);
    if (/^\/cart\/?$/i.test(url.pathname)) {
      return "https://emrn.ca/cart.php";
    }
    return url.toString();
  } catch {
    return value;
  }
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="emrn-pulse-icon-button flex h-9 w-9 items-center justify-center rounded-full text-white/95 transition hover:bg-white/15 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
    >
      {children}
    </button>
  );
}

export function MeriMascot({ className = "" }: { className?: string }) {
  return (
    <img
      src="/emrn-pulse/meri-mascot-transparent.png"
      alt=""
      className={`emrn-pulse-mascot ${className}`}
      draggable={false}
    />
  );
}

export function Icon({ name }: { name: "search" | "quote" | "box" | "send" | "menu" | "minus" | "refresh" | "heart" | "shield" | "truck" | "leaf" | "lock" | "cart" | "mail" | "globe" | "fleur" | "kit" | "spark" | "people" }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (name) {
    case "search":
      return <svg {...common}><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>;
    case "quote":
      return <svg {...common}><path d="M6 3h9l4 4v14H6z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></svg>;
    case "box":
      return <svg {...common}><path d="m21 8-9-5-9 5 9 5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>;
    case "send":
      return <svg {...common}><path d="M22 2 11 13" /><path d="m22 2-7 20-4-9-9-4z" /></svg>;
    case "menu":
      return <svg {...common}><circle cx="12" cy="5" r="1" fill="currentColor" /><circle cx="12" cy="12" r="1" fill="currentColor" /><circle cx="12" cy="19" r="1" fill="currentColor" /></svg>;
    case "minus":
      return <svg {...common}><path d="M5 12h14" /></svg>;
    case "refresh":
      return <svg {...common}><path d="M21 12a9 9 0 0 1-15.5 6.2" /><path d="M3 12A9 9 0 0 1 18.5 5.8" /><path d="M18 2v4h-4" /><path d="M6 22v-4h4" /></svg>;
    case "heart":
      return <svg {...common}><path d="M20.8 5.6a5.2 5.2 0 0 0-7.4 0L12 7l-1.4-1.4a5.2 5.2 0 1 0-7.4 7.4L12 21l8.8-8a5.2 5.2 0 0 0 0-7.4z" fill="currentColor" stroke="none" /></svg>;
    case "shield":
      return <svg {...common}><path d="M12 3 4 6v6c0 5 3.4 8.8 8 10 4.6-1.2 8-5 8-10V6z" /><path d="M12 9v7M8.5 12.5h7" /></svg>;
    case "truck":
      return <svg {...common}><path d="M3 6h11v10H3zM14 10h4l3 3v3h-7z" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></svg>;
    case "leaf":
      return <svg {...common}><path d="M12 22c-1-5 1-10 8-16-7 0-14 3-15 10-1 4 2 6 7 6z" fill="currentColor" stroke="none" /></svg>;
    case "lock":
      return <svg {...common}><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
    case "cart":
      return <svg {...common}><path d="M6 6h15l-2 8H8z" /><path d="M6 6 5 3H2" /><circle cx="9" cy="20" r="1.5" /><circle cx="18" cy="20" r="1.5" /></svg>;
    case "mail":
      return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 7 9-7" /></svg>;
    case "globe":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>;
    case "fleur":
      return <svg {...common}><path d="M12 21v-7" /><path d="M8.5 17.5c1.2.1 2.3-.5 3.5-2 1.2 1.5 2.3 2.1 3.5 2" /><path d="M12 3c-2.7 2.3-2.7 5.3 0 8 2.7-2.7 2.7-5.7 0-8z" /><path d="M5.8 8.8c-.8 2.8.6 5 4.1 6.5.3-3.3-1-5.5-4.1-6.5z" /><path d="M18.2 8.8c.8 2.8-.6 5-4.1 6.5-.3-3.3 1-5.5 4.1-6.5z" /></svg>;
    case "kit":
      return <svg {...common}><rect x="4" y="7" width="16" height="13" rx="2" /><path d="M9 7V5h6v2M12 10v6M9 13h6" /></svg>;
    case "spark":
      return <svg {...common}><path d="M12 2l1.6 6.4L20 10l-6.4 1.6L12 18l-1.6-6.4L4 10l6.4-1.6z" fill="currentColor" stroke="none" /></svg>;
    case "people":
      return <svg {...common}><path d="M16 11a4 4 0 1 0-8 0" /><path d="M4 20c1-4 5-6 8-6s7 2 8 6" /><path d="M18 10a3 3 0 0 1 3 3M6 10a3 3 0 0 0-3 3" /></svg>;
  }
}
