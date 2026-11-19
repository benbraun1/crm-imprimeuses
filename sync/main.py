"""Synchronisation nocturne Shopify -> base du CRM.

Lancée chaque nuit par GitHub Actions (.github/workflows/sync.yml), ou à la main :

    pip install -r sync/requirements.txt
    export SHOPIFY_SHOP=on-the-other-fish SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=...
    export DATABASE_URL=postgresql://...
    python -m sync.main            # ou --dry-run pour ne rien écrire

Étapes :
1. Trois exports Shopify (bulk operations) : commandes de gros taguées, fiches
   entreprises (avec leurs commandes et contacts), clients tagués B2B.
2. Regroupement en comptes revendeurs selon la règle du carnet.
3. Écriture en base : comptes, commandes, contacts. Les notes, relances et
   autres champs saisis dans le CRM ne sont jamais touchés.

Le segment RFM n'est pas calculé ici : la vue SQL account_overview le calcule
à partir des commandes, à la date du jour.
"""
import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone

from . import comptes as C

DEBUT_B2B = "2024-02-01"  # avant cette date, les commandes de gros ne sont pas taguées

def champs_commande(lignes):
    return """
  id name createdAt cancelledAt tags
  app { name }
  currentSubtotalPriceSet { shopMoney { amount } }
  customer { id displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } }
  purchasingEntity { __typename ... on PurchasingCompany { company { id name } } }
  shippingAddress { company address1 city zip countryCodeV2 phone }
  billingAddress { company address1 city zip countryCodeV2 phone }
  %s
""" % lignes


# Bulk operation : connexions imbriquées sur 2 niveaux au plus, 5 connexions au total.
REQ_COMMANDES = """
{ orders(query: "created_at:>=%s AND (tag:b2b OR tag:Faire OR tag:Ankorstore OR tag:Wholesale)") {
    edges { node { %s } } } }
""" % (DEBUT_B2B, champs_commande("lineItems { edges { node { id sku currentQuantity } } }"))

# Les commandes des fiches entreprises ne peuvent pas descendre jusqu'aux lignes
# (3 niveaux) : on ne récupère que leurs id, puis on va chercher celles qui ne
# sont pas déjà dans l'export des commandes taguées (REQ_NODES).
REQ_ENTREPRISES = """
{ companies { edges { node {
    id name
    contacts { edges { node { id customer {
      id displayName defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber } } } } }
    locations { edges { node { id
      shippingAddress { address1 city zip countryCode phone }
      billingAddress { address1 city zip countryCode phone } } } }
    orders { edges { node { id createdAt } } }
} } } }
"""

REQ_NODES = """
query($ids: [ID!]!) { nodes(ids: $ids) { ... on Order { %s } } }
""" % champs_commande("lineItems(first: 60) { nodes { sku currentQuantity } }")

REQ_CLIENTS_B2B = """
{ customers(query: "tag:b2b OR tag:Faire OR tag:Ankorstore OR tag:Wholesale") { edges { node {
    id displayName numberOfOrders tags
    defaultEmailAddress { emailAddress } defaultPhoneNumber { phoneNumber }
    defaultAddress { company address1 city zip countryCodeV2 phone }
} } } }
"""


def charger_shopify(shop=None):
    from .shopify import Shopify, regrouper

    shop = shop or Shopify()
    print("Export des commandes de gros…", flush=True)
    commandes = regrouper(shop.bulk(REQ_COMMANDES), "Order")
    print(f"  {len(commandes)} commandes taguées", flush=True)
    print("Export des fiches entreprises…", flush=True)
    entreprises = regrouper(shop.bulk(REQ_ENTREPRISES), "Company")
    print(f"  {len(entreprises)} entreprises", flush=True)

    # Commandes d'entreprise sans tag : on les charge en détail, par lots.
    connues = {o["id"] for o in commandes}
    manquantes = sorted({
        o["id"] for e in entreprises for o in nodes(e.get("orders"))
        if o["id"] not in connues and (o.get("createdAt") or "") >= DEBUT_B2B
    })
    details = {}
    for i in range(0, len(manquantes), 10):
        for o in shop.graphql(REQ_NODES, {"ids": manquantes[i:i + 10]})["nodes"]:
            if o:
                details[o["id"]] = o
    for e in entreprises:
        if e.get("orders"):
            e["orders"]["nodes"] = [details.get(o["id"]) for o in nodes(e["orders"]) if details.get(o["id"])]
    print(f"  {len(details)} commandes d'entreprise sans tag", flush=True)

    print("Export des clients tagués B2B…", flush=True)
    clients = shop.bulk(REQ_CLIENTS_B2B)
    print(f"  {len(clients)} clients", flush=True)
    return commandes, entreprises, clients


