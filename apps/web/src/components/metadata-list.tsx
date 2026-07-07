import { prettyJson } from "@/lib/format"

export function MetadataList({ value }: { readonly value: Record<string, unknown> }) {
  const entries = Object.entries(value).filter(([, item]) => item !== undefined)
  if (entries.length === 0) {
    return <p className="muted-copy">No runtime metadata was captured.</p>
  }

  return (
    <div className="metadata-list">
      {entries.map(([key, item]) => (
        <div key={key} className="metadata-row">
          <span>{key}</span>
          <code>{prettyJson(item)}</code>
        </div>
      ))}
    </div>
  )
}
