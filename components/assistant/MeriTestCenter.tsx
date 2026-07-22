"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { AssistantMessage } from "@/lib/assistant/types";

type TestCase = {
  name: string;
  description: string;
  language: "en" | "fr";
  messages: AssistantMessage[];
  expect: string[];
  unsafe?: boolean;
};

type TestResult = {
  name: string;
  ok: boolean;
  output: string;
  missing: string[];
  error?: string;
};

const baseMessages = {
  quotePrompt: "Sure. For quote lookup, please send the quote number or the email used for the quote.",
  invoicePrompt: "Sure. For invoice lookup, please send the order number and the email used for the order.",
  frQuotePrompt: "Bien sûr. Pour rechercher un devis, envoyez-moi le numéro du devis ou le courriel utilisé pour le devis.",
};

const tests: TestCase[] = [
  {
    name: "Exact SKU",
    description: "SKU lookup should find the exact trauma shears product.",
    language: "en",
    messages: [{ role: "user", content: "is this available ZZ-0063" }],
    expect: ["NAR TRAUMA SHEARS", "SKU: ZZ-0063", "In stock"],
  },
  {
    name: "Quote Lookup",
    description: "Quote lookup should show details, expiration, and purchase link.",
    language: "en",
    messages: [
      { role: "user", content: "Look up a quote" },
      { role: "assistant", content: baseMessages.quotePrompt },
      { role: "user", content: "QN001611" },
    ],
    expect: ["I found quote QN001611", "Items:", "Expires:", "Purchase link:"],
  },
  {
    name: "Invoice Follow-Up",
    description: "Invoice lookup should remember the order number and ask only for email.",
    language: "en",
    messages: [
      { role: "user", content: "Find my invoice or receipt" },
      { role: "assistant", content: baseMessages.invoicePrompt },
      { role: "user", content: "9634" },
    ],
    expect: ["I have the number", "email"],
  },
  {
    name: "French Quote",
    description: "French quote lookup should return quote details in French.",
    language: "fr",
    messages: [
      { role: "user", content: "Trouver un devis" },
      { role: "assistant", content: baseMessages.frQuotePrompt },
      { role: "user", content: "QN001611" },
    ],
    expect: ["J’ai trouvé le devis QN001611", "Articles:", "Expiration:", "Lien de paiement:"],
  },
  {
    name: "Compatibility Fallback",
    description: "Compatibility answers should use a structured confidence label.",
    language: "en",
    messages: [
      { role: "user", content: "do you have Little Junior QCPR" },
      {
        role: "assistant",
        content:
          "I found this item for “Little Junior QCPR”:\n\n- Little Junior QCPR Manikin — SKU: 128-01050 — $1. [View product](https://emrn.ca/shop-all/little-junior-qcpr-cpr-training-manikin/)",
      },
      { role: "user", content: "is this compatible with Little Junior QCPR" },
    ],
    expect: ["compatible:"],
  },
  {
    name: "Laerdal QCPR Compatibility",
    description: "Optional manufacturer-style compatibility check for a Laerdal Little Junior QCPR part.",
    language: "en",
    unsafe: true,
    messages: [
      {
        role: "assistant",
        content:
          "I found this item for “Little Junior QCPR”:\n1. Little Junior QCPR Manikin — SKU: 128-01050 — [View product](https://emrn.ca/shop-all/little-junior-qcpr-cpr-training-manikin/)",
      },
      { role: "user", content: "Does the Little Junior QCPR airway fit this manikin?" },
    ],
    expect: ["compatible:"],
  },
  {
    name: "Philips AED Compatibility",
    description: "Optional compatibility check for Philips AED pads or battery questions.",
    language: "en",
    unsafe: true,
    messages: [
      {
        role: "assistant",
        content:
          "I found this item for “Philips AED”:\n1. Philips HeartStart OnSite AED — SKU: M5066A — [View product](https://emrn.ca/)",
      },
      { role: "user", content: "Are these Philips AED pads compatible with the HeartStart OnSite?" },
    ],
    expect: ["compatible:"],
  },
  {
    name: "ZOLL Electrode Compatibility",
    description: "Optional compatibility check for ZOLL electrodes.",
    language: "en",
    unsafe: true,
    messages: [
      {
        role: "assistant",
        content:
          "I found this item for “ZOLL AED”:\n1. ZOLL AED Plus — SKU: 8000-004000 — [View product](https://emrn.ca/)",
      },
      { role: "user", content: "Do these CPR-D-padz electrodes fit the ZOLL AED Plus?" },
    ],
    expect: ["compatible:"],
  },
  {
    name: "Nasco Manikin Compatibility",
    description: "Optional compatibility check for Nasco manikin replacement parts.",
    language: "en",
    unsafe: true,
    messages: [
      {
        role: "assistant",
        content:
          "I found this item for “Nasco manikin”:\n1. Nasco Healthcare Infant CPR Manikin — SKU: LF03623U — [View product](https://emrn.ca/)",
      },
      { role: "user", content: "Does the LF06203U infant lung fit this Nasco infant manikin?" },
    ],
    expect: ["compatible:"],
  },
];

