import { useState, useEffect } from "react";

interface Props {
  totalResolved: number;
  hasActiveIncident: boolean;
  lastUpdated: Date | null;
}

export function TopBar({ totalResolved, hasActiveIncident, lastUpdated }: Props) {
  const [time,     setTime]     = useState(new Date());
  const [secsSince, setSecsSince] = useState<number | null>(null);

  useEffect(() => {
    const t = setInterval(() => {
      setTime(new Date());
      if (lastUpdated) {
        setSecsSince(Math.round((Date.now() - lastUpdated.getTime()) / 1000));
      }
    }, 1000);
    return () => clearInterval(t);
  }, [lastUpdated]);

  // Reset counter immediately when lastUpdated changes
  useEffect(() => {
    if (lastUpdated) setSecsSince(0);
  }, [lastUpdated]);

  const timeStr = time.toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }) + " PT";

  return (
    <header className="flex items-center justify-between px-6 py-3 bg-surface border-b border-brd">
      {/* Left: brand + status */}
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-2.5">
          <span
            className={`w-2 h-2 rounded-full flex-shrink-0 ${
              hasActiveIncident
                ? "bg-danger animate-pulse"
                : "bg-accent animate-pulse-dot"
            }`}
          />
          <span className="font-mono text-xs font-bold tracking-[0.22em] text-primary">
            INCIDENT RESPONSE SYSTEM
          </span>
        </div>

        <span className="text-brd select-none">│</span>

        <span
          className={`font-mono text-xs font-semibold ${
            hasActiveIncident ? "text-danger glow-red" : "text-accent glow-green"
          }`}
        >
          {hasActiveIncident ? "▲ INCIDENT ACTIVE" : "● ALL SYSTEMS OPERATIONAL"}
        </span>
      </div>

      {/* Right: resolved + last-updated counter + clock */}
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-muted uppercase tracking-widest">
            Resolved
          </span>
          <span className="font-mono text-sm font-bold text-accent glow-green">
            {totalResolved}
          </span>
        </div>

        <span className="text-brd select-none">│</span>

        <span className="font-mono text-xs text-muted tabular-nums">
          {secsSince === null ? "connecting…" : `Updated ${secsSince}s ago`}
        </span>

        <span className="text-brd select-none">│</span>

        <span className="font-mono text-xs text-muted tabular-nums">{timeStr}</span>
      </div>
    </header>
  );
}
