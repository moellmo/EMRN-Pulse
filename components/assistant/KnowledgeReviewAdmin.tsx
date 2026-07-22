"use client";

import { useState } from "react";
import type { KnowledgeMemoryItem, KnowledgeMemoryStatus, KnowledgeMemoryType } from "@/lib/assistant/knowledge-memory";

type FailedRow = {
  createdAt: string;
  type: string;
  query?: string;
  language?: string;
  sessionId?: string;
};

type KnowledgeReviewAdminProps = {
  token: string;
  items: KnowledgeMemoryItem[];
  failedSearches: FailedRow[];
  initialDraft?: Partial<typeof emptyDraft>;
};

const typeOptions: KnowledgeMemoryType[] = ["alias", "preferred_product", "compatibility", "replacement_part", "color_option", "note"];
const statusOptions: KnowledgeMemoryStatus[] = ["approved", "needs_review", "disabled"];
const answerOptions: Array<NonNullable<KnowledgeMemoryItem["answer"]>> = ["", "confirmed", "not_compatible", "cant_confirm"];

const typeHelp: Record<KnowledgeMemoryType, { title: string; useWhen: string; example: string; fields: string }> = {
  alias: {
    title: "Alias: customer wording means another search term",
    useWhen: "Use this for French words, misspellings, abbreviations, or customer wording that should search better.",
    example: "Example: electrodes pour Philips FRx -> Philips FRx SMART Pads II.",
    fields: "Fill Customer Query and Correct Search Terms. Add Correct SKU only if one exact product should win.",
  },
  preferred_product: {
    title: "Preferred product: one SKU should rank first",
    useWhen: "Use this when you know the exact EMRN product that should show first for a question or search.",
    example: "Example: what AED pads work with Philips FRx -> SKU 989803139261.",
    fields: "Fill Customer Query, Correct SKU, and helpful Correct Search Terms.",
  },
  compatibility: {
    title: "Compatibility: does item A work with item B?",
    useWhen: "Use this for works with, fits, compatible with, goes with, or does not fit questions.",
    example: "Example: FRx SMART Pads II are compatible with Philips FRx.",
    fields: "Fill Customer Query, Answer, and Correct SKU if known. Use Note to explain the proof in plain language.",
  },
  replacement_part: {
    title: "Replacement part: part/accessory for a parent product",
    useWhen: "Use this when the customer needs pads, lungs, batteries, airways, cables, or parts for a product.",
    example: "Example: replacement lungs for Little Junior QCPR -> Little Junior QCPR airways/lungs.",
    fields: "Fill Customer Query, Correct Search Terms, and Answer if this is a verified fit. Add Correct SKU if one exact part should win.",
  },
  color_option: {
    title: "Color/option: teach available or unavailable options",
    useWhen: "Use this for colors, sizes, versions, or when a requested option does not exist.",
    example: "Example: orange G3 Load N Go -> no orange; offer blue, red, tactical black.",
    fields: "Fill Customer Query, Correct Search Terms, and Note with the available options.",
  },
  note: {
    title: "Note: general staff instruction",
    useWhen: "Use this for broad behavior guidance that is not tied to one exact product.",
    example: "Example: training pads should not outrank real AED pads unless customer says training.",
    fields: "Fill Customer Query and Note. Add search terms only if it should also improve search.",
  },
};

const emptyDraft = {
  type: "alias" as KnowledgeMemoryType,
  query: "",
  correctSearchTerms: "",
  correctSku: "",
  relatedSku: "",
  answer: "" as KnowledgeMemoryItem["answer"],
  sourceUrl: "",
  note: "",
  status: "approved" as KnowledgeMemoryStatus,
};

