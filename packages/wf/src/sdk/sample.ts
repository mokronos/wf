import { Schema, SchemaAST } from "effect"
import type { JsonSchema } from "../schemas.ts"

const schemaAst = (schema: unknown): SchemaAST.AST | undefined =>
  Schema.isSchema(schema) ? schema.ast : undefined

const DateTypeConstructor = Schema.TaggedStruct("Date", {})
const isDateTypeConstructor = Schema.is(DateTypeConstructor)

export const sampleValueForSchema = (schema: unknown): unknown =>
  sampleValueFromAst(schemaAst(schema), new Set())

/** Sample value for a JSON Schema document, mirroring Effect schema samples. */
export const sampleValueForJsonSchema = (schema: JsonSchema, depth = 0): unknown => {
  if (depth > 8) return {}
  if (schema.const !== undefined) return schema.const
  if (schema.enum !== undefined && schema.enum.length > 0) return schema.enum[0]
  const alternative = schema.anyOf?.[0] ?? schema.oneOf?.[0]
  if (alternative !== undefined) return sampleValueForJsonSchema(alternative, depth + 1)
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  switch (type) {
    case "string":
      return "sample"
    case "number":
    case "integer":
      return 1
    case "boolean":
      return true
    case "null":
      return null
    case "array":
      return schema.items === undefined ? [] : [sampleValueForJsonSchema(schema.items, depth + 1)]
    case "object": {
      const properties = schema.properties ?? {}
      const required = schema.required
      return Object.fromEntries(
        Object.entries(properties)
          .filter(([key]) => required === undefined || required.includes(key))
          .map(([key, property]) => [key, sampleValueForJsonSchema(property, depth + 1)])
      )
    }
    default:
      return {}
  }
}

// `seen` holds only the current recursion path because AST nodes are shared.
const sampleValueFromAst = (
  ast: SchemaAST.AST | undefined,
  seen: Set<SchemaAST.AST>
): unknown => {
  if (ast === undefined || seen.has(ast)) return {}
  seen.add(ast)
  try {
    return sampleValueFromAstUnguarded(ast, seen)
  } finally {
    seen.delete(ast)
  }
}

const sampleValueFromAstUnguarded = (
  ast: SchemaAST.AST,
  seen: Set<SchemaAST.AST>
): unknown => {
  switch (ast._tag) {
    case "String":
      return "sample"
    case "Number":
      return 1
    case "Boolean":
      return true
    case "Void":
    case "Undefined":
      return undefined
    case "Null":
      return null
    case "Literal":
      return ast.literal
    case "Arrays": {
      const element = ast.rest?.[0] ?? ast.elements?.[0]
      return [sampleValueFromAst(element, seen)]
    }
    case "Union": {
      const candidate = ast.types?.find((item) => item._tag !== "Undefined") ?? ast.types?.[0]
      return sampleValueFromAst(candidate, seen)
    }
    case "Objects":
      return Object.fromEntries(ast.propertySignatures?.map((property) => [
        property.name,
        sampleValueFromAst(property.type, seen)
      ]) ?? [])
    case "Declaration":
      return isDateTypeConstructor(ast.annotations?.["typeConstructor"]) ? new Date(0) : {}
    case "Unknown":
    case "Any":
      return {}
    case "Never":
      throw new Error("Cannot create a sample value for Schema.Never")
    default:
      return {}
  }
}
