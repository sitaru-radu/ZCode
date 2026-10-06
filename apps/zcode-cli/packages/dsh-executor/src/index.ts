/**
 * @zcode/dsh-executor — public entry point.
 *
 * Engine-agnostic by construction: nothing here imports a workflow engine. The mission package
 * binds `DeepSeekHarnessAdapter` to its driver; this barrel is the only surface it needs.
 * See CONTRACT.md for the confirmed protocol facts, the invariants and the known traps.
 */

// Transport and lifecycle
export { AcpClient, type AcpClientOptions, type AcpRequestOptions } from './acp-client.js';
export {
  DshExecutorAdapter,
  createDshExecutor,
  type DeepSeekHarnessAdapter,
  type DshResumeOptions,
} from './adapter.js';

// Configuration
export {
  DEFAULT_BINARY,
  DEFAULT_CLIENT_NAME,
  DEFAULT_CLIENT_VERSION,
  DEFAULT_DISPOSE_GRACE_MS,
  DEFAULT_MAX_LINE_CHARS,
  DEFAULT_PROFILE,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_STDERR_BUFFER_LINES,
  DEFAULT_SUBMIT_SERVER_NAME,
  DEFAULT_SUBMIT_TOOL_NAME,
  DEFAULT_TURN_TIMEOUT_MS,
  DSH_PERMISSION_MODE_ENV,
  buildChildArgs,
  buildChildEnv,
  resolveConfig,
  type DshExecutorConfig,
  type DshPermissionMode,
  type DshPermissionPolicy,
  type ResolvedDshExecutorConfig,
} from './config.js';

// Errors
export {
  DshExecutorError,
  ExecutorExited,
  ExecutorHandshakeFailed,
  ExecutorRequestFailed,
  ExecutorSpawnFailed,
  PromptTimeout,
  ProtocolViolation,
  RequestTimeout,
  RpcMethodNotFound,
  SessionCreateFailed,
  SessionNotFound,
  isDshExecutorError,
  isExecutorExited,
  isProtocolViolation,
  isSessionNotFound,
  requestFailedError,
  type DshErrorKind,
  type RpcErrorShape,
} from './errors.js';

// Events and sessions
export { HotEventStream, DEFAULT_SUBSCRIBER_LIMIT } from './events.js';
export {
  SessionRegistry,
  SessionState,
  MAX_BUFFERED_UPDATES_PER_SESSION,
  MAX_BUFFERED_UPDATES_TOTAL,
  type SettledTurn,
  type UpdateOptions,
} from './session-state.js';
export {
  MAX_EVENT_TEXT_CHARS,
  MAX_PAYLOAD_CHARS,
  UPDATE_CONFIG_OPTION,
  UPDATE_MESSAGE_CHUNK,
  UPDATE_THOUGHT_CHUNK,
  UPDATE_TOOL_CALL,
  UPDATE_TOOL_CALL_UPDATE,
  UPDATE_USAGE,
  isSubmitToolName,
  normalizeUpdate,
  truncateText,
} from './updates.js';

// Model selection
export {
  MODEL_CONFIG_ID,
  REASONING_EFFORT_CONFIG_ID,
  REASONING_EFFORT_VALUES,
  encodeModelValue,
  findConfigOption,
  modelIdsFromOptions,
  parseModelValue,
  resolveModelValue,
} from './models.js';

// Permission requests
export {
  buildPermissionResponse,
  readPermissionRequest,
  selectPermissionOption,
  type PermissionChoice,
  type PermissionOutcome,
  type PermissionRequestDetails,
} from './permissions.js';

// Typed-result bridge
export {
  createSubmitServer,
  attachSubmitServer,
  createSubmitMcpServer,
  runSubmitServerStdio,
  submitServerEntryPath,
  submitServerMain,
  validateArguments,
  DEFAULT_SUBMIT_DESCRIPTION,
  MCP_PROTOCOL_VERSION,
  SUBMIT_RESULT_FILE_ENV,
  SUBMIT_SCHEMA_ENV,
  SUBMIT_SCHEMA_FILE_ENV,
  SUBMIT_TOOL_NAME_ENV,
  type SubmitCallReport,
  type SubmitMcpServerOptions,
  type SubmitServer,
  type SubmitServerIo,
  type SubmitServerOptions,
} from './mcp/submit-server.js';
export { MCP_SERVER_NAME_PATTERN, McpConfigError, toAcpMcpServers } from './mcp/servers.js';
export { fencedJsonBlocks, parseFencedJson, type FencedJson } from './submission.js';

// Redaction and framing (exported for callers that log or assert on the wire)
export { REDACTED, createRedactor, secretValuesFromEnv, type Redactor } from './redact.js';
export { LogRing, MAX_LINE_CHARS } from './log-buffer.js';
export { DEFAULT_MAX_LINE_CHARS as DEFAULT_FRAME_MAX_LINE_CHARS, LineSplitter, type SplitResult } from './line-splitter.js';
export {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  classifyFrame,
  encodeError,
  encodeNotification,
  encodeRequest,
  encodeResult,
  isRecord,
  type IncomingFrame,
  type JsonRpcErrorObject,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './jsonrpc.js';

// Shared types
export {
  ACP_PROTOCOL_VERSION,
  type AcpEnvVariable,
  type AcpExitInfo,
  type AcpMcpServer,
  type AcpMcpServerHttp,
  type AcpMcpServerStdio,
  type DshConfigOption,
  type DshConfigOptionChoice,
  type DshEvent,
  type DshEventKind,
  type DshExecutorState,
  type DshExitReason,
  type DshExitReport,
  type DshMcpServer,
  type DshMcpServerHttp,
  type DshMcpServerStdio,
  type DshSessionSpec,
  type DshSessionStatus,
  type DshSessionSummary,
  type DshStreamStats,
  type DshSubmission,
  type DshSubmissionSource,
  type DshTurnResult,
} from './types.js';
