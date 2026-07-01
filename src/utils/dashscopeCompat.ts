/**
 * DashScope Anthropic-compatible interface compatibility adapter.
 *
 * DashScope's Anthropic-compatible endpoint (dashscope.aliyuncs.com/apps/anthropic)
 * does not support the full set of content block types that the official Anthropic
 * API supports. In particular, it rejects "image" and "document" content blocks
 * with: "Unexpected item type in content."
 *
 * This module:
 * 1. Detects DashScope base URLs
 * 2. Normalizes messages to convert unsupported content blocks
 * 3. Provides image-to-text conversion via DashScope's OpenAI-compatible vision API
 * 4. Includes debug logging for diagnosing API request structure issues
 */

import path from 'node:path'
import { logForDebugging } from './debug.js'
import { getFsImplementation } from './fsOperations.js'

// ---------------------------------------------------------------------------
// Provider detection
// ---------------------------------------------------------------------------

/** Check if the configured ANTHROPIC_BASE_URL targets DashScope's Anthropic-compatible endpoint. */
export function isDashScopeAnthropic(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) return false
  return baseUrl.includes('dashscope.aliyuncs.com/apps/anthropic')
}

/** Check if the model name indicates DeepSeek (which does not support image blocks). */
export function isDeepSeekModel(): boolean {
  const model = (
    process.env.ANTHROPIC_MODEL ||
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ||
    ''
  ).toLowerCase()
  return model.includes('deepseek')
}

/** Whether image blocks should be converted to text for the current configuration. */
export function shouldConvertImageBlocks(): boolean {
  return isDashScopeAnthropic() || isDeepSeekModel()
}

// ---------------------------------------------------------------------------
// MIME type helpers
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function getMimeTypeFromExt(ext: string): string {
  return MIME_MAP[ext.toLowerCase()] || 'image/png'
}

// ---------------------------------------------------------------------------
// Debug logging — request structure without secrets
// ---------------------------------------------------------------------------

interface DebugContentBlock {
  type: string
  text_preview?: string
  text_length?: number
  media_type?: string
  source_type?: string
  data_size?: number
  tool_use_id?: string
  tool_name?: string
  thinking_length?: number
  nested_types?: string[]
}

interface DebugMessage {
  role: string
  content_summary: string | DebugContentBlock[]
}

/**
 * Recursively summarize a single content block for debug logging.
 * Does NOT print base64 data or API keys.
 */
function summarizeContentBlock(block: any): DebugContentBlock {
  const info: DebugContentBlock = { type: block.type || 'unknown' }
  switch (block.type) {
    case 'text':
      info.text_preview = String(block.text || '').slice(0, 120)
      info.text_length = String(block.text || '').length
      break
    case 'image':
      info.media_type = block.source?.media_type
      info.source_type = block.source?.type
      info.data_size = block.source?.data?.length
      break
    case 'document':
      info.media_type = block.source?.media_type
      info.source_type = block.source?.type
      info.data_size = block.source?.data?.length
      break
    case 'tool_use':
      info.tool_name = block.name
      break
    case 'tool_result':
      info.tool_use_id = block.tool_use_id
      if (typeof block.content === 'string') {
        info.text_length = block.content.length
      } else if (Array.isArray(block.content)) {
        info.text_length = JSON.stringify(block.content).length
        info.nested_types = block.content.map((c: any) => c.type || 'unknown')
      }
      break
    case 'thinking':
    case 'redacted_thinking':
      info.thinking_length = String(block.thinking || block.data || '').length
      break
    default:
      break
  }
  return info
}

/**
 * Log the request structure that will be sent to the API.
 * Recursively shows nested content blocks (e.g. tool_result.content[]).
 * NEVER prints API keys or full base64 data.
 */
