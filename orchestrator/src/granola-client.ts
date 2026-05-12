import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import type { GranolaTokens, GranolaMeeting, MeetingDetail } from './types.js';

const GRANOLA_API = 'https://api.granola.ai';
const WORKOS_AUTH = 'https://api.workos.com/user_management/authenticate';
const FALLBACK_CLIENT_ID = 'client_01JZJ0XBDAT8PHJWQY09Y0VD61';
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

const STATE_FILE = process.env.STATE_FILE ?? '../state/state.json';
const TOKEN_FILE = STATE_FILE.replace('state.json', 'tokens.json');
const STORED_ACCOUNTS_FILE =
  process.env.GRANOLA_AUTH_PATH ??
  `${process.env.HOME}/Library/Application Support/Granola/stored-accounts.json`;
const BOOTSTRAP_FILE =
  process.env.GRANOLA_SUPABASE_PATH ??
  `${process.env.HOME}/Library/Application Support/Granola/supabase.json`;

let cachedTokens: GranolaTokens | null = null;

function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
}

function decodeJwtExp(token: string): number | null {
  const claims = decodeJwt(token);
  return claims?.exp ? (claims.exp as number) * 1000 : null;
}

function extractClientId(token: string): string {
  const claims = decodeJwt(token);
  return (claims?.azp as string) ?? FALLBACK_CLIENT_ID;
}

function loadTokens(): GranolaTokens {
  if (cachedTokens) return cachedTokens;

  if (existsSync(TOKEN_FILE)) {
    cachedTokens = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')) as GranolaTokens;
    console.log('Tokens loaded from state');
    return cachedTokens;
  }

  const fromStored = bootstrapFromStoredAccounts();
  if (fromStored) return fromStored;

  return bootstrapFromSupabase();
}

function bootstrapFromStoredAccounts(): GranolaTokens | null {
  if (!existsSync(STORED_ACCOUNTS_FILE)) return null;
  try {
    const raw = JSON.parse(readFileSync(STORED_ACCOUNTS_FILE, 'utf-8'));
    const accounts: Array<{ email?: string; tokens?: string | Record<string, unknown> }> =
      typeof raw.accounts === 'string' ? JSON.parse(raw.accounts) : raw.accounts;

    if (!Array.isArray(accounts) || accounts.length === 0) return null;

    const targetEmail = process.env.GRANOLA_USER_EMAIL;
    const account = targetEmail
      ? accounts.find((a) => a.email === targetEmail)
      : accounts[0];
    if (!account) return null;

    const tokens: Record<string, unknown> =
      typeof account.tokens === 'string' ? JSON.parse(account.tokens) : (account.tokens ?? {});

    if (!tokens.access_token) return null;

    const result: GranolaTokens = {
      accessToken: tokens.access_token as string,
      refreshToken: tokens.refresh_token as string,
      clientId: extractClientId(tokens.access_token as string),
    };

    console.log(`Tokens bootstrapped from stored-accounts.json (session: ${(tokens.session_id as string) ?? 'unknown'})`);
    return result;
  } catch (err) {
    console.warn('Failed to parse stored-accounts.json:', (err as Error).message);
    return null;
  }
}

function bootstrapFromSupabase(): GranolaTokens {
  if (!existsSync(BOOTSTRAP_FILE)) {
    throw new Error(
      `No tokens found. Place Granola supabase.json at ${BOOTSTRAP_FILE} ` +
        'or set GRANOLA_SUPABASE_PATH. Ensure Granola desktop is signed in.',
    );
  }

  const raw = JSON.parse(readFileSync(BOOTSTRAP_FILE, 'utf-8'));
  let tokens: GranolaTokens;

  if (raw.workos_tokens) {
    const wt = typeof raw.workos_tokens === 'string' ? JSON.parse(raw.workos_tokens) : raw.workos_tokens;
    tokens = {
      accessToken: wt.access_token,
      refreshToken: wt.refresh_token,
      clientId: wt.client_id ?? extractClientId(wt.access_token),
    };
  } else if (raw.cognito_tokens) {
    const ct = typeof raw.cognito_tokens === 'string' ? JSON.parse(raw.cognito_tokens) : raw.cognito_tokens;
    tokens = {
      accessToken: ct.access_token,
      refreshToken: ct.refresh_token,
      clientId: ct.client_id ?? extractClientId(ct.access_token),
    };
  } else if (raw.refresh_token) {
    tokens = {
      accessToken: raw.access_token,
      refreshToken: raw.refresh_token,
      clientId: raw.client_id ?? extractClientId(raw.access_token),
    };
  } else {
    throw new Error('Cannot parse supabase.json — no recognized token format');
  }

  console.log(`Tokens bootstrapped from supabase.json (clientId: ${tokens.clientId})`);
  return tokens;
}

