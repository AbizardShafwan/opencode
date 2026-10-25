export * as SessionRunCoordinator from "./run-coordinator.js"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"
import type { Promotable } from "./inbox.js"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Receipt<A, E, Reason = never> {
  /** Process-local identity; callers may use it to deduplicate observers. */
  readonly owner: object
  readonly wait: Effect.Effect<A | void, E>
  readonly outcome: Effect.Effect<{ exit: Exit.Exit<A | void, E>; reason: Reason | undefined }>
}

export interface Coordinator<Key, E, Reason = never, A = void> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Checks ownership for one key, including cleanup and terminal settlement. */
  readonly isActive: (key: Key) => Effect.Effect<boolean>
  /** Starts an execution while idle, or joins the active execution and returns its exit. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Rings the doorbell: an idle key starts an execution; an active one drains again before settling. */
  readonly wake: (key: Key, scope?: Promotable) => Effect.Effect<void>
  /** Joins the accepting busy period, or captures its successor during terminal cleanup.
   * `work: false` only observes; `force` is reserved for explicit recovery.
   */
  readonly schedule: (
    key: Key,
    options?: { scope?: Promotable; work?: boolean; force?: boolean },
  ) => Effect.Effect<Receipt<A, E, Reason> | undefined>
  /**
   * Stops the active execution and clears its doorbell. No-op when idle. Resolves once the
   * interruption is accepted, not when cleanup settles: the execution fiber finishes its
   * finalizers and settled hook on its own time. Returns whether an active execution was
   * interrupted.
   */
  readonly interrupt: (key: Key, reason?: Reason, owner?: object) => Effect.Effect<boolean>
  /** Resolves once no execution is active for the key. Returns immediately when already idle and never starts work. */
  readonly awaitIdle: (key: Key) => Effect.Effect<void>
}

/**
 * One execution is a busy period for one key: one fiber that drains from the first wake
 * until the key would stay idle. `pendingWake` is the doorbell: work recorded during the
 * execution rings it with the scope that work needs, and the execution loop drains again
 * instead of ending. The doorbell closes the gap between a drain's last eligibility check
 * and the idle transition, since those cannot be one atomic step. `done` resolves joiners
 * with this execution's exit.
 */
type Observation<E, Reason, A> = {
  readonly done: Deferred.Deferred<A | void, E>
  readonly receipt: Receipt<A, E, Reason>
  readonly termination: { reason: Reason | undefined }
}

type Execution<E, Reason, A> = Observation<E, Reason, A> & {
  successor?: Observation<E, Reason, A>
  owner?: Fiber.Fiber<void>
  scope: Promotable
  pendingWake?: Promotable
  stopping: boolean
  accepting: boolean
  pendingForce: boolean
}

/**
 * ```text
 *              wake | run
 *      idle ──────────────▶ execution (one fiber)
 *                             drain ⟲ doorbell rung mid-drain
 *                             │ exit (settled hook runs)
 *      doorbell quiet ◀───────┴───────▶ doorbell rung
 *      idle, waiters get exit          successor execution,
 *                                      waiters get this exit
 * ```
 */
