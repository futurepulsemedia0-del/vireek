export type Persona = 'owner' | 'dispatcher' | 'tech';

export const PERSONAS: { id: Persona; label: string }[] = [
  { id: 'owner', label: 'Owner' },
  { id: 'dispatcher', label: 'Dispatcher' },
  { id: 'tech', label: 'Technician' },
];

/** Starter questions per persona. Every one is answerable from the public knowledge base. */
export const PERSONA_PROMPTS: Record<Persona, string[]> = {
  owner: ['How much does Vireek cost?', 'Which plan fits a small HVAC company?', 'Is my business data secure?', 'How do I get started?'],
  dispatcher: ['How does emergency detection work?', 'Can calls be transferred to on-call staff?', 'Which CRMs do you integrate with?'],
  tech: ['How does Vireek book jobs on my calendar?', 'What happens when a call comes in while I am on a job?', 'Which trades do you support?'],
};
