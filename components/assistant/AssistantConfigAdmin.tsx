"use client";

import { useState } from "react";
import type { AssistantRuntimeConfig } from "@/lib/assistant/admin-config";

type AssistantConfigAdminProps = {
  token: string;
  config: AssistantRuntimeConfig;
};

type BooleanConfigKey = Exclude<keyof Omit<AssistantRuntimeConfig, "updatedAt">, "trustedExternalDomains">;

const labels: Array<[BooleanConfigKey, string, string]> = [
  [
    "aiSearchHelperEnabled",
    "AI Search Helper",
    "ON helps messy, typo, French, and question-style searches by asking OpenAI for better EMRN search terms. Safe to keep on.",
  ],
  [
    "siteKnowledgeEnabled",
    "EMRN Knowledge Check",
    "ON lets Pulse check EMRN catalog/search evidence for compatibility and product facts. Keep on for testing and launch.",
  ],
  [
    "externalKnowledgeEnabled",
    "External Knowledge Search",
    "ON lets OpenAI verify hard product questions against approved manufacturer, supplier, catalog, marketplace, and manual sources when EMRN cannot confirm.",
  ],
  [
    "showExternalSources",
    "Show Outside Links",
    "OFF keeps customers on EMRN. If OpenAI uses outside info, it should not show competitor/manufacturer links to customers.",
  ],
  [
    "knowledgeShadowMode",
    "Shadow Mode",
    "ON means Pulse logs what the knowledge checker thinks without forcing it into the answer. Safest while testing.",
  ],
  [
    "qaDailyReminderEnabled",
    "Daily QA Reminder Email",
    "ON sends one daily email to the admin reminder address only when the QA Queue has questions to review. Turn off anytime if you do not want reminders.",
  ],
  [
    "answerCacheEnabled",
    "Answer Cache",
    "ON lets Meri reuse recent successful product/compatibility answers for speed. It never caches quote, invoice, order, cart, support, availability, no-product, or can’t-confirm answers.",
  ],
];

export function AssistantConfigAdmin({ token, config }: AssistantConfigAdminProps) {
  const [draft, setDraft] = useState(config);
  const [trustedDomainsText, setTrustedDomainsText] = useState((config.trustedExternalDomains || []).join("\n"));
  const [status, setStatus] = useState("");

  async function save() {
    setStatus("Saving...");
    try {
      const payload = {
        ...draft,
        trustedExternalDomains: trustedDomainsText
          .split(/[\n,]+/)
          .map((item) => item.trim())
          .filter(Boolean),
      };
      const response = await fetch("/api/assistant/admin/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });
      const saved = await response.json();
      if (!response.ok) throw new Error(saved?.error || "Save failed");
      setDraft(saved);
      setTrustedDomainsText((saved.trustedExternalDomains || []).join("\n"));
      setStatus("Saved. New assistant requests will use this config.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Save failed");
    }
  }

  return (
    <section className="mt-8 rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold">Assistant Controls</h2>
      <p className="mt-1 text-sm text-slate-600">
        Safe default for now: AI Search Helper on, EMRN Knowledge Check on, Outside Links off, Shadow Mode on.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        {labels.map(([key, label, help]) => (
          <label key={key} className="flex items-start gap-3 rounded-md border border-slate-200 p-3">
            <input
              type="checkbox"
              checked={Boolean(draft[key])}
              onChange={(event) => setDraft((current) => ({ ...current, [key]: event.target.checked }))}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-semibold text-slate-800">{label}</span>
              <span className="block text-xs text-slate-500">{help}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="mt-4 rounded-md border border-slate-200 p-3">
        <label className="block text-sm font-semibold text-slate-800" htmlFor="trusted-domains">
          Extra Trusted External Domains
        </label>
        <p className="mt-1 text-xs text-slate-500">
          Add official brand/manufacturer sites or approved supplier/catalog sites for hard product questions. Use one domain per line.
        </p>
        <textarea
          id="trusted-domains"
          value={trustedDomainsText}
          onChange={(event) => setTrustedDomainsText(event.target.value)}
          className="mt-3 min-h-28 w-full rounded-md border border-slate-200 p-3 text-sm text-slate-800"
          placeholder={"statpacks.com\nbrandwebsite.com"}
        />
        <p className="mt-2 text-xs text-slate-500">
          Customer replies still hide outside links when Show Outside Links is off.
        </p>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
          Save Assistant Controls
        </button>
        {status ? <span className="text-sm text-slate-600">{status}</span> : null}
        {draft.updatedAt ? <span className="text-xs text-slate-400">Updated {draft.updatedAt}</span> : null}
      </div>
    </section>
  );
}
