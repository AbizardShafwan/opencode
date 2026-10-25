import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261024104804_delegated-threads",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`task_name\` text;`)
      yield* tx.run(`ALTER TABLE \`session_v2\` ADD \`authority\` text;`)
    })
  },
}

export default migration
