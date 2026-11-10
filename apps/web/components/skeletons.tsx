import { Fragment, type CSSProperties, type ReactNode } from "react";

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

export function SkeletonStatus({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  return (
    <div className={className} role="status">
      <span className="sr-only">{label}</span>
      {children}
    </div>
  );
}

export function Skel({
  w = "100%",
  h = 12,
  r,
  className,
  style,
}: {
  w?: number | string;
  h?: number;
  r?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      className={`skel${className ? ` ${className}` : ""}`}
      style={{ display: "block", width: w, maxWidth: "100%", height: h, borderRadius: r, flex: "none", ...style }}
    />
  );
}

function SkeletonShell({
  children,
  label,
  titleWidth = 190,
  subWidth = 380,
  maxWidth,
  action = false,
}: {
  children: ReactNode;
  label: string;
  titleWidth?: number;
  subWidth?: number;
  maxWidth?: number;
  action?: boolean;
}) {
  return (
    <SkeletonStatus className="page" label={label}>
      <header className="page-bar">
        <div className="crumbs">
          <Skel w={112} h={13} />
        </div>
        {action && <Skel w={78} h={30} r={10} />}
      </header>
      <div className="main" style={maxWidth ? { maxWidth } : undefined}>
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div className="stack" style={{ gap: 8, minWidth: 0 }}>
            <Skel w={titleWidth} h={30} />
            <Skel w={subWidth} h={13} />
          </div>
        </header>
        {children}
      </div>
    </SkeletonStatus>
  );
}

function SkeletonTabs({ count = 2 }: { count?: number }) {
  if (!count) return null;
  return (
    <div
      aria-hidden="true"
      className="row"
      style={{ gap: 22, marginTop: 20, paddingBottom: 12, borderBottom: "1px solid var(--border)" }}
    >
      {range(count).map((i) => (
        <Skel key={i} w={i === 0 ? 62 : 78} h={13} />
      ))}
    </div>
  );
}

export function SkeletonCardGrid({ count = 6, lines = 2 }: { count?: number; lines?: number }) {
  return (
    <div className="agent-grid" aria-hidden="true">
      {range(count).map((i) => (
        <div key={i} className="agent-card" style={{ "--i": i } as CSSProperties}>
          {/* mirrors StudioCard (app/app/[org]/agents/shared.tsx) */}
          <div className="sc-top">
            <Skel w={44} h={44} r={13} />
            <Skel w={52} h={22} r={999} />
          </div>
          <div className="sc-title stack" style={{ gap: 7 }}>
            <Skel w="58%" h={15} />
            <Skel w="34%" h={11} />
          </div>
          <div className="stack" style={{ gap: 6, margin: "12px 0 18px" }}>
            {range(lines).map((line) => (
              <Skel key={line} w={line === lines - 1 ? "82%" : "100%"} h={11} />
            ))}
          </div>
          <div className="sc-foot">
            <Skel w={68} h={20} r={999} />
            <Skel w={84} h={14} />
            <Skel w={28} h={28} r={999} style={{ marginLeft: "auto" }} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonRunRows({ count = 5 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      {range(count).map((i) => (
        <div key={i} className="run-row">
          <span className="meta">
            <Skel w={i % 2 === 0 ? "52%" : "44%"} h={14} />
            <Skel w={i % 3 === 0 ? "72%" : "62%"} h={11} />
          </span>
          <span className="side">
            <Skel w={64} h={22} r={999} />
            {i % 2 === 0 && <Skel w={76} h={22} r={999} />}
          </span>
        </div>
      ))}
    </div>
  );
}

export function SkeletonTable({
  rows = 6,
  columns,
  leading,
}: {
  rows?: number;
  columns: readonly string[];
  leading?: "avatar" | "file";
}) {
  return (
    <div className="table-card" aria-hidden="true">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {columns.map((className, c) => (
                <th key={c} className={className}>
                  <Skel w={c === 0 ? 70 : 46} h={10} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {range(rows).map((r) => (
              <tr key={r}>
                {columns.map((className, c) =>
                  c === 0 && leading ? (
                    <td key={c} className={className}>
                      <div className="cell-title">
                        {leading === "file" ? (
                          <span className="file-tile"><Skel w={34} h={40} /></span>
                        ) : <Skel w={28} h={28} r={999} />}
                        <div className="stack" style={{ gap: 5 }}>
                          <Skel w={120} h={12} />
                          <Skel w={92} h={10} />
                        </div>
                      </div>
                    </td>
                  ) : (
                    <td key={c} className={className}>
                      <Skel w={c === 0 ? "72%" : c === columns.length - 1 ? 42 : 60} h={12} />
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="stats" aria-hidden="true">
      {range(count).map((i) => (
        <div key={i} className="tile">
          <div className="row spread">
            <Skel w="45%" h={11} />
            <Skel w={28} h={10} />
          </div>
          <Skel w="42%" h={24} style={{ marginTop: 12 }} />
          <Skel h={6} style={{ marginTop: 18 }} />
        </div>
      ))}
    </div>
  );
}

function SkeletonPanel({ children }: { children?: ReactNode }) {
  return (
    <section className="card panel-card" aria-hidden="true">
      <div className="card-head">
        <div className="stack" style={{ gap: 7 }}>
          <Skel w={90} h={15} />
          <Skel w={150} h={11} />
        </div>
      </div>
      {children ?? <div className="stack" style={{ gap: 12 }}>
        {range(4).map((i) => (
          <div key={i} className="row spread">
            <Skel w={i % 2 === 0 ? "46%" : "38%"} h={12} />
            <Skel w={42} h={12} />
          </div>
        ))}
      </div>}
    </section>
  );
}

export function UsageSkeleton() {
  return (
    <SkeletonStatus label="Loading usage…">
      <div className="stack" style={{ gap: 32 }} aria-hidden="true">
        <section className="stack" style={{ gap: 12 }}>
          <div className="row spread">
            <Skel w={132} h={16} />
            <Skel w={118} h={11} />
          </div>
          <SkeletonStats />
        </section>
        <div className="grid-2">
          <SkeletonPanel />
          <SkeletonPanel>
            <div className="mini-stats">
              {range(4).map((i) => (
                <div className="stat stack" key={i} style={{ gap: 8 }}>
                  <Skel w={92} h={11} />
                  <Skel w={64} h={23} />
                </div>
              ))}
            </div>
          </SkeletonPanel>
        </div>
        <SkeletonPanel />
      </div>
    </SkeletonStatus>
  );
}

export function InboxSkeleton() {
  return (
    <SkeletonStatus label="Loading inbox…">
      <div className="inbox-grid" aria-hidden="true">
        <div className="stack" style={{ gap: 12 }}>
          {range(3).map((i) => (
            <article key={i} className="card approval" aria-hidden="true">
              <header>
                <Skel w={36} h={36} r={12} />
                <div className="stack" style={{ gap: 7, flex: 1 }}>
                  <Skel w={i % 2 === 0 ? "44%" : "58%"} h={14} />
                  <Skel w="70%" h={11} />
                </div>
                <Skel w={68} h={22} r={999} />
              </header>
              <Skel w="42%" h={12} />
              <Skel h={34} r={12} />
              <div className="actions">
                <Skel w={190} h={30} r={10} />
              </div>
            </article>
          ))}
        </div>
        <aside className="card ed-section" aria-hidden="true">
          <header>
            <Skel w={78} h={16} />
          </header>
          <div style={{ margin: "0 -20px -20px" }}>
            {range(4).map((i) => (
              <div key={i} className="run-row">
                <span className="meta">
                  <Skel w="58%" h={13} />
                  <Skel w="42%" h={10} />
                </span>
                <span className="side">
                  <Skel w={56} h={20} r={999} />
                </span>
              </div>
            ))}
          </div>
        </aside>
      </div>
    </SkeletonStatus>
  );
}

function WorkflowOutlineSkeleton() {
  return (
    <div className="stack" aria-hidden="true">
      <section className="card ed-section">
        <div className="ob-fields">
          <Skel h={36} r={10} />
          <Skel h={36} r={10} />
        </div>
      </section>
      <div className="flow">
        {["START", "AGENT_TASK", "END"].map((type, index) => (
          <Fragment key={type}>
            {index > 0 && <span className="flow-link" />}
            <div className="flow-node" data-type={type}>
              <Skel w={30} h={30} r={8} />
              <div className="body">
                <Skel w={type === "AGENT_TASK" ? 110 : 52} h={14} />
                {type === "AGENT_TASK" && (
                  <div className="ob-fields">
                    <Skel h={36} r={10} />
                    <Skel h={36} r={10} />
                  </div>
                )}
              </div>
            </div>
          </Fragment>
        ))}
      </div>
    </div>
  );
}

export function SkeletonEditor({
  label,
  workflow = false,
  titleWidth = 240,
  tabs = 2,
  sections = 4,
  sideSections = 3,
}: {
  label: string;
  workflow?: boolean;
  titleWidth?: number;
  tabs?: number;
  sections?: number;
  sideSections?: number;
}) {
  return (
    <SkeletonShell label={label} titleWidth={titleWidth} maxWidth={1240} action>
      {!workflow && <SkeletonTabs count={tabs} />}
      <div className="ed tab-panel" style={{ marginTop: 20 }}>
        {workflow ? <WorkflowOutlineSkeleton /> : <div className="stack" style={{ gap: 14 }}>
          {range(sections).map((i) => (
            <section key={i} className="card ed-section" aria-hidden="true">
              <header>
                <div className="stack" style={{ gap: 7 }}>
                  <Skel w={86 + (i % 3) * 24} h={15} />
                  <Skel w={260} h={11} />
                </div>
              </header>
              <div className="ob-fields">
                <div className="stack" style={{ gap: 6 }}>
                  <Skel w={50} h={10} />
                  <Skel h={36} r={10} />
                </div>
                <div className="stack" style={{ gap: 6 }}>
                  <Skel w={62} h={10} />
                  <Skel h={36} r={10} />
                </div>
              </div>
              <Skel h={72} r={10} />
            </section>
          ))}
        </div>}
        <aside className="ed-side">
          {range(sideSections).map((i) => (
            <section key={i} className="card ed-section" aria-hidden="true">
              <header>
                <Skel w={74 + i * 10} h={15} />
              </header>
              <div className="stack" style={{ gap: 10 }}>
                <Skel h={12} />
                <Skel w="78%" h={12} />
                <Skel h={36} r={10} />
              </div>
            </section>
          ))}
        </aside>
      </div>
    </SkeletonShell>
  );
}

export function RunDetailSkeleton() {
  return (
    <SkeletonShell label="Loading run…" titleWidth={230} maxWidth={1240} action>
      <div className="ed" style={{ marginTop: 20 }}>
        <section className="card" aria-hidden="true">
          <ol className="tl">
            {range(5).map((i) => (
              <li key={i}>
                <span className="dot">
                  <Skel w={28} h={28} r={999} />
                </span>
                <div className="content">
                  <header>
                    <Skel w={i % 2 === 0 ? 180 : 140} h={14} />
                    <Skel w={64} h={20} r={999} />
                  </header>
                  <Skel w="92%" h={12} />
                  <Skel w="68%" h={12} />
                </div>
              </li>
            ))}
          </ol>
        </section>
        <aside className="ed-side">
          {range(2).map((i) => (
            <section key={i} className="card ed-section" aria-hidden="true">
              <header>
                <Skel w={i === 0 ? 52 : 68} h={15} />
              </header>
              <div className="stack" style={{ gap: 10 }}>
                {range(i === 0 ? 5 : 4).map((j) => (
                  <div key={j} className="row spread">
                    <Skel w={64} h={11} />
                    <Skel w={j % 2 === 0 ? 120 : 90} h={11} />
                  </div>
                ))}
              </div>
            </section>
          ))}
        </aside>
      </div>
    </SkeletonShell>
  );
}

export function EnvelopeSkeleton() {
  return (
    <SkeletonShell label="Loading signature request…" titleWidth={210} maxWidth={1240} action>
      <div className="ed" style={{ marginTop: 20 }}>
        <div className="stack">
          {range(3).map((i) => (
            <section key={i} className="card ed-section" aria-hidden="true">
              <header>
                <Skel w={i === 0 ? 84 : 96} h={15} />
              </header>
              {range(i === 0 ? 2 : 3).map((j) => (
                <div key={j} className="row spread">
                  <Skel w={j === 0 ? "56%" : "72%"} h={12} />
                  <Skel w={48} h={12} />
                </div>
              ))}
            </section>
          ))}
        </div>
        <aside className="ed-side">
          {range(2).map((i) => (
            <section key={i} className="card ed-section" aria-hidden="true">
              <header>
                <Skel w={i === 0 ? 64 : 58} h={15} />
              </header>
              <div className="stack" style={{ gap: 10 }}>
                <Skel h={36} r={10} />
                <Skel w="82%" h={12} />
                <Skel w="64%" h={12} />
              </div>
            </section>
          ))}
        </aside>
      </div>
    </SkeletonShell>
  );
}

export function OnboardingSkeleton() {
  return (
    <SkeletonStatus className="page" label="Loading setup…">
      <header className="page-bar">
        <div className="crumbs">
          <Skel w={112} h={13} />
        </div>
        <Skel w={84} h={30} r={10} />
      </header>
      <div className="main">
        <div className="ob">
          <nav className="ob-rail" aria-hidden="true">
            <div className="ob-rail-head">
              <Skel w={150} h={14} />
              <Skel w={112} h={10} style={{ marginTop: 8 }} />
              <Skel h={4} r={999} style={{ marginTop: 10 }} />
            </div>
            {range(9).map((i) => (
              <div key={i} className="ob-step" style={{ pointerEvents: "none" }}>
                <Skel w={22} h={22} r={999} />
                <span className="label"><Skel w={110 - (i % 3) * 14} h={12} /></span>
              </div>
            ))}
          </nav>
          <section className="card ob-card" aria-hidden="true">
            <header>
              <Skel w={76} h={11} />
              <Skel w={330} h={24} style={{ marginTop: 10 }} />
              <Skel w={420} h={13} style={{ marginTop: 10 }} />
            </header>
            <div className="ob-fields">
              {range(3).map((i) => (
                <div key={i} className="stack" style={{ gap: 6 }}>
                  <Skel w={64} h={10} />
                  <Skel h={36} r={10} />
                </div>
              ))}
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {range(3).map((i) => (
                <Skel key={i} w={i === 2 ? "72%" : "100%"} h={12} />
              ))}
            </div>
            <div className="ob-foot">
              <Skel w={96} h={32} r={10} />
              <span className="grow" />
              <Skel w={84} h={32} r={10} />
            </div>
          </section>
        </div>
      </div>
    </SkeletonStatus>
  );
}
