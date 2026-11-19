import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Account } from "../lib/types";
import { SEGMENTS } from "../lib/segments";
import { useTeam } from "../lib/team";
import { firstName, fmtDate, fmtDays, fmtEuro, todayISO } from "../lib/format";
import { SegmentPill } from "../components/SegmentPill";

type Params = Record<string, string>;

/** Listes prêtes à l'emploi : chacune n'est qu'un jeu de filtres. */
const PRESETS: { label: string; params: Params; help: string }[] = [
  { label: "Mes relances", params: { owner: "me", relance: "planned", sort: "next_action_on" }, help: "Comptes dont je suis responsable avec une prochaine action datée" },
  { label: "Relances en retard", params: { relance: "due", sort: "next_action_on" }, help: "Prochaine action prévue aujourd'hui ou avant" },
  { label: "Champions sans contact (60 j)", params: { seg: "Champions", contact: "60", sort: "-ca_ht" }, help: "Nos meilleurs comptes à qui on n'a pas parlé depuis 2 mois" },
  { label: "À relancer sans contact (30 j)", params: { seg: "À relancer", contact: "30", sort: "-ca_ht" }, help: "Bons clients qui décrochent" },
  { label: "Nouveaux à fidéliser", params: { seg: "Nouveaux", contact: "30", sort: "-last_order_on" }, help: "Une seule commande récente, pas de contact depuis 30 j" },
  { label: "Inactifs à réveiller", params: { seg: "Inactifs", sort: "-ca_ht" }, help: "Plus de commande depuis plus d'un an, les plus gros d'abord" },
  { label: "Prospects jamais contactés", params: { seg: "Prospects", contact: "never" }, help: "Aucune commande et aucun échange noté" },
];

const COLUMNS: { id: string; label: string; numeric?: boolean }[] = [
  { id: "label", label: "Compte" },
  { id: "segment", label: "Segment" },
  { id: "channel", label: "Canal" },
  { id: "ca_ht", label: "CA HT", numeric: true },
  { id: "nb_orders", label: "Cmd", numeric: true },
  { id: "last_order_on", label: "Dernière commande" },
  { id: "last_contact_on", label: "Dernier contact" },
  { id: "owner_email", label: "Resp." },
  { id: "next_action_on", label: "Prochaine action" },
];

const SEG_ORDER = SEGMENTS.map((s) => s.id as string);

function compare(a: Account, b: Account, col: string): number {
  if (col === "segment") return SEG_ORDER.indexOf(a.segment) - SEG_ORDER.indexOf(b.segment);
  const va = (a as unknown as Record<string, unknown>)[col];
  const vb = (b as unknown as Record<string, unknown>)[col];
  if (va == null && vb == null) return 0;
  if (va == null) return 1; // les vides toujours à la fin
  if (vb == null) return -1;
  if (typeof va === "number" && typeof vb === "number") return va - vb;
  return String(va).localeCompare(String(vb), "fr", { sensitivity: "base" });
}

