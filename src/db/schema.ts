// ThreadMap PostgreSQL schema. This file is the single owner of table shapes;
// migrations in ./migrations are generated from it with `npm run db:generate`.
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();
const updatedAt = () => ts('updated_at').notNull().defaultNow();

// ---------------------------------------------------------------------------
// Better Auth tables (names/fields follow the Better Auth core schema).
// ---------------------------------------------------------------------------
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  isAnonymous: boolean('is_anonymous').default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  expiresAt: ts('expires_at').notNull(),
  token: text('token').notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: ts('access_token_expires_at'),
  refreshTokenExpiresAt: ts('refresh_token_expires_at'),
  scope: text('scope'),
  password: text('password'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Workspaces and deployment settings
// ---------------------------------------------------------------------------
export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: text('owner_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    mode: text('mode', { enum: ['private', 'demo'] }).notNull(),
    name: text('name').notNull(),
    // Demo guest workspaces expire; private ones do not.
    expiresAt: ts('expires_at'),
    // Bumped when the workspace is being deleted so in-flight work is fenced.
    deletionGeneration: integer('deletion_generation').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('workspaces_owner_mode_uq').on(t.ownerUserId, t.mode)],
);

export const runtimeSettings = pgTable('runtime_settings', {
  deploymentId: text('deployment_id').primaryKey(),
  publicOrigin: text('public_origin').notNull(),
  configRevision: text('config_revision').notNull(),
  bootstrappedAt: ts('bootstrapped_at').notNull().defaultNow(),
  bootstrappedBy: text('bootstrapped_by').notNull(),
  audit: jsonb('audit').notNull().default({}),
});

// ---------------------------------------------------------------------------
// WhatsApp linked account, encrypted auth, lease, commands, status
// ---------------------------------------------------------------------------
export const linkedAccounts = pgTable(
  'linked_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // SHA-256 of the normalized account user JID; raw identifiers stay out of reports.
    accountFingerprint: text('account_fingerprint'),
    connectionGeneration: integer('connection_generation').notNull().default(0),
    desiredState: text('desired_state', { enum: ['active', 'paused', 'disconnected'] })
      .notNull()
      .default('disconnected'),
    keyVersion: integer('key_version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('linked_accounts_workspace_uq').on(t.workspaceId)],
);

export const authRecords = pgTable(
  'auth_records',
  {
    linkedAccountId: uuid('linked_account_id')
      .notNull()
      .references(() => linkedAccounts.id, { onDelete: 'cascade' }),
    // 'creds' for the credential document, otherwise a Signal key type.
    category: text('category').notNull(),
    recordId: text('record_id').notNull(),
    keyVersion: integer('key_version').notNull(),
    iv: bytea('iv').notNull(),
    tag: bytea('tag').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.linkedAccountId, t.category, t.recordId] })],
);

export const connectorLeases = pgTable('connector_leases', {
  linkedAccountId: uuid('linked_account_id')
    .primaryKey()
    .references(() => linkedAccounts.id, { onDelete: 'cascade' }),
  ownerId: text('owner_id').notNull(),
  fencingToken: bigint('fencing_token', { mode: 'number' }).notNull(),
  expiresAt: ts('expires_at').notNull(),
  heartbeatAt: ts('heartbeat_at').notNull().defaultNow(),
});

export const connectorCommands = pgTable(
  'connector_commands',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    linkedAccountId: uuid('linked_account_id')
      .notNull()
      .references(() => linkedAccounts.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: ['pair', 'pause', 'resume', 'disconnect', 'delete_account', 'fetch_media', 'fetch_avatars', 'request_history', 'cancel_pair'],
    }).notNull(),
    // Never contains QR payloads or credentials.
    payload: jsonb('payload').notNull().default({}),
    status: text('status', { enum: ['pending', 'running', 'done', 'failed'] })
      .notNull()
      .default('pending'),
    result: jsonb('result'),
    idempotencyKey: text('idempotency_key'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('connector_commands_pending_idx').on(t.linkedAccountId, t.status, t.createdAt),
    uniqueIndex('connector_commands_idem_uq').on(t.workspaceId, t.idempotencyKey),
  ],
);

