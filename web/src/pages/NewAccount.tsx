import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "../lib/supabase";
import { norm } from "../lib/norm";
import { useTeam } from "../lib/team";

/** Création d'un compte à la main : prospect, client Pennylane, rencontre en salon… */
export default function NewAccount() {
  const { me, team } = useTeam();
  const navigate = useNavigate();
  const [f, setF] = useState({ name: "", city: "", zip: "", country: "FR", email: "", phone: "", website: "", owner_email: me, source: "manuel", memo: "" });
  const [err, setErr] = useState("");
  const [existing, setExisting] = useState<{ id: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const upd = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const key = norm(f.name);
    if (!key) return setErr("Le nom doit contenir au moins une lettre ou un chiffre.");
    setBusy(true);
    setErr("");
    setExisting(null);
    const dup = await supabase.from("account_overview").select("id, label").eq("key", key).maybeSingle();
    if (dup.data) {
      setBusy(false);
      setExisting(dup.data as { id: string; label: string });
      return;
    }
    const { data, error } = await supabase
      .from("accounts")
      .insert({
        key,
        name: f.name.trim(),
        city: f.city.trim() || null,
        zip: f.zip.trim() || null,
        country: f.country.trim().toUpperCase() || null,
        email: f.email.trim() || null,
        phone: f.phone.trim() || null,
        website: f.website.trim() || null,
        owner_email: f.owner_email || null,
        memo: f.memo.trim() || null,
        sources: [f.source],
      })
      .select("id")
      .single();
    setBusy(false);
    if (error) return setErr(error.message);
    navigate(`/compte/${data.id}`);
  }

  return (
    <div className="detail narrow-page">
      <h1>Nouveau compte</h1>
      <p className="muted">
        Pour un prospect, un client qui n'est que dans Pennylane, une boutique rencontrée en salon… Si ce revendeur
        commande plus tard sur Shopify sous le même nom de société, ses commandes arriveront automatiquement ici.
      </p>
      <form className="card stack" onSubmit={submit}>
        <label className="field">
          <span>Nom de la boutique / société *</span>
          <input required autoFocus value={f.name} onChange={upd("name")} />
        </label>
        <div className="row">
          <label className="field"><span>Code postal</span><input value={f.zip} onChange={upd("zip")} /></label>
          <label className="field grow"><span>Ville</span><input value={f.city} onChange={upd("city")} /></label>
          <label className="field"><span>Pays (code)</span><input value={f.country} onChange={upd("country")} maxLength={2} size={3} /></label>
        </div>
        <div className="row">
          <label className="field grow"><span>E-mail</span><input type="email" value={f.email} onChange={upd("email")} /></label>
          <label className="field grow"><span>Téléphone</span><input value={f.phone} onChange={upd("phone")} /></label>
        </div>
        <label className="field"><span>Site / Instagram</span><input value={f.website} onChange={upd("website")} /></label>
        <div className="row">
          <label className="field grow">
            <span>Origine</span>
            <select value={f.source} onChange={upd("source")}>
              <option value="manuel">Saisie manuelle</option>
              <option value="pennylane">Pennylane</option>
              <option value="salon">Salon</option>
              <option value="klaviyo">Klaviyo</option>
            </select>
          </label>
          <label className="field grow">
            <span>Responsable</span>
            <select value={f.owner_email} onChange={upd("owner_email")}>
              <option value="">—</option>
              {team.map((m) => <option key={m.email} value={m.email}>{m.display_name}</option>)}
            </select>
          </label>
        </div>
        <label className="field"><span>Mémo</span><textarea rows={3} value={f.memo} onChange={upd("memo")} /></label>
        {existing && (
          <p className="error">
            Un compte avec ce nom existe déjà : <Link to={`/compte/${existing.id}`}>{existing.label}</Link>
          </p>
        )}
        {err && <p className="error">{err}</p>}
        <div className="row end">
          <button className="btn primary" disabled={busy}>{busy ? "Création…" : "Créer le compte"}</button>
        </div>
      </form>
    </div>
  );
}