export function logRequestStructure(params: {
  model: string
  messages: Array<{ role: string; content: unknown }>
  max_tokens?: number
  tools_count?: number
}): void {
  const baseURL = process.env.ANTHROPIC_BASE_URL || '(default api.anthropic.com)'

  const debugMessages: DebugMessage[] = params.messages.map((msg) => {
    const content = msg.content
    if (typeof content === 'string') {
      return {
        role: msg.role,
        content_summary: `text (${content.length} chars)`,
      }
    }
    if (!Array.isArray(content)) {
      return { role: msg.role, content_summary: `unknown type: ${typeof content}` }
    }

    const blocks: DebugContentBlock[] = content.map((block: any) =>
      summarizeContentBlock(block),
    )

    return { role: msg.role, content_summary: blocks }
  })

  // Now also print per-block recursive debug info
  const lines: string[] = []
  for (let i = 0; i < params.messages.length; i++) {
    const msg = params.messages[i]
    const content = msg.content
    if (!Array.isArray(content)) continue

    for (let j = 0; j < (content as any[]).length; j++) {
      const block = (content as any[])[j]
      const type = block.type || 'unknown'
      lines.push(
        `[DASHSCOPE DEBUG]   messages[${i}].content[${j}].type = ${type}`,
      )

      // If it's a tool_result with array content, show nested types
      if (
        block.type === 'tool_result' &&
        Array.isArray(block.content)
      ) {
        for (let k = 0; k < block.content.length; k++) {
          const nested = block.content[k]
          const nestedType = nested?.type || 'unknown'
          lines.push(
            `[DASHSCOPE DEBUG]   messages[${i}].content[${j}].content[${k}].type = ${nestedType}`,
          )
          if (nestedType === 'image') {
            lines.push(
              `[DASHSCOPE DEBUG]   *** WARNING: image block found inside tool_result! ***`,
            )
          }
        }
      }
    }
  }

  console.error(
    `\n[DASHSCOPE DEBUG] ===== API Request Structure =====\n` +
      `[DASHSCOPE DEBUG] baseURL: ${baseURL}\n` +
      `[DASHSCOPE DEBUG] model: ${params.model}\n` +
      `[DASHSCOPE DEBUG] max_tokens: ${params.max_tokens ?? 'N/A'}\n` +
      `[DASHSCOPE DEBUG] tools_count: ${params.tools_count ?? 'N/A'}\n` +
      `[DASHSCOPE DEBUG] messages (${params.messages.length}):\n` +
      lines.join('\n') +
      `\n[DASHSCOPE DEBUG] Summary:\n` +
      debugMessages
        .map(
          (m, i) =>
            `[DASHSCOPE DEBUG]   [${i}] role=${m.role} content=${JSON.stringify(m.content_summary)}`,
        )
        .join('\n') +
      `\n[DASHSCOPE DEBUG] =================================\n`,
  )

  logForDebugging(
    `[DashScope] Request: model=${params.model} messages=${params.messages.length} baseURL=${baseURL}`,
  )
}

// ---------------------------------------------------------------------------
// Image analysis via DashScope OpenAI-compatible vision API
// ---------------------------------------------------------------------------

/** Get the base64 data from an image content block. */
function extractBase64FromImageBlock(block: any): { data: string; mediaType: string } | null {
  if (block.type !== 'image') return null
  if (block.source?.type !== 'base64') return null
  if (!block.source?.data) return null
  return {
    data: block.source.data,
    mediaType: block.source.media_type || 'image/png',
  }
}

/**
 * Call DashScope's OpenAI-compatible vision API to analyze an image.
 * Uses base64 data URL format.
 */