export function KnowledgeReviewAdmin({ token, items, failedSearches, initialDraft }: KnowledgeReviewAdminProps) {
  const [memoryItems, setMemoryItems] = useState(items);
  const [draft, setDraft] = useState({ ...emptyDraft, ...(initialDraft || {}) });
  const [status, setStatus] = useState(initialDraft?.query ? "Prefilled from a performance row. Review, choose the answer, then save." : "");

  function fillFailedQuery(query = "") {
    setDraft((current) => ({ ...current, query }));
  }

  async function save() {
    setStatus("Saving...");
    try {
      const response = await fetch("/api/assistant/admin/knowledge", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(draft),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Save failed");
      setMemoryItems((current) => [payload, ...current.filter((item) => item.id !== payload.id)]);
      setDraft(emptyDraft);
      setStatus("Saved. Approved rows are used as extra EMRN search hints.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Save failed");
    }
  }

  async function remove(id: string) {
    setStatus("Deleting...");
    const response = await fetch("/api/assistant/admin/knowledge", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ deleteId: id }),
    });
    if (response.ok) {
      setMemoryItems((current) => current.filter((item) => item.id !== id));
      setStatus("Deleted.");
    } else {
      setStatus("Delete failed.");
    }
  }

  return (
    <section className="mt-8 rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold">Knowledge Review & Corrections</h2>
      <p className="mt-1 text-sm text-slate-600">
        Teach Pulse approved aliases, preferred SKUs, compatibility facts, replacement parts, and color-option rules.
      </p>
      {initialDraft?.query ? (
        <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          This row was prefilled from Performance. Add the correct SKU, exact search terms, answer, and proof note before saving.
        </div>
      ) : null}
      <details className="mt-3 rounded-md border border-blue-100 bg-blue-50 p-3 text-sm text-blue-950">
        <summary className="cursor-pointer font-semibold">What type should I use?</summary>
        <div className="mt-3 grid gap-2 md:grid-cols-2">
          {typeOptions.map((type) => (
            <div key={type} className="rounded bg-white/70 p-3">
              <div className="font-semibold">{typeLabel(type)}</div>
              <div className="mt-1 text-xs">{typeHelp[type].useWhen}</div>
            </div>
          ))}
        </div>
      </details>

      <div className="mt-4 grid gap-3 md:grid-cols-3">
        <Select label="Type" value={draft.type} options={typeOptions} onChange={(value) => setDraft((current) => ({ ...current, type: value as KnowledgeMemoryType }))} />
        <Select label="Status" value={draft.status} options={statusOptions} onChange={(value) => setDraft((current) => ({ ...current, status: value as KnowledgeMemoryStatus }))} />
        <Select label="Answer" value={draft.answer || ""} options={answerOptions} onChange={(value) => setDraft((current) => ({ ...current, answer: value as KnowledgeMemoryItem["answer"] }))} />
        <Input label="Correct SKU" value={draft.correctSku || ""} onChange={(value) => setDraft((current) => ({ ...current, correctSku: value }))} placeholder="989803139261" />
        <Input label="Customer Query" value={draft.query} onChange={(value) => setDraft((current) => ({ ...current, query: value }))} placeholder="electrodes pour philips frx" />
        <Input label="Correct Search Terms" value={draft.correctSearchTerms || ""} onChange={(value) => setDraft((current) => ({ ...current, correctSearchTerms: value }))} placeholder="Philips FRx SMART Pads II" />
        <Input label="Related SKU" value={draft.relatedSku || ""} onChange={(value) => setDraft((current) => ({ ...current, relatedSku: value }))} placeholder="Optional" />
        <Input label="Source URL" value={draft.sourceUrl || ""} onChange={(value) => setDraft((current) => ({ ...current, sourceUrl: value }))} placeholder="Internal/proof URL" />
        <Input label="Note" value={draft.note || ""} onChange={(value) => setDraft((current) => ({ ...current, note: value }))} placeholder="Staff note" />
      </div>

      <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        <div className="font-semibold text-slate-900">{typeHelp[draft.type].title}</div>
        <div className="mt-1">{typeHelp[draft.type].useWhen}</div>
        <div className="mt-1 text-slate-600">{typeHelp[draft.type].example}</div>
        <div className="mt-1 text-xs font-semibold text-slate-500">{typeHelp[draft.type].fields}</div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white">
          Save Knowledge Row
        </button>
        {status ? <span className="text-sm text-slate-600">{status}</span> : null}
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div className="rounded-md border border-slate-200">
          <h3 className="border-b border-slate-200 px-3 py-2 text-sm font-semibold">Recent Failed / No-Result Searches</h3>
          <div className="max-h-72 overflow-y-auto">
            {failedSearches.length ? failedSearches.slice(0, 20).map((row, index) => (
              <button key={`${row.createdAt}-${index}`} type="button" onClick={() => fillFailedQuery(row.query)} className="block w-full border-b border-slate-100 p-3 text-left text-sm hover:bg-slate-50">
                <span className="block font-medium text-slate-800">{row.query || row.type}</span>
                <span className="block text-xs text-slate-500">{row.language || "unknown"} · {row.createdAt}</span>
              </button>
            )) : <div className="p-3 text-sm text-slate-500">No failed searches yet.</div>}
          </div>
        </div>

        <div className="rounded-md border border-slate-200">
          <h3 className="border-b border-slate-200 px-3 py-2 text-sm font-semibold">Approved / Review Knowledge</h3>
          <div className="max-h-72 overflow-y-auto">
            {memoryItems.length ? memoryItems.slice(0, 50).map((item) => (
              <article key={item.id} className="border-b border-slate-100 p-3 text-sm">
                <div className="font-semibold text-slate-800">{item.query || item.correctSku || item.correctSearchTerms}</div>
                <div className="text-xs text-slate-500">{typeLabel(item.type)} · {item.status} · {item.updatedAt}</div>
                <div className="mt-1 text-xs text-slate-700">
                  {[item.correctSku, item.correctSearchTerms, item.relatedSku].filter(Boolean).join(" · ")}
                </div>
                {item.note ? <div className="mt-1 text-xs text-slate-500">{item.note}</div> : null}
                <button type="button" onClick={() => void remove(item.id)} className="mt-2 text-xs font-semibold text-red-700">Delete</button>
              </article>
            )) : <div className="p-3 text-sm text-slate-500">No knowledge rows yet.</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

function typeLabel(type: KnowledgeMemoryType) {
  return type.replace(/_/g, " ");
}

function Input({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="block text-sm">
      <span className="font-semibold text-slate-700">{label}</span>
      <input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm" />
    </label>
  );
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm">
      <span className="font-semibold text-slate-700">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm">
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    </label>
  );
}
