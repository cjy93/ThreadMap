export interface PathItem {
  id: string;
  title: string;
  depth: number;
}

export interface MapNode {
  id: string;
  kind: 'CATEGORY' | 'TOPIC';
  root: string;
  parent_id: string | null;
  title: string;
  depth: number;
  matching_message_count: number;
  matching_missed_count: number;
  child_topic_count: number;
  children_shown: number;
  next_child_offset: number | null;
  boundary: boolean;
  has_deeper_topics: boolean;
  collapsed: boolean;
  needs_review: boolean;
  discussion_count: number;
  diameter: number | null;
}

export interface ChainMessage {
  message_id: string;
  sender: string;
  direction: string;
  snippet: string | null;
  sent_at: string | null;
  depth: number;
  /** This step is an answer Nemotron found, not a WhatsApp reply. */
  inferred: boolean;
}

export interface MapResponse {
  chat: { id: string; title: string; kind: string; source: string };
  graph_version: number;
  count_version: string;
  filter_fingerprint: string;
  depth_source: 'url' | 'preference' | 'default';
  nodes: MapNode[];
  edges: { source: string; target: string }[];
  available_max_topic_depth: number;
  max_topic_depth: number | 'all';
  effective_depth: number;
  visible_node_budget: number;
  visible_node_count: number;
  truncated_by_budget: boolean;
  focus: { id: string; breadcrumbs: PathItem[] } | null;
  hidden_selected_topics: { id: string; path: PathItem[]; visible_ancestor_id: string | null }[];
  sizing: { min_diameter_px: number; max_diameter_px: number; reference_count: number; revision: string; legend: string };
  chat_totals: { message_count: number; missed_count: number; pending_analysis_count: number; filler_count: number };
  /** Which map this is: the chat's own (null), or its map from one side's messages. */
  side: 'mine' | 'others' | null;
  /** How far this map's analysis has got. */
  analysis: { pending_jobs: number; unread_messages?: number; budget_paused: boolean; failed: boolean };
  /** When ThreadMap last asked the phone for this chat's older messages. */
  history_requested_at: string | null;
  history_loading: boolean;
  /** The chat holds the most older messages ThreadMap keeps per chat (this many); null below the limit. */
  history_limited?: number | null;
}

export interface ChatSummary {
  id: string;
  title: string;
  kind: string;
  source: string;
  avatar_url: string | null;
  selected: boolean;
  paused: boolean;
  message_count: number;
  missed_count: number;
  pending_analysis_count: number;
  first_message_at?: string | null;
  last_message_at?: string | null;
  analysis: { pending_jobs: number; unread_messages?: number; budget_paused: boolean; failed: boolean; last_analysis_at: string | null };
  last_event_at: string | null;
}

export interface ContentMessage {
  message_id: string;
  sender: string;
  direction: string;
  kind: string;
  snippet: string | null;
  sent_at: string | null;
  edited: boolean;
  content_revision: number;
  review: 'read' | 'missed';
  attachment_count: number;
  topic_paths: PathItem[][];
}

export interface ContentFile {
  attachment_id: string;
  message_id: string;
  media_type: string;
  mime: string | null;
  filename: string | null;
  size: number | null;
  availability: string;
  has_preview: boolean;
  description: string | null;
  sent_at: string | null;
  sender: string;
  topic_paths: PathItem[][];
}

export interface ContentResponse {
  node_id: string;
  node_path: PathItem[];
  tab: 'messages' | 'files';
  filter_fingerprint: string;
  matching_message_count: number;
  matching_missed_count: number;
  matching_file_count: number;
  items: (ContentMessage | ContentFile)[];
  next_cursor: string | null;
  summary: { coverage: string; available: boolean; claims: { id: string; text: string; evidence: { m: string; r: number }[] }[]; note: string | null };
}

export interface SourceMessage {
  message_id: string;
  chat: { id: string; title: string; kind: string };
  sender: string;
  direction: string;
  kind: string;
  state: string;
  body: string | null;
  marker: string | null;
  sent_at: string | null;
  received_at: string;
  edited_at: string | null;
  content_revision: number;
  review: 'read' | 'missed';
  reviewable: boolean;
  /** root: the category the topic is under (concept maps are offered for KNOWLEDGE and RESOURCES). */
  topic_paths: { primary: boolean; root?: string; path: PathItem[] }[];
  attachments: { id: string; media_type: string; mime: string | null; filename: string | null; size: number | null; availability: string; has_preview: boolean; description: string | null }[];
  context: { message_id: string; sender: string; direction: string; current: boolean; snippet: string | null; sent_at: string | null }[];
  /** Every message of the discussion this one belongs to, in order (null before it is analysed). */
  thread: {
    title: string;
    messages: {
      message_id: string;
      sender: string;
      direction: string;
      current: boolean;
      filler: boolean;
      snippet: string | null;
      sent_at: string | null;
      reply_to: { message_id: string; sender: string; snippet: string | null } | null;
      /** The earlier message it answers without WhatsApp's Reply, as Nemotron read it. */
      answers: { message_id: string; sender: string; snippet: string | null } | null;
    }[];
    /** Whether Nemotron has read the discussion for answers given without Reply. */
    answers_checked: boolean;
    before: { message_id: string; sender: string; direction: string; snippet: string | null; sent_at: string | null }[];
  } | null;
  /** The WhatsApp reply chain: what this replies to (oldest first) and every reply to it; depth = reply steps away. */
  reply_chain: {
    before: ChainMessage[];
    after: ChainMessage[];
  };
}

/** A concept map (study guide) built from one message by Nemotron Ultra, with web sources. */
export interface StudyMap {
  title: string;
  summary: string;
  subject: string;
  topic_path: string;
  concepts: { key: string; label: string; kind: 'core' | 'concept' | 'detail' | 'example' | 'question'; explanation: string; messages: string[]; web: number[] }[];
  relations: { from: string; to: string; label: string }[];
  guide: { heading: string; text: string; messages: string[]; web: number[] }[];
  gaps: string[];
  web: { enabled: boolean; queries: string[]; results: { title: string; url: string }[]; note: string | null };
  read: { messages: number; discussions: number };
}
export interface StudySource {
  message_id: string;
  chat_id: string;
  sender: string;
  snippet: string;
  sent_at: string | null;
}
export type StudyMapState =
  | { state: 'none' }
  | { state: 'pending' | 'reading' | 'searching' | 'building' | 'failed'; id: string; note: string | null; started_at: string }
  | { state: 'done'; id: string; built_at: string; map: StudyMap; sources: Record<string, StudySource> };
