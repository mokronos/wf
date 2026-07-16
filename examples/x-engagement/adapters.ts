import type { SecretRef } from "wf"

export interface TimelinePost {
  readonly id: string
  readonly author: string
  readonly text: string
  readonly createdAt: string
}

export interface RankedCandidate {
  readonly post: TimelinePost
  readonly reason: string
}

export interface TimelineSourceInput {
  readonly bearerToken: SecretRef | string
}

export interface ZenInput {
  readonly apiKey: SecretRef | string
  readonly model?: string | undefined
}

export interface DraftReplyInput extends ZenInput {
  readonly post: TimelinePost
  readonly feedback: ReadonlyArray<string>
}

export interface SelectCandidatesInput extends ZenInput {
  readonly posts: ReadonlyArray<TimelinePost>
  readonly maxCandidates: number
}

export interface ReplyPosterInput {
  readonly bearerToken: SecretRef | string
  readonly postId: string
  readonly replyText: string
  readonly dryRun: boolean
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface AdapterConfig {
  readonly zenBaseUrl?: string | undefined
  readonly zenModel?: string | undefined
  readonly xUserId?: string | undefined
  readonly enableRealX?: boolean | undefined
  readonly fetch?: FetchLike | undefined
}

const fixtureUrl = new URL("./fixtures/timeline.json", import.meta.url)

let config: AdapterConfig = {
  zenBaseUrl: "https://opencode.ai/zen/v1",
  zenModel: process.env["ZEN_MODEL"] ?? "minimax-m2.5-free",
  xUserId: process.env["X_USER_ID"],
  enableRealX: process.env["X_ENGAGEMENT_REAL_X"] === "1"
}

export const configureXEngagementAdapters = (next: AdapterConfig) => {
  config = { ...config, ...next }
}

export const resetXEngagementAdapters = () => {
  config = {
    zenBaseUrl: "https://opencode.ai/zen/v1",
    zenModel: process.env["ZEN_MODEL"] ?? "minimax-m2.5-free",
    xUserId: process.env["X_USER_ID"],
    enableRealX: process.env["X_ENGAGEMENT_REAL_X"] === "1"
  }
}

const getFetch = () => config.fetch ?? fetch

const isConfiguredSecret = (value: SecretRef | string): boolean =>
  typeof value === "string" && value.length > 0 && !value.startsWith("secret:")

const readFixtureTimeline = async (): Promise<ReadonlyArray<TimelinePost>> => {
  const posts = await Bun.file(fixtureUrl).json()
  return posts as ReadonlyArray<TimelinePost>
}

export const fetchTimeline = async (input: TimelineSourceInput): Promise<ReadonlyArray<TimelinePost>> => {
  if (config.enableRealX !== true || config.xUserId === undefined || !isConfiguredSecret(input.bearerToken)) {
    return readFixtureTimeline()
  }

  const url = new URL(`https://api.x.com/2/users/${config.xUserId}/timelines/reverse_chronological`)
  url.searchParams.set("max_results", "25")
  url.searchParams.set("tweet.fields", "created_at,author_id")
  url.searchParams.set("expansions", "author_id")
  url.searchParams.set("user.fields", "name,username")

  const response = await getFetch()(url, {
    headers: { Authorization: `Bearer ${input.bearerToken}` }
  })
  if (!response.ok) {
    throw new Error(`X timeline request failed: ${response.status} ${await response.text()}`)
  }

  const body = await response.json() as {
    readonly data?: ReadonlyArray<{ readonly id: string; readonly text: string; readonly created_at?: string; readonly author_id?: string }>
    readonly includes?: { readonly users?: ReadonlyArray<{ readonly id: string; readonly name?: string; readonly username?: string }> }
  }
  const users = new Map((body.includes?.users ?? []).map((user) => [user.id, user.name ?? user.username ?? user.id]))
  return (body.data ?? []).map((post) => ({
    id: post.id,
    author: users.get(post.author_id ?? "") ?? post.author_id ?? "unknown",
    text: post.text,
    createdAt: post.created_at ?? new Date().toISOString()
  }))
}

const shouldDropPost = (post: TimelinePost): boolean => {
  const text = post.text.trim().toLowerCase()
  return text.startsWith("rt @") || text.startsWith("@") || text.includes("promoted:")
}

const localRank = (
  posts: ReadonlyArray<TimelinePost>,
  maxCandidates: number
): ReadonlyArray<RankedCandidate> =>
  posts
    .filter((post) => !shouldDropPost(post))
    .map((post) => ({
      post,
      reason: post.text.includes("?") ? "asks a concrete question" : "has a specific engineering observation"
    }))
    .slice(0, maxCandidates)

const chatCompletion = async (input: ZenInput, messages: ReadonlyArray<{ readonly role: string; readonly content: string }>) => {
  if (!isConfiguredSecret(input.apiKey)) {
    return undefined
  }

  const baseUrl = config.zenBaseUrl ?? "https://opencode.ai/zen/v1"
  const response = await getFetch()(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: input.model ?? config.zenModel ?? "minimax-m2.5-free",
      messages,
      temperature: 0.3
    })
  })
  if (!response.ok) {
    throw new Error(`Zen chat completion failed: ${response.status} ${await response.text()}`)
  }

  const body = await response.json() as {
    readonly choices?: ReadonlyArray<{ readonly message?: { readonly content?: string } }>
  }
  return body.choices?.[0]?.message?.content
}

const parseCandidates = (
  content: string | undefined,
  posts: ReadonlyArray<TimelinePost>,
  maxCandidates: number
): ReadonlyArray<RankedCandidate> | undefined => {
  if (content === undefined) {
    return undefined
  }
  try {
    const parsed = JSON.parse(content) as ReadonlyArray<{ readonly postId: string; readonly reason: string }>
    const byId = new Map(posts.map((post) => [post.id, post]))
    return parsed
      .map((candidate) => {
        const post = byId.get(candidate.postId)
        return post === undefined ? undefined : { post, reason: candidate.reason }
      })
      .filter((candidate): candidate is RankedCandidate => candidate !== undefined)
      .slice(0, maxCandidates)
  } catch {
    return undefined
  }
}

export const selectCandidates = async (input: SelectCandidatesInput): Promise<ReadonlyArray<RankedCandidate>> => {
  const filtered = input.posts.filter((post) => !shouldDropPost(post))
  const content = await chatCompletion(input, [
    {
      role: "system",
      content: "Rank X timeline posts for whether they are worth a short, genuine engineering reply. Return only JSON."
    },
    {
      role: "user",
      content: JSON.stringify({
        maxCandidates: input.maxCandidates,
        posts: filtered.map((post) => ({ id: post.id, author: post.author, text: post.text })),
        responseShape: [{ postId: "string", reason: "one line" }]
      })
    }
  ])
  return parseCandidates(content, filtered, input.maxCandidates) ?? localRank(input.posts, input.maxCandidates)
}

const localDraft = (post: TimelinePost, feedback: ReadonlyArray<string>): string => {
  if (feedback.length > 0) {
    return `That framing helps. What changed your mind most while working through this?`
  }
  if (post.text.includes("?")) {
    return "I like the shape of this question. What signal has been most useful in practice?"
  }
  return "What tradeoff made this stand out to you in the implementation?"
}

export const draftReply = async (input: DraftReplyInput): Promise<string> => {
  const feedbackBlock = input.feedback.length === 0
    ? "No reviewer feedback yet."
    : `Reviewer feedback to address:\n${input.feedback.map((note) => `- ${note}`).join("\n")}`
  const content = await chatCompletion(input, [
    {
      role: "system",
      content: "Draft one short, genuine X reply. No hashtags, no sycophancy, no generic praise."
    },
    {
      role: "user",
      content: [
        `Author: ${input.post.author}`,
        `Post: ${input.post.text}`,
        feedbackBlock,
        "Return only the reply text."
      ].join("\n")
    }
  ])
  return (content?.trim() || localDraft(input.post, input.feedback)).slice(0, 280)
}

export const postReply = async (input: ReplyPosterInput): Promise<{ readonly posted: boolean }> => {
  if (input.dryRun || config.enableRealX !== true || !isConfiguredSecret(input.bearerToken)) {
    console.log(`[dry-run] would reply to ${input.postId}: ${input.replyText}`)
    return { posted: false }
  }

  const response = await getFetch()("https://api.x.com/2/tweets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.bearerToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      text: input.replyText,
      reply: { in_reply_to_tweet_id: input.postId }
    })
  })
  if (response.ok) {
    return { posted: true }
  }

  const text = await response.text()
  if (response.status === 403 && text.toLowerCase().includes("duplicate")) {
    return Promise.reject(Object.assign(new Error("Duplicate reply rejected by X"), { duplicateReply: true }))
  }
  throw new Error(`X post reply failed: ${response.status} ${text}`)
}
