export interface EmbeddedWebAsset {
  readonly base64: string
  readonly contentType: string
}

const assets: Readonly<Record<string, EmbeddedWebAsset>> = {}

export default assets
