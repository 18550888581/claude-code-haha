import type { AssistantMessage, ProgressMessage, UserMessage, AttachmentMessage, SystemMessage } from '../../types/message.js'
import type { Output } from './LocalWebFetchTool.js'

export function getToolUseSummary(input: { url: string }): string {
  try {
    const hostname = new URL(input.url).hostname
    return hostname
  } catch {
    return 'web page'
  }
}

export function renderToolUseMessage(
  input: { url: string },
  _toolUseID: string,
  _assistantMessage: AssistantMessage,
): (UserMessage | AttachmentMessage | SystemMessage)[] {
  const hostname = getToolUseSummary(input)
  return [
    {
      type: 'user',
      message: {
        role: 'user',
        content: `Fetching ${hostname} via local web fetch...`,
      },
    },
  ]
}

export function renderToolUseProgressMessage(
  input: { url: string },
  _toolUseID: string,
  _progressMessage: ProgressMessage,
): (UserMessage | AttachmentMessage | SystemMessage)[] {
  const hostname = getToolUseSummary(input)
  return [
    {
      type: 'user',
      message: {
        role: 'user',
        content: `Fetching ${hostname}...`,
      },
    },
  ]
}

export function renderToolResultMessage(
  output: Output,
  _toolUseID: string,
  _assistantMessage: AssistantMessage,
): (UserMessage | AttachmentMessage | SystemMessage)[] {
  const statusLine = output.status ? `HTTP ${output.status}` : 'Failed'
  const header = output.title ? `${statusLine} — ${output.title}` : statusLine

  const textPreview = output.extractedText.length > 500
    ? output.extractedText.slice(0, 500) + '...'
    : output.extractedText

  return [
    {
      type: 'user',
      message: {
        role: 'user',
        content: `**${header}**\n\n${textPreview}`,
      },
    },
  ]
}
