import { Link, useLocation } from "react-router-dom";

const NAV = [
  { to: "/", label: "Today" },
  { to: "/parlays", label: "Parlays" },
  { to: "/review", label: "Accuracy Review" },
  { to: "/excluded", label: "Excluded" },
];

export default function AppShell({ children }) {
  const { pathname } = useLocation();
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/60 bg-card/40 backdrop-blur sticky top-0 z-40">
        <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-4 py-3">
          <Link to="/" className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground font-black text-lg">◆</div>
            <div>
              <div className="text-sm font-bold tracking-tight">DIAMOND EDGE</div>
              <div className="text-[10px] uppercase tracking-widest text-muted-foreground">MLB prop engine</div>
            </div>
          </Link>
          <nav className="flex items-center gap-1 overflow-x-auto">
            {NAV.map((n) => (
              <Link
                key={n.to}
                to={n.to}
                className={
                  "rounded-md px-3 py-1.5 text-sm font-medium transition-colors whitespace-nowrap " +
                  (pathname === n.to
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground")
                }
              >
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
      <footer className="border-t border-border/60 px-4 py-6 text-center text-xs text-muted-foreground">
        Data: MLB Stats API. Never fabricated. Predictions are analysis outputs, not betting advice.
      </footer>
    </div>
  );
}