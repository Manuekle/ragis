"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, formatBytes } from "@/lib/api";
import { UsageSkeleton } from "@/components/skeletons";
import { IconAlert, IconCalendar } from "@/components/icons";
import { Disclosure } from "@/components/ui";
import { duration } from "@/lib/plain";

interface Usage {
  usage: Record<string, number>;
  corpus: { documents: number; storage_bytes: number };
  my_queries: { n: number; avg_latency_ms: number; p95_latency_ms: number; abstention_rate: number; cost_usd: number };
  limits: {
    id: string;
    display_name?: string;
    max_documents: number;
    max_storage_bytes: string | number;
    max_queries_month: number;
    max_pages_per_doc: number;
    queries_per_minute: number;
    max_upload_bytes?: number;
    max_context_tokens?: number;
    rerank_enabled?: boolean;
  };
}

const fmt = (n: number | undefined) => (n ?? 0).toLocaleString("en-US");
const pct = (value: number, max: number) => {
  if (!max || value <= 0) return "0%";
  const r = (value / max) * 100;
  return r < 1 ? "<1%" : `${Math.round(r)}%`;
};
const usd = (n: number) =>
  n === 0 ? "0.00" : n < 0.01 ? n.toLocaleString("en-US", { maximumSignificantDigits: 2 }) : n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const now = new Date();
const PERIOD = (() => {
  const s = now.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
})();
const RESET = new Date(now.getFullYear(), now.getMonth() + 1, 1).toLocaleDateString("en-US", { day: "numeric", month: "long" });

function Limit({ label, value, display, of, max }: { label: string; value: number; display: string; of: string; max?: number }) {
  return (
    <div className="tile stat">
      <div className="stat-top">
        <span className="k">{label}</span>
        {max !== undefined && <span className="pct">{pct(value, max)}</span>}
      </div>
      <div className="v">{display}</div>
      <div className="l">{of}</div>
      {max !== undefined && <Meter value={value} max={max} />}
    </div>
  );
}

function Meter({ value, max }: { value: number; max: number }) {
  const ratio = value > 0 ? Math.max(0.02, Math.min(1, max ? value / max : 0)) : 0;
  const level = ratio > 0.9 ? "err" : ratio > 0.7 ? "warn" : "ok";
  return (
    <div className="meter" data-level={level} role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={`${(ratio * 100).toFixed(0)}% used`}>
      <i style={{ ["--v" as string]: ratio }} />
    </div>
  );
}

