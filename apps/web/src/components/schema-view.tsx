import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

type JsonRecord = Record<string, unknown>

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isNumberEncoding = (items: ReadonlyArray<unknown>): boolean => {
  if (items.length !== 4) {
    return false
  }
  const types = items.map((item) => isRecord(item) ? item.type : undefined)
  const consts = items.map((item) => isRecord(item) ? item.const : undefined)
  return types.includes("number") &&
    consts.includes("NaN") &&
    consts.includes("Infinity") &&
    consts.includes("-Infinity")
}

const simplifySchema = (schema: unknown): unknown => {
  if (!isRecord(schema)) {
    return schema
  }
  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : undefined
  if (anyOf !== undefined && isNumberEncoding(anyOf)) {
    return { type: "number" }
  }
  return schema
}

const typeLabel = (schema: unknown): string => {
  const value = simplifySchema(schema)
  if (!isRecord(value)) {
    return "unknown"
  }
  if (typeof value.const === "string" || typeof value.const === "number" || typeof value.const === "boolean") {
    return JSON.stringify(value.const)
  }
  if (Array.isArray(value.enum)) {
    return value.enum.map((item) => JSON.stringify(item)).join(" | ")
  }
  if (Array.isArray(value.anyOf)) {
    return value.anyOf.map(typeLabel).join(" | ")
  }
  if (Array.isArray(value.oneOf)) {
    return value.oneOf.map(typeLabel).join(" | ")
  }
  if (value.type === "array") {
    return `${typeLabel(value.items)}[]`
  }
  if (Array.isArray(value.type)) {
    return value.type.join(" | ")
  }
  if (typeof value.type === "string") {
    return value.type
  }
  return "unknown"
}

function SchemaNode({
  name,
  schema,
  required,
  depth = 0
}: {
  readonly name?: string
  readonly schema: unknown
  readonly required?: boolean
  readonly depth?: number
}) {
  const value = simplifySchema(schema)
  if (!isRecord(value)) {
    return <pre className="schema-fallback">{JSON.stringify(schema, null, 2)}</pre>
  }

  const properties = isRecord(value.properties) ? value.properties : undefined
  const requiredKeys = new Set(Array.isArray(value.required) ? value.required.filter((item) => typeof item === "string") : [])
  const union = Array.isArray(value.anyOf) ? value.anyOf : Array.isArray(value.oneOf) ? value.oneOf : undefined

  if (properties !== undefined || value.type === "object") {
    const entries = Object.entries(properties ?? {})
    return (
      <div className={cn("schema-node", depth > 0 && "schema-node-nested")}>
        <div className="schema-line">
          {name === undefined ? null : <span className="schema-name">{name}</span>}
          <Badge variant="secondary">object</Badge>
          {required ? <span className="schema-required">required</span> : null}
        </div>
        {entries.length === 0 ? (
          <span className="schema-empty">no declared properties</span>
        ) : (
          <div className="schema-children">
            {entries.map(([key, child]) => (
              <SchemaNode
                key={key}
                name={key}
                schema={child}
                required={requiredKeys.has(key)}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  if (value.type === "array") {
    return (
      <div className={cn("schema-node", depth > 0 && "schema-node-nested")}>
        <div className="schema-line">
          {name === undefined ? null : <span className="schema-name">{name}</span>}
          <Badge variant="secondary">{typeLabel(value)}</Badge>
          {required ? <span className="schema-required">required</span> : null}
        </div>
        <div className="schema-children">
          <SchemaNode name="item" schema={value.items} depth={depth + 1} />
        </div>
      </div>
    )
  }

  if (union !== undefined) {
    return (
      <div className={cn("schema-node", depth > 0 && "schema-node-nested")}>
        <div className="schema-line">
          {name === undefined ? null : <span className="schema-name">{name}</span>}
          <Badge variant="secondary">{typeLabel(value)}</Badge>
          {required ? <span className="schema-required">required</span> : null}
        </div>
      </div>
    )
  }

  if (
    typeof value.type === "string" ||
    Array.isArray(value.type) ||
    value.const !== undefined ||
    Array.isArray(value.enum)
  ) {
    return (
      <div className={cn("schema-node", depth > 0 && "schema-node-nested")}>
        <div className="schema-line">
          {name === undefined ? null : <span className="schema-name">{name}</span>}
          <Badge variant="secondary">{typeLabel(value)}</Badge>
          {required ? <span className="schema-required">required</span> : null}
        </div>
      </div>
    )
  }

  return <pre className="schema-fallback">{JSON.stringify(schema, null, 2)}</pre>
}

export function SchemaView({ schema }: { readonly schema: unknown }) {
  return (
    <div className="schema-view">
      <SchemaNode schema={schema} />
    </div>
  )
}
