export type Segment =
  | "Champions"
  | "Fidèles"
  | "Nouveaux"
  | "À relancer"
  | "Occasionnels"
  | "Inactifs"
  | "Prospects";

/** Une ligne de la vue account_overview. */
export interface Account {
  id: string;
  key: string;
  name: string;
  display_name: string | null;
  label: string;
  address1: string | null;
  city: string | null;
  zip: string | null;
  country: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  sources: string[];
  shopify_company_ids: string[];
  owner_email: string | null;
  tags: string[];
  next_action_on: string | null;
  next_action: string | null;
  memo: string | null;
  hidden: boolean;
  synced_at: string | null;
  created_at: string;
  nb_orders: number;
  ca_ht: number;
  first_order_on: string | null;
  last_order_on: string | null;
  prev_order_on: string | null;
  has_keychains: boolean;
  channel: string | null;
  faire_origin: boolean | null;
  last_contact_on: string | null;
  last_contact_by: string | null;
  last_contact_kind: string | null;
  days_since_order: number | null;
  days_since_contact: number | null;
  segment: Segment;
}

export interface Order {
  id: string;
  name: string | null;
  created_at: string;
  subtotal: number;
  channel: string;
  cancelled: boolean;
  has_keychains: boolean;
}

export interface Contact {
  id: string;
  account_id: string;
  shopify_customer_id: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  role: string | null;
  notes: string | null;
  source: string;
}

export const KINDS = ["appel", "email", "visite", "salon", "rendez-vous", "message", "note"] as const;
export type Kind = (typeof KINDS)[number];

export interface Interaction {
  id: string;
  account_id: string;
  contact_id: string | null;
  kind: Kind;
  happened_on: string;
  author_email: string;
  body: string;
  created_at: string;
}

export interface Adjustment {
  id: string;
  account_key: string;
  amount: number;
  reason: string;
  created_by: string | null;
  created_at: string;
}

export interface TeamMember {
  email: string;
  display_name: string;
}
