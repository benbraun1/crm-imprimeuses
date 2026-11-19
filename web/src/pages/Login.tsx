import { useState } from "react";
import { supabase } from "../lib/supabase";

/**
 * Connexion par e-mail + mot de passe (comptes créés par Benjamin dans Supabase),
 * ou par lien magique envoyé par e-mail.
 */
export default function Login() {
  const [mode, setMode] = useState<"password" | "link">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent">("idle");
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setState("busy");
    setError("");
    const addr = email.trim().toLowerCase();
    if (mode === "password") {
      const { error } = await supabase.auth.signInWithPassword({ email: addr, password });
      if (error) setError(error.message === "Invalid login credentials" ? "E-mail ou mot de passe incorrect." : error.message);
      setState("idle");
      return;
    }
    const { error } = await supabase.auth.signInWithOtp({
      email: addr,
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
    if (error) {
      setError(error.message.includes("Signups not allowed") ? "Cette adresse n'a pas d'accès au CRM." : error.message);
      setState("idle");
    } else setState("sent");
  }

  return (
    <div className="center-page">
      <form className="card narrow" onSubmit={submit}>
        <h1>
          <span className="brand-dot" /> CRM Revendeurs
        </h1>
        {state === "sent" ? (
          <p>
            Un lien de connexion vient d'être envoyé à <strong>{email}</strong>. Ouvrez-le depuis ce navigateur.
          </p>
        ) : (
          <>
            <label className="field">
              <span>Adresse e-mail</span>
              <input type="email" required autoFocus autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            {mode === "password" && (
              <label className="field">
                <span>Mot de passe</span>
                <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </label>
            )}
            <button className="btn primary" disabled={state === "busy"}>
              {state === "busy" ? "…" : mode === "password" ? "Se connecter" : "Recevoir un lien de connexion"}
            </button>
            {error && <p className="error">{error}</p>}
            <button type="button" className="link" onClick={() => { setMode(mode === "password" ? "link" : "password"); setError(""); }}>
              {mode === "password" ? "Mot de passe oublié ? Recevoir un lien par e-mail" : "Se connecter avec un mot de passe"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
