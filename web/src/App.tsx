import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import type { Session } from "@supabase/supabase-js";
import { configOk, supabase } from "./lib/supabase";
import { Team } from "./lib/team";
import type { TeamMember } from "./lib/types";
import { fmtDays } from "./lib/format";
import Login from "./pages/Login";
import AccountList from "./pages/AccountList";
import AccountDetail from "./pages/AccountDetail";
import NewAccount from "./pages/NewAccount";

async function changePassword() {
  const pwd = prompt("Nouveau mot de passe (8 caractères minimum) :");
  if (!pwd) return;
  if (pwd.length < 8) return alert("Mot de passe trop court.");
  const { error } = await supabase.auth.updateUser({ password: pwd });
  alert(error ? `Erreur : ${error.message}` : "Mot de passe modifié.");
}

interface SyncRun {
  finished_at: string | null;
  status: string;
}

export default function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [team, setTeam] = useState<TeamMember[] | null>(null);
  const [lastSync, setLastSync] = useState<SyncRun | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    supabase
      .from("team_members")
      .select("email, display_name")
      .order("display_name")
      .then(({ data }) => setTeam(data ?? []));
    supabase
      .from("sync_runs")
      .select("finished_at, status")
      .eq("source", "shopify")
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(1)
      .then(({ data }) => setLastSync(data?.[0] ?? null));
  }, [session]);

  if (!configOk) {
    return (
      <div className="center-page">
        <div className="card narrow">
          <h1>Configuration manquante</h1>
          <p>
            Définir <code>VITE_SUPABASE_URL</code> et <code>VITE_SUPABASE_ANON_KEY</code> (voir le README).
          </p>
        </div>
      </div>
    );
  }
  if (session === undefined) return <div className="center-page muted">Chargement…</div>;
  if (!session) return <Login />;
  if (team === null) return <div className="center-page muted">Chargement…</div>;

  const me = (session.user.email ?? "").toLowerCase();
  if (!team.some((m) => m.email === me)) {
    return (
      <div className="center-page">
        <div className="card narrow">
          <h1>Accès non autorisé</h1>
          <p>
            L'adresse <strong>{me}</strong> n'est pas dans l'équipe du CRM. Demandez à Benjamin de l'ajouter à la
            table <code>team_members</code>.
          </p>
          <button className="btn" onClick={() => supabase.auth.signOut()}>
            Se déconnecter
          </button>
        </div>
      </div>
    );
  }

  const syncAge = lastSync?.finished_at
    ? Math.floor((Date.now() - new Date(lastSync.finished_at).getTime()) / 86400000)
    : null;

  return (
    <Team.Provider value={{ me, team }}>
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-dot" /> Revendeurs
        </Link>
        <nav>
          <NavLink to="/" end>
            Comptes
          </NavLink>
          <NavLink to="/nouveau">+ Nouveau compte</NavLink>
        </nav>
        <div className="topbar-right">
          <span
            className={"sync " + (lastSync?.status === "ok" && (syncAge ?? 99) <= 1 ? "ok" : "warn")}
            title="Dernière synchronisation Shopify"
          >
            Shopify : {lastSync ? `${fmtDays(syncAge)}${lastSync.status !== "ok" ? " (échec)" : ""}` : "jamais"}
          </span>
          <button className="link me" title="Changer mon mot de passe" onClick={changePassword}>
            {team.find((m) => m.email === me)?.display_name}
          </button>
          <button className="btn ghost small" onClick={() => supabase.auth.signOut()}>
            Déconnexion
          </button>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<AccountList />} />
          <Route path="/compte/:id" element={<AccountDetail />} />
          <Route path="/nouveau" element={<NewAccount />} />
          <Route path="*" element={<p className="muted">Page introuvable.</p>} />
        </Routes>
      </main>
    </Team.Provider>
  );
}
