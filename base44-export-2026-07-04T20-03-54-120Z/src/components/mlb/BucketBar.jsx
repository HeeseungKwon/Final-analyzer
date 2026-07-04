import React from "react";

// Simple horizontal bar to visualize a hit rate percentage.
export default function BucketBar({ rate }) {
  const pct = rate != null ? Math.round(rate * 100) : 0;
  const color = pct >= 60 ? "bg-emerald-500" : pct >= 45 ? "bg-amber-500" : "bg-rose-500";
  return (
    <div className="h-2 w-full rounded-full bg-muted">
      <div className={`h-2 rounded-full ${color}`} style={{ width: `${pct}%` }} />
    </div>
  );
}