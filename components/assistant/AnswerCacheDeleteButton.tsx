"use client";

import { useState } from "react";
import type { MouseEvent } from "react";

type AnswerCacheDeleteButtonProps = {
  token: string;
  cacheKey: string;
};

export function AnswerCacheDeleteButton({ token, cacheKey }: AnswerCacheDeleteButtonProps) {
  const [status, setStatus] = useState<"idle" | "deleting" | "done" | "error">("idle");

  async function deleteRow(event: MouseEvent<HTMLButtonElement>) {
    const confirmed = window.confirm("Delete this cached answer? Meri will rebuild it the next time someone asks.");
    if (!confirmed) return;

    const row = event.currentTarget.closest("article");
    setStatus("deleting");
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
      setStatus("done");
      row?.remove();
    } catch {
      setStatus("error");
    }
  }

  return (
    <button
      type="button"
      onClick={deleteRow}
      disabled={status === "deleting" || status === "done"}
      className="rounded border border-red-200 bg-white px-2 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
      title="Delete this cached answer. Meri will answer normally and create a fresh cache later if the answer is good."
    >
      {status === "deleting" ? "Deleting..." : status === "done" ? "Deleted" : status === "error" ? "Try again" : "Delete cache"}
    </button>
  );
}