export const connectionStatus = pgTable('connection_status', {
  linkedAccountId: uuid('linked_account_id')
    .primaryKey()
    .references(() => linkedAccounts.id, { onDelete: 'cascade' }),
  state: text('state', {
    enum: [
      'disconnected',
      'pairing',
      'connecting',
      'connected',
      'reconnecting',
      'paused',
      'relink_required',
      'error',
    ],
  })
    .notNull()
    .default('disconnected'),
  detail: text('detail'),
  lastEventAt: ts('last_event_at'),
  heartbeatAt: ts('heartbeat_at'),
  connectedSince: ts('connected_since'),
  // Content-free gap records: [{from, to, reason}]
  uncertainIntervals: jsonb('uncertain_intervals').notNull().default([]),
  remoteUnlinkConfirmed: boolean('remote_unlink_confirmed'),
  updatedAt: updatedAt(),
});

export const processHeartbeats = pgTable('process_heartbeats', {
  processName: text('process_name').primaryKey(),
  instanceId: text('instance_id').notNull(),
  heartbeatAt: ts('heartbeat_at').notNull().defaultNow(),
  detail: jsonb('detail').notNull().default({}),
});

// ---------------------------------------------------------------------------
// Chats, aliases, participants
// ---------------------------------------------------------------------------
export const chats = pgTable(
  'chats',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    // Null for synthetic demo/fixture chats that have no linked account.
    linkedAccountId: uuid('linked_account_id').references(() => linkedAccounts.id, {
      onDelete: 'set null',
    }),
    sourceKind: text('source_kind', { enum: ['whatsapp', 'fixture'] }).notNull(),
    nativeJid: text('native_jid').notNull(),
    kind: text('kind', { enum: ['group', 'direct'] }).notNull(),
    title: text('title').notNull(),
    selected: boolean('selected').notNull().default(false),
    paused: boolean('paused').notNull().default(false),
    selectionEpoch: integer('selection_epoch').notNull().default(0),
    historyMode: text('history_mode', { enum: ['available_history', 'new_only'] })
      .notNull()
      .default('available_history'),
    newOnlyCutoff: ts('new_only_cutoff'),
    // Excluded = deleted by the user; replay may not recreate content until reselected.
    excluded: boolean('excluded').notNull().default(false),
    deletionGeneration: integer('deletion_generation').notNull().default(0),
    sourceVersion: bigint('source_version', { mode: 'number' }).notNull().default(0),
    graphVersion: bigint('graph_version', { mode: 'number' }).notNull().default(0),
    taxonomyVersion: integer('taxonomy_version').notNull().default(0),
    lastEventAt: ts('last_event_at'),
    lastAnalysisAt: ts('last_analysis_at'),
    // New messages are analysed only while this is in the future: briefly after the chat is
    // first opened (its history is arriving) and after the owner clicks Refresh.
    autoAnalyzeUntil: ts('auto_analyze_until'),
    // WhatsApp profile photo cached in storage (null: none, hidden, or not fetched yet).
    avatarKey: text('avatar_key'),
    // When the photo was last looked up; a null means look it up when the chat is shown.
    avatarCheckedAt: ts('avatar_checked_at'),
    // Key of the newest message seen (ids and time only, never content), so history can be
    // requested from WhatsApp for a chat selected after its initial history was discarded.
    historyAnchor: jsonb('history_anchor').$type<{ remoteJid: string; id: string; fromMe: boolean; participant: string | null; ts: number }>(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('chats_native_uq').on(t.workspaceId, t.sourceKind, t.linkedAccountId, t.nativeJid),
    index('chats_workspace_idx').on(t.workspaceId),
  ],
);

