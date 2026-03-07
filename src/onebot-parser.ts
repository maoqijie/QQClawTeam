/**
 * OneBot v11 Event Parser
 * Parses raw OneBot v11 events from NapCat into normalized messages.
 */

export interface OneBotMessageEvent {
  post_type: 'message';
  message_type: 'group' | 'private';
  sub_type: string;
  message_id: number;
  self_id: number;
  user_id: number;
  group_id?: number;
  message: OneBotMessageSegment[];
  raw_message: string;
  sender: {
    user_id: number;
    nickname: string;
    card?: string;
    role?: string;
  };
  time: number;
  font?: number;
}

export interface OneBotMessageSegment {
  type: string;
  data: Record<string, string>;
}

export interface OneBotMetaEvent {
  post_type: 'meta_event';
  meta_event_type: string;
  self_id: number;
  time: number;
}

export interface OneBotNoticeEvent {
  post_type: 'notice';
  notice_type: string;
  self_id: number;
  time: number;
  group_id?: number;
  user_id?: number;
}

export type OneBotEvent = OneBotMessageEvent | OneBotMetaEvent | OneBotNoticeEvent;

export interface ParsedOneBotMessage {
  selfId: string;
  messageId: string;
  messageType: 'group' | 'private';
  groupId?: string;
  userId: string;
  nickname: string;
  card?: string;
  content: string;
  rawMessage: string;
  timestamp: string;
  mentionedUsers: string[];
  images: Array<{ url: string; file: string }>;
}

/**
 * Check if an event is a message event.
 */
export function isMessageEvent(event: unknown): event is OneBotMessageEvent {
  const e = event as Record<string, unknown>;
  return e?.post_type === 'message' && (e?.message_type === 'group' || e?.message_type === 'private');
}

/**
 * Check if an event is a meta event (heartbeat, lifecycle).
 */
export function isMetaEvent(event: unknown): event is OneBotMetaEvent {
  const e = event as Record<string, unknown>;
  return e?.post_type === 'meta_event';
}

/**
 * Extract text content from CQ-code / message segment array.
 */
export function extractTextContent(message: OneBotMessageSegment[]): string {
  return message
    .filter((seg) => seg.type === 'text')
    .map((seg) => seg.data.text || '')
    .join('')
    .trim();
}

/**
 * Extract mentioned user IDs from message segments.
 */
export function extractMentions(message: OneBotMessageSegment[]): string[] {
  return message
    .filter((seg) => seg.type === 'at')
    .map((seg) => seg.data.qq || '')
    .filter(Boolean);
}

/**
 * Extract image URLs from message segments.
 */
export function extractImages(message: OneBotMessageSegment[]): Array<{ url: string; file: string }> {
  return message
    .filter((seg) => seg.type === 'image')
    .map((seg) => ({
      url: seg.data.url || '',
      file: seg.data.file || '',
    }));
}

/**
 * Parse a raw OneBot v11 message event into a normalized structure.
 */
export function parseMessageEvent(event: OneBotMessageEvent): ParsedOneBotMessage {
  const content = extractTextContent(event.message);
  const mentionedUsers = extractMentions(event.message);
  const images = extractImages(event.message);

  return {
    selfId: String(event.self_id),
    messageId: String(event.message_id),
    messageType: event.message_type,
    groupId: event.group_id ? String(event.group_id) : undefined,
    userId: String(event.user_id),
    nickname: event.sender.card || event.sender.nickname,
    card: event.sender.card,
    content,
    rawMessage: event.raw_message,
    timestamp: new Date(event.time * 1000).toISOString(),
    mentionedUsers,
    images,
  };
}

/**
 * Check if a message is from one of the bot accounts.
 */
export function isBotMessage(event: OneBotMessageEvent, botAccounts: Set<string>): boolean {
  return botAccounts.has(String(event.user_id));
}

/**
 * Check if the bot itself is mentioned in the message.
 */
export function mentionsBot(event: OneBotMessageEvent, botAccounts: Set<string>): boolean {
  const mentions = extractMentions(event.message);
  return mentions.some((uid) => botAccounts.has(uid));
}
