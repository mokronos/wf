export const compactDate = (value: string | undefined): string =>
  value === undefined
    ? "unknown"
    : new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(value))

export const shortId = (value: string): string =>
  value.length <= 12 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`

export const durationBetween = (startedAt: string, finishedAt: string | undefined): string => {
  const end = finishedAt === undefined ? Date.now() : new Date(finishedAt).getTime()
  const elapsed = Math.max(0, end - new Date(startedAt).getTime())
  if (elapsed < 1000) {
    return `${elapsed}ms`
  }
  const seconds = Math.round(elapsed / 1000)
  if (seconds < 60) {
    return `${seconds}s`
  }
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) {
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
  }
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

export const prettyJson = (value: unknown): string =>
  JSON.stringify(value, null, 2)