function saveTokens(tokens: GranolaTokens): void {
  cachedTokens = tokens;
  const tmp = `${TOKEN_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(tokens, null, 2), 'utf-8');
  renameSync(tmp, TOKEN_FILE);
}

async function refreshTokens(tokens: GranolaTokens): Promise<GranolaTokens> {
  const res = await fetch(WORKOS_AUTH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: tokens.clientId,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { access_token: string; refresh_token: string };
  const refreshed: GranolaTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    clientId: tokens.clientId,
    lastRefreshedAt: new Date().toISOString(),
  };

  saveTokens(refreshed);
  console.log('Tokens refreshed via WorkOS');
  return refreshed;
}

function rebootstrapIfFresher(tokens: GranolaTokens): GranolaTokens {
  const fromStored = bootstrapFromStoredAccounts();
  if (fromStored && fromStored.accessToken !== tokens.accessToken) {
    const exp = decodeJwtExp(fromStored.accessToken);
    if (exp && Date.now() + TOKEN_EXPIRY_BUFFER_MS < exp) {
      console.log('Detected fresher token in stored-accounts.json, re-bootstrapping');
      saveTokens(fromStored);
      return fromStored;
    }
  }

  if (!existsSync(BOOTSTRAP_FILE)) return tokens;
  try {
    const fresh = bootstrapFromSupabase();
    if (fresh.accessToken !== tokens.accessToken) {
      console.log('Detected fresher token in supabase.json, re-bootstrapping');
      saveTokens(fresh);
      return fresh;
    }
  } catch { /* bootstrap parse failed, keep current */ }
  return tokens;
}

async function getAccessToken(): Promise<string> {
  let tokens = loadTokens();
  const exp = decodeJwtExp(tokens.accessToken);

  if (exp && Date.now() + TOKEN_EXPIRY_BUFFER_MS >= exp) {
    tokens = rebootstrapIfFresher(tokens);
    const newExp = decodeJwtExp(tokens.accessToken);
    if (newExp && Date.now() + TOKEN_EXPIRY_BUFFER_MS >= newExp) {
      console.log(`Token still expired after re-bootstrap (clientId: ${tokens.clientId}), attempting WorkOS refresh...`);
      tokens = await refreshTokens(tokens);
    }
  }

  if (!existsSync(TOKEN_FILE)) {
    saveTokens(tokens);
  }

  return tokens.accessToken;
}

function buildHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'X-App-Version': '7.0.0',
    'X-Client-Version': '7.0.0',
    'X-Client-Type': 'cli',
    'X-Client-Platform': process.platform,
    'X-Client-Architecture': process.arch,
    'X-Client-Id': 'granola-cli-goc-kb',
    'User-Agent': `Granola/7.0.0 goc-kb/1.0.0 (${process.platform})`,
  };
}

async function granolaFetch(endpoint: string, body: unknown, attempt = 0): Promise<unknown> {
  const accessToken = await getAccessToken();
  const res = await fetch(`${GRANOLA_API}${endpoint}`, {
    method: 'POST',
    headers: buildHeaders(accessToken),
    body: JSON.stringify(body),
  });

  if (res.status === 401 && attempt === 0) {
    const tokens = loadTokens();
    await refreshTokens(tokens);
    return granolaFetch(endpoint, body, 1);
  }

  if ([429, 500, 502, 503, 504].includes(res.status) && attempt < 3) {
    const delay = 250 * Math.pow(2, attempt);
    await new Promise((r) => setTimeout(r, delay));
    return granolaFetch(endpoint, body, attempt + 1);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Granola API ${endpoint} failed (${res.status}): ${text}`);
  }

  return res.json();
}

// --- API Methods ---