def nodes(conn):
    return (conn or {}).get("nodes") or []


def adresse_entreprise(ent):
    for loc in nodes(ent.get("locations")):
        adr = loc.get("shippingAddress") or loc.get("billingAddress")
        if adr:
            return {
                "address1": adr.get("address1"), "city": adr.get("city"), "zip": adr.get("zip"),
                "country": adr.get("countryCode"), "phone": adr.get("phone"),
            }
    return {}


class Regroupement:
    """Construit les comptes revendeurs à partir des données Shopify.

    alias : {ancienne clé: clé du compte} (comptes fusionnés dans le CRM)
    cles_entreprise : {gid entreprise Shopify: clé du compte} (comptes existants)
    """

    def __init__(self, alias=None, cles_entreprise=None):
        self.alias = dict(alias or {})
        self.cles_entreprise = dict(cles_entreprise or {})
        self.comptes = {}
        self.commandes = {}
        self.contacts = {}

    def resoudre(self, cle, company_id=None):
        if company_id and company_id in self.cles_entreprise:
            return self.cles_entreprise[company_id]
        return self.alias.get(cle, cle)

    def compte(self, cle, nom):
        c = self.comptes.get(cle)
        if c is None:
            c = self.comptes[cle] = {
                "key": cle, "name": nom, "address1": None, "city": None, "zip": None,
                "country": None, "email": None, "phone": None,
                "company_ids": set(), "sources": {"shopify"}, "_date_adresse": "",
                "name_from_company": False,
            }
        return c

    def ajouter_entreprise(self, ent):
        cle = self.resoudre(C.norm(ent.get("name")), ent.get("id"))
        if not cle or cle in C.CLIENTS_EXCLUS:
            return
        # La 1re fiche entreprise rencontrée pour une clé devient la référence.
        self.cles_entreprise.setdefault(ent["id"], cle)
        c = self.compte(cle, ent["name"].strip())
        c["company_ids"].add(ent["id"])
        c["name"] = ent["name"].strip()  # le nom de la fiche entreprise fait foi
        c["name_from_company"] = True
        adr = adresse_entreprise(ent)
        if adr and not c["_date_adresse"]:
            c.update({k: v for k, v in adr.items() if v})
            c["_date_adresse"] = "9999"  # l'adresse de la fiche entreprise fait foi
        for contact in nodes(ent.get("contacts")):
            self.ajouter_contact(cle, contact.get("customer"), "shopify (entreprise)")

    def ajouter_commande(self, o):
        if not C.est_b2b(o) or C.est_interne(o):
            return
        ent = C.entreprise(o)
        cle_brute, nom = C.cle_compte(o)
        cle = self.resoudre(cle_brute, ent and ent.get("id"))
        if not cle or cle in C.CLIENTS_EXCLUS:
            return
        c = self.compte(cle, nom)
        if ent and ent.get("id"):
            c["company_ids"].add(ent["id"])
        date = o["createdAt"]
        adr = o.get("shippingAddress") or o.get("billingAddress") or {}
        if adr.get("city") and date > c["_date_adresse"]:
            c.update({
                "address1": adr.get("address1"), "city": adr.get("city"), "zip": adr.get("zip"),
                "country": adr.get("countryCodeV2"),
            })
            c["phone"] = adr.get("phone") or c["phone"]
            c["_date_adresse"] = date
        client = o.get("customer") or {}
        email = C.email_client(o)
        if email and not email.endswith("@relay.faire.com"):
            c["email"] = c["email"] or email
        self.commandes[o["id"]] = {
            "id": o["id"],
            "account_key": cle,
            "name": o.get("name"),
            "created_at": date,
            "subtotal": round(C.montant(o), 2),
            "channel": C.canal(o),
            "cancelled": bool(o.get("cancelledAt")),
            "has_keychains": C.a_porte_cles(o),
            "customer_id": client.get("id"),
        }
        self.ajouter_contact(cle, client, "shopify (commande)", date)

    def ajouter_client_b2b(self, cl):
        """Client tagué B2B : prospect s'il n'a pas de compte via ses commandes."""
        if cl.get("id") in self.contacts:
            return
        email = ((cl.get("defaultEmailAddress") or {}).get("emailAddress") or "").strip()
        if any(email.lower().endswith(d) for d in C.DOMAINES_INTERNES):
            return
        adr = cl.get("defaultAddress") or {}
        nom = (adr.get("company") or "").strip() or email or (cl.get("displayName") or "").strip()
        cle = self.resoudre(C.norm(nom))
        if not cle or cle in C.CLIENTS_EXCLUS:
            return
        c = self.compte(cle, nom)
        if not c["city"] and adr.get("city"):
            c.update({
                "address1": adr.get("address1"), "city": adr.get("city"), "zip": adr.get("zip"),
                "country": adr.get("countryCodeV2"),
            })
        if email and not email.endswith("@relay.faire.com"):
            c["email"] = c["email"] or email
        self.ajouter_contact(cle, cl, "shopify (client B2B)")

    def ajouter_contact(self, cle, client, source, date=""):
        if not client or not client.get("id"):
            return
        email = ((client.get("defaultEmailAddress") or {}).get("emailAddress") or "").strip()
        if any(email.lower().endswith(d) for d in C.DOMAINES_INTERNES):
            return
        prec = self.contacts.get(client["id"])
        # Un même client peut commander pour plusieurs comptes : on garde le plus récent.
        if prec and prec["_date"] >= date:
            return
        self.contacts[client["id"]] = {
            "shopify_customer_id": client["id"],
            "account_key": cle,
            "name": (client.get("displayName") or "").strip() or None,
            "email": email or None,
            "phone": (client.get("defaultPhoneNumber") or {}).get("phoneNumber"),
            "source": source,
            "_date": date,
        }

    def construire(self, commandes, entreprises, clients):
        for ent in entreprises:
            self.ajouter_entreprise(ent)
        vues = set()
        for o in list(commandes) + [o for e in entreprises for o in nodes(e.get("orders"))]:
            if o["id"] in vues:
                continue
            vues.add(o["id"])
            self.ajouter_commande(o)
        for cl in clients:
            self.ajouter_client_b2b(cl)
        return self