export const make = <Key, E, Reason = never, A = void>(options: {
  readonly drain: (key: Key, force: boolean, scope: Promotable) => Effect.Effect<void, E>
  /** Runs once when a process-local busy period begins, before its first drain. */
  readonly started?: (key: Key) => Effect.Effect<void, E>
  /** Captures a successful execution's result before terminal settlement or any successor. */
  readonly result?: (key: Key) => Effect.Effect<A, E>
  /**
   * Runs in the execution fiber for every exit, including interruption, after the final
   * drain and before the execution settles (waiters resolve after it completes).
   */
  readonly settled?: (
    key: Key,
    exit: Exit.Exit<void, E>,
    reason: Reason | undefined,
    owner: object,
  ) => Effect.Effect<void>
}): Effect.Effect<Coordinator<Key, E, Reason, A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const executions = new Map<Key, Execution<E, Reason, A>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    let closing = false
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        closing = true
      }),
    )

    const loop = (key: Key, execution: Execution<E, Reason, A>, force: boolean): Effect.Effect<void, E> =>
      Effect.suspend(() => options.drain(key, force, execution.scope)).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            if (execution.stopping || execution.pendingWake === undefined) {
              execution.accepting = false
              return Effect.void
            }
            execution.scope = execution.pendingWake
            execution.pendingWake = undefined
            execution.pendingForce = false
            // Trampoline so drains that complete synchronously cannot grow the stack.
            return Effect.yieldNow.pipe(Effect.andThen(loop(key, execution, false)))
          }),
        ),
      )

    const observe = (): Observation<E, Reason, A> => {
      const done = Deferred.makeUnsafe<A | void, E>()
      const owner = {}
      const termination: Observation<E, Reason, A>["termination"] = { reason: undefined }
      return {
        done,
        receipt: {
          owner,
          wait: Deferred.await(done),
          outcome: Deferred.await(done).pipe(
            Effect.exit,
            Effect.map((exit) => ({ exit, reason: termination.reason })),
          ),
        },
        termination,
      }
    }

    const start = (key: Key, force: boolean, scope: Promotable, observation = observe()) => {
      const execution: Execution<E, Reason, A> = {
        ...observation,
        scope,
        stopping: false,
        accepting: true,
        pendingForce: false,
      }
      executions.set(key, execution)
      // The leading yield lets `owner` be assigned before the drain can settle, and keeps
      // failing self-waking executions from growing the stack across successor starts.
      // Drains start one tick after wake; callers observe progress through events or run.
      execution.owner = fork(
        Effect.yieldNow.pipe(
          Effect.andThen(Effect.uninterruptible(options.started?.(key) ?? Effect.void)),
          Effect.andThen(loop(key, execution, force)),
          Effect.andThen(Effect.suspend(() => options.result?.(key) ?? Effect.void)),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              execution.owner = undefined
              execution.accepting = false
            }).pipe(
              Effect.andThen(
                options.settled?.(key, Exit.asVoid(exit), execution.termination.reason, execution.receipt.owner) ??
                  Effect.void,
              ),
            ),
          ),
          Effect.onExit((exit) => Effect.sync(() => settle(key, execution, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      return execution
    }

    // A doorbell that survives the execution loop (rung after the loop decided to end, or
    // during failure or interruption cleanup) starts a fresh execution for the remaining work.
    const settle = (key: Key, execution: Execution<E, Reason, A>, exit: Exit.Exit<A | void, E>) => {
      if (execution.pendingWake && !closing)
        start(key, execution.pendingForce, execution.pendingWake, execution.successor)
      else executions.delete(key)
      if (closing && execution.successor) Deferred.doneUnsafe(execution.successor.done, Exit.interrupt())
      execution.successor = undefined
      Deferred.doneUnsafe(execution.done, exit)
    }

    const isActive = (key: Key) => Effect.sync(() => executions.has(key))

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.suspend(() => {
        const execution = executions.get(key)
        if (execution !== undefined) {
          // A stopping execution refuses joiners: wait out its cleanup, then run fresh.
          if (execution.stopping)
            return Deferred.await(execution.done).pipe(Effect.ignoreCause, Effect.andThen(run(key)))
          return Deferred.await(execution.done).pipe(Effect.asVoid)
        }
        return Deferred.await(start(key, true, "input").done).pipe(Effect.asVoid)
      })

    const ring = (
      key: Key,
      options: { scope?: Promotable; work?: boolean; force?: boolean } | undefined,
      capture: boolean,
    ) =>
      Effect.sync(() => {
        if (closing)
          return {
            owner: {},
            wait: Effect.interrupt,
            outcome: Effect.succeed({ exit: Exit.interrupt(), reason: undefined }),
          }
        const execution = executions.get(key)
        // An observation of empty durable work must not ring a doorbell or start work.
        if (options?.work === false) return execution?.receipt
        const scope = options?.scope ?? "input"
        if (execution !== undefined) {
          // Coalesced wakes keep the widest scope: "input" subsumes "steer".
          execution.pendingWake = execution.pendingWake === "input" ? "input" : scope
          execution.pendingForce ||= options?.force ?? false
          if (!capture) return undefined
          // Steering joins the current busy period, including its failure. A wake
          // left by a failed drain still runs, but is not a per-prompt result claim.
          if (execution.accepting && !execution.stopping) return execution.receipt
          execution.successor ??= observe()
          return execution.successor.receipt
        }
        return start(key, options?.force ?? false, scope).receipt
      })

    const schedule: Coordinator<Key, E, Reason, A>["schedule"] = (key, options) => ring(key, options, true)
    const wake = (key: Key, scope?: Promotable) => ring(key, { scope }, false).pipe(Effect.asVoid)
    const cancelPending = (execution: Execution<E, Reason, A>, reason?: Reason) => {
      execution.pendingWake = undefined
      if (execution.successor) {
        execution.successor.termination.reason = reason
        Deferred.doneUnsafe(execution.successor.done, Exit.interrupt())
      }
      execution.successor = undefined
    }

    const interrupt = (key: Key, reason?: Reason, owner?: object): Effect.Effect<boolean> =>
      Effect.sync(() => {
        const execution = executions.get(key)
        if (execution === undefined) return false
        if (owner && execution.receipt.owner !== owner) {
          if (execution.successor?.receipt.owner !== owner) return false
          cancelPending(execution, reason)
          return true
        }
        if (execution.stopping || (owner && !execution.accepting)) return false
        if (execution.owner === undefined) {
          // Settlement window: the owner exited but the settled hook has not finished. The
          // terminal outcome is already decided, so no reason attaches — but the interrupt
          // still claims the recorded wakes so settle does not start a dead-intent successor.
          cancelPending(execution, reason)
          return false
        }
        execution.stopping = true
        // Wakes recorded so far belong to the interrupted intent; the interrupt claims them.
        // Wakes arriving during cleanup are new admissions and restart normally at settle.
        cancelPending(execution, reason)
        execution.termination.reason = reason
        // Fire and forget: nobody benefits from waiting out cleanup here, and callers like
        // the interrupt endpoint must acknowledge immediately even when finalizers are slow.
        fork(Fiber.interrupt(execution.owner))
        return true
      })

    // One execution's `done` already spans coalesced continuations; re-check after it
    // settles to cover a successor execution started by a late doorbell.
    const awaitIdle = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const execution = executions.get(key)
        if (execution === undefined) return Effect.void
        return Deferred.await(execution.done).pipe(Effect.ignoreCause, Effect.andThen(awaitIdle(key)))
      })

    return {
      active: Effect.sync(() => new Set(executions.keys())),
      isActive,
      run,
      wake,
      schedule,
      interrupt,
      awaitIdle,
    }
  })