export async function listMeetings(since: string, limit = 100): Promise<GranolaMeeting[]> {
  const sinceTime = new Date(since).getTime();
  const allMeetings: GranolaMeeting[] = [];
  let offset = 0;

  while (allMeetings.length < limit) {
    const pageSize = Math.min(100, limit - allMeetings.length);
    const data = (await granolaFetch('/v2/get-documents', {
      include_last_viewed_panel: false,
      limit: pageSize,
      offset,
    })) as { docs?: Array<{ id: string; title: string; created_at: string; updated_at?: string; workspace_id?: string }> };

    const docs = data.docs ?? [];
    if (docs.length === 0) break;

    for (const doc of docs) {
      if (new Date(doc.created_at).getTime() >= sinceTime) {
        allMeetings.push({
          id: doc.id,
          title: doc.title,
          created_at: doc.created_at,
          updated_at: doc.updated_at,
          workspace_id: doc.workspace_id,
        });
      }
    }

    if (docs.length < pageSize) break;
    offset += pageSize;
  }

  return allMeetings;
}

export async function getMeetingDetail(meeting: GranolaMeeting): Promise<MeetingDetail> {
  const [metaRes, transcriptRes] = await Promise.all([
    granolaFetch('/v1/get-document-metadata', { document_id: meeting.id }) as Promise<{
      notes?: unknown;
      last_viewed_panel?: { content?: unknown };
    }>,
    granolaFetch('/v1/get-document-transcript', { document_id: meeting.id }) as Promise<
      Array<{ source: string; text: string; start_timestamp?: string }>
    >,
  ]);

  const notesDoc = metaRes.last_viewed_panel?.content ?? metaRes.notes;
  const notes = notesDoc ? prosemirrorToMarkdown(notesDoc) : '';

  const transcript = Array.isArray(transcriptRes)
    ? transcriptRes
        .map((u) => {
          const speaker = u.source === 'microphone' ? 'You' : 'Participant';
          return `${speaker}: ${u.text}`;
        })
        .join('\n')
    : '';

  return {
    id: meeting.id,
    title: meeting.title,
    createdAt: meeting.created_at,
    notes: notes.trim(),
    transcript: transcript.trim(),
  };
}

// --- ProseMirror to Markdown ---

interface PmNode {
  type: string;
  content?: PmNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, string> }>;
  attrs?: Record<string, unknown>;
}

function applyMarks(text: string, marks?: PmNode['marks']): string {
  if (!marks) return text;
  for (const m of marks) {
    if (m.type === 'bold' || m.type === 'strong') text = `**${text}**`;
    if (m.type === 'italic' || m.type === 'em') text = `*${text}*`;
    if (m.type === 'code') text = `\`${text}\``;
    if (m.type === 'strike') text = `~~${text}~~`;
  }
  return text;
}

function inlineToMd(nodes?: PmNode[]): string {
  if (!nodes) return '';
  return nodes.map((n) => (n.type === 'text' ? applyMarks(n.text ?? '', n.marks) : '')).join('');
}

function nodeToMd(node: PmNode, indent = ''): string {
  switch (node.type) {
    case 'heading': {
      const level = (node.attrs?.level as number) ?? 1;
      return `${'#'.repeat(level)} ${inlineToMd(node.content)}`;
    }
    case 'paragraph':
      return `${indent}${inlineToMd(node.content)}`;
    case 'bulletList':
      return (node.content ?? []).map((li) => nodeToMd(li, indent)).join('\n');
    case 'orderedList':
      return (node.content ?? [])
        .map((li, i) => {
          const text = nodeToMd(li, indent).replace(/^(\s*)- /, `$1${i + 1}. `);
          return text;
        })
        .join('\n');
    case 'listItem': {
      const inner = (node.content ?? []).map((c) => nodeToMd(c, indent + '  ')).join('\n');
      return `${indent}- ${inner.trimStart()}`;
    }
    case 'blockquote': {
      const bqContent = (node.content ?? []).map((c) => nodeToMd(c)).join('\n');
      return bqContent
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    }
    case 'codeBlock': {
      const lang = (node.attrs?.language as string) ?? '';
      const code = inlineToMd(node.content);
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }
    case 'horizontalRule':
      return '---';
    default:
      if (node.content) {
        return node.content.map((c) => nodeToMd(c, indent)).join('\n');
      }
      return '';
  }
}

function prosemirrorToMarkdown(doc: unknown): string {
  const d = doc as PmNode;
  if (!d?.content) return '';
  return d.content.map((n) => nodeToMd(n)).join('\n\n');
}
