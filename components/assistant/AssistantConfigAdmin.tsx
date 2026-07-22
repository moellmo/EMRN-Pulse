"use client";

import { useState } from "react";
import type { AssistantRuntimeConfig } from "@/lib/assistant/admin-config";

type AssistantConfigAdminProps = {
  token: string;
  config: AssistantRuntimeConfig;
};

const labels: Array<[keyof Omit<AssistantRuntimeConfig, "updatedAt">, string, string]> = [
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
];

export function AssistantConfigAdmin({ token, config }: AssistantConfigAdminProps) {
  const [draft, setDraft] = useState(config);
  const [status, setStatus] = useState("");

  async function save() {
    setStatus("Saving...");
    try {
      const response = await fetch("/api/assistant/admin/config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(draft),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Save failed");
      setDraft(payload);
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