export const chatAliases = pgTable(
  'chat_aliases',
  {
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    workspaceId: uuid('workspace_id').notNull(),
    aliasJid: text('alias_jid').notNull(),
    source: text('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('chat_aliases_uq').on(t.workspaceId, t.aliasJid)],
);

export const participants = pgTable(
  'participants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    canonicalJid: text('canonical_jid').notNull(),
    displayName: text('display_name'),
    isSelf: boolean('is_self').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('participants_uq').on(t.workspaceId, t.canonicalJid)],
);

export const participantAliases = pgTable(
  'participant_aliases',
  {
    workspaceId: uuid('workspace_id').notNull(),
    aliasJid: text('alias_jid').notNull(),
    participantId: uuid('participant_id')
      .notNull()
      .references(() => participants.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.aliasJid] })],
);

// ---------------------------------------------------------------------------
// Messages, revisions, controls, coverage
// ---------------------------------------------------------------------------
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    // Hash of (native id, fromMe, canonical participant): the dedupe identity within a chat.
    nativeKeyHash: text('native_key_hash').notNull(),
    nativeId: text('native_id').notNull(),
    fromMe: boolean('from_me').notNull(),
    // Private native key detail (remoteJid/participant aliases); never sent to browsers.
    nativeKey: jsonb('native_key').notNull(),
    senderParticipantId: uuid('sender_participant_id').references(() => participants.id),
    senderLabel: text('sender_label').notNull(),
    direction: text('direction', { enum: ['incoming', 'outgoing'] }).notNull(),
    kind: text('kind', { enum: ['text', 'media', 'system', 'unsupported'] }).notNull(),
    state: text('state', { enum: ['active', 'revoked', 'expired', 'deleted'] })
      .notNull()
      .default('active'),
    body: text('body'),
    searchText: text('search_text'),
    sentAt: ts('sent_at'),
    sentAtRaw: text('sent_at_raw'),
    receivedAt: ts('received_at').notNull(),
    editedAt: ts('edited_at'),
    contentRevision: integer('content_revision').notNull().default(1),
    revisionDigest: text('revision_digest').notNull(),
    replyToNativeId: text('reply_to_native_id'),
    expiresAt: ts('expires_at'),
    // Starred in WhatsApp (synced from the phone; ThreadMap never stars or unstars).
    starred: boolean('starred').notNull().default(false),
    starredAt: ts('starred_at'),
    ingestEventType: text('ingest_event_type').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('messages_native_uq').on(t.chatId, t.nativeKeyHash),
    index('messages_chat_time_idx').on(t.chatId, t.sentAt, t.id),
    index('messages_workspace_idx').on(t.workspaceId),
    index('messages_native_id_idx').on(t.chatId, t.nativeId),
    index('messages_starred_idx').on(t.chatId).where(sql`${t.starred}`),
  ],
);

