"use client";

import { Children, ReactNode, useState } from "react";

export function AssistantAdminTabs({ labels, children }: { labels: string[]; children: ReactNode }) {
  const panels = Children.toArray(children);
  const [active, setActive] = useState(0);

  return (
    <div className="mt-8">
      <div className="flex flex-wrap gap-2 border-b border-slate-200">
        {labels.map((label, index) => (
          <button
            key={label}
            type="button"
            onClick={() => setActive(index)}
            className={`rounded-t-md border border-b-0 px-4 py-2 text-sm font-semibold ${
              active === index
                ? "border-slate-300 bg-white text-slate-950"
                : "border-transparent bg-transparent text-slate-500 hover:text-slate-800"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="pt-6">{panels[active] || null}</div>
    </div>
  );
}
