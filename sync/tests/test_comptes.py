from sync import comptes as C
from sync.main import Regroupement, resume
from sync.shopify import regrouper


def commande(id, nom_societe=None, tags=(), entreprise=None, montant="100.0", date="2026-06-01T10:00:00Z",
             app=None, annulee=False, skus=(), email="boutique@example.com", ville="Nantes", cp="44000"):
    o = {
        "id": f"gid://shopify/Order/{id}",
        "name": f"#{id}",
        "createdAt": date,
        "cancelledAt": "2026-06-02T00:00:00Z" if annulee else None,
        "tags": list(tags),
        "app": {"name": app} if app else None,
        "currentSubtotalPriceSet": {"shopMoney": {"amount": montant}},
        "customer": {"id": f"gid://shopify/Customer/{id}", "displayName": "Marie Martin",
                     "defaultEmailAddress": {"emailAddress": email}},
        "purchasingEntity": None,
        "shippingAddress": {"company": nom_societe, "city": ville, "zip": cp, "countryCodeV2": "FR"},
        "billingAddress": {"company": nom_societe},
        "lineItems": {"nodes": [{"sku": s, "currentQuantity": 1} for s in skus]},
    }
    if entreprise:
        o["purchasingEntity"] = {"__typename": "PurchasingCompany",
                                 "company": {"id": f"gid://shopify/Company/{entreprise[0]}", "name": entreprise[1]}}
    return o


def test_norm():
    assert C.norm("Pépite(s) SARL") == "pepite s"
    assert C.norm("L’Amour Fou") == "l amour fou"
    assert C.norm("  CHEZ BOGATO ") == "chez bogato"


def test_est_b2b_par_tag_ou_entreprise():
    assert C.est_b2b(commande(1, tags=["Faire"]))
    assert C.est_b2b(commande(2, entreprise=(9, "FAM Store")))
    assert not C.est_b2b(commande(3, tags=["Shop"]))


def test_canal():
    assert C.canal(commande(1, tags=["Faire"])) == "Faire"
    assert C.canal(commande(2, app="Ankorstore")) == "Ankorstore"
    assert C.canal(commande(3, tags=["b2b"])) == "Direct"


def test_cle_compte_priorites():
    assert C.cle_compte(commande(1, "Les Voisines", entreprise=(9, "Les Voisines SAS"))) == ("les voisines", "Les Voisines SAS")
    assert C.cle_compte(commande(2, "Rares")) == ("rares", "Rares")
    # Pas de société : on se rabat sur l'e-mail
    assert C.cle_compte(commande(3, None, email="a@b.fr"))[1] == "a@b.fr"
    # Numéro de TVA saisi comme société : ignoré
    assert C.cle_compte(commande(4, "FR60894420041", email="x@y.fr"))[1] == "x@y.fr"


def test_porte_cles():
    assert C.a_porte_cles(commande(1, skus=["PIN-1", "POR-12"]))
    assert C.a_porte_cles(commande(1, skus=["kc-3"]))
    assert not C.a_porte_cles(commande(1, skus=["PIN-1"]))


def test_regroupement_fusionne_faire_et_entreprise():
    entreprises = [{"id": "gid://shopify/Company/9", "name": "Rares", "contacts": {"nodes": []}, "locations": {"nodes": []},
                    "orders": {"nodes": [commande(3, None, entreprise=(9, "Rares"), date="2026-10-01T00:00:00Z")]}}]
    commandes = [
        commande(1, "RARES", tags=["Faire"], email="x@relay.faire.com"),
        commande(2, "Rares", tags=["Faire"]),
        commande(5, "Hineni Partners", tags=["b2b"]),          # exclu
        commande(6, "Boutique", tags=["b2b"], email="ben@lesimprimeuses.com"),  # interne
        commande(7, "Boutique", tags=["Shop"]),                 # pas B2B
    ]
    r = Regroupement().construire(commandes, entreprises, [])
    assert set(r.comptes) == {"rares"}
    assert len(r.commandes) == 3
    assert r.comptes["rares"]["company_ids"] == {"gid://shopify/Company/9"}
    # l'e-mail relais Faire n'est pas retenu comme e-mail du compte
    assert r.comptes["rares"]["email"] == "boutique@example.com"


def test_alias_et_entreprise_renommee():
    commandes = [
        commande(1, "La Cachette M", tags=["b2b"]),
        commande(2, None, entreprise=(5, "Nouveau nom"), tags=[]),
    ]
    r = Regroupement(
        alias={"la cachette m": "la cachette de m"},
        cles_entreprise={"gid://shopify/Company/5": "ancien nom"},
    ).construire(commandes, [], [])
    assert {o["account_key"] for o in r.commandes.values()} == {"la cachette de m", "ancien nom"}


def test_prospects_clients_tagues():
    clients = [
        {"id": "gid://shopify/Customer/1", "displayName": "Tiffany", "numberOfOrders": "0",
         "defaultEmailAddress": {"emailAddress": "t@ohmay.fr"},
         "defaultAddress": {"company": "OHMAY", "city": "Antibes", "zip": "06600", "countryCodeV2": "FR"}},
        {"id": "gid://shopify/Customer/2", "displayName": "Lauriane B2B",
         "defaultEmailAddress": {"emailAddress": "lauriane@lesimprimeuses.com"}, "defaultAddress": {}},
    ]
    r = Regroupement().construire([], [], clients)
    assert set(r.comptes) == {"ohmay"}
    assert resume(r)["prospects"] == 1


def test_regrouper_jsonl():
    lignes = [
        {"id": "gid://shopify/Company/1", "name": "A"},
        {"id": "gid://shopify/Order/10", "name": "#10", "__parentId": "gid://shopify/Company/1"},
        {"id": "gid://shopify/LineItem/100", "sku": "POR-1", "__parentId": "gid://shopify/Order/10"},
        {"id": "gid://shopify/CompanyContact/7", "customer": None, "__parentId": "gid://shopify/Company/1"},
    ]
    [ent] = regrouper(lignes, "Company")
    assert ent["orders"]["nodes"][0]["lineItems"]["nodes"][0]["sku"] == "POR-1"
    assert len(ent["contacts"]["nodes"]) == 1


def test_departement():
    assert C.departement("FR", "06600") == "06"
    assert C.departement("BE", "1300") == ""


def test_charger_shopify_complete_les_commandes_entreprise():
    from sync import main

    tagged = commande(1, "Rares", tags=["Faire"])
    native = commande(2, None, entreprise=(5, "FAM Store"), date="2026-10-01T00:00:00Z")

    class FauxShopify:
        def bulk(self, q):
            if q is main.REQ_COMMANDES:
                return [{k: v for k, v in tagged.items() if k != "lineItems"}]
            if q is main.REQ_ENTREPRISES:
                return [
                    {"id": "gid://shopify/Company/5", "name": "FAM Store"},
                    {"id": tagged["id"], "createdAt": tagged["createdAt"], "__parentId": "gid://shopify/Company/5"},
                    {"id": native["id"], "createdAt": native["createdAt"], "__parentId": "gid://shopify/Company/5"},
                ]
            return []

        def graphql(self, q, v):
            assert v["ids"] == [native["id"]]  # la commande taguée n'est pas rechargée
            return {"nodes": [native]}

    commandes, entreprises, clients = main.charger_shopify(FauxShopify())
    r = Regroupement().construire(commandes, entreprises, clients)
    assert {o["account_key"] for o in r.commandes.values()} == {"rares", "fam store"}