export const messageRevisions = pgTable(
  'message_revisions',
  {
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    // Purged (set null) when the message is revoked, expired or deleted.
    body: text('body'),
    digest: text('digest').notNull(),
    observedAt: ts('observed_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.messageId, t.revision] })],
);

// Edits/revocations that arrived before their base message, or that must be
// remembered for idempotency. Content-free except an edit's new body, which is
// purged if the message is later revoked.
export const controlEvents = pgTable(
  'control_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    eventKey: text('event_key').notNull(),
    targetNativeId: text('target_native_id').notNull(),
    type: text('type', { enum: ['edit', 'revoke', 'expire'] }).notNull(),
    editBody: text('edit_body'),
    eventTime: ts('event_time'),
    applied: boolean('applied').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('control_events_key_uq').on(t.chatId, t.eventKey),
    index('control_events_target_idx').on(t.chatId, t.targetNativeId),
  ],
);

export const syncCoverage = pgTable('sync_coverage', {
  chatId: uuid('chat_id')
    .primaryKey()
    .references(() => chats.id, { onDelete: 'cascade' }),
  historyState: text('history_state', {
    enum: ['not_requested', 'receiving', 'settled', 'limited', 'unavailable'],
  })
    .notNull()
    .default('not_requested'),
  earliestAt: ts('earliest_at'),
  latestAt: ts('latest_at'),
  historyCount: integer('history_count').notNull().default(0),
  liveCount: integer('live_count').notNull().default(0),
  excludedBeforeCutoff: integer('excluded_before_cutoff').notNull().default(0),
  unknownTimeExcluded: integer('unknown_time_excluded').notNull().default(0),
  warnings: jsonb('warnings').notNull().default([]),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Attachments and resources
// ---------------------------------------------------------------------------
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    ordinal: integer('ordinal').notNull().default(0),
    mediaType: text('media_type').notNull(),
    declaredMime: text('declared_mime'),
    detectedMime: text('detected_mime'),
    filename: text('filename'),
    declaredSize: bigint('declared_size', { mode: 'number' }),
    byteCount: bigint('byte_count', { mode: 'number' }),
    contentHash: text('content_hash'),
    availability: text('availability', {
      enum: ['available', 'fetching', 'cached', 'unavailable', 'unsupported', 'failed'],
    }).notNull(),
    objectKey: text('object_key'),
    // AES-GCM encrypted native download material (companion-only).
    mediaRef: bytea('media_ref'),
    failureReason: text('failure_reason'),
    viewOnce: boolean('view_once').notNull().default(false),
    expiresAt: ts('expires_at'),
    // Small JPEG preview WhatsApp embeds in image/video messages (shown before download; a video's frame for VL).
    thumbnail: bytea('thumbnail'),
    // What the vision model sees in the image / video frame, fed into categorisation. Purged with the content.
    aiDescription: text('ai_description'),
    aiDescribedBy: text('ai_described_by'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('attachments_msg_ord_uq').on(t.messageId, t.ordinal),
    index('attachments_workspace_idx').on(t.workspaceId),
  ],
);

export const resources = pgTable(
  'resources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['url', 'attachment', 'mention'] }).notNull(),
    url: text('url'),
    canonicalUrl: text('canonical_url'),
    attachmentId: uuid('attachment_id').references(() => attachments.id, { onDelete: 'cascade' }),
    label: text('label'),
    createdAt: createdAt(),
  },
  (t) => [
    index('resources_message_idx').on(t.messageId),
    index('resources_canonical_idx').on(t.workspaceId, t.canonicalUrl),
  ],
);

// ---------------------------------------------------------------------------
// Recursive topic graph, discussions, placements, claims
// ---------------------------------------------------------------------------
export const topics = pgTable(
  'topics',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    root: text('root', { enum: ['KNOWLEDGE', 'GENERAL_CHAT', 'EVENTS_ACTIVITIES', 'RESOURCES'] }).notNull(),
    kind: text('kind', { enum: ['CATEGORY', 'TOPIC'] }).notNull(),
    // Null only for the four CATEGORY roots.
    parentId: uuid('parent_id'),
    title: text('title').notNull(),
    aliases: jsonb('aliases').$type<string[]>().notNull().default([]),
    provenance: text('provenance', { enum: ['system', 'model', 'user', 'fixture'] }).notNull(),
    titleLocked: boolean('title_locked').notNull().default(false),
    parentLocked: boolean('parent_locked').notNull().default(false),
    needsReview: boolean('needs_review').notNull().default(false),
    // Set when merged away; retired topics are excluded from the live tree.
    retiredInto: uuid('retired_into'),
    taxonomyVersion: integer('taxonomy_version').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('topics_tree_idx').on(t.workspaceId, t.chatId, t.root, t.parentId),
    index('topics_parent_idx').on(t.parentId),
  ],
);

