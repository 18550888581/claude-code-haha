export const LOCAL_WEB_FETCH_TOOL_NAME = 'LocalWebFetch'

export const DESCRIPTION = `
- Fetches content from a specified URL using a local HTTP client (bypasses remote safety checks)
- Takes a URL and an optional prompt as input
- Fetches the URL content, converts HTML to markdown
- Returns the extracted text content
- Use this tool when you need to retrieve and analyze web content that may be blocked by remote safety checks

Usage notes:
  - The URL must be a fully-formed valid http:// or https:// URL
  - Internal/private IPs (127.0.0.1, localhost, 10.x, 192.168.x, etc.) are BLOCKED for security
  - file:// URLs are BLOCKED
  - Only fetch publicly accessible web pages — do NOT use for authenticated/private content
  - HTTP URLs will be automatically upgraded to HTTPS
  - Results may be summarized if the content is very large
  - 15-second timeout per request
  - Maximum response body size: 5MB
`.trim()
