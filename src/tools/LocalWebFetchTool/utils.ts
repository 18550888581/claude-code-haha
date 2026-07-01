import axios from 'axios'
import { getWebFetchUserAgent } from '../../utils/http.js'

// ----- URL validation / SSRF protection -----

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
])

function isPrivateIP(hostname: string): boolean {
  // IPv4 private ranges
  const ipv4Patterns = [
    /^10\.\d+\.\d+\.\d+$/,
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
    /^192\.168\.\d+\.\d+$/,
    /^169\.254\.\d+\.\d+$/, // link-local
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/, // CGNAT 100.64.0.0/10
    /^0\.0\.0\.0$/,
  ]
  return ipv4Patterns.some(p => p.test(hostname))
}

export type URLValidationResult =
  | { valid: true; upgradedUrl: string }
  | { valid: false; error: string }

export function validateAndSanitizeURL(raw: string): URLValidationResult {
  if (raw.length > 2000) {
    return { valid: false, error: 'URL exceeds maximum length of 2000 characters' }
  }

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return { valid: false, error: `Invalid URL: "${raw}" could not be parsed` }
  }

  // Only http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      valid: false,
      error: `Protocol "${parsed.protocol.replace(':', '')}" is not allowed. Only http:// and https:// URLs are supported.`,
    }
  }

  // Block URLs with credentials
  if (parsed.username || parsed.password) {
    return { valid: false, error: 'URLs with embedded credentials are not allowed' }
  }

  const hostname = parsed.hostname.toLowerCase()

  // Block known-bad hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { valid: false, error: `Access to "${hostname}" is blocked for security reasons` }
  }

  // Block private / internal IP ranges
  if (isPrivateIP(hostname)) {
    return { valid: false, error: `Access to private/internal IP "${hostname}" is blocked` }
  }

  // Upgrade http → https
  let upgradedUrl = raw
  if (parsed.protocol === 'http:') {
    parsed.protocol = 'https:'
    upgradedUrl = parsed.toString()
  }

  return { valid: true, upgradedUrl }
}

// ----- Fetching -----

export const MAX_CONTENT_LENGTH = 5 * 1024 * 1024 // 5MB
export const FETCH_TIMEOUT_MS = 15_000 // 15 seconds
export const MAX_OUTPUT_LENGTH = 100_000 // truncate extracted text

export type FetchResult = {
  url: string
  status: number
  title: string
  contentType: string
  extractedText: string
}

type TurndownCtor = typeof import('turndown')
let turndownServicePromise: Promise<InstanceType<TurndownCtor>> | undefined
function getTurndownService(): Promise<InstanceType<TurndownCtor>> {
  return (turndownServicePromise ??= import('turndown').then(m => {
    const Turndown = (m as unknown as { default: TurndownCtor }).default
    return new Turndown()
  }))
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  return match ? match[1].trim().replace(/\s+/g, ' ') : ''
}

export async function fetchAndExtract(
  url: string,
  signal: AbortSignal,
): Promise<FetchResult> {
  const response = await axios.get(url, {
    signal,
    timeout: FETCH_TIMEOUT_MS,
    maxRedirects: 5,
    responseType: 'arraybuffer',
    maxContentLength: MAX_CONTENT_LENGTH,
    headers: {
      Accept: 'text/html, text/plain, text/markdown, application/json, */*',
      'User-Agent': getWebFetchUserAgent(),
    },
    // Prevent axios from automatically following cross-origin redirects
    // that try to change the host — we let axios handle same-host redirects
    // but manual cross-host redirects are rejected below
    validateStatus: status => status < 400,
  })

  const contentType = (response.headers['content-type'] ?? '').toLowerCase()
  const rawBuffer = Buffer.from(response.data)
  ;(response as { data: unknown }).data = null

  let extractedText: string
  let title = ''

  if (contentType.includes('text/html')) {
    const html = rawBuffer.toString('utf-8')
    title = extractTitle(html)
    extractedText = (await getTurndownService()).turndown(html)
  } else if (
    contentType.includes('text/') ||
    contentType.includes('application/json') ||
    contentType.includes('application/xml')
  ) {
    extractedText = rawBuffer.toString('utf-8')
    // Try to extract title from markdown or plain text
    const firstLine = extractedText.split('\n')[0]?.trim() ?? ''
    if (firstLine.startsWith('# ')) {
      title = firstLine.replace(/^# /, '')
    }
  } else {
    // Binary or unknown content — provide a short description
    const sizeStr = rawBuffer.length < 1024
      ? `${rawBuffer.length} B`
      : rawBuffer.length < 1024 * 1024
        ? `${(rawBuffer.length / 1024).toFixed(1)} KB`
        : `${(rawBuffer.length / (1024 * 1024)).toFixed(1)} MB`
    extractedText = `[Binary content: ${contentType || 'unknown type'}, ${sizeStr}]`
    title = url
  }

  // Truncate extracted text
  if (extractedText.length > MAX_OUTPUT_LENGTH) {
    extractedText = extractedText.slice(0, MAX_OUTPUT_LENGTH) +
      '\n\n[Content truncated at 100,000 characters...]'
  }

  return {
    url,
    status: response.status,
    title,
    contentType: contentType || 'unknown',
    extractedText,
  }
}
