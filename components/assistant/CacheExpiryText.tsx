"use client";

import { useState } from "react";

type CacheExpiryTextProps = {
  expiresAt: number;
};

export function CacheExpiryText({ expiresAt }: CacheExpiryTextProps) {
  const [now] = useState(() => Date.now());
  const expiresTime = Number(expiresAt || 0);

  if (!Number.isFinite(expiresTime) || expiresTime <= 0) {
    return <span>No expiry logged</span>;
  }

  const deltaMs = expiresTime - now;
  const expired = deltaMs <= 0;
  return (
    <span className={expired ? "font-semibold text-red-700" : undefined}>
      {expired ? `Expired ${humanDuration(Math.abs(deltaMs))} ago` : `Expires in ${humanDuration(deltaMs)}`}
    </span>
  );
}

function humanDuration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hr`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}
