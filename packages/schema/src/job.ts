export * as Job from "./job.js"

import { Schema } from "effect"
import { Session } from "./session.js"
import { optional } from "./schema.js"

export const Status = Schema.Literals(["running", "completed", "error", "cancelled"])
export type Status = typeof Status.Type

export const Kind = Schema.Literals(["shell", "subagent", "image"])
export type Kind = typeof Kind.Type

export interface Time extends Schema.Schema.Type<typeof Time> {}
export const Time = Schema.Struct({
  started: Schema.Number,
  completed: optional(Schema.Number),
}).annotate({ identifier: "Job.Time" })

const Base = {
  id: Schema.String,
  sessionID: Session.ID,
  status: Status,
  title: optional(Schema.String),
  time: Time,
}

export interface Shell extends Schema.Schema.Type<typeof Shell> {}
export const Shell = Schema.Struct({
  kind: Schema.Literal("shell"),
  ...Base,
  shellID: Schema.String,
  command: Schema.String,
}).annotate({ identifier: "Job.Shell" })

export interface Subagent extends Schema.Schema.Type<typeof Subagent> {}
export const Subagent = Schema.Struct({
  kind: Schema.Literal("subagent"),
  ...Base,
  childSessionID: Session.ID,
  agent: Schema.String,
  description: Schema.String,
}).annotate({ identifier: "Job.Subagent" })

export interface Image extends Schema.Schema.Type<typeof Image> {}
export const Image = Schema.Struct({
  kind: Schema.Literal("image"),
  ...Base,
  path: Schema.String,
  model: Schema.String,
}).annotate({ identifier: "Job.Image" })

export type Info = Shell | Subagent | Image
export const Info = Schema.Union([Shell, Subagent, Image]).annotate({ identifier: "Job.Info" })

export interface List extends Schema.Schema.Type<typeof List> {}
export const List = Schema.Struct({
  data: Schema.Array(Info),
}).annotate({ identifier: "Job.List" })
