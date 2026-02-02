import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";

interface PostmortemData {
  incident_id: string;
  content: string;
  service: string | null;
  severity: string | null;
  root_cause: string | null;
  time_to_resolve_sec: number | null;
  generated_at: string;
}

interface Props {
  incidentId: string;
  onClose: () => void;
}

export function PostmortemModal({ incidentId, onClose }: Props) {
  const [data, setData]       = useState<PostmortemData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`http://localhost:8000/postmortem/${incidentId}`, {
      signal: AbortSignal.timeout(8_000),
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<PostmortemData>;
      })
      .then((d) => { setData(d); setLoading(false); })
      .catch((e: Error) => { setError(e.message); setLoading(false); });
  }, [incidentId]);

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative bg-surface border border-brd rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-brd flex-shrink-0">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="font-mono text-xs font-bold tracking-widest text-accent uppercase">
              Postmortem
            </span>
            <span className="font-mono text-xs text-primary font-semibold">{incidentId}</span>
            {data?.service && (
              <span className="font-mono text-xs text-muted">{data.service}</span>
            )}
            {data?.severity && (
              <span className={`font-mono text-[10px] px-1.5 py-0.5 rounded font-bold ${
                data.severity === "SEV1" ? "bg-red-500 text-white" :
                data.severity === "SEV2" ? "bg-orange-500 text-white" :
                data.severity === "SEV3" ? "bg-yellow-500 text-black" :
                "bg-gray-500 text-white"
              }`}>
                {data.severity}
              </span>
            )}
            {data?.time_to_resolve_sec && (
              <span className="font-mono text-xs text-muted">
                {Math.round(data.time_to_resolve_sec / 60)}m MTTR
              </span>
            )}
            {data?.generated_at && (
              <span className="font-mono text-xs text-muted">
                {new Date(data.generated_at).toLocaleString()}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-muted hover:text-primary transition-colors font-mono text-lg leading-none ml-4 flex-shrink-0"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-5">
          {loading && (
            <p className="font-mono text-xs text-muted animate-pulse text-center py-16">
              Loading postmortem…
            </p>
          )}
          {error && (
            <p className="font-mono text-xs text-red-400 text-center py-16">
              Failed to load: {error}
            </p>
          )}
          {data && (
            <div className="prose prose-sm prose-invert max-w-none
              prose-headings:font-mono prose-headings:text-primary prose-headings:tracking-wide
              prose-h1:text-base prose-h2:text-sm prose-h3:text-xs
              prose-p:text-muted prose-p:leading-relaxed
              prose-li:text-muted
              prose-strong:text-primary
              prose-code:text-accent prose-code:bg-brd prose-code:px-1 prose-code:rounded
              prose-table:text-xs prose-th:text-primary prose-td:text-muted
              prose-hr:border-brd">
              <ReactMarkdown>{data.content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