def charger_correspondances(cur):
    cur.execute("select alias_key, account_key from public.account_aliases")
    alias = dict(cur.fetchall())
    cur.execute("select key, unnest(shopify_company_ids) from public.accounts")
    cles_entreprise = {gid: cle for cle, gid in cur.fetchall()}
    return alias, cles_entreprise


def ecrire(cur, r):
    maintenant = datetime.now(timezone.utc)
    # 1. Comptes : création ou mise à jour des seuls champs synchronisés.
    for c in r.comptes.values():
        cur.execute(
            """
            insert into public.accounts
              (key, name, address1, city, zip, country, email, phone,
               shopify_company_ids, sources, synced_at)
            values (%(key)s, %(name)s, %(address1)s, %(city)s, %(zip)s, %(country)s,
                    %(email)s, %(phone)s, %(company_ids)s, %(sources)s, %(now)s)
            on conflict (key) do update set
              -- le nom d'un compte existant ne change que s'il vient d'une fiche entreprise
              name = case when %(name_from_company)s then excluded.name else accounts.name end,
              address1 = coalesce(excluded.address1, accounts.address1),
              city = coalesce(excluded.city, accounts.city),
              zip = coalesce(excluded.zip, accounts.zip),
              country = coalesce(excluded.country, accounts.country),
              email = coalesce(accounts.email, excluded.email),
              phone = coalesce(accounts.phone, excluded.phone),
              shopify_company_ids = array(select distinct unnest(accounts.shopify_company_ids || excluded.shopify_company_ids)),
              sources = array(select distinct unnest(accounts.sources || excluded.sources)),
              synced_at = excluded.synced_at
            """,
            {**c, "company_ids": sorted(c["company_ids"]), "sources": sorted(c["sources"]), "now": maintenant},
        )
    cur.execute("select key, id from public.accounts")
    ids = dict(cur.fetchall())

    # 2. Commandes : la table est le reflet exact de Shopify.
    cur.execute("create temporary table _orders (like public.orders) on commit drop")
    with cur.copy(
        "copy _orders (id, account_id, name, created_at, subtotal, channel, cancelled, has_keychains, customer_id) from stdin"
    ) as cp:
        for o in r.commandes.values():
            cp.write_row((
                o["id"], ids[o["account_key"]], o["name"], o["created_at"], o["subtotal"],
                o["channel"], o["cancelled"], o["has_keychains"], o["customer_id"],
            ))
    cur.execute("delete from public.orders where id not in (select id from _orders)")
    cur.execute(
        """
        insert into public.orders select * from _orders
        on conflict (id) do update set
          account_id = excluded.account_id, name = excluded.name, created_at = excluded.created_at,
          subtotal = excluded.subtotal, channel = excluded.channel, cancelled = excluded.cancelled,
          has_keychains = excluded.has_keychains, customer_id = excluded.customer_id
        """
    )

    # 3. Contacts Shopify (les contacts saisis à la main ne sont pas touchés).
    for ct in r.contacts.values():
        cur.execute(
            """
            insert into public.contacts (account_id, shopify_customer_id, name, email, phone, source)
            values (%(account_id)s, %(shopify_customer_id)s, %(name)s, %(email)s, %(phone)s, %(source)s)
            on conflict (shopify_customer_id) do update set
              account_id = excluded.account_id,
              name = excluded.name,
              email = excluded.email,
              phone = coalesce(excluded.phone, contacts.phone),
              source = excluded.source
            """,
            {**ct, "account_id": ids[ct["account_key"]]},
        )


