"use client";

import { useState } from "react";

type SkuConfigAdminProps = {
  token: string;
  prefixes: string[];
  suffixes: string[];
};

function parseList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function SkuConfigAdmin({ token, prefixes, suffixes }: SkuConfigAdminProps) {
  const [prefixText, setPrefixText] = useState(prefixes.join(", "));
  const [suffixText, setSuffixText] = useState(suffixes.join(", "));
  const [status, setStatus] = useState("");

  async function save() {
    setStatus("Saving...");
    try {
      const response = await fetch("/api/assistant/admin/sku-config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          prefixes: parseList(prefixText),
          suffixes: parseList(suffixText),
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error || "Save failed");
      setPrefixText((payload.prefixes || []).join(", "));
      setSuffixText((payload.suffixes || []).join(", "));
      setStatus("Saved. New searches will use this config on this server instance.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Save failed");
    }
  }

  return (
    <section className="mt-8 rounded-md border border-slate-200 bg-white p-4">
      <h2 className="text-lg font-semibold">SKU Prefix/Suffix Matching</h2>
      <p className="mt-1 text-sm text-slate-600">
        Add EMRN-specific SKU prefixes or suffixes so manufacturer numbers still match exact EMRN SKUs.
      </p>
      <label className="mt-4 block text-sm font-semibold text-slate-700" htmlFor="sku-prefixes">
        Prefixes
      </label>
      <input
        id="sku-prefixes"
        value={prefixText}
        onChange={(event) => setPrefixText(event.target.value)}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        placeholder="DY, 3M, PEL, AMD"
      />
      <label className="mt-4 block text-sm font-semibold text-slate-700" htmlFor="sku-suffixes">
        Suffixes
      </label>
      <input
        id="sku-suffixes"
        value={suffixText}
        onChange={(event) => setSuffixText(event.target.value)}
        className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        placeholder="+, U"
      />
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          className="rounded-md bg-slate-950 px-4 py-2 text-sm font-semibold text-white"
        >
          Save SKU Rules
        </button>
        {status ? <span className="text-sm text-slate-600">{status}</span> : null}
      </div>
    </section>
  );
}
