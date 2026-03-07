import { describe, it, expect } from 'vitest';
import {
  isMessageEvent,
  isMetaEvent,
  parseMessageEvent,
  extractTextContent,
  extractMentions,
  extractImages,
  isBotMessage,
  mentionsBot,
  type OneBotMessageEvent,
  type OneBotMessageSegment,
} from './onebot-parser.js';

describe('onebot-parser', () => {
  const makeGroupMsgEvent = (overrides: Partial<OneBotMessageEvent> = {}): OneBotMessageEvent => ({
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: 12345,
    self_id: 100001,
    user_id: 200001,
    group_id: 300001,
    message: [{ type: 'text', data: { text: '你好世界' } }],
    raw_message: '你好世界',
    sender: { user_id: 200001, nickname: '测试用户', card: '群名片' },
    time: 1709827200,
    ...overrides,
  });

  describe('isMessageEvent', () => {
    it('identifies group message events', () => {
      expect(isMessageEvent(makeGroupMsgEvent())).toBe(true);
    });

    it('identifies private message events', () => {
      expect(isMessageEvent({ post_type: 'message', message_type: 'private' })).toBe(true);
    });

    it('rejects non-message events', () => {
      expect(isMessageEvent({ post_type: 'meta_event' })).toBe(false);
      expect(isMessageEvent({ post_type: 'notice' })).toBe(false);
      expect(isMessageEvent(null)).toBe(false);
      expect(isMessageEvent(undefined)).toBe(false);
    });
  });

  describe('isMetaEvent', () => {
    it('identifies meta events', () => {
      expect(isMetaEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat' })).toBe(true);
    });

    it('rejects non-meta events', () => {
      expect(isMetaEvent(makeGroupMsgEvent())).toBe(false);
    });
  });

  describe('extractTextContent', () => {
    it('extracts text from single text segment', () => {
      const segments = [{ type: 'text', data: { text: 'hello' } }];
      expect(extractTextContent(segments)).toBe('hello');
    });

    it('concatenates multiple text segments', () => {
      const segments: OneBotMessageSegment[] = [
        { type: 'text', data: { text: 'hello ' } },
        { type: 'at', data: { qq: '123' } },
        { type: 'text', data: { text: 'world' } },
      ];
      expect(extractTextContent(segments)).toBe('hello world');
    });

    it('returns empty for no text segments', () => {
      const segments = [{ type: 'image', data: { url: 'http://example.com' } }];
      expect(extractTextContent(segments)).toBe('');
    });
  });

  describe('extractMentions', () => {
    it('extracts mentioned user IDs', () => {
      const segments: OneBotMessageSegment[] = [
        { type: 'at', data: { qq: '100001' } },
        { type: 'text', data: { text: ' 你好' } },
        { type: 'at', data: { qq: '100002' } },
      ];
      expect(extractMentions(segments)).toEqual(['100001', '100002']);
    });

    it('returns empty when no mentions', () => {
      const segments = [{ type: 'text', data: { text: 'hello' } }];
      expect(extractMentions(segments)).toEqual([]);
    });
  });

  describe('extractImages', () => {
    it('extracts image URLs', () => {
      const segments: OneBotMessageSegment[] = [
        { type: 'image', data: { url: 'http://img.com/1.jpg', file: '1.jpg' } },
        { type: 'text', data: { text: 'look' } },
      ];
      expect(extractImages(segments)).toEqual([{ url: 'http://img.com/1.jpg', file: '1.jpg' }]);
    });
  });

  describe('parseMessageEvent', () => {
    it('parses group message correctly', () => {
      const event = makeGroupMsgEvent();
      const parsed = parseMessageEvent(event);

      expect(parsed.selfId).toBe('100001');
      expect(parsed.messageId).toBe('12345');
      expect(parsed.messageType).toBe('group');
      expect(parsed.groupId).toBe('300001');
      expect(parsed.userId).toBe('200001');
      expect(parsed.nickname).toBe('群名片');
      expect(parsed.content).toBe('你好世界');
      expect(parsed.timestamp).toBeTruthy();
    });

    it('uses nickname when card is empty', () => {
      const event = makeGroupMsgEvent({
        sender: { user_id: 200001, nickname: 'nick', card: '' },
      });
      // card is empty string so nickname should be used (empty string is falsy)
      const parsed = parseMessageEvent(event);
      expect(parsed.nickname).toBe('nick');
    });

    it('parses private message without groupId', () => {
      const event: OneBotMessageEvent = {
        ...makeGroupMsgEvent(),
        message_type: 'private',
        group_id: undefined,
      };
      const parsed = parseMessageEvent(event);
      expect(parsed.messageType).toBe('private');
      expect(parsed.groupId).toBeUndefined();
    });

    it('parses message with @mentions', () => {
      const event = makeGroupMsgEvent({
        message: [
          { type: 'at', data: { qq: '100001' } },
          { type: 'text', data: { text: ' 帮我查一下' } },
        ],
        raw_message: '[CQ:at,qq=100001] 帮我查一下',
      });
      const parsed = parseMessageEvent(event);
      expect(parsed.content).toBe('帮我查一下');
      expect(parsed.mentionedUsers).toEqual(['100001']);
    });
  });

  describe('isBotMessage', () => {
    it('returns true when sender is a bot account', () => {
      const botAccounts = new Set(['200001', '200002']);
      const event = makeGroupMsgEvent({ user_id: 200001 });
      expect(isBotMessage(event, botAccounts)).toBe(true);
    });

    it('returns false when sender is not a bot', () => {
      const botAccounts = new Set(['100001']);
      const event = makeGroupMsgEvent({ user_id: 200001 });
      expect(isBotMessage(event, botAccounts)).toBe(false);
    });
  });

  describe('mentionsBot', () => {
    it('returns true when bot is mentioned', () => {
      const botAccounts = new Set(['100001']);
      const event = makeGroupMsgEvent({
        message: [
          { type: 'at', data: { qq: '100001' } },
          { type: 'text', data: { text: ' hello' } },
        ],
      });
      expect(mentionsBot(event, botAccounts)).toBe(true);
    });

    it('returns false when bot is not mentioned', () => {
      const botAccounts = new Set(['100001']);
      const event = makeGroupMsgEvent({
        message: [{ type: 'text', data: { text: 'hello' } }],
      });
      expect(mentionsBot(event, botAccounts)).toBe(false);
    });
  });
});
