/**
 * Nom normalisé d'un compte : doit rester identique à norm() dans sync/comptes.py.
 * Sert de clé : un compte créé à la main sous le nom « Rares » récupérera
 * automatiquement les commandes Shopify passées sous ce nom.
 */
export function norm(s: string): string {
  let out = "";
  for (const ch of (s || "").normalize("NFKD")) {
    if (/\p{M}/u.test(ch)) continue; // accents
    out += ch.charCodeAt(0) < 128 ? ch : " ";
  }
  return out
    .toLowerCase()
    .replace(/\b(sarl|sas|sasu|eurl|sa|srl|sprl|gmbh|ag)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
