import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { LOCAL_WEB_FETCH_TOOL_NAME, DESCRIPTION } from './prompt.js'
import {
  getToolUseSummary,
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
} from './UI.js'
import {
  fetchAndExtract,
  validateAndSanitizeURL,
} from './utils.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    url: z.string().describe('The http:// or https:// URL to fetch content from'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    url: z.string().describe('The URL that was fetched'),
    status: z.number().describe('HTTP response status code'),
    title: z.string().describe('Extracted page title'),
    contentType: z.string().describe('Content-Type of the response'),
    extractedText: z.string().describe('Extracted text content (HTML converted to markdown)'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const LocalWebFetchTool = buildTool({
  name: LOCAL_WEB_FETCH_TOOL_NAME,
  searchHint: 'fetch and extract content from a URL using local HTTP client',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description(input) {
    const { url } = input as { url: string }
    try {
      const hostname = new URL(url).hostname
      return `Claude wants to fetch content from ${hostname} (local fetch)`
    } catch {
      return `Claude wants to fetch content from this URL (local fetch)`
    }
  },
  userFacingName() {
    return 'Local Web Fetch'
  },
  getToolUseSummary,
  getActivityDescription(input) {
    const summary = getToolUseSummary(input)
    return summary ? `Fetching ${summary} (local)` : 'Fetching web page (local)'
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.url
  },
  async checkPermissions(_input, _context) {
    // Always allow — the URL validation in call() handles SSRF protection
    return {
      behavior: 'allow',
      updatedInput: _input,
      decisionReason: { type: 'other', reason: 'Local web fetch — SSRF protection in URL validation' },
    }
  },
  async prompt() {
    return `IMPORTANT: This tool uses a local HTTP client that bypasses remote domain safety checks. Only use it for PUBLICLY accessible web pages. Do NOT use for authenticated/private content (e.g., Google Docs, Confluence, Jira, GitHub private repos).

${DESCRIPTION}`
  },
  async validateInput(input) {
    const validation = validateAndSanitizeURL(input.url)
    if (!validation.valid) {
      return {
        result: false,
        message: `Error: ${validation.error}`,
        meta: { reason: 'invalid_url' },
        errorCode: 1,
      }
    }
    return { result: true }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  async call(
    { url },
    { abortController },
  ) {
    // Validate and sanitize URL
    const validation = validateAndSanitizeURL(url)
    if (!validation.valid) {
      return {
        data: {
          url,
          status: 0,
          title: '',
          contentType: '',
          extractedText: `Error: ${validation.error}`,
        } satisfies Output,
      }
    }

    try {
      const result = await fetchAndExtract(
        validation.upgradedUrl,
        abortController.signal,
      )

      const output: Output = {
        url: validation.upgradedUrl,
        status: result.status,
        title: result.title,
        contentType: result.contentType,
        extractedText: result.extractedText,
      }

      return { data: output }
    } catch (error: unknown) {
      const err = error as Error & {
        code?: string
        response?: { status?: number; statusText?: string }
      }

      let errorMsg: string
      if (err.name === 'CanceledError' || abortController.signal.aborted) {
        errorMsg = 'Request was aborted'
      } else if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND') {
        errorMsg = `Could not connect to host: ${err.message}`
      } else if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
        errorMsg = `Request timed out after 15 seconds: ${err.message}`
      } else if (err.response) {
        errorMsg = `Server returned HTTP ${err.response.status} ${err.response.statusText || ''}`.trim()
      } else {
        errorMsg = `Fetch failed: ${err.message || 'Unknown error'}`
      }

      const output: Output = {
        url: validation.upgradedUrl,
        status: err.response?.status ?? 0,
        title: '',
        contentType: '',
        extractedText: `Error: ${errorMsg}`,
      }

      return { data: output }
    }
  },
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    const d = data as Output
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: [
        `URL: ${d.url}`,
        `Status: ${d.status}`,
        d.title ? `Title: ${d.title}` : '',
        d.contentType ? `Content-Type: ${d.contentType}` : '',
        '',
        d.extractedText,
      ].filter(l => l !== '').join('\n'),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
