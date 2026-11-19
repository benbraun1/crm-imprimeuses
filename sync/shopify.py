"""Accès à l'API GraphQL Admin de Shopify.

Authentification, au choix (variables d'environnement) :
- SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET : app créée dans le Dev Dashboard
  (recommandé). Un jeton valable 24 h est demandé à chaque exécution
  (« client credentials grant »).
- SHOPIFY_ADMIN_TOKEN : jeton shpat_… d'une ancienne app personnalisée créée
  dans l'admin Shopify, si vous en avez déjà une.

Les exports volumineux passent par les « bulk operations » : Shopify prépare
un fichier JSONL qu'on télécharge, sans limite de coût de requête.
"""
import json
import os
import time

import requests

API_VERSION = os.environ.get("SHOPIFY_API_VERSION", "2026-10")


class ShopifyError(RuntimeError):
    pass


class Shopify:
    def __init__(self, shop=None, token=None, client_id=None, client_secret=None):
        shop = (shop or os.environ["SHOPIFY_SHOP"]).strip()
        if not shop.endswith(".myshopify.com"):
            shop = f"{shop}.myshopify.com"
        self.shop = shop
        token = token or os.environ.get("SHOPIFY_ADMIN_TOKEN")
        if not token:
            token = self._client_credentials(
                client_id or os.environ.get("SHOPIFY_CLIENT_ID"),
                client_secret or os.environ.get("SHOPIFY_CLIENT_SECRET"),
            )
        self.session = requests.Session()
        self.session.headers.update({
            "X-Shopify-Access-Token": token,
            "Content-Type": "application/json",
        })
        self.url = f"https://{shop}/admin/api/{API_VERSION}/graphql.json"

    def _client_credentials(self, client_id, client_secret):
        if not client_id or not client_secret:
            raise ShopifyError(
                "Identifiants Shopify manquants : définir SHOPIFY_CLIENT_ID et "
                "SHOPIFY_CLIENT_SECRET (ou SHOPIFY_ADMIN_TOKEN)."
            )
        r = requests.post(
            f"https://{self.shop}/admin/oauth/access_token",
            data={
                "grant_type": "client_credentials",
                "client_id": client_id,
                "client_secret": client_secret,
            },
            timeout=30,
        )
        if r.status_code != 200:
            raise ShopifyError(f"Obtention du jeton Shopify impossible ({r.status_code}) : {r.text[:300]}")
        return r.json()["access_token"]

    def graphql(self, query, variables=None):
        for essai in range(5):
            r = self.session.post(self.url, json={"query": query, "variables": variables or {}}, timeout=60)
            if r.status_code in (429, 502, 503, 504):
                time.sleep(2 * (essai + 1))
                continue
            if r.status_code != 200:
                raise ShopifyError(f"Erreur HTTP {r.status_code} : {r.text[:500]}")
            data = r.json()
            erreurs = data.get("errors")
            if erreurs:
                if any((e.get("extensions") or {}).get("code") == "THROTTLED" for e in erreurs):
                    time.sleep(2 * (essai + 1))
                    continue
                raise ShopifyError(json.dumps(erreurs, ensure_ascii=False)[:1000])
            return data["data"]
        raise ShopifyError("Shopify ne répond pas (trop de tentatives).")

    def bulk(self, query, timeout_s=1800):
        """Lance une bulk operation et renvoie la liste des objets du JSONL."""
        data = self.graphql(
            """mutation($q: String!) {
                 bulkOperationRunQuery(query: $q) {
                   bulkOperation { id status }
                   userErrors { field message }
                 }
               }""",
            {"q": query},
        )
        res = data["bulkOperationRunQuery"]
        if res["userErrors"]:
            raise ShopifyError(f"Bulk operation refusée : {res['userErrors']}")
        op_id = res["bulkOperation"]["id"]

        debut = time.time()
        attente = 2
        while True:
            op = self.graphql(
                """query($id: ID!) {
                     node(id: $id) { ... on BulkOperation {
                       status errorCode objectCount url partialDataUrl } }
                   }""",
                {"id": op_id},
            )["node"]
            statut = op["status"]
            if statut == "COMPLETED":
                break
            if statut in ("FAILED", "CANCELED", "CANCELLED", "EXPIRED"):
                raise ShopifyError(f"Bulk operation {statut} ({op.get('errorCode')})")
            if time.time() - debut > timeout_s:
                raise ShopifyError("Bulk operation trop longue, abandon.")
            time.sleep(attente)
            attente = min(attente * 1.5, 15)

        if not op.get("url"):
            return []  # aucun résultat
        r = requests.get(op["url"], timeout=300)
        r.raise_for_status()
        return [json.loads(ligne) for ligne in r.text.splitlines() if ligne.strip()]


def type_gid(gid):
    """'gid://shopify/LineItem/123' -> 'LineItem'."""
    try:
        return gid.split("/")[3]
    except (AttributeError, IndexError):
        return ""


def regrouper(lignes, racine):
    """Reconstruit les objets imbriqués d'un export JSONL de bulk operation.

    Shopify aplatit les connexions imbriquées : chaque enfant est une ligne à
    part avec un champ __parentId. On les raccroche à leur parent, dans une
    liste au format des réponses GraphQL classiques (champ {"nodes": [...]}).
    Le nom du champ est déduit du type de l'enfant via ENFANTS.
    """
    par_id = {}
    racines = []
    for obj in lignes:
        if "id" in obj:
            par_id[obj["id"]] = obj
    for obj in lignes:
        parent_id = obj.pop("__parentId", None)
        if parent_id is None:
            if type_gid(obj.get("id")) == racine:
                racines.append(obj)
            continue
        parent = par_id.get(parent_id)
        if parent is None:
            continue
        champ = ENFANTS.get((type_gid(parent.get("id")), type_gid(obj.get("id"))))
        if champ is None:
            continue
        parent.setdefault(champ, {"nodes": []})["nodes"].append(obj)
    return racines


# (type parent, type enfant) -> nom du champ GraphQL de la connexion
ENFANTS = {
    ("Order", "LineItem"): "lineItems",
    ("Company", "Order"): "orders",
    ("Company", "CompanyContact"): "contacts",
    ("Company", "CompanyLocation"): "locations",
}
