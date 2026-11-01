export * as ConfigCompaction from "./compaction.js"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "../schema.js"

export class Keep extends Schema.Class<Keep>("Config.Compaction.Keep")({
  tokens: NonNegativeInt.pipe(optional),
}) {}

export class Info extends Schema.Class<Info>("Config.Compaction")({
  auto: Schema.Boolean.pipe(optional),
  keep: Keep.pipe(optional),
  buffer: NonNegativeInt.pipe(optional),
  default_soft_limit: NonNegativeInt.pipe(optional),
  soft_limits: Schema.Record(Schema.String, NonNegativeInt).pipe(optional),
}) {}
