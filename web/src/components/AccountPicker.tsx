import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

interface Option {
  id: string;
  label: string;
  city: string | null;
  nb_orders: number;
}

/** Recherche d'un autre compte (pour une fusion). */
export function AccountPicker({ exclude, onPick }: { exclude: string; onPick: (o: Option) => void }) {
  const [q, setQ] = useState("");
  const [opts, setOpts] = useState<Option[]>([]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setOpts([]);
      return;
    }
    const t = setTimeout(() => {
      supabase
        .from("account_overview")
        .select("id, label, city, nb_orders")
        .or(`label.ilike.%${term.replace(/[,()%]/g, " ")}%,city.ilike.%${term.replace(/[,()%]/g, " ")}%`)
        .neq("id", exclude)
        .limit(10)
        .then(({ data }) => setOpts((data as Option[]) ?? []));
    }, 250);
    return () => clearTimeout(t);
  }, [q, exclude]);

  return (
    <div className="picker">
      <input type="search" placeholder="Nom ou ville du compte à garder…" value={q} onChange={(e) => setQ(e.target.value)} />
      {opts.length > 0 && (
        <ul>
          {opts.map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => onPick(o)}>
                <strong>{o.label}</strong> <span className="muted">{o.city ?? ""} · {o.nb_orders} cmd</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