def resume(r):
    comptes_avec_cmd = {o["account_key"] for o in r.commandes.values() if not o["cancelled"]}
    return {
        "comptes": len(r.comptes),
        "comptes_avec_commandes": len(comptes_avec_cmd),
        "prospects": len(r.comptes) - len(comptes_avec_cmd),
        "commandes": len(r.commandes),
        "contacts": len(r.contacts),
        "canaux": dict(Counter(o["channel"] for o in r.commandes.values())),
    }


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--dry-run", action="store_true", help="n'écrit rien en base")
    p.add_argument("--depuis-json", help="lit commandes/entreprises/clients depuis un fichier JSON (tests)")
    args = p.parse_args(argv)

    if args.depuis_json:
        with open(args.depuis_json, encoding="utf-8") as f:
            d = json.load(f)
        commandes, entreprises, clients = d.get("commandes", []), d.get("entreprises", []), d.get("clients", [])
    else:
        commandes, entreprises, clients = charger_shopify()

    if args.dry_run:
        r = Regroupement().construire(commandes, entreprises, clients)
        print(json.dumps(resume(r), ensure_ascii=False, indent=2))
        return 0

    import os
    import psycopg

    with psycopg.connect(os.environ["DATABASE_URL"], prepare_threshold=None) as conn:
        with conn.cursor() as cur:
            cur.execute("insert into public.sync_runs (source) values ('shopify') returning id")
            run_id = cur.fetchone()[0]
        conn.commit()
        try:
            with conn.transaction():
                with conn.cursor() as cur:
                    alias, cles_entreprise = charger_correspondances(cur)
                    r = Regroupement(alias, cles_entreprise).construire(commandes, entreprises, clients)
                    ecrire(cur, r)
            details = resume(r)
            statut = "ok"
        except Exception as e:  # noqa: BLE001 - on trace l'échec en base puis on relance
            details, statut = {"erreur": str(e)[:2000]}, "échec"
            raise
        finally:
            with conn.cursor() as cur:
                cur.execute(
                    "update public.sync_runs set finished_at = now(), status = %s, details = %s where id = %s",
                    (statut, json.dumps(details, ensure_ascii=False), run_id),
                )
            conn.commit()
    print(json.dumps(details, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