export const discussions = pgTable(
  'discussions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    unitKey: text('unit_key'),
    provenance: text('provenance', { enum: ['model', 'user', 'fixture'] }).notNull(),
    taxonomyVersion: integer('taxonomy_version').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index('discussions_topic_idx').on(t.topicId)],
);

export const placements = pgTable(
  'placements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    discussionId: uuid('discussion_id').references(() => discussions.id, { onDelete: 'set null' }),
    isPrimary: boolean('is_primary').notNull().default(false),
    provenance: text('provenance', { enum: ['model', 'user', 'fixture'] }).notNull(),
    // User-locked placements survive regeneration.
    locked: boolean('locked').notNull().default(false),
    // Revision the placement was derived from; stale ones are suppressed.
    analyzedRevision: integer('analyzed_revision').notNull().default(1),
    taxonomyVersion: integer('taxonomy_version').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('placements_uq').on(t.topicId, t.messageId),
    index('placements_message_idx').on(t.messageId),
    index('placements_chat_topic_idx').on(t.chatId, t.topicId),
    index('placements_discussion_idx').on(t.discussionId),
  ],
);

export const summaryClaims = pgTable(
  'summary_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id').references(() => topics.id, { onDelete: 'cascade' }),
    discussionId: uuid('discussion_id').references(() => discussions.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    // Digest over the complete sorted (message id, revision) input set summarized.
    inputDigest: text('input_digest').notNull(),
    inputMessageIds: jsonb('input_message_ids').$type<string[]>().notNull(),
    valid: boolean('valid').notNull().default(true),
    modelId: text('model_id'),
    promptVersion: text('prompt_version'),
    createdAt: createdAt(),
  },
  (t) => [index('summary_claims_topic_idx').on(t.topicId), index('summary_claims_disc_idx').on(t.discussionId)],
);

export const claimEvidence = pgTable(
  'claim_evidence',
  {
    claimId: uuid('claim_id')
      .notNull()
      .references(() => summaryClaims.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
  },
  (t) => [primaryKey({ columns: [t.claimId, t.messageId] }), index('claim_evidence_msg_idx').on(t.messageId)],
);

export const crossChatLinks = pgTable(
  'cross_chat_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    aChatId: uuid('a_chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    aTopicId: uuid('a_topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    bChatId: uuid('b_chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    bTopicId: uuid('b_topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    relationType: text('relation_type', { enum: ['RELATED_TOPIC', 'SHARED_RESOURCE'] }).notNull(),
    reason: text('reason').notNull(),
    // [{message_id, revision}] on each side
    aEvidence: jsonb('a_evidence').$type<{ messageId: string; revision: number }[]>().notNull(),
    bEvidence: jsonb('b_evidence').$type<{ messageId: string; revision: number }[]>().notNull(),
    status: text('status', { enum: ['verified', 'rejected', 'suppressed'] }).notNull(),
    dismissed: boolean('dismissed').notNull().default(false),
    dismissedBy: text('dismissed_by'),
    generationVersion: integer('generation_version').notNull().default(0),
    verifierModel: text('verifier_model'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('cross_chat_links_pair_uq').on(t.aTopicId, t.bTopicId, t.relationType),
    index('cross_chat_links_ws_idx').on(t.workspaceId),
  ],
);

// ---------------------------------------------------------------------------
// Review state, overrides, view preferences
// ---------------------------------------------------------------------------
export const reviewState = pgTable(
  'review_state',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    status: text('status', { enum: ['read', 'missed'] }).notNull(),
    reviewedRevision: integer('reviewed_revision'),
    readAt: ts('read_at'),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.messageId] })],
);

// Monotonic per-user/chat review counter; part of count_version.
export const reviewVersions = pgTable(
  'review_versions',
  {
    userId: text('user_id').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    version: bigint('version', { mode: 'number' }).notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.chatId] })],
);

