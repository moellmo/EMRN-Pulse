"use client";

import { useState } from "react";

type AnswerCacheRefreshButtonProps = {
  token: string;
  cacheKey: string;
  query: string;
};

export function AnswerCacheRefreshButton({ token, cacheKey, query }: AnswerCacheRefreshButtonProps) {
  const [status, setStatus] = useState<"idle" | "refreshing" | "error">("idle");

  async function refreshCache() {
    const confirmed = window.confirm("Refresh this cached answer? The old cache will be deleted, then the test page will run the question fresh.");
    if (!confirmed) return;

    setStatus("refreshing");
    try {
      const response = await fetch("/api/assistant/admin/answer-cache", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ key: cacheKey }),
      });
      if (!response.ok) throw new Error("Delete failed");
      const params = new URLSearchParams({
        ...(token ? { token } : {}),
        q: query,
        autorun: "1",
      });
      window.location.href = `/ai-assistant-test?${params.toString()}`;
    } catch {
      setStatus("error");
    }
  }

  return (
    <button
      type="button"
      onClick={refreshCache}
      disabled={status === "refreshing"}
      className="rounded border border-blue-200 bg-white px-2 py-1 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60"
      title="Delete this cached answer and open the test page to run the question fresh."
    >
      {status === "refreshing" ? "Refreshing..." : status === "error" ? "Try again" : "Refresh cache"}
    </button>
  );
}
