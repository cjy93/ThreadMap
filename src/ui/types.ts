export interface PathItem {
  id: string;
  title: string;
  depth: number;
}

export interface MapNode {
  id: string;
  kind: 'CATEGORY' | 'TOPIC' | 'DISCUSSION';
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
  chat_totals: { message_count: number; missed_count: number; pending_analysis_count: number };
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
  analysis: { pending_jobs: number; budget_paused: boolean; failed: boolean; last_analysis_at: string | null };
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
  topic_paths: { primary: boolean; path: PathItem[] }[];
  attachments: { id: string; media_type: string; mime: string | null; filename: string | null; size: number | null; availability: string; has_preview: boolean; description: string | null }[];
  context: { message_id: string; sender: string; direction: string; current: boolean; snippet: string | null; sent_at: string | null }[];
}