export default function AccountList() {
  const { me, team } = useTeam();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const [rows, setRows] = useState<Account[] | null>(null);
  const [error, setError] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  useEffect(() => {
    supabase
      .from("account_overview")
      .select("*")
      .limit(10000)
      .then(({ data, error }) => {
        if (error) setError(error.message);
        setRows((data as Account[]) ?? []);
      });
  }, []);

  const p = Object.fromEntries(sp.entries()) as Params;
  const set = (patch: Params) => {
    const next: Params = { ...p, ...patch };
    for (const k of Object.keys(next)) if (!next[k]) delete next[k];
    setSp(next, { replace: true });
  };
  const segs = p.seg ? p.seg.split(",") : [];
  const sort = p.sort || "-last_order_on";
  const today = todayISO();

  const options = useMemo(() => {
    const r = rows ?? [];
    const uniq = (xs: (string | null)[]) => [...new Set(xs.filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b, "fr"));
    return {
      countries: uniq(r.map((a) => a.country)),
      deps: uniq(r.map((a) => a.department)),
      tags: uniq(r.flatMap((a) => a.tags)),
    };
  }, [rows]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = (p.q || "").toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
    const owner = p.owner === "me" ? me : p.owner;
    const out = rows.filter((a) => {
      if (!p.hidden && a.hidden) return false;
      if (segs.length && !segs.includes(a.segment)) return false;
      if (p.canal && a.channel !== p.canal) return false;
      if (p.pays && a.country !== p.pays) return false;
      if (p.dep && a.department !== p.dep) return false;
      if (p.pc === "oui" && !a.has_keychains) return false;
      if (p.pc === "non" && a.has_keychains) return false;
      if (p.tag && !a.tags.includes(p.tag)) return false;
      if (owner === "none" && a.owner_email) return false;
      if (owner && owner !== "none" && a.owner_email !== owner) return false;
      if (p.contact === "never" && a.last_contact_on) return false;
      if (p.contact && p.contact !== "never" && a.days_since_contact != null && a.days_since_contact < Number(p.contact)) return false;
      if (p.cmd && (a.days_since_order == null || a.days_since_order < Number(p.cmd))) return false;
      if (p.relance === "planned" && !a.next_action_on) return false;
      if (p.relance === "due" && (!a.next_action_on || a.next_action_on > today)) return false;
      if (p.relance === "none" && a.next_action_on) return false;
      if (q) {
        const hay = [a.label, a.name, a.city, a.zip, a.country, a.email, a.memo, ...a.tags]
          .join(" ")
          .toLowerCase()
          .normalize("NFD")
          .replace(/\p{M}/gu, "");
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const desc = sort.startsWith("-");
    const col = sort.replace(/^-/, "");
    out.sort((a, b) => {
      const c = compare(a, b, col);
      if (a[col as keyof Account] == null || b[col as keyof Account] == null) return c; // vides en bas
      return desc ? -c : c;
    });
    return out;
  }, [rows, sp, me, today]); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const a of rows ?? []) if (p.hidden || !a.hidden) m[a.segment] = (m[a.segment] ?? 0) + 1;
    return m;
  }, [rows, p.hidden]);

  const activeFilters = Object.keys(p).filter((k) => k !== "sort").length;
  const caTotal = filtered.reduce((s, a) => s + Number(a.ca_ht || 0), 0);

  function toggleSeg(id: string) {
    const next = segs.includes(id) ? segs.filter((s) => s !== id) : [...segs, id];
    set({ seg: next.join(",") });
  }

  function sortBy(col: string) {
    const cur = sort.replace(/^-/, "");
    const numericOrDate = ["ca_ht", "nb_orders", "last_order_on", "last_contact_on"].includes(col);
    if (cur === col) set({ sort: sort.startsWith("-") ? col : "-" + col });
    else set({ sort: numericOrDate ? "-" + col : col });
  }

  function exportCsv() {
    const cols: [string, (a: Account) => unknown][] = [
      ["compte", (a) => a.label], ["segment", (a) => a.segment], ["canal", (a) => a.channel],
      ["ca_ht", (a) => a.ca_ht], ["nb_commandes", (a) => a.nb_orders], ["derniere_commande", (a) => a.last_order_on],
      ["dernier_contact", (a) => a.last_contact_on], ["responsable", (a) => a.owner_email],
      ["prochaine_action", (a) => a.next_action_on], ["action", (a) => a.next_action],
      ["email", (a) => a.email], ["telephone", (a) => a.phone], ["ville", (a) => a.city],
      ["code_postal", (a) => a.zip], ["pays", (a) => a.country], ["porte_cles", (a) => (a.has_keychains ? "oui" : "non")],
      ["origine_faire", (a) => (a.faire_origin ? "oui" : "non")], ["tags", (a) => a.tags.join(", ")],
    ];
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.map((c) => c[0]).join(";"), ...filtered.map((a) => cols.map(([, f]) => esc(f(a))).join(";"))].join("\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `revendeurs-${today}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  if (error) return <p className="error">Erreur de chargement : {error}</p>;
  if (!rows) return <p className="muted">Chargement des comptes…</p>;

  return (
    <div className="list-page">
      <section className="presets" aria-label="Listes">
        {PRESETS.map((pr) => {
          const on = Object.entries(pr.params).every(([k, v]) => p[k] === v) && activeFilters === Object.keys(pr.params).filter((k) => k !== "sort").length;
          return (
            <button key={pr.label} className={"chip preset" + (on ? " on" : "")} title={pr.help} onClick={() => setSp(pr.params, { replace: true })}>
              {pr.label}
            </button>
          );
        })}
      </section>

      <section className="segbar" aria-label="Segments">
        {SEGMENTS.map((s) => (
          <button
            key={s.id}
            className={"chip seg" + (segs.includes(s.id) ? " on" : "")}
            style={{ "--seg": s.color } as React.CSSProperties}
            title={s.help}
            onClick={() => toggleSeg(s.id)}
          >
            <span className="dot" /> {s.id} <span className="count">{counts[s.id] ?? 0}</span>
          </button>
        ))}
      </section>

      <section className="filters">
        <input className="search" type="search" placeholder="Rechercher un nom, une ville, un tag…" value={p.q ?? ""} onChange={(e) => set({ q: e.target.value })} />
        <button className="btn ghost small filters-toggle" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>
          Filtres{activeFilters ? ` (${activeFilters})` : ""}
        </button>
        <div className={"more-filters" + (showFilters ? " open" : "")}>
        <select value={p.canal ?? ""} onChange={(e) => set({ canal: e.target.value })}>
          <option value="">Tous canaux</option>
          <option>Direct</option>
          <option>Faire</option>
          <option>Ankorstore</option>
        </select>
        <select value={p.pays ?? ""} onChange={(e) => set({ pays: e.target.value, dep: "" })}>
          <option value="">Tous pays</option>
          {options.countries.map((c) => <option key={c}>{c}</option>)}
        </select>
        {(!p.pays || p.pays === "FR") && (
          <select value={p.dep ?? ""} onChange={(e) => set({ dep: e.target.value })}>
            <option value="">Tous départements</option>
            {options.deps.map((d) => <option key={d}>{d}</option>)}
          </select>
        )}
        <select value={p.owner ?? ""} onChange={(e) => set({ owner: e.target.value })}>
          <option value="">Tous responsables</option>
          <option value="me">Moi</option>
          {team.map((m) => <option key={m.email} value={m.email}>{m.display_name}</option>)}
          <option value="none">Sans responsable</option>
        </select>
        <select value={p.contact ?? ""} onChange={(e) => set({ contact: e.target.value })}>
          <option value="">Dernier contact : tous</option>
          <option value="never">Jamais contacté</option>
          <option value="30">Pas de contact depuis 30 j</option>
          <option value="60">Pas de contact depuis 60 j</option>
          <option value="90">Pas de contact depuis 90 j</option>
          <option value="180">Pas de contact depuis 6 mois</option>
        </select>
        <select value={p.cmd ?? ""} onChange={(e) => set({ cmd: e.target.value })}>
          <option value="">Dernière commande : toutes</option>
          <option value="60">Pas de commande depuis 60 j</option>
          <option value="90">Pas de commande depuis 90 j</option>
          <option value="180">Pas de commande depuis 6 mois</option>
          <option value="365">Pas de commande depuis 1 an</option>
        </select>
        <select value={p.relance ?? ""} onChange={(e) => set({ relance: e.target.value })}>
          <option value="">Relances : toutes</option>
          <option value="due">En retard / aujourd'hui</option>
          <option value="planned">Prévue</option>
          <option value="none">Aucune prévue</option>
        </select>
        <select value={p.pc ?? ""} onChange={(e) => set({ pc: e.target.value })}>
          <option value="">Porte-clés : tous</option>
          <option value="oui">A acheté des porte-clés</option>
          <option value="non">Jamais de porte-clés</option>
        </select>
        {options.tags.length > 0 && (
          <select value={p.tag ?? ""} onChange={(e) => set({ tag: e.target.value })}>
            <option value="">Tous tags</option>
            {options.tags.map((t) => <option key={t}>{t}</option>)}
          </select>
        )}
        <label className="check">
          <input type="checkbox" checked={!!p.hidden} onChange={(e) => set({ hidden: e.target.checked ? "1" : "" })} /> Masqués
        </label>
        </div>
        {activeFilters > 0 && (
          <button className="btn ghost small" onClick={() => setSp({}, { replace: true })}>
            Tout effacer
          </button>
        )}
      </section>

      <div className="list-summary">
        <span>
          <strong>{filtered.length}</strong> compte{filtered.length > 1 ? "s" : ""} · {fmtEuro(caTotal)} HT cumulés
        </span>
        <button className="btn ghost small" onClick={exportCsv} disabled={!filtered.length}>
          Exporter en CSV
        </button>
      </div>

      <div className="table-wrap">
        <table className="accounts">
          <thead>
            <tr>
              {COLUMNS.map((c) => {
                const cur = sort.replace(/^-/, "") === c.id;
                return (
                  <th key={c.id} className={`col-${c.id}` + (c.numeric ? " num" : "")} aria-sort={cur ? (sort.startsWith("-") ? "descending" : "ascending") : "none"}>
                    <button onClick={() => sortBy(c.id)}>
                      {c.label} {cur ? (sort.startsWith("-") ? "↓" : "↑") : ""}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => {
              const late = a.next_action_on && a.next_action_on <= today;
              return (
                <tr key={a.id} onClick={() => navigate(`/compte/${a.id}`)} className={a.hidden ? "is-hidden" : ""}>
                  <td>
                    <a href={`/compte/${a.id}`} onClick={(e) => e.preventDefault()} className="acc-name">
                      {a.label}
                    </a>
                    {a.faire_origin && <span className="badge faire" title="Revendeur apporté par Faire : ne pas démarcher hors plateforme">Faire</span>}
                    <div className="sub">
                      {[a.city, a.country === "FR" ? a.department : a.country].filter(Boolean).join(" · ")}
                    </div>
                  </td>
                  <td><SegmentPill segment={a.segment} /></td>
                  <td className="col-channel">{a.channel ?? "—"}</td>
                  <td className="num">{a.nb_orders ? fmtEuro(a.ca_ht) : "—"}</td>
                  <td className="num col-nb_orders">{a.nb_orders || "—"}</td>
                  <td>
                    {fmtDate(a.last_order_on)}
                    {a.days_since_order != null && <div className="sub">{fmtDays(a.days_since_order)}</div>}
                  </td>
                  <td>
                    {a.last_contact_on ? (
                      <>
                        {fmtDays(a.days_since_contact)}
                        <div className="sub">{a.last_contact_kind} · {firstName(a.last_contact_by, team)}</div>
                      </>
                    ) : (
                      <span className="muted">jamais</span>
                    )}
                  </td>
                  <td className="col-owner_email">{a.owner_email ? firstName(a.owner_email, team) : <span className="muted">—</span>}</td>
                  <td className={late ? "late" : ""}>
                    {a.next_action_on ? fmtDate(a.next_action_on) : <span className="muted">—</span>}
                    {a.next_action && <div className="sub clamp">{a.next_action}</div>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filtered.length && <p className="muted empty">Aucun compte ne correspond à ces filtres.</p>}
      </div>
    </div>
  );
}
