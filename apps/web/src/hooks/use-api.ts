import { useCallback, useEffect, useState } from "react"

export interface ApiState<T> {
  readonly data: T | undefined
  readonly loading: boolean
  readonly error: string | undefined
  readonly reload: () => Promise<void>
}

export const useApi = <T,>(loader: () => Promise<T>, loadImmediately = true): ApiState<T> => {
  const [data, setData] = useState<T | undefined>()
  const [loading, setLoading] = useState(loadImmediately)
  const [error, setError] = useState<string | undefined>()

  const reload = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      setData(await loader())
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [loader])

  useEffect(() => {
    if (loadImmediately) {
      void reload()
    }
  }, [loadImmediately, reload])

  return { data, loading, error, reload }
}
