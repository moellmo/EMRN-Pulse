"use client";

import { useState } from "react";

type AnswerCacheClearButtonProps = {
  token: string;
};

export function AnswerCacheClearButton({ token }: AnswerCacheClearButtonProps) {
  const [status, setStatus] = useState<"idle" | "clearing" | "done" | "error">("idle");

  async function clearCache() {
    const confirmed = window.confirm("Clear all cached answers? Meri will rebuild fresh answers as customers ask.");
    if (!confirmed) return;

    setStatus("clearing");
    try {
      const response = await fetch("/api/assistant/admin/answer-cache", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ all: true }),
      });
      if (!response.ok) throw new Error("Clear failed");
      setStatus("done");
      window.location.reload();
    } catch {
      setStatus("error");
    }
  }

  return (
    <button
      type="button"
      onClick={clearCache}
      disabled={status === "clearing" || status === "done"}
      className="rounded border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
      title="Clear every cached answer. Meri will rebuild fresh cache rows from future good answers."
    >
      {status === "clearing" ? "Clearing..." : status === "done" ? "Cleared" : status === "error" ? "Try again" : "Clear all cache"}
    </button>
  );
}
