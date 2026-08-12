import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { decodePersistedJsonSchema } from "../src/sdk/json-schema-validation.ts"
import { jsonSchemaOf } from "../src/schemas.ts"

describe("persisted JSON Schema validation", () => {
  test("reconstructs a runtime decoder without a process-local schema", () => {
    const persisted = jsonSchemaOf(Schema.Struct({ approved: Schema.Boolean }))
    if (persisted === undefined) throw new Error("Expected a JSON Schema")

    expect(decodePersistedJsonSchema(persisted, { approved: true })).toEqual({ approved: true })
    expect(() => decodePersistedJsonSchema(persisted, { approved: "yes" })).toThrow()
  })

  test("simplifies nested alternatives while preserving sibling fields", () => {
    const date = Schema.Union([Schema.DateFromString, Schema.Date]).annotate({
      description: "A date"
    })

    expect(jsonSchemaOf(Schema.Struct({ dates: Schema.Array(date) }))).toMatchObject({
      properties: {
        dates: {
          items: {
            anyOf: [{ type: "string" }],
            description: "A date"
          }
        }
      }
    })
  })
})
