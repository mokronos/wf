import { whenTrue } from "./optional.ts"
import { Effect, Schema } from "effect"

/** How results are shaped for the reader.
 *
 * The primary reader is an agent with a finite context window, which pulls in
 * two directions: a listing must not cost tens of thousands of tokens, and it
 * must not silently hide rows either — a truncated answer that looks complete
 * is worse than a large one, because the reader acts on it.
 *
 * The resolution is that nothing is ever dropped without being asked for. A
 * listing returns every row, in summary form and in a stable order; `--limit`
 * and `--offset` take a window when one is wanted; `--verbose` says how much of
 * each row to show, and never how many rows. Every listing carries its `count`,
 * so a reader can tell a window from the whole.
 *
 * JSON output is always parseable. It is the machine format, and a JSON
 * document truncated mid-token is not a smaller answer — it is no answer. Where
 * a value is long, the *value* is shortened and marked; the document stays
 * whole. */

/** The size past which a listing suggests narrowing it. High enough that
 *  ordinary results say nothing, low enough to catch a 300-operation API. */
export const largeListing = 50

export interface Page<A> {
  readonly items: ReadonlyArray<A>
  /** How many rows matched before the window was applied. */
  readonly count: number
  readonly limit: number | undefined
  readonly offset: number
}

export interface Window {
  readonly limit: number | undefined
  readonly offset: number | undefined
}

/** Takes the requested window out of an already-ordered listing. Order is the
 *  caller's business: an offset into an unstably-ordered listing addresses
 *  different rows each time it is asked, which is worse than no window. */
export const page = <A>(items: ReadonlyArray<A>, window: Window): Page<A> => {
  const offset = Math.max(0, window.offset ?? 0)
  const limited = window.limit === undefined
    ? items.slice(offset)
    : items.slice(offset, offset + Math.max(0, window.limit))
  return { items: limited, count: items.length, limit: window.limit, offset }
}

/** What a listing reports about its own shape. Present only when it says
 *  something the rows do not: a window was applied, or the result is large
 *  enough to be worth narrowing. */
export const pageFields = <A>(result: Page<A>, narrowing: string) => {
  const windowed = result.limit !== undefined || result.offset > 0
  return {
    count: result.count,
    ...whenTrue(windowed, () => ({ showing: result.items.length, offset: result.offset })),
    ...whenTrue(
      result.count > largeListing && !windowed,
      () => ({ hint: `${result.count} rows — ${narrowing}, or pipe this into jq` })
    )
  }
}

/** A value on its way out through JSON.stringify. Wider than Schema.Json
 *  because the rows come from decoded gateway responses, which carry Dates and
 *  optional properties typed `| undefined`. */
export type JsonEncodable =
  | Schema.Json
  | undefined
  | Date
  | ReadonlyArray<JsonEncodable>
  | { readonly [key: string]: JsonEncodable }

/** JSON is compact unless verbose, because an agent pays for whitespace. */
export const jsonOutput = (value: JsonEncodable, verbose: boolean): string =>
  JSON.stringify(value, null, verbose ? 2 : undefined)

export const inline = (value: string, limit: number): string => {
  const collapsed = value.replace(/\s+/g, " ").trim()
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit)}…`
}

/** Awaits the write rather than firing and forgetting, so a large result is
 *  fully drained before the process exits. */
export const writeStdoutLine = (text: string): Effect.Effect<void> =>
  Effect.promise(() =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(`${text}\n`, (error) => {
        if (error === undefined || error === null) resolve()
        else reject(error)
      })
    })
  )

/** Listings append the command that follows, so an agent does not have to guess
 *  the next step. `<…>` marks what the reader fills in; anything else is
 *  runnable as printed. */
export const withNext = (
  body: Record<string, typeof Schema.Json.Type>,
  next: string | undefined
): Record<string, typeof Schema.Json.Type> => next === undefined ? body : { ...body, next }
