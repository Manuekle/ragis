"use client";

import { useEffect, useId, useState } from "react";
import { api } from "@/lib/api";
import { useT } from "@/lib/use-t";
import { DatePicker, Select } from "@/components/ui";
import { Checkbox } from "@/components/motion";
import { Skel } from "@/components/skeletons";
import { IconAlert } from "@/components/icons";
import { ComputationView, TRIGGER_COPY, TRIGGER_KINDS, UNITS, UNIT_COPY, personName, type Computation, type Person, type TriggerKind, type Unit } from "./shared";

export interface TermValues {
  title: string;
  trigger_kind: TriggerKind;
  trigger_date: string;
  notice_by_email: boolean;
  unit: Unit;
  amount: string;
  legal_basis: string;
  responsible_id: string;
}

/** Body for POST /deadlines and PATCH /deadlines/:id. */
export const termBody = (v: TermValues) => ({
  title: v.title.trim(),
  trigger_kind: v.trigger_kind,
  trigger_date: v.trigger_date,
  notice_by_email: v.unit === "fixed" ? false : v.notice_by_email,
  unit: v.unit,
  amount: v.unit === "fixed" ? null : Number(v.amount),
  legal_basis: v.legal_basis.trim(),
  responsible_id: v.responsible_id,
});

export const termProblem = (v: TermValues): string | null => {
  if (v.title.trim().length < 3) return "Give it a title of at least 3 characters.";
  if (!v.trigger_date) return v.unit === "fixed" ? "Pick the date." : "Pick the date it runs from.";
  if (v.unit !== "fixed") {
    const n = Number(v.amount);
    if (!Number.isInteger(n) || n < 1 || n > 3650) return "The term needs a whole number between 1 and 3650.";
  }
  if (!v.responsible_id) return "Choose who is responsible.";
  return null;
};

/**
 * The fields of a term and, beside them, the due date the server computes from the firm's calendar as they change
 * (POST /deadlines/preview). The web never computes due dates itself.
 */
export function TermForm({
  org,
  value,
  onChange,
  people,
  me,
  unitAssumed,
  country,
}: {
  org: string;
  value: TermValues;
  onChange: (v: TermValues) => void;
  people: Person[];
  me: string;
  unitAssumed?: boolean;
  country?: string;
}) {
  const t = useT();
  const id = useId();
  const set = <K extends keyof TermValues>(k: K, v: TermValues[K]) => onChange({ ...value, [k]: v });
  const fixed = value.unit === "fixed";
  const [preview, setPreview] = useState<{ computation: Computation; country: string } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const amount = Number(value.amount);
  const ready = !!value.trigger_date && (fixed || (Number.isInteger(amount) && amount >= 1 && amount <= 3650));
  useEffect(() => {
    if (!ready) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    let live = true;
    setLoading(true);
    const timer = window.setTimeout(() => {
      api<{ computation: Computation; country: string }>(`organizations/${org}/deadlines/preview`, {
        method: "POST",
        body: { trigger_date: value.trigger_date, unit: value.unit, amount: fixed ? null : amount, notice_by_email: fixed ? false : value.notice_by_email },
      })
        .then((r) => {
          if (!live) return;
          setPreview(r);
          setPreviewError(null);
        })
        .catch((e: Error) => live && setPreviewError(e.message))
        .finally(() => live && setLoading(false));
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [org, ready, value.trigger_date, value.unit, value.notice_by_email, amount, fixed]);

  return (
    <div className="dl-form">
      <div className="field">
        <label htmlFor={`${id}-title`}>{t("Title")}</label>
        <input id={`${id}-title`} value={value.title} maxLength={200} onChange={(e) => set("title", e.target.value)} placeholder={t("e.g. Answer the claim")} />
      </div>

      <div className="dl-form-row">
        <div className="field">
          <span className="field-label" id={`${id}-unit`}>{t("Counted in")}</span>
          <Select
            ariaLabel={t("Counted in")}
            value={value.unit}
            onChange={(v) => set("unit", v as Unit)}
            options={UNITS.map((u) => ({ value: u, label: u === "fixed" ? t("Fixed date") : t(UNIT_COPY[u]) }))}
          />
        </div>
        {!fixed && (
          <div className="field dl-amount">
            <label htmlFor={`${id}-amount`}>{t("Amount")}</label>
            <input id={`${id}-amount`} type="number" inputMode="numeric" min={1} max={3650} value={value.amount} onChange={(e) => set("amount", e.target.value)} />
          </div>
        )}
      </div>
      {unitAssumed && value.unit === "business_days" && (
        <p className="dl-hint">{t("The document says «días» without «hábiles» or «calendario», so working days are assumed (art. 118 CGP). Change it if the norm says otherwise.")}</p>
      )}

      <div className="dl-form-row">
        {!fixed && (
          <div className="field">
            <span className="field-label">{t("Runs from")}</span>
            <Select
              ariaLabel={t("Runs from")}
              value={value.trigger_kind}
              onChange={(v) => set("trigger_kind", v as TriggerKind)}
              options={TRIGGER_KINDS.map((k) => ({ value: k, label: t(TRIGGER_COPY[k]) }))}
            />
          </div>
        )}
        <div className="field">
          <span className="field-label">{fixed ? t("Date") : t("Date of that event")}</span>
          <DatePicker value={value.trigger_date} onChange={(v) => set("trigger_date", v)} label={fixed ? t("Date") : t("Event date")} ariaLabel={fixed ? t("Date") : t("Date of that event")} emptyText={t("pick a date")} />
        </div>
      </div>
      {!fixed && value.trigger_kind === "notification" && (
        <Checkbox
          checked={value.notice_by_email}
          onChange={(v) => set("notice_by_email", v)}
          label={t("Personal notice sent by email (Ley 2213 de 2022, art. 8): it counts as made two working days after it was sent")}
        />
      )}

      <div className="field">
        <label htmlFor={`${id}-basis`}>{t("Legal basis")}</label>
        <input id={`${id}-basis`} value={value.legal_basis} maxLength={300} onChange={(e) => set("legal_basis", e.target.value)} placeholder={t("e.g. art. 369 CGP")} />
      </div>

      <div className="field">
        <span className="field-label">{t("Responsible")}</span>
        <Select
          ariaLabel={t("Responsible")}
          value={value.responsible_id}
          onChange={(v) => set("responsible_id", v)}
          placeholder={t("Choose a person…")}
          options={people.map((p) => ({ value: p.id, label: p.id === me ? t("{name} (you)", { name: personName(p) }) : personName(p), hint: p.display_name ? p.email : undefined }))}
        />
      </div>

      <section className="dl-preview" aria-live="polite" aria-label={t("Due date")}>
        {!ready ? (
          <p className="muted">{fixed ? t("Pick the date to check it against the calendar.") : value.trigger_date ? t("Fill in the amount and the date to see the due date.") : t("Pick the date it runs from to see the due date.")}</p>
        ) : previewError ? (
          <div className="alert" role="alert">
            <IconAlert size={16} />
            {previewError}
          </div>
        ) : !preview ? (
          <div className="stack" aria-hidden="true">
            <Skel w="60%" h={18} />
            <Skel w="90%" h={12} />
            <Skel w="80%" h={12} />
          </div>
        ) : (
          <div className={loading ? "dl-stale" : undefined}>
            <ComputationView c={preview.computation} unit={value.unit} org={org} country={preview.country ?? country} />
          </div>
        )}
      </section>
    </div>
  );
}