function testSessionId(name: string) {
  return `meri-test-${name.replace(/\W+/g, "-").toLowerCase()}-${Date.now()}`;
}

export function MeriTestCenter() {
  const searchParams = useSearchParams();
  const [running, setRunning] = useState("");
  const [results, setResults] = useState<TestResult[]>([]);
  const [customMessages, setCustomMessages] = useState(() => searchParams.get("q") || "Check order status");
  const [customOutput, setCustomOutput] = useState("");
  const autoRunStarted = useRef(false);
  const safeTests = useMemo(() => tests.filter((test) => !test.unsafe), []);

  async function runTest(test: TestCase): Promise<TestResult> {
    setRunning(test.name);
    try {
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: testSessionId(test.name),
          language: test.language,
          messages: test.messages,
        }),
      });
      const output = await response.text();
      const lowerOutput = output.toLowerCase();
      const missing = test.expect.filter((item) => !lowerOutput.includes(item.toLowerCase()));
      return { name: test.name, ok: missing.length === 0, output, missing };
    } catch (error) {
      return {
        name: test.name,
        ok: false,
        output: "",
        missing: test.expect,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      setRunning("");
    }
  }

  async function runOne(test: TestCase) {
    const result = await runTest(test);
    setResults((current) => [result, ...current.filter((item) => item.name !== result.name)]);
  }

  async function runAll() {
    const next: TestResult[] = [];
    for (const test of safeTests) {
      next.push(await runTest(test));
      setResults([...next]);
    }
    setRunning("");
  }

  async function runCustom() {
    setRunning("Custom");
    setCustomOutput("");
    try {
      const response = await fetch("/api/assistant/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId: testSessionId("custom"),
          language: "en",
          messages: [{ role: "user", content: customMessages }],
        }),
      });
      setCustomOutput(await response.text());
    } catch (error) {
      setCustomOutput(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setRunning("");
    }
  }

  useEffect(() => {
    if (autoRunStarted.current || searchParams.get("autorun") !== "1") return;
    autoRunStarted.current = true;
    void runCustom();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  return (
    <main className="min-h-screen bg-slate-50 p-6 text-slate-950">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">Meri Test Center</h1>
            <p className="mt-2 max-w-3xl text-slate-600">
              Run safe chat-flow checks before pushing Meri changes. These tests call the same chat API as the widget.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void runAll()}
            disabled={Boolean(running)}
            className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {running ? `Running ${running}...` : "Run Safe Tests"}
          </button>
        </div>

        <section className="mt-8 grid gap-4 lg:grid-cols-2">
          {tests.map((test) => {
            const result = results.find((item) => item.name === test.name);
            return (
              <article key={test.name} className="rounded-md border border-slate-200 bg-white p-4">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold">{test.name}</h2>
                    <p className="mt-1 text-sm text-slate-600">{test.description}</p>
                    {test.unsafe ? (
                      <p className="mt-1 text-xs font-semibold text-amber-700">Optional web/manufacturer check</p>
                    ) : null}
                  </div>
                  <button
                    type="button"
                    onClick={() => void runOne(test)}
                    disabled={Boolean(running)}
                    className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
                  >
                    Run
                  </button>
                </div>
                {result ? (
                  <div className="mt-4">
                    <div className={result.ok ? "font-semibold text-green-700" : "font-semibold text-red-700"}>
                      {result.ok ? "Passed" : "Needs review"}
                    </div>
                    {result.missing.length ? (
                      <div className="mt-2 text-sm text-red-700">Missing: {result.missing.join(", ")}</div>
                    ) : null}
                    {result.error ? <div className="mt-2 text-sm text-red-700">{result.error}</div> : null}
                    <pre className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">
                      {result.output}
                    </pre>
                  </div>
                ) : null}
              </article>
            );
          })}
        </section>

        <section className="mt-8 rounded-md border border-slate-200 bg-white p-4">
          <h2 className="font-semibold">Custom One-Message Test</h2>
          <textarea
            value={customMessages}
            onChange={(event) => setCustomMessages(event.target.value)}
            className="mt-3 min-h-24 w-full rounded-md border border-slate-300 p-3 text-sm"
          />
          <button
            type="button"
            onClick={() => void runCustom()}
            disabled={Boolean(running)}
            className="mt-3 rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Run Custom
          </button>
          {customOutput ? (
            <pre className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs text-slate-700">
              {customOutput}
            </pre>
          ) : null}
        </section>
      </div>
    </main>
  );
}
