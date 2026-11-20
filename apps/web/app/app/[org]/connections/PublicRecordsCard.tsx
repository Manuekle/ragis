"use client";

import { useEffect, useState } from "react";
import { api, type PublicSourcesSettings } from "@/lib/api";
import { IconAlert, IconGlobalSearch, IconLandmark } from "@/components/icons";
import { Checkbox } from "@/components/motion";
import { Disclosure, Select, TextField } from "@/components/ui";
import { Skel } from "@/components/skeletons";
import { useT } from "@/lib/use-t";

const PROFILE = "__profile__";

/**
 * Public records (ADR-036): official government data and the web through Croma, looked up only when someone turns
 * it on in Ask. Administrators switch it on, pick the default country and cap the lookups per month.
 */
export function PublicRecordsSection({ org, notify }: { org: string; notify: (msg: string) => void }) {
  const t = useT();
  const [s, setS] = useState<PublicSourcesSettings | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState("");

  useEffect(() => {
    let alive = true;
    api<PublicSourcesSettings>(`organizations/${org}/public-sources`)
      .then((v) => {
        if (!alive) return;
        setS(v);
        setLimit(String(v.monthly_limit));
      })
      .catch(() => alive && setS(null));
    return () => {
      alive = false;
    };
  }, [org]);

  async function save(body: Partial<{ enabled: boolean; country: string | null; web: boolean; monthly_limit: number }>, msg: string) {
    setBusy(true);
    setError(null);
    try {
      const v = await api<PublicSourcesSettings>(`organizations/${org}/public-sources`, { method: "PUT", body });
      setS(v);
      setLimit(String(v.monthly_limit));
      notify(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (s === null) return null; // older API or no access: nothing to show

  const profileName = t(s?.countries.find((c) => c.code === s.country_from_profile)?.name);
  const countryOptions = s
    ? [
        { value: PROFILE, label: profileName ? `${profileName} (from your company profile)` : "None — worldwide only", hint: profileName ? undefined : "People can still name a country in their question" },
        ...s.countries.map((c) => ({ value: c.code, label: t(c.name) })),
      ]
    : [];
  const idle = !!s && (!s.available || !s.can_manage || !!s.restricted);

  return (
    <section className="conn-section" aria-labelledby="conn-public">
      <header className="conn-section-head">
        <h3 id="conn-public" className="conn-section-title">
          <IconGlobalSearch size={15} />{t("Outside your documents")}</h3>
        <p className="muted">{t("Looked up only when someone turns on Public records in Ask. Nothing is copied into your library.")}</p>
      </header>
      <div className="conn-list">
        <div className={`card conn-card${idle ? " is-idle" : ""}`}>
          <div className="conn-head">
            <span className="conn-logo" aria-hidden="true">
              <IconLandmark size={24} variant="duotone" />
            </span>
            <div className="conn-title">
              <div className="conn-title-row">
                <h2>{t("Public records")}</h2>
                {s && <StateBadge s={s} />}
              </div>
              <p className="muted">{t("Official government data — companies, court cases, laws, sanctions and public contracts in 11 countries — plus the web. Answers cite each record with a link. Provided by Croma.")}</p>
            </div>
          </div>

          <div className="conn-body">
            {s === undefined ? (
              <Skel w={180} h={30} r={12} />
            ) : s.restricted ? (
              <p className="conn-next muted">{t("Not available: your organization's data is classified as restricted, so nothing may be sent to outside services.")}</p>
            ) : !s.available ? (
              <p className="conn-next muted">{s.can_manage ? t("Your technical team needs to add the Croma key on the server first.") : t("Not available yet.")}</p>
            ) : !s.can_manage ? (
              <p className="conn-next muted">{s.enabled ? t("Turn on Public records under the question box in Ask when you need outside facts.") : t("Ask your administrator to turn this on.")}</p>
            ) : (
              <div className="stack" style={{ gap: 14 }}>
                {s.demo && (
                  <p className="conn-note">
                    <IconAlert size={14} />{t("Demo mode: answers use labelled sample records, not live government data.")}</p>
                )}
                <Checkbox checked={s.enabled} onChange={(on) => !busy && save({ enabled: on }, on ? "Public records turned on" : "Public records turned off")} label={t("Let people check public records in Ask")} />
                {s.enabled && (
                  <>
                    <div className="conn-field">
                      <strong>{t("Country to check first")}</strong>
                      <Select
                        value={s.country_setting ?? PROFILE}
                        onChange={(v) => save({ country: v === PROFILE ? null : v }, "Country saved")}
                        options={countryOptions}
                        ariaLabel={t("Country to check first")}
                        size="sm"
                      />
                      <small className="muted">{t("People can pick another country in Ask, or name it in their question.")}</small>
                    </div>
                    <Checkbox checked={s.web} onChange={(on) => !busy && save({ web: on }, on ? "Web results included" : "Web results turned off")} label={t("Also search the web (news, international topics)")} />
                    <p className="conn-meta muted">
                      <span>
                        {s.used_this_month}{" "}{t("of")}{" "}{s.monthly_limit}{" "}{t("lookups used this month")}</span>
                      <span>{t("Each one is listed in the Activity log")}</span>
                    </p>
                    <Disclosure title={t("Advanced")} hint={t("Monthly limit")}>
                      <form
                        className="inline-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          const n = Math.max(0, Math.min(100_000, Math.round(Number(limit))));
                          if (Number.isFinite(n)) void save({ monthly_limit: n }, "Monthly limit saved");
                        }}
                      >
                        <TextField label={t("Lookups per month for the whole company")} type="number" min={0} max={100000} value={limit} onChange={(e) => setLimit(e.target.value)} />
                        <button type="submit" className="ghost" disabled={busy || String(s.monthly_limit) === limit}>{t("Save")}</button>
                      </form>
                      <small className="muted">{t("A question uses up to 2 lookups. When the limit is reached, Ask answers from your documents only until next month.")}</small>
                    </Disclosure>
                  </>
                )}
                <p className="conn-note">
                  <IconGlobalSearch size={14} />{t("Names and keywords from a question are sent to Croma to search official registers. Your documents are never sent.")}</p>
                {error && (
                  <p className="conn-note err">
                    <IconAlert size={14} />
                    {error}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function StateBadge({ s }: { s: PublicSourcesSettings }) {
  const t = useT();
  if (s.restricted) return <span className="badge conn-state"><span className="dot" />{t("Not available")}</span>;
  if (!s.available) return <span className="badge conn-state"><span className="dot" />{t("Not set up")}</span>;
  if (!s.enabled) return <span className="badge conn-state"><span className="dot" />{t("Off")}</span>;
  if (s.remaining <= 0) return <span className="badge warn"><span className="dot" />{t("Monthly limit reached")}</span>;
  return <span className="badge ok"><span className="dot" />{t("On")}</span>;
}
