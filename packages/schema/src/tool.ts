export * as Tool from "./tool.js"

import { Effect, JsonSchema, Schema } from "effect"
import type { StandardSchemaV1 } from "@standard-schema/spec"
import type { Agent } from "./agent.js"
import type { Session } from "./session.js"
import type { SessionMessage } from "./session-message.js"

/** The strictest provider limit on advertised tool names (Gemini function declarations). */
export const MAX_DIRECT_TOOL_NAME_LENGTH = 63
/** Advertised tool names every supported provider accepts: letter-initial, at most 63 characters. */
export const PROVIDER_SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,62}$/

export type Metadata = Readonly<Record<string, any>>

export const CallID = Schema.String.pipe(Schema.brand("Tool.CallID"))
export type CallID = typeof CallID.Type

export interface Context {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly messageID: SessionMessage.ID
  readonly id: CallID
  readonly progress: (update: Metadata) => Effect.Effect<void>
}

export interface Namespace {
  readonly name: string
  readonly description: string
}

interface BaseOptions {
  readonly namespace?: string
  readonly permission?: string
  /**
   * Top-level input keys carrying secrets. Their values reach `execute` unchanged but are redacted from
   * durable events, permission requests and progress displays, and the tool is never exposed through Code Mode.
   */
  readonly sensitiveInputs?: ReadonlyArray<string>
  /**
   * Runs a direct call only after the provider stream finished and every sibling call succeeded.
   * A failed or interrupted sibling skips it, so the tool observes a completed turn.
   */
  readonly deferred?: "after-stream-and-siblings"
}

export type Options = BaseOptions &
  (
    | {
        readonly codemode?: true
        readonly pinned?: boolean
      }
    | {
        readonly codemode: boolean
        readonly pinned?: never
      }
  )

export type ValueSchema<A = unknown> = Schema.Codec<A, any> | StandardSchemaV1<any, A> | JsonSchema.JsonSchema

type InputValue<S> = 0 extends 1 & S
  ? any
  : S extends Schema.Codec<infer A, any>
    ? A
    : S extends StandardSchemaV1<any, infer A>
      ? A
      : unknown
type OutputValue<S> = S extends undefined
  ? never
  : S extends Schema.Codec<infer A, any>
    ? A
    : S extends StandardSchemaV1<infer A, any>
      ? A
      : any

export class Error extends Schema.TaggedError<Error>()("Tool.Error", {
  message: Schema.String,
  error: Schema.optional(Schema.Defect()),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
}) {}

export interface TextContent extends Schema.Schema.Type<typeof TextContent> {}
export const TextContent = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
}).annotate({ identifier: "Tool.TextContent" })

export interface FileContent extends Schema.Schema.Type<typeof FileContent> {}
export const FileContent = Schema.Struct({
  type: Schema.Literal("file"),
  uri: Schema.String,
  mime: Schema.String,
  name: Schema.optional(Schema.String),
}).annotate({ identifier: "Tool.FileContent" })

export const Content = Schema.Union([TextContent, FileContent])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Tool.Content" })
export type Content = Schema.Schema.Type<typeof Content>

export interface Result<Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined> {
  readonly output?: OutputValue<Output>
  readonly content?: string | ReadonlyArray<Content>
  readonly metadata?: Metadata
}

export type Info<
  Input extends ValueSchema<any> = ValueSchema<any>,
  Output extends ValueSchema<any> | undefined = ValueSchema<any> | undefined,
> = {
  readonly name: string
  readonly input: Input
  readonly description: string
  readonly execute: (input: InputValue<Input>, context: Context) => Effect.Effect<Result<Output>, Error>
  readonly output?: Output
  readonly options?: Options
}
