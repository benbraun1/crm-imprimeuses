const euro = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const euro2 = new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" });
const date = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

export const fmtEuro = (n: number | null | undefined) => (n == null ? "—" : euro.format(n));
export const fmtEuro2 = (n: number | null | undefined) => (n == null ? "—" : euro2.format(n));

export function fmtDate(d: string | null | undefined) {
  if (!d) return "—";
  return date.format(new Date(d.length === 10 ? d + "T12:00:00" : d));
}

export function fmtDays(n: number | null | undefined) {
  if (n == null) return "jamais";
  if (n === 0) return "aujourd'hui";
  if (n === 1) return "hier";
  if (n < 60) return `il y a ${n} j`;
  if (n < 730) return `il y a ${Math.round(n / 30.4)} mois`;
  return `il y a ${(n / 365).toFixed(1).replace(".", ",")} ans`;
}

export function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

export function firstName(email: string | null | undefined, team: { email: string; display_name: string }[]) {
  if (!email) return "—";
  return team.find((m) => m.email === email.toLowerCase())?.display_name ?? email.split("@")[0];
}
