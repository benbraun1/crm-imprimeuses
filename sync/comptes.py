"""Règles métier du carnet revendeurs, reprises de rfm_revendeurs.py (01/09/2026).

Ces fonctions ne parlent ni à Shopify ni à la base : elles prennent des
commandes au format de l'API GraphQL Admin et renvoient des clés de compte,
des canaux, etc. Elles sont testées dans tests/test_comptes.py.

La fonction norm() a un équivalent exact en TypeScript (web/src/lib/norm.ts),
utilisé quand on crée un compte à la main : garder les deux identiques.
"""
import re
import unicodedata

TAGS_B2B = {"b2b", "faire", "ankorstore", "wholesale"}

# Clés normalisées des comptes à ignorer (comptes internes et de test).
CLIENTS_EXCLUS = {
    "hineni partners",
    "les imprimeuses",
    "b2ben b2braun",
    "ankorstore",
    "test",
    "john doe",
}
# Toute fiche client dont l'e-mail est sur ce domaine est un compte interne.
DOMAINES_INTERNES = ("@lesimprimeuses.com",)

PREFIXES_PORTE_CLES = ("POR-", "KC-")

_FORMES_JURIDIQUES = re.compile(r"\b(sarl|sas|sasu|eurl|sa|srl|sprl|gmbh|ag)\b")
_NUMERO_TVA = re.compile(r"[A-Z]{2}\d{8,}")


def norm(s):
    """Nom normalisé : sans accents, en minuscules, sans forme juridique.

    Les accents sont retirés ; tout autre caractère non ASCII (apostrophe
    typographique, ø…) devient un séparateur, comme la ponctuation ASCII.
    """
    s = "".join(
        ch if ord(ch) < 128 else " "
        for ch in unicodedata.normalize("NFKD", s or "")
        if not unicodedata.combining(ch)
    ).lower()
    s = _FORMES_JURIDIQUES.sub(" ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def tags_de(o):
    return {t.lower() for t in (o.get("tags") or [])}


def entreprise(o):
    """L'entreprise Shopify (B2B natif) qui a passé la commande, ou None."""
    pe = o.get("purchasingEntity") or {}
    if pe.get("__typename") == "PurchasingCompany":
        return pe.get("company") or None
    return None


def est_b2b(o):
    return bool(tags_de(o) & TAGS_B2B) or entreprise(o) is not None


def canal(o):
    app = ((o.get("app") or {}).get("name") or "").lower()
    tags = tags_de(o)
    if "faire" in app or "faire" in tags:
        return "Faire"
    if "ankorstore" in app or "ankorstore" in tags:
        return "Ankorstore"
    return "Direct"


def email_client(o):
    c = o.get("customer") or {}
    return ((c.get("defaultEmailAddress") or {}).get("emailAddress") or "").strip()


def est_interne(o):
    e = email_client(o).lower()
    return any(e.endswith(d) for d in DOMAINES_INTERNES)


def nom_compte(o):
    """Nom affiché du compte revendeur d'une commande (règle du carnet)."""
    ent = entreprise(o)
    if ent and ent.get("name"):
        return ent["name"].strip()
    nom = ((o.get("billingAddress") or {}).get("company")
           or (o.get("shippingAddress") or {}).get("company") or "").strip()
    if _NUMERO_TVA.fullmatch(nom):
        # Numéro de TVA saisi à la place du nom de société : on tente la facturation.
        facturation = ((o.get("billingAddress") or {}).get("company") or "").strip()
        nom = "" if _NUMERO_TVA.fullmatch(facturation) else facturation
    if not nom:
        c = o.get("customer") or {}
        nom = email_client(o) or (c.get("displayName") or "").strip()
    return nom


def cle_compte(o):
    """(clé normalisée, nom affiché) du compte revendeur d'une commande."""
    nom = nom_compte(o)
    return norm(nom), nom


def a_porte_cles(o):
    for ligne in ((o.get("lineItems") or {}).get("nodes") or []):
        sku = (ligne.get("sku") or "").upper()
        if ligne.get("currentQuantity") and sku.startswith(PREFIXES_PORTE_CLES):
            return True
    return False


def montant(o):
    return float((((o.get("currentSubtotalPriceSet") or {}).get("shopMoney") or {}).get("amount")) or 0)


def departement(pays, cp):
    cp = (cp or "").strip()
    if pays == "FR" and cp[:2].isdigit():
        return cp[:2]
    return ""
