import type { Segment } from "./types";

export const SEGMENTS: { id: Segment; color: string; help: string }[] = [
  { id: "Champions", color: "#22A55B", help: "Commande il y a 90 j ou moins et CA cumulé ≥ seuil (566 €)" },
  { id: "Fidèles", color: "#3B82F6", help: "Commande il y a 90 j ou moins, sous le seuil, au moins 2 commandes" },
  { id: "Nouveaux", color: "#D4A20B", help: "Commande il y a 90 j ou moins, sous le seuil, une seule commande" },
  { id: "À relancer", color: "#EA7A1E", help: "Dernière commande entre 91 et 365 j, au moins 2 commandes" },
  { id: "Occasionnels", color: "#8B5CF6", help: "Dernière commande entre 91 et 365 j, une seule commande" },
  { id: "Inactifs", color: "#8A8A8A", help: "Plus rien depuis plus de 365 j" },
  { id: "Prospects", color: "#C0569C", help: "Aucune commande de gros enregistrée" },
];

export const segColor = (s: string) => SEGMENTS.find((x) => x.id === s)?.color ?? "#888";
