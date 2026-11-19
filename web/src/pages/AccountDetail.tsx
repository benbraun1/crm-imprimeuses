import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { supabase } from "../lib/supabase";
import type { Account, Adjustment, Contact, Interaction, Kind, Order } from "../lib/types";
import { KINDS } from "../lib/types";
import { useTeam } from "../lib/team";
import { firstName, fmtDate, fmtDays, fmtEuro, fmtEuro2, todayISO } from "../lib/format";
import { SegmentPill } from "../components/SegmentPill";
import { AccountPicker } from "../components/AccountPicker";

const KIND_LABEL: Record<Kind, string> = {
  appel: "Appel",
  email: "E-mail",
  visite: "Visite",
  salon: "Salon",
  "rendez-vous": "Rendez-vous",
  message: "Message",
  note: "Note",
};

interface Data {
  account: Account;
  orders: Order[];
  contacts: Contact[];
  interactions: Interaction[];
  adjustments: Adjustment[];
}

export default function AccountDetail() {
  const { id } = useParams();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [acc, ord, con, int] = await Promise.all([
      supabase.from("account_overview").select("*").eq("id", id!).maybeSingle(),
      supabase.from("orders").select("*").eq("account_id", id!).order("created_at", { ascending: false }),
      supabase.from("contacts").select("*").eq("account_id", id!).order("name"),
      supabase.from("interactions").select("*").eq("account_id", id!).order("happened_on", { ascending: false }).order("created_at", { ascending: false }),
    ]);
    const err = acc.error || ord.error || con.error || int.error;
    if (err) return setError(err.message);
    if (!acc.data) return setError("Ce compte n'existe plus (il a peut-être été fusionné).");
    const adj = await supabase.from("revenue_adjustments").select("*").eq("account_key", (acc.data as Account).key);
    setData({
      account: acc.data as Account,
      orders: (ord.data as Order[]) ?? [],
      contacts: (con.data as Contact[]) ?? [],
      interactions: (int.data as Interaction[]) ?? [],
      adjustments: (adj.data as Adjustment[]) ?? [],
    });
  }, [id]);

  useEffect(() => {
    setData(null);
    setError("");
    load();
  }, [load]);

  if (error) return <p className="error">{error} <Link to="/">Retour à la liste</Link></p>;
  if (!data) return <p className="muted">Chargement…</p>;
  const a = data.account;

  return (
    <div className="detail">
      <div className="detail-head">
        <button className="btn ghost small" onClick={() => history.back()}>← Retour</button>
        <div className="title-row">
          <h1>{a.label}</h1>
          <SegmentPill segment={a.segment} />
          {a.hidden && <span className="badge">Masqué</span>}
        </div>
        <div className="sub">
          {[a.address1, [a.zip, a.city].filter(Boolean).join(" "), a.country].filter(Boolean).join(" · ") || "Adresse inconnue"}
          {a.display_name && a.display_name !== a.name && <> · nom Shopify : {a.name}</>}
        </div>
      </div>

      {a.faire_origin && (
        <div className="banner warn">
          <strong>Revendeur apporté par Faire.</strong> Les règles de Faire interdisent de le démarcher hors de la plateforme :
          passer par la messagerie Faire.
        </div>
      )}

      <div className="kpis">
        <Kpi label="CA HT cumulé" value={fmtEuro(a.ca_ht)} hint={data.adjustments.length ? "dont corrections manuelles" : undefined} />
        <Kpi label="Commandes" value={String(a.nb_orders)} hint={a.channel ? `surtout ${a.channel}` : undefined} />
        <Kpi label="Dernière commande" value={fmtDate(a.last_order_on)} hint={a.days_since_order != null ? fmtDays(a.days_since_order) : undefined} />
        <Kpi label="Avant-dernière" value={fmtDate(a.prev_order_on)} />
        <Kpi label="Client depuis" value={fmtDate(a.first_order_on)} />
        <Kpi label="Porte-clés" value={a.has_keychains ? "Oui" : "Non"} />
        <Kpi label="Dernier contact" value={a.last_contact_on ? fmtDays(a.days_since_contact) : "Jamais"} hint={a.last_contact_on ? fmtDate(a.last_contact_on) : undefined} />
      </div>

      <div className="detail-grid">
        <div className="col-main">
          <Journal account={a} contacts={data.contacts} interactions={data.interactions} reload={load} />
          <Orders orders={data.orders} />
        </div>
        <div className="col-side">
          <FollowUp account={a} reload={load} />
          <Contacts accountId={a.id} contacts={data.contacts} reload={load} />
          <Advanced account={a} adjustments={data.adjustments} reload={load} />
        </div>
      </div>
    </div>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {hint && <div className="kpi-hint">{hint}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- Journal */

function Journal({ account, contacts, interactions, reload }: { account: Account; contacts: Contact[]; interactions: Interaction[]; reload: () => void }) {
  const { me, team } = useTeam();
  const [kind, setKind] = useState<Kind>("appel");
  const [date, setDate] = useState(todayISO());
  const [contactId, setContactId] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const { error } = await supabase.from("interactions").insert({
      account_id: account.id,
      kind,
      happened_on: date,
      contact_id: contactId || null,
      body: body.trim(),
      author_email: me,
    });
    setBusy(false);
    if (error) return setErr(error.message);
    setBody("");
    setDate(todayISO());
    reload();
  }

  async function remove(i: Interaction) {
    if (!confirm("Supprimer cette entrée du journal ?")) return;
    const { error } = await supabase.from("interactions").delete().eq("id", i.id);
    if (error) alert(error.message);
    reload();
  }

  return (
    <section className="card">
      <h2>Journal des échanges</h2>
      <form className="journal-form" onSubmit={add}>
        <div className="row">
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} aria-label="Type d'échange">
            {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
          <input type="date" value={date} max={todayISO()} onChange={(e) => setDate(e.target.value)} aria-label="Date" required />
          {contacts.length > 0 && (
            <select value={contactId} onChange={(e) => setContactId(e.target.value)} aria-label="Contact">
              <option value="">Contact : —</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name || c.email}</option>)}
            </select>
          )}
        </div>
        <textarea rows={3} placeholder="Ce qui s'est dit, ce qui a été promis…" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row end">
          {err && <span className="error">{err}</span>}
          <button className="btn primary" disabled={busy}>{busy ? "Enregistrement…" : "Ajouter au journal"}</button>
        </div>
      </form>

      {interactions.length === 0 ? (
        <p className="muted">Aucun échange noté pour l'instant.</p>
      ) : (
        <ol className="timeline">
          {interactions.map((i) => {
            const c = contacts.find((x) => x.id === i.contact_id);
            return (
              <li key={i.id}>
                <div className="tl-head">
                  <span className={"kind k-" + i.kind}>{KIND_LABEL[i.kind]}</span>
                  <strong>{fmtDate(i.happened_on)}</strong>
                  <span className="muted">· {firstName(i.author_email, team)}{c ? ` avec ${c.name || c.email}` : ""}</span>
                  {i.author_email === me && (
                    <button className="link danger" onClick={() => remove(i)}>Supprimer</button>
                  )}
                </div>
                {i.body && <p className="tl-body">{i.body}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ Suivi */

function FollowUp({ account, reload }: { account: Account; reload: () => void }) {
  const { team } = useTeam();
  const init = () => ({
    owner_email: account.owner_email ?? "",
    next_action_on: account.next_action_on ?? "",
    next_action: account.next_action ?? "",
    tags: account.tags.join(", "),
    memo: account.memo ?? "",
    website: account.website ?? "",
    email: account.email ?? "",
    phone: account.phone ?? "",
  });
  const [f, setF] = useState(init);
  const [state, setState] = useState<"" | "saving" | "saved">("");
  const [err, setErr] = useState("");
  useEffect(() => setF(init()), [account]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = JSON.stringify(f) !== JSON.stringify(init());
  const upd = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setF({ ...f, [k]: e.target.value });
    setState("");
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setState("saving");
    setErr("");
    const { error } = await supabase
      .from("accounts")
      .update({
        owner_email: f.owner_email || null,
        next_action_on: f.next_action_on || null,
        next_action: f.next_action.trim() || null,
        tags: [...new Set(f.tags.split(",").map((t) => t.trim()).filter(Boolean))],
        memo: f.memo.trim() || null,
        website: f.website.trim() || null,
        email: f.email.trim() || null,
        phone: f.phone.trim() || null,
      })
      .eq("id", account.id);
    if (error) {
      setErr(error.message);
      setState("");
      return;
    }
    setState("saved");
    reload();
  }

  return (
    <section className="card">
      <h2>Suivi</h2>
      <form className="stack" onSubmit={save}>
        <label className="field">
          <span>Responsable</span>
          <select value={f.owner_email} onChange={upd("owner_email")}>
            <option value="">—</option>
            {team.map((m) => <option key={m.email} value={m.email}>{m.display_name}</option>)}
          </select>
        </label>
        <div className="row">
          <label className="field">
            <span>Prochaine action le</span>
            <input type="date" value={f.next_action_on} onChange={upd("next_action_on")} />
          </label>
          {f.next_action_on && (
            <button type="button" className="link" onClick={() => setF({ ...f, next_action_on: "", next_action: "" })}>
              Fait / effacer
            </button>
          )}
        </div>
        <label className="field">
          <span>Quoi</span>
          <input value={f.next_action} onChange={upd("next_action")} placeholder="Ex. rappeler pour la collection de Noël" />
        </label>
        <label className="field">
          <span>Tags (séparés par des virgules)</span>
          <input value={f.tags} onChange={upd("tags")} placeholder="librairie, concept store, salon M&O…" />
        </label>
        <label className="field">
          <span>Mémo (infos durables : horaires, préférences, qui décide…)</span>
          <textarea rows={3} value={f.memo} onChange={upd("memo")} />
        </label>
        <div className="row">
          <label className="field">
            <span>E-mail</span>
            <input type="email" value={f.email} onChange={upd("email")} />
          </label>
          <label className="field">
            <span>Téléphone</span>
            <input value={f.phone} onChange={upd("phone")} />
          </label>
        </div>
        <label className="field">
          <span>Site / Instagram</span>
          <input value={f.website} onChange={upd("website")} />
        </label>
        <div className="row end">
          {err && <span className="error">{err}</span>}
          {state === "saved" && !dirty && <span className="ok-text">Enregistré</span>}
          <button className="btn primary" disabled={!dirty || state === "saving"}>
            {state === "saving" ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </form>
      {(f.email || f.phone) && (
        <div className="quick-actions">
          {f.email && <a className="btn ghost small" href={`mailto:${f.email}`}>Écrire</a>}
          {f.phone && <a className="btn ghost small" href={`tel:${f.phone.replace(/\s/g, "")}`}>Appeler</a>}
        </div>
      )}
    </section>
  );
}

/* --------------------------------------------------------------- Contacts */

function Contacts({ accountId, contacts, reload }: { accountId: string; contacts: Contact[]; reload: () => void }) {
  const empty = { id: "", name: "", email: "", phone: "", role: "", notes: "" };
  const [edit, setEdit] = useState<typeof empty | null>(null);
  const [err, setErr] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!edit) return;
    const row = {
      name: edit.name.trim() || null,
      email: edit.email.trim() || null,
      phone: edit.phone.trim() || null,
      role: edit.role.trim() || null,
      notes: edit.notes.trim() || null,
    };
    const { error } = edit.id
      ? await supabase.from("contacts").update(row).eq("id", edit.id)
      : await supabase.from("contacts").insert({ ...row, account_id: accountId, source: "manuel" });
    if (error) return setErr(error.message);
    setEdit(null);
    setErr("");
    reload();
  }

  async function remove(c: Contact) {
    if (!confirm(`Supprimer le contact ${c.name || c.email} ?`)) return;
    const { error } = await supabase.from("contacts").delete().eq("id", c.id);
    if (error) alert(error.message);
    reload();
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Contacts</h2>
        {!edit && <button className="btn ghost small" onClick={() => setEdit(empty)}>+ Ajouter</button>}
      </div>
      {edit && (
        <form className="stack contact-form" onSubmit={save}>
          <div className="row">
            <input placeholder="Nom" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <input placeholder="Rôle (gérante, acheteur…)" value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value })} />
          </div>
          <div className="row">
            <input type="email" placeholder="E-mail" value={edit.email} onChange={(e) => setEdit({ ...edit, email: e.target.value })} />
            <input placeholder="Téléphone" value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
          </div>
          <input placeholder="Notes" value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} />
          <div className="row end">
            {err && <span className="error">{err}</span>}
            <button type="button" className="btn ghost small" onClick={() => setEdit(null)}>Annuler</button>
            <button className="btn primary small">Enregistrer</button>
          </div>
        </form>
      )}
      {contacts.length === 0 && !edit && <p className="muted">Aucun contact.</p>}
      <ul className="contacts">
        {contacts.map((c) => (
          <li key={c.id}>
            <div>
              <strong>{c.name || "(sans nom)"}</strong>
              {c.role && <span className="muted"> · {c.role}</span>}
            </div>
            {c.email && (
              <div className="sub">
                {c.email.endsWith("@relay.faire.com") ? <span title="Adresse relais Faire">{c.email}</span> : <a href={`mailto:${c.email}`}>{c.email}</a>}
              </div>
            )}
            {c.phone && <div className="sub"><a href={`tel:${c.phone.replace(/\s/g, "")}`}>{c.phone}</a></div>}
            {c.notes && <div className="sub">{c.notes}</div>}
            <div className="sub row-actions">
              <span className="muted">{c.source}</span>
              <button className="link" onClick={() => setEdit({ id: c.id, name: c.name ?? "", email: c.email ?? "", phone: c.phone ?? "", role: c.role ?? "", notes: c.notes ?? "" })}>Modifier</button>
              {!c.shopify_customer_id && <button className="link danger" onClick={() => remove(c)}>Supprimer</button>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/* -------------------------------------------------------------- Commandes */

function Orders({ orders }: { orders: Order[] }) {
  if (!orders.length) return null;
  return (
    <section className="card">
      <h2>Commandes de gros</h2>
      <div className="table-wrap">
        <table className="orders">
          <thead>
            <tr><th>Date</th><th>N°</th><th>Canal</th><th className="num">Sous-total HT</th><th></th></tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} className={o.cancelled ? "cancelled" : ""}>
                <td>{fmtDate(o.created_at)}</td>
                <td>{o.name}</td>
                <td>{o.channel}</td>
                <td className="num">{fmtEuro2(o.subtotal)}</td>
                <td>{o.cancelled ? "annulée" : o.has_keychains ? "porte-clés" : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- Avancé */

function Advanced({ account, adjustments, reload }: { account: Account; adjustments: Adjustment[]; reload: () => void }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(account.display_name ?? "");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [target, setTarget] = useState<{ id: string; label: string } | null>(null);
  const [err, setErr] = useState("");

  async function run(p: PromiseLike<{ error: { message: string } | null }>) {
    const { error } = await p;
    if (error) {
      setErr(error.message);
      return false;
    }
    setErr("");
    reload();
    return true;
  }

  async function merge() {
    if (!target) return;
    if (!confirm(`Fusionner « ${account.label} » dans « ${target.label} » ?\n\nCommandes, contacts et journal seront déplacés, et les prochaines commandes de « ${account.label} » iront dans « ${target.label} ». Ce compte-ci disparaîtra.`)) return;
    const { error } = await supabase.rpc("merge_accounts", { source_id: account.id, target_id: target.id });
    if (error) return setErr(error.message);
    navigate(`/compte/${target.id}`);
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Avancé</h2>
        <button className="btn ghost small" onClick={() => setOpen(!open)}>{open ? "Fermer" : "Ouvrir"}</button>
      </div>
      {!open ? (
        <p className="muted small">Renommer, corriger le CA, fusionner un doublon, masquer.</p>
      ) : (
        <div className="stack">
          <form className="stack" onSubmit={(e) => { e.preventDefault(); run(supabase.from("accounts").update({ display_name: name.trim() || null }).eq("id", account.id)); }}>
            <label className="field">
              <span>Nom affiché dans le CRM (vide = nom Shopify « {account.name} »)</span>
              <div className="row">
                <input value={name} onChange={(e) => setName(e.target.value)} />
                <button className="btn small">Renommer</button>
              </div>
            </label>
          </form>

          <div>
            <h3>Corrections de CA</h3>
            {adjustments.map((x) => (
              <div key={x.id} className="adj">
                <strong>{fmtEuro2(x.amount)}</strong> <span className="muted">{x.reason}</span>
                <button className="link danger" onClick={() => confirm("Supprimer cette correction ?") && run(supabase.from("revenue_adjustments").delete().eq("id", x.id))}>Supprimer</button>
              </div>
            ))}
            <form className="row" onSubmit={async (e) => {
              e.preventDefault();
              if (await run(supabase.from("revenue_adjustments").insert({ account_key: account.key, amount: Number(amount.replace(",", ".")), reason: reason.trim() }))) {
                setAmount("");
                setReason("");
              }
            }}>
              <input inputMode="decimal" placeholder="Montant HT (€)" value={amount} onChange={(e) => setAmount(e.target.value)} required pattern="-?[0-9]+([.,][0-9]{1,2})?" />
              <input placeholder="Motif" value={reason} onChange={(e) => setReason(e.target.value)} required />
              <button className="btn small">Ajouter</button>
            </form>
          </div>

          <div>
            <h3>Fusionner ce compte dans un autre</h3>
            <p className="muted small">Pour les doublons (ex. « La Cachette M » et « La Cachette de M »). Choisir le compte à garder.</p>
            {target ? (
              <div className="row">
                <span>→ <strong>{target.label}</strong></span>
                <button className="btn danger small" onClick={merge}>Fusionner</button>
                <button className="link" onClick={() => setTarget(null)}>Changer</button>
              </div>
            ) : (
              <AccountPicker exclude={account.id} onPick={setTarget} />
            )}
          </div>

          <div className="row">
            <button className="btn ghost small" onClick={() => run(supabase.from("accounts").update({ hidden: !account.hidden }).eq("id", account.id))}>
              {account.hidden ? "Ne plus masquer" : "Masquer ce compte (test, doublon…)"}
            </button>
          </div>
          <p className="muted small">
            Sources : {account.sources.join(", ") || "—"} · clé : <code>{account.key}</code>
            {account.synced_at && <> · synchro {fmtDate(account.synced_at)}</>}
          </p>
          {err && <p className="error">{err}</p>}
        </div>
      )}
    </section>
  );
}