async function analyzeImageWithDashScopeVision(
  base64Data: string,
  mediaType: string,
  prompt?: string,
): Promise<string> {
  const apiKey =
    process.env.DASHSCOPE_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || ''
  const model = process.env.DASHSCOPE_VISION_MODEL || 'qwen-vl-plus'

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt || '请详细描述这张图片的内容。如果图片包含UI界面、代码、图表或文字，请尽可能详细地描述。',
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:${mediaType};base64,${base64Data}`,
            },
          },
        ],
      },
    ],
  }

  console.error(
    `[DASHSCOPE VISION] Calling vision API: model=${model} mediaType=${mediaType} dataSize=${base64Data.length}`,
  )

  const resp = await fetch(
    'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  )

  const data = await resp.json()

  if (!resp.ok) {
    const errMsg = `DashScope vision API failed: HTTP ${resp.status} — ${JSON.stringify(data)}`
    console.error(`[DASHSCOPE VISION] ERROR: ${errMsg}`)
    throw new Error(errMsg)
  }

  const text = data.choices?.[0]?.message?.content ?? ''
  console.error(
    `[DASHSCOPE VISION] Success: response length=${text.length} chars`,
  )
  return text
}

// ---------------------------------------------------------------------------
// Message normalization for DashScope Anthropic-compatible endpoint
// ---------------------------------------------------------------------------

/**
 * Check if a content block or any nested content contains unsupported types
 * (image/document). Recurses into tool_result.content arrays.
 */
export function hasUnsupportedContentBlocks(
  messages: Array<{ role: string; content: unknown }>,
): boolean {
  function scanContentArray(blocks: any[]): boolean {
    for (const block of blocks) {
      if (block.type === 'image' || block.type === 'document') {
        return true
      }
      // Recurse into tool_result.content
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        if (scanContentArray(block.content)) return true
      }
    }
    return false
  }

  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      if (scanContentArray(msg.content as any[])) return true
    }
  }
  return false
}

/**
 * Analyze a single image block and return a text description.
 * Handles both base64 data and URL-based image sources.
 */
async function convertImageBlockToText(block: any): Promise<string> {
  if (!isDashScopeAnthropic()) {
    // DeepSeek or unsupported model — plain placeholder
    return '[图片 — 当前模型不支持识图，无法查看图片内容。请切换到 Qwen/DashScope 模式。]'
  }

  const imageData = extractBase64FromImageBlock(block)
  if (imageData) {
    try {
      console.error(
        `[DASHSCOPE] Analyzing image via vision API (dataSize=${imageData.data.length}, mediaType=${imageData.mediaType})`,
      )
      const analysis = await analyzeImageWithDashScopeVision(
        imageData.data,
        imageData.mediaType,
      )
      return `[图片分析结果]\n${analysis}`
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      console.error(`[DASHSCOPE] Image analysis failed: ${errorText}`)
      return `[图片无法分析: ${errorText}]`
    }
  }

  // Non-base64 image (URL-based) — can't analyze
  console.error(
    `[DASHSCOPE] Skipping non-base64 image block (source type: ${block.source?.type || 'none'})`,
  )
  return '[图片 — 图片源非 base64 格式，无法通过视觉 API 分析。请使用其他方式描述图片内容。]'
}

/**
 * Process a single content block. Returns the block unchanged if no conversion
 * is needed, or a replacement text block if the original was image/document.
 *
 * Recurses into tool_result.content arrays.
 */
async function processContentBlock(
  block: any,
  path: string,
): Promise<any> {
  switch (block.type) {
    case 'image': {
      console.error(`[DASHSCOPE] Intercepting ${path}.type = image`)
      const text = await convertImageBlockToText(block)
      return { type: 'text', text }
    }

    case 'document': {
      console.error(`[DASHSCOPE] Intercepting ${path}.type = document`)
      return {
        type: 'text',
        text: '[文档 — 当前接口不支持直接发送文档，文档内容已被省略]',
      }
    }

    case 'tool_result': {
      // Contains nested content blocks — must recurse
      if (typeof block.content === 'string') {
        // String content is fine, pass through
        return block
      }

      if (!Array.isArray(block.content)) {
        return block
      }

      // Check if any nested block is image/document
      const hasMediaNested = block.content.some(
        (c: any) => c.type === 'image' || c.type === 'document',
      )
      if (!hasMediaNested) {
        return block
      }

      console.error(
        `[DASHSCOPE] Found media blocks inside ${path}.content (tool_result) — processing recursively`,
      )

      // Process nested content blocks
      const newNestedContent: any[] = []
      for (let i = 0; i < block.content.length; i++) {
        const nested = block.content[i]
        const nestedPath = `${path}.content[${i}]`
        console.error(
          `[DASHSCOPE]   ${nestedPath}.type = ${nested.type || 'unknown'}`,
        )
        const processed = await processContentBlock(nested, nestedPath)
        newNestedContent.push(processed)
      }

      return {
        ...block,
        content: newNestedContent,
      }
    }

    default:
      // text, tool_use, thinking, redacted_thinking, etc. — pass through
      return block
  }
}

/**
 * Process an array of content blocks, converting any image/document blocks
 * to text. Recursively handles tool_result.content arrays.
 */
async function processContentArray(
  blocks: any[],
  parentPath: string,
): Promise<any[]> {
  const result: any[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const blockPath = `${parentPath}[${i}]`
    const blockType = block.type || 'unknown'

    // Log the block type for debugging
    if (
      blockType === 'image' ||
      blockType === 'document' ||
      blockType === 'tool_result'
    ) {
      console.error(
        `[DASHSCOPE DEBUG] ${blockPath}.type = ${blockType}`,
      )
      if (blockType === 'tool_result' && Array.isArray(block.content)) {
        for (let j = 0; j < block.content.length; j++) {
          const nested = block.content[j]
          console.error(
            `[DASHSCOPE DEBUG] ${blockPath}.content[${j}].type = ${nested.type || 'unknown'}`,
          )
        }
      }
    }

    const processed = await processContentBlock(block, blockPath)
    result.push(processed)
  }

  return result
}

/**
 * Normalize messages for DashScope Anthropic-compatible endpoint.
 *
 * This function recursively scans ALL content blocks including those nested
 * inside tool_result.content arrays. It ensures that no type=image or
 * type=document block reaches the DashScope API.
 *
 * Conversion rules:
 * - `image` blocks (DashScope) → analyzed via vision API → `text` blocks
 * - `image` blocks (DeepSeek) → placeholder `text` blocks
 * - `document` blocks → placeholder `text` blocks
 * - String content → `[{ type: "text", text: "..." }]`
 * - `tool_result` with nested media → recursively processed, preserving
 *   tool_use_id and is_error
 */
export async function normalizeMessagesForDashScope(
  messages: any[],
): Promise<any[]> {
  const result: any[] = []
  let convertedCount = 0

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex]
    const content = msg.content
    const msgPath = `messages[${msgIndex}]`

    // String content → wrap in text block
    if (typeof content === 'string') {
      result.push({
        ...msg,
        content: [{ type: 'text', text: content }],
      })
      continue
    }

    if (!Array.isArray(content)) {
      result.push(msg)
      continue
    }

    // Check if any block at any depth is image/document
    const hasMedia = hasUnsupportedContentBlocks([msg])
    if (!hasMedia) {
      result.push(msg)
      continue
    }

    // Process content array recursively
    console.error(
      `[DASHSCOPE] Processing ${msgPath} (role=${msg.role}) — contains unsupported blocks`,
    )

    const newContent = await processContentArray(
      content as any[],
      `${msgPath}.content`,
    )

    result.push({
      ...msg,
      content: newContent,
    })
    convertedCount++
  }

  if (convertedCount > 0) {
    console.error(
      `[DASHSCOPE] Normalization complete: ${convertedCount} message(s) modified`,
    )
  }

  return result
}

// ---------------------------------------------------------------------------
// Image path → Anthropic block conversion (for when the original path is known)
// ---------------------------------------------------------------------------

/**
 * Read a local image file and convert it into an Anthropic-compatible image block.
 * Used when the user provides a local image path and we need to create the block
 * BEFORE normalization.
 */
export function imagePathToAnthropicBlock(filePath: string): {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
} {
  const fsImpl = getFsImplementation()

  let buffer: Buffer
  try {
    buffer = fsImpl.readFileBytesSync(filePath)
  } catch (err) {
    throw new Error(`无法读取图片文件: ${filePath} — ${err instanceof Error ? err.message : String(err)}`)
  }

  if (!buffer || buffer.length === 0) {
    throw new Error(`图片文件为空: ${filePath}`)
  }

  const ext = path.extname(filePath).toLowerCase()
  const mediaType = getMimeTypeFromExt(ext)

  // 10 MB limit
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error(
      `图片文件过大 (${(buffer.length / 1024 / 1024).toFixed(1)}MB)，最大支持 10MB: ${filePath}`,
    )
  }

  console.error(
    `[DASHSCOPE] Read image: path=${filePath} size=${buffer.length} mediaType=${mediaType}`,
  )

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mediaType,
      data: buffer.toString('base64'),
    },
  }
}

// ---------------------------------------------------------------------------
// Direct image analysis tool (方案 B fallback)
// ---------------------------------------------------------------------------

/**
 * Analyze a local image file using DashScope's vision API and return a text description.
 * This is the "方案 B" fallback — it bypasses the Anthropic-compatible endpoint entirely
 * for image analysis.
 */
export async function analyzeLocalImageWithVision(
  imagePath: string,
  prompt?: string,
): Promise<string> {
  const fsImpl = getFsImplementation()

  let buffer: Buffer
  try {
    buffer = fsImpl.readFileBytesSync(imagePath)
  } catch (err) {
    throw new Error(
      `图片路径不存在或无法读取: ${imagePath}\n` +
        `错误: ${err instanceof Error ? err.message : String(err)}\n\n` +
        `请检查图片路径是否正确，并确保文件存在。`,
    )
  }

  if (!buffer || buffer.length === 0) {
    throw new Error(`图片文件为空: ${imagePath}`)
  }

  // 10 MB limit
  if (buffer.length > 10 * 1024 * 1024) {
    throw new Error(
      `图片文件过大 (${(buffer.length / 1024 / 1024).toFixed(1)}MB)，最大支持 10MB: ${imagePath}`,
    )
  }

  const ext = path.extname(imagePath).toLowerCase()
  const mediaType = getMimeTypeFromExt(ext)
  const base64Data = buffer.toString('base64')

  console.error(
    `[DASHSCOPE VISION] Analyzing local image: path=${imagePath} size=${buffer.length} mediaType=${mediaType}`,
  )

  return analyzeImageWithDashScopeVision(base64Data, mediaType, prompt)
}

// ---------------------------------------------------------------------------
// Enhanced image block analysis (handles CLI drag-and-paste / [Image #1])
// ---------------------------------------------------------------------------

/**
 * Analyze a single image content block using DashScope's vision API.
 *
 * Supports multiple image block formats:
 * 1. base64 data (from CLI drag-and-paste / [Image #1]):
 *    { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
 * 2. File path in block metadata:
 *    { type: "image", source: { ..., file_path: "/path/to/img.png" } }
 * 3. URL-based images (limited support — returns placeholder)
 * 4. Unrecognized formats — returns a descriptive placeholder
 *
 * @param block - The image content block to analyze
 * @param prompt - Optional custom prompt for the vision API
 * @returns A text description of the image
 */
export async function analyzeImageBlockWithDashScopeVision(
  block: any,
  prompt?: string,
): Promise<string> {
  // ── DeepSeek guard: don't call any vision API ──
  if (!isDashScopeAnthropic()) {
    return '[当前模型不支持图片识别。请切换到 Qwen/DashScope 模式，或使用图片路径 + DashScope vision tool。]'
  }

  // ── Case 1: base64 image block (from CLI drag-and-paste / [Image #1]) ──
  const imageData = extractBase64FromImageBlock(block)
  if (imageData) {
    try {
      console.error(
        `[DASHSCOPE VISION] Analyzing base64 image block: mediaType=${imageData.mediaType} dataSize=${imageData.data.length}`,
      )
      const analysis = await analyzeImageWithDashScopeVision(
        imageData.data,
        imageData.mediaType,
        prompt,
      )
      return `[图片识别结果]\n${analysis}`
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      console.error(`[DASHSCOPE VISION] Base64 image analysis failed: ${errorText}`)
      return `[图片无法分析: ${errorText}]`
    }
  }

  // ── Case 2: File path in block metadata ──
  const filePath =
    block.source?.file_path ||
    block.source?.path ||
    block.filePath ||
    block.path
  if (filePath && typeof filePath === 'string') {
    try {
      const fileName = path.basename(filePath)
      console.error(
        `[DASHSCOPE VISION] Analyzing image via file path: ${filePath}`,
      )
      const analysis = await analyzeLocalImageWithVision(filePath, prompt)
      return `[图片识别结果：${fileName}]\n${analysis}`
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err)
      console.error(
        `[DASHSCOPE VISION] File path image analysis failed: ${errorText}`,
      )
      return `[图片无法分析: ${errorText}]`
    }
  }

  // ── Case 3: URL-based image (limited support) ──
  if (block.source?.type === 'url' && block.source?.url) {
    console.error(
      `[DASHSCOPE VISION] Cannot analyze URL-based image: ${block.source.url}`,
    )
    return '[图片附件已被拦截，但无法识别：URL 类型的图片源不支持通过 DashScope Vision API 分析。请下载图片后使用本地路径或直接粘贴图片。]'
  }

  // ── Case 4: Unrecognized image block ──
  console.error(
    `[DASHSCOPE VISION] Unrecognized image block format: source.type=${block.source?.type || 'none'}`,
  )
  return '[图片附件已被拦截，但无法识别：无法解析 image block source。请尝试使用图片路径或直接粘贴图片。]'
}

// ---------------------------------------------------------------------------
// Deep recursive normalization — final sweep before API request
// ---------------------------------------------------------------------------

/**
 * Ultra-deep recursive content block normalizer.
 *
 * Scans content arrays at ANY nesting depth, including:
 * - message.content[]
 * - tool_result.content[]
 * - tool_result.content[].content[] (double nesting, e.g. nested tool results)
 * - Any arbitrary nesting of content arrays
 *
 * This is a DEFENSE-IN-DEPTH sweep. Even if normalizeMessagesForDashScope
 * misses a nested image/document block, this function will catch it.
 */
async function deepNormalizeContentBlocks(
  blocks: any[],
  path: string,
): Promise<any[]> {
  const result: any[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const blockPath = `${path}[${i}]`

    if (!block || typeof block !== 'object') {
      result.push(block)
      continue
    }

    switch (block.type) {
      case 'image': {
        console.error(
          `[DASHSCOPE] FINAL SWEEP: Converting image block at ${blockPath}`,
        )
        const text = await analyzeImageBlockWithDashScopeVision(block)
        result.push({ type: 'text', text })
        break
      }

      case 'document': {
        console.error(
          `[DASHSCOPE] FINAL SWEEP: Converting document block at ${blockPath}`,
        )
        result.push({
          type: 'text',
          text: '[文档附件已被 DashScope 适配层拦截。当前接口不支持 document block，请改用文件读取工具或转为文本后再处理。]',
        })
        break
      }

      case 'tool_result': {
        // Process nested content if it's an array
        if (Array.isArray(block.content)) {
          const hasMedia = block.content.some(
            (c: any) => c?.type === 'image' || c?.type === 'document',
          )
          if (hasMedia) {
            console.error(
              `[DASHSCOPE] FINAL SWEEP: Processing nested content inside ${blockPath}.content`,
            )
            const newNested = await deepNormalizeContentBlocks(
              block.content,
              `${blockPath}.content`,
            )
            result.push({ ...block, content: newNested })
            break
          }
        }

        // Also scan for any other array-typed property that might contain content blocks
        const clone: any = { ...block }
        let modified = false
        for (const key of Object.keys(clone)) {
          if (
            key !== 'type' &&
            key !== 'tool_use_id' &&
            key !== 'is_error' &&
            Array.isArray(clone[key]) &&
            clone[key].length > 0 &&
            clone[key].some(
              (c: any) => c?.type === 'image' || c?.type === 'document',
            )
          ) {
            console.error(
              `[DASHSCOPE] FINAL SWEEP: Processing nested content inside ${blockPath}.${key}`,
            )
            clone[key] = await deepNormalizeContentBlocks(
              clone[key],
              `${blockPath}.${key}`,
            )
            modified = true
          }
        }
        result.push(modified ? clone : block)
        break
      }

      default: {
        // For any other block type, check ALL object properties for nested
        // content arrays that might contain image/document blocks
        const clone: any = { ...block }
        let modified = false
        for (const key of Object.keys(clone)) {
          if (
            Array.isArray(clone[key]) &&
            clone[key].length > 0 &&
            clone[key].some(
              (c: any) => c?.type === 'image' || c?.type === 'document',
            )
          ) {
            console.error(
              `[DASHSCOPE] FINAL SWEEP: Processing nested content inside ${blockPath}.${key} (type=${block.type})`,
            )
            clone[key] = await deepNormalizeContentBlocks(
              clone[key],
              `${blockPath}.${key}`,
            )
            modified = true
          }
        }
        result.push(modified ? clone : block)
        break
      }
    }
  }

  return result
}

/**
 * Final-sweep normalization for DashScope / DeepSeek Anthropic-compatible endpoints.
 *
 * This is the LAST LINE OF DEFENSE before the API request. It recursively scans
 * ALL content blocks at ANY nesting depth and converts any remaining
 * type=image or type=document blocks to text.
 *
 * Rules:
 * - DashScope mode: image blocks → analyzed via DashScope vision API → text
 * - DeepSeek mode: image blocks → placeholder text (no vision API available)
 * - Document blocks (any mode) → placeholder text
 *
 * This function should be called at the closest point to the API request,
 * AFTER all other message processing has completed.
 */
export async function normalizeUnsupportedBlocksBeforeDashScopeRequest(
  messages: any[],
): Promise<any[]> {
  if (!shouldConvertImageBlocks()) {
    return messages
  }

  let modifiedCount = 0
  const result: any[] = []

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex]
    const msgPath = `messages[${msgIndex}]`
    const content = msg.content

    if (!Array.isArray(content)) {
      // String content or other shapes — check if it needs wrapping
      result.push(msg)
      continue
    }

    // Check if this message has unsupported blocks at any depth
    const hasUnsupported = content.some((block: any) => {
      if (!block || typeof block !== 'object') return false
      if (block.type === 'image' || block.type === 'document') return true
      // Check nested content arrays
      for (const key of Object.keys(block)) {
        if (
          Array.isArray(block[key]) &&
          block[key].some(
            (c: any) => c?.type === 'image' || c?.type === 'document',
          )
        ) {
          return true
        }
      }
      return false
    })

    if (!hasUnsupported) {
      result.push(msg)
      continue
    }

    console.error(
      `[DASHSCOPE] FINAL SWEEP: Processing ${msgPath} (role=${msg.role})`,
    )

    const newContent = await deepNormalizeContentBlocks(
      content,
      `${msgPath}.content`,
    )

    result.push({ ...msg, content: newContent })
    modifiedCount++
  }

  if (modifiedCount > 0) {
    console.error(
      `[DASHSCOPE] FINAL SWEEP complete: ${modifiedCount} message(s) cleaned`,
    )
  }

  return result
}

// ---------------------------------------------------------------------------
// Final assertion — prevent unsupported blocks from reaching DashScope
// ---------------------------------------------------------------------------

/**
 * Assert that the final request body contains NO type=image or type=document
 * content blocks at ANY depth.
 *
 * If any unsupported blocks are found, this function throws IMMEDIATELY with
 * detailed path information, preventing the request from reaching DashScope
 * and producing the cryptic "Unexpected item type in content" error.
 *
 * Call this RIGHT BEFORE sending the API request.
 */
export function assertNoUnsupportedContentBlocksForDashScope(
  messages: any[],
  context: string = 'API request',
): void {
  const violations: string[] = []

  function scanBlocks(blocks: any[], path: string): void {
    if (!Array.isArray(blocks)) return
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i]
      if (!block || typeof block !== 'object') continue
      const blockPath = `${path}[${i}]`

      if (block.type === 'image' || block.type === 'document') {
        violations.push(`${blockPath}.type = ${block.type}`)
      }

      // Recurse into any array-typed property
      for (const key of Object.keys(block)) {
        if (Array.isArray(block[key])) {
          scanBlocks(block[key], `${blockPath}.${key}`)
        }
      }
    }
  }

  for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
    const msg = messages[msgIndex]
    const msgPath = `messages[${msgIndex}]`
    if (Array.isArray(msg.content)) {
      scanBlocks(msg.content, `${msgPath}.content`)
    }
  }

  if (violations.length > 0) {
    const errorLines = [
      '',
      '===============================================================',
      '  DASHSCOPE ASSERTION FAILED',
      `  Context: ${context}`,
      '  Unsupported content blocks found in request body:',
      ...violations.map(v => `    - ${v}`),
      '',
      '  These blocks would cause DashScope to return:',
      '    API Error: 400 InvalidParameter "Unexpected item type in content."',
      '',
      '  The request has been BLOCKED locally to prevent this error.',
      '  Check the normalization pipeline for gaps.',
      '===============================================================',
    ]
    const errorMessage = errorLines.join('\n')
    console.error(errorMessage)
    throw new Error(
      `DashScope compatibility assertion failed: found ${violations.length} unsupported content block(s). ` +
        violations.join('; '),
    )
  }
}

// ---------------------------------------------------------------------------
// Combined: normalize + assert in one call (for use in paramsFromContext)
// ---------------------------------------------------------------------------

/**
 * Synchronous version of the assertion — safe to call inside paramsFromContext.
 * Use this in contexts where async/await is not available.
 *
 * IMPORTANT: This should be called AFTER normalizeUnsupportedBlocksBeforeDashScopeRequest
 * has completed. It only checks and throws — it does NOT modify the messages.
 */
export function assertNoUnsupportedBlocksSync(
  messages: any[],
  context?: string,
): void {
  if (!shouldConvertImageBlocks()) return
  assertNoUnsupportedContentBlocksForDashScope(messages, context)
}
