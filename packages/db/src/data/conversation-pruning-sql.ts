// Shared by expression indexes and their queries: SQLite requires matching
// expressions to seek metadata without materializing a history payload in V8.
function field(path: string): string {
  return `CASE WHEN json_valid(payload) THEN COALESCE(json_extract(payload, '$.event.${path}'), json_extract(payload, '$.${path}')) END`;
}
function fieldType(path: string): string {
  return `CASE WHEN json_valid(payload) THEN COALESCE(json_type(payload, '$.event.${path}'), json_type(payload, '$.${path}')) END`;
}

export const PRUNE_TURN = field('scope.turnId');
export const PRUNE_ITEM = `COALESCE(${field('itemId')}, ${field('item.id')})`;
export const PRUNE_PARENT = `COALESCE(${field('item.parentToolCallId')}, ${field('parentToolCallId')})`;
export const PRUNE_KIND = field('item.type');
export const PRUNE_CAPACITY = field('contextWindowUsage.modelContextWindow');
export const PRUNE_FINAL_OUTPUT = `CASE ${PRUNE_KIND}
  WHEN 'commandExecution' THEN ${fieldType('item.aggregatedOutput')} = 'text'
  WHEN 'agentMessage' THEN ${fieldType('item.text')} = 'text' AND length(${field('item.text')}) > 0
  WHEN 'reasoning' THEN CASE WHEN ${fieldType('item.summary')} = 'array' AND ${fieldType('item.content')} = 'array'
    THEN COALESCE(length(json_extract(${field('item.summary')}, '$[0]')), 0) > 0
      OR COALESCE(length(json_extract(${field('item.content')}, '$[0]')), 0) > 0 ELSE 0 END
  ELSE 0 END`;
export const PRUNE_DELTA_TYPES = [
  'item/agentMessage/delta', 'item/commandExecution/outputDelta',
  'item/reasoning/summaryTextDelta', 'item/reasoning/textDelta'
] as const;
export const PRUNE_DELTA_LIST = PRUNE_DELTA_TYPES.map(type => `'${type}'`).join(', ');
export const qualifyPruningSql = (sql: string, alias: string) => sql.replace(/\bpayload\b/g, `${alias}.payload`);
export const PRUNE_ROOT_USAGE = `NOT EXISTS (SELECT 1 FROM thread_events nested INDEXED BY thread_events_nested_turn_idx
  WHERE nested.thread_id = candidate.thread_id AND ${qualifyPruningSql(PRUNE_TURN, 'nested')} = ${qualifyPruningSql(PRUNE_TURN, 'candidate')}
    AND nested.type = 'turn/started' AND ${qualifyPruningSql(PRUNE_PARENT, 'nested')} IS NOT NULL)`;

export const CONVERSATION_PRUNING_INDEXES = [
  'CREATE INDEX thread_events_type_thread_seq_idx ON thread_events(type, thread_id, sequence)',
  `CREATE INDEX thread_events_delta_candidates_idx ON thread_events(thread_id, sequence) WHERE type IN (${PRUNE_DELTA_LIST})`,
  `CREATE INDEX thread_events_delta_identity_idx ON thread_events(
    thread_id, ${PRUNE_TURN}, ${PRUNE_ITEM}, ${PRUNE_PARENT}, type, sequence
  ) WHERE type IN (${PRUNE_DELTA_LIST})`,
  `CREATE INDEX thread_events_completed_identity_idx ON thread_events(
    thread_id, ${PRUNE_TURN}, ${PRUNE_ITEM}, ${PRUNE_PARENT}, ${PRUNE_KIND}, ${PRUNE_FINAL_OUTPUT}, sequence
  ) WHERE type = 'item/completed'`,
  `CREATE INDEX thread_events_background_identity_idx ON thread_events(
    thread_id, ${PRUNE_ITEM}, ${PRUNE_PARENT}, type, ${PRUNE_KIND}, sequence
  ) WHERE type IN ('item/backgroundTask/progress', 'item/backgroundTask/completed')`,
  `CREATE INDEX thread_events_nested_turn_idx ON thread_events(thread_id, ${PRUNE_TURN})
    WHERE type = 'turn/started' AND ${PRUNE_PARENT} IS NOT NULL`,
  `CREATE INDEX thread_events_context_capacity_idx ON thread_events(thread_id, sequence)
    WHERE type = 'thread/contextWindowUsage/updated' AND ${PRUNE_CAPACITY} IS NOT NULL`
];