export const bulkReviewSnapshots = pgTable('bulk_review_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: text('user_id').notNull(),
  workspaceId: uuid('workspace_id').notNull(),
  chatId: uuid('chat_id').notNull(),
  scope: jsonb('scope').notNull(),
  pairs: jsonb('pairs').$type<{ m: string; r: number }[]>().notNull(),
  executedAt: ts('executed_at'),
  result: jsonb('result'),
  createdAt: createdAt(),
});

export const taxonomyOverrides = pgTable(
  'taxonomy_overrides',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    topicId: uuid('topic_id'),
    kind: text('kind', { enum: ['rename', 'move', 'merge', 'placement_add', 'placement_remove'] }).notNull(),
    payload: jsonb('payload').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('taxonomy_overrides_chat_idx').on(t.chatId)],
);

export const topicMergeMap = pgTable('topic_merge_map', {
  retiredId: uuid('retired_id').primaryKey(),
  survivingId: uuid('surviving_id').notNull(),
  chatId: uuid('chat_id').notNull(),
  createdAt: createdAt(),
});

export const userChatViewPreferences = pgTable(
  'user_chat_view_preferences',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    // 'all' or a nonnegative safe integer rendered as text.
    showDepth: text('show_depth').notNull(),
    collapsedNodeIds: jsonb('collapsed_node_ids').$type<string[]>().notNull().default([]),
    focusNodeId: uuid('focus_node_id'),
    autoReadEnabled: boolean('auto_read_enabled').notNull().default(true),
    revision: integer('revision').notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.chatId] })],
);

// ---------------------------------------------------------------------------
// Analysis: outbox, logical jobs, budget ledger, model runs, frontiers
// ---------------------------------------------------------------------------
export const analysisOutbox = pgTable(
  'analysis_outbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    workspaceId: uuid('workspace_id').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id')
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    revision: integer('revision').notNull(),
    deletionGeneration: integer('deletion_generation').notNull(),
    selectionEpoch: integer('selection_epoch').notNull(),
    dispatchedJobId: uuid('dispatched_job_id'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('analysis_outbox_uq').on(t.messageId, t.revision),
    index('analysis_outbox_pending_idx').on(t.chatId, t.dispatchedJobId, t.createdAt),
  ],
);

export const analysisJobs = pgTable(
  'analysis_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['microbatch', 'rebuild', 'refine', 'links'] }).notNull(),
    // Continuations share the logical job id (and therefore its budget ledger).
    logicalJobId: uuid('logical_job_id').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    inputMessages: jsonb('input_messages').$type<{ m: string; r: number }[]>().notNull(),
    pipelineVersion: text('pipeline_version').notNull(),
    deletionGeneration: integer('deletion_generation').notNull(),
    selectionEpoch: integer('selection_epoch').notNull(),
    status: text('status', {
      enum: ['pending', 'running', 'completed', 'failed', 'budget_paused', 'cancelled', 'superseded'],
    })
      .notNull()
      .default('pending'),
    attempts: integer('attempts').notNull().default(0),
    safeError: text('safe_error'),
    result: jsonb('result'),
    createdAt: createdAt(),
    startedAt: ts('started_at'),
    completedAt: ts('completed_at'),
  },
  (t) => [
    uniqueIndex('analysis_jobs_fingerprint_uq').on(t.chatId, t.inputFingerprint),
    index('analysis_jobs_status_idx').on(t.chatId, t.status),
  ],
);

export const budgetLedger = pgTable('budget_ledger', {
  logicalJobId: uuid('logical_job_id').primaryKey(),
  workspaceId: uuid('workspace_id').notNull(),
  maxCalls: integer('max_calls').notNull(),
  maxUsdMicros: bigint('max_usd_micros', { mode: 'number' }).notNull(),
  callsReserved: integer('calls_reserved').notNull().default(0),
  callsUsed: integer('calls_used').notNull().default(0),
  usdMicrosReserved: bigint('usd_micros_reserved', { mode: 'number' }).notNull().default(0),
  usdMicrosUsed: bigint('usd_micros_used', { mode: 'number' }).notNull().default(0),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  updatedAt: updatedAt(),
});

