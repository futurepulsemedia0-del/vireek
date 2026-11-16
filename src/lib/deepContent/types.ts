export type DeepBlock =
  | { kind: 'p'; text: string }
  | { kind: 'list'; items: string[]; ordered?: boolean }
  | { kind: 'steps'; items: Array<{ title: string; text: string }> }
  | { kind: 'callout'; title: string; text: string }
  | { kind: 'table'; caption: string; headers: string[]; rows: string[][] };

export interface DeepSection {
  /** Unique within the page; used for the anchor link. Lowercase letters, digits and hyphens only. */
  id: string;
  title: string;
  blocks: DeepBlock[];
}

export interface DeepFaq {
  q: string;
  a: string;
}

export interface DeepContentData {
  eyebrow: string;
  title: string;
  intro: string;
  sections: DeepSection[];
  faqs?: DeepFaq[];
}
