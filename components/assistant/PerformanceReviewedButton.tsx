"use client";

import { useState } from "react";
import type { MouseEvent } from "react";

type PerformanceReviewedButtonProps = {
  token: string;
  reviewedPerformanceKey: string;
  query: string;
};

export function PerformanceReviewedButton({ token, reviewedPerformanceKey, query }: PerformanceReviewedButtonProps) {
  const [status, setStatus] = useState<"idle" | "saving" | "done" | "error">("idle");

  async function markReviewed(event: MouseEvent<HTMLButtonElement>) {
    const row = event.currentTarget.closest("article");
    setStatus("saving");
    try {
      const response = await fetch("/api/assistant/admin/performance-review", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ reviewedPerformanceKey, query }),
      });
      if (!response.ok) throw new Error("Save failed");
      setStatus("done");
      row?.remove();
    } catch {
      setStatus("error");
    }
  }

  return (
    <button
      type="button"
      onClick={markReviewed}
      disabled={status === "saving" || status === "done"}
      className="rounded border border-slate-300 bg-white px-2 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
      title="Hide this row from Slow Questions and Recent Timings after you have reviewed it."
    >
      {status === "saving" ? "Saving..." : status === "done" ? "Reviewed" : status === "error" ? "Try again" : "Reviewed"}
    </button>
  );
}
