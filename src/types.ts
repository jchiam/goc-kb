export interface GranolaMeeting {
  id: string;
  title: string;
  created_at: string;
  updated_at?: string;
  workspace_id?: string;
}

export interface MeetingDetail {
  id: string;
  title: string;
  createdAt: string;
  updatedAt?: string;
  webUrl?: string;
  attendees: string[];
  /** User's own typed notes (Granola private notes) */
  notes: string;
  /** Granola AI summary, including any edits the user made to it */
  summary: string;
  transcript: string;
}

export interface ConceptNote {
  slug: string;
  title: string;
  content: string;
}

export interface Entity {
  slug: string;
  name: string;
  entity_type: 'person' | 'organization' | 'product' | 'repository';
  role?: string;
  description: string;
  /** Exact form the meeting used for this entity (e.g. "Darren"), for ambiguity checks */
  mention?: string;
}

/** Something the pipeline could not settle from the source; surfaced for a human to confirm. */
export interface ReviewItem {
  kind: 'attendees' | 'absent-invitee' | 'ambiguous-mention' | 'unowned-action' | 'uncited-owner' | 'inferred-role';
  detail: string;
}

export interface ProcessedMeeting {
  meeting: MeetingDetail;
  meetingNote: string;
  conceptNotes: ConceptNote[];
  entities: Entity[];
  /** Claims the LLM could only infer from the unlabelled transcript, e.g. a reporting line */
  inferences: string[];
  /** Granola invitees the transcript suggests were not there */
  absentInvitees: string[];
  /** For each named action owner, the Notes/Summary phrase that names them */
  ownerCitations: OwnerCitation[];
}

export interface OwnerCitation {
  owner: string;
  task: string;
  quote: string;
}

