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
  notes: string;
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
}

export interface ProcessedMeeting {
  meeting: MeetingDetail;
  meetingNote: string;
  conceptNotes: ConceptNote[];
  entities: Entity[];
}

