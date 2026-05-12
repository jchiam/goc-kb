export interface State {
  lastProcessedAt: string;
  processedIds: string[];
  processedMeta?: Record<string, { updatedAt: string }>;
}

export interface GranolaTokens {
  accessToken: string;
  refreshToken: string;
  clientId: string;
  lastRefreshedAt?: string;
}

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

export interface ProcessedMeeting {
  meeting: MeetingDetail;
  meetingNote: string;
  conceptNotes: ConceptNote[];
}

export interface PipelineOptions {
  meetingId?: string;
  dryRun?: boolean;
}