export const dailyBudget = pgTable('daily_budget', {
  day: text('day').primaryKey(),
  maxUsdMicros: bigint('max_usd_micros', { mode: 'number' }).notNull(),
  usdMicrosReserved: bigint('usd_micros_reserved', { mode: 'number' }).notNull().default(0),
  usdMicrosUsed: bigint('usd_micros_used', { mode: 'number' }).notNull().default(0),
  calls: integer('calls').notNull().default(0),
});

export const modelRuns = pgTable(
  'model_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id'),
    logicalJobId: uuid('logical_job_id'),
    jobId: uuid('job_id'),
    role: text('role', { enum: ['reasoning', 'fast', 'balanced', 'vision'] }).notNull(),
    provider: text('provider', { enum: ['nebius', 'fixture'] }).notNull(),
    modelId: text('model_id').notNull(),
    fallback: boolean('fallback').notNull().default(false),
    operation: text('operation').notNull(),
    promptVersion: text('prompt_version').notNull(),
    schemaVersion: text('schema_version').notNull(),
    status: text('status', { enum: ['ok', 'invalid_output', 'repaired', 'error'] }).notNull(),
    attempt: integer('attempt').notNull().default(1),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    reasoningTokens: integer('reasoning_tokens'),
    usdMicros: bigint('usd_micros', { mode: 'number' }),
    durationMs: integer('duration_ms').notNull(),
    safeError: text('safe_error'),
    createdAt: createdAt(),
  },
  (t) => [index('model_runs_job_idx').on(t.logicalJobId)],
);

export const taxonomyFrontiers = pgTable(
  'taxonomy_frontiers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    logicalJobId: uuid('logical_job_id').notNull(),
    parentTopicId: uuid('parent_topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    // [{m, r}] scoped source revisions to refine beneath this parent
    inputMessages: jsonb('input_messages').$type<{ m: string; r: number }[]>().notNull(),
    status: text('status', { enum: ['pending', 'running', 'completed', 'budget_paused', 'failed'] })
      .notNull()
      .default('pending'),
    checkpoint: jsonb('checkpoint').notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('taxonomy_frontiers_status_idx').on(t.chatId, t.status),
    uniqueIndex('taxonomy_frontiers_parent_uq').on(t.logicalJobId, t.parentTopicId),
  ],
);

// Extracted units from Nano kept for taxonomy/refinement/assignment steps.
export const analysisUnits = pgTable(
  'analysis_units',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id').notNull(),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    jobId: uuid('job_id').notNull(),
    unitKey: text('unit_key').notNull(),
    primaryRoot: text('primary_root', { enum: ['KNOWLEDGE', 'GENERAL_CHAT', 'EVENTS_ACTIVITIES', 'RESOURCES'] }).notNull(),
    topicTerms: jsonb('topic_terms').$type<string[]>().notNull(),
    messageRefs: jsonb('message_refs').$type<{ m: string; r: number }[]>().notNull(),
    summaryBullets: jsonb('summary_bullets').notNull(),
    resourceRefs: jsonb('resource_refs').$type<string[]>().notNull(),
    needsReview: boolean('needs_review').notNull().default(false),
    assignedTopicId: uuid('assigned_topic_id'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('analysis_units_uq').on(t.jobId, t.unitKey), index('analysis_units_chat_idx').on(t.chatId)],
);

export const auditLog = pgTable('audit_log', {
  id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  workspaceId: uuid('workspace_id'),
  actor: text('actor').notNull(),
  action: text('action').notNull(),
  // Allowlisted, content-free metadata only.
  detail: jsonb('detail').notNull().default({}),
  createdAt: createdAt(),
});
