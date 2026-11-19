import { createContext, useContext } from "react";
import type { TeamMember } from "./types";

export interface TeamCtx {
  me: string; // e-mail de la personne connectée (minuscules)
  team: TeamMember[];
}

export const Team = createContext<TeamCtx>({ me: "", team: [] });
export const useTeam = () => useContext(Team);