export default function UsagePage() {
  const { org } = useParams<{ org: string }>();
  const [u, setU] = useState<Usage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Usage>(`organizations/${org}/usage`).then(setU).catch((e) => setError(e.message));
  }, [org]);

  const queries = u?.usage.query ?? 0;
  const maxStorage = Number(u?.limits.max_storage_bytes ?? 0);
  const abst = u?.my_queries.abstention_rate ?? 0;
  const tokens = (u?.usage.embedding_tokens ?? 0) + (u?.usage.llm_input_tokens ?? 0) + (u?.usage.llm_output_tokens ?? 0);

  return (
    <div className="page">
      <header className="page-bar">
        <div className="crumbs">
          <strong>Usage & costs</strong>
          <span className="crumb-sep" aria-hidden="true">/</span>
          <span className="crumb-ws">
            <IconCalendar size={15} />
            {PERIOD}
          </span>
        </div>
        {u && <span className="badge accent">{u.limits.display_name ?? u.limits.id} plan</span>}
      </header>

      <div className="main">
        <header className="page-head">
          <div>
            <h1>Usage & costs</h1>
            <p className="sub">This month's usage against your plan limits.</p>
          </div>
        </header>

        {error ? (
          <div className="alert">
            <IconAlert size={16} />
            {error}
          </div>
        ) : !u ? (
          <UsageSkeleton />
        ) : (
          <div className="stack" style={{ gap: 32 }}>
            <section className="stack" style={{ gap: 12 }}>
              <div className="section-head">
                <h2>Monthly limits</h2>
                <span className="muted small">Resets on {RESET}</span>
              </div>
              <div className="stats">
                <Limit label="Questions" value={queries} display={fmt(queries)} of={`of ${fmt(u.limits.max_queries_month)}`} max={u.limits.max_queries_month} />
                <Limit label="Documents" value={u.corpus.documents} display={fmt(u.corpus.documents)} of={`of ${fmt(u.limits.max_documents)}`} max={u.limits.max_documents} />
                <Limit label="Storage" value={u.corpus.storage_bytes} display={formatBytes(u.corpus.storage_bytes)} of={`of ${formatBytes(maxStorage)}`} max={maxStorage} />
                <Limit label="Pages processed" value={u.usage.ingest_pages ?? 0} display={fmt(u.usage.ingest_pages)} of={`max ${fmt(u.limits.max_pages_per_doc)} per document`} />
              </div>
            </section>

            <div className="grid-2">
              <section className="card panel-card">
                <div className="card-head">
                  <div>
                    <h2>Your questions</h2>
                    <p>
                      {fmt(u.my_queries.n)} {u.my_queries.n === 1 ? "question" : "questions"} asked this month
                    </p>
                  </div>
                </div>
                <div className="mini-stats">
                  <div className="stat">
                    <div className="k">Typical response time</div>
                    <div className="v">{u.my_queries.n ? duration(u.my_queries.avg_latency_ms) : "—"}</div>
                  </div>
                  <div className="stat" data-level={u.my_queries.n === 0 ? undefined : abst > 0.5 ? "warn" : abst > 0.2 ? "mid" : "ok"}>
                    <div className="k">Couldn't answer</div>
                    <div className="v">
                      {(abst * 100).toFixed(0)}
                      <small>%</small>
                    </div>
                    {u.my_queries.n > 0 && abst > 0.2 && <div className="l">Usually a missing document or no access to it</div>}
                  </div>
                  <div className="stat">
                    <div className="k">Estimated cost</div>
                    <div className="v">
                      <small className="pre">$</small>
                      {usd(u.my_queries.cost_usd)}
                    </div>
                  </div>
                </div>
              </section>

              <section className="card panel-card">
                <div className="card-head">
                  <div>
                    <h2>Your plan</h2>
                    <p>{u.limits.display_name ?? u.limits.id}</p>
                  </div>
                </div>
                <dl className="kv">
                  <div>
                    <dt>Questions per minute</dt>
                    <dd>{fmt(u.limits.queries_per_minute)}</dd>
                  </div>
                  {u.limits.max_upload_bytes !== undefined && (
                    <div>
                      <dt>Largest file</dt>
                      <dd>{formatBytes(u.limits.max_upload_bytes)}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Pages per document</dt>
                    <dd>{fmt(u.limits.max_pages_per_doc)}</dd>
                  </div>
                  {u.limits.rerank_enabled !== undefined && (
                    <div>
                      <dt>Extra-accurate search</dt>
                      <dd>{u.limits.rerank_enabled ? <span className="badge ok">Included</span> : <span className="badge">Not included</span>}</dd>
                    </div>
                  )}
                </dl>
              </section>
            </div>

            <Disclosure title="Technical details" hint="AI usage measured in tokens, for admins and billing.">
              <dl className="kv">
                <div>
                  <dt>Total tokens this month</dt>
                  <dd>{fmt(tokens)}</dd>
                </div>
                <div>
                  <dt>Embeddings (documents + questions)</dt>
                  <dd>{fmt(u.usage.embedding_tokens)}</dd>
                </div>
                <div>
                  <dt>AI input</dt>
                  <dd>{fmt(u.usage.llm_input_tokens)}</dd>
                </div>
                <div>
                  <dt>AI output</dt>
                  <dd>{fmt(u.usage.llm_output_tokens)}</dd>
                </div>
                <div>
                  <dt>Re-ranking calls</dt>
                  <dd>{fmt(u.usage.rerank_calls)}</dd>
                </div>
                <div>
                  <dt>Slowest responses (p95)</dt>
                  <dd>{u.my_queries.n ? duration(u.my_queries.p95_latency_ms) : "—"}</dd>
                </div>
                {u.limits.max_context_tokens !== undefined && (
                  <div>
                    <dt>Context per answer</dt>
                    <dd>{fmt(u.limits.max_context_tokens)} tokens</dd>
                  </div>
                )}
              </dl>
              <p className="card-note">Costs are estimates based on current AI provider prices.</p>
            </Disclosure>
          </div>
        )}
      </div>
    </div>
  );
}
