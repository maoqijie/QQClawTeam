/**
 * OneBot v11 API Client for NapCat
 * Each NapCat instance has its own connector for sending messages via OneBot API.
 */

import { logger } from './logger.js';

export interface OneBotMessageSegment {
  type: string;
  data: Record<string, string | number | boolean>;
}

export interface OneBotResponse {
  status: string;
  retcode: number;
  data: unknown;
  message?: string;
}

export interface OneBotGroupInfo {
  group_id: number;
  group_name: string;
  member_count: number;
  max_member_count: number;
}

export interface OneBotGroupMember {
  group_id: number;
  user_id: number;
  nickname: string;
  card: string;
  role: 'owner' | 'admin' | 'member';
}

export class NapCatConnector {
  private readonly baseUrl: string;

  constructor(
    public readonly qqAccount: string,
    private readonly httpPort: number,
    private readonly host: string = '127.0.0.1',
  ) {
    this.baseUrl = `http://${host}:${httpPort}`;
  }

  private async callApi(action: string, params: Record<string, unknown> = {}): Promise<OneBotResponse> {
    const url = `${this.baseUrl}/${action}`;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await response.json() as OneBotResponse;
      if (data.retcode !== 0) {
        logger.warn({ action, params, retcode: data.retcode, message: data.message }, 'OneBot API non-zero retcode');
      }
      return data;
    } catch (err) {
      logger.error({ action, params, err }, 'OneBot API call failed');
      throw err;
    }
  }

  async sendGroupMsg(groupId: string, message: string): Promise<OneBotResponse> {
    return this.callApi('send_group_msg', {
      group_id: Number(groupId),
      message: [{ type: 'text', data: { text: message } }],
    });
  }

  async sendGroupMsgSegments(
    groupId: string,
    message: OneBotMessageSegment[],
  ): Promise<OneBotResponse> {
    return this.callApi('send_group_msg', {
      group_id: Number(groupId),
      message,
    });
  }

  async sendPrivateMsg(userId: string, message: string): Promise<OneBotResponse> {
    return this.callApi('send_private_msg', {
      user_id: Number(userId),
      message: [{ type: 'text', data: { text: message } }],
    });
  }

  async sendPrivateMsgSegments(
    userId: string,
    message: OneBotMessageSegment[],
  ): Promise<OneBotResponse> {
    return this.callApi('send_private_msg', {
      user_id: Number(userId),
      message,
    });
  }

  async sendPrivateImageBase64(
    userId: string,
    base64: string,
  ): Promise<OneBotResponse> {
    return this.sendPrivateMsgSegments(userId, [
      {
        type: 'image',
        data: {
          file: `base64://${base64}`,
        },
      },
    ]);
  }

  async getGroupList(): Promise<OneBotGroupInfo[]> {
    const resp = await this.callApi('get_group_list');
    return (resp.data as OneBotGroupInfo[]) || [];
  }

  async getGroupMemberList(groupId: string): Promise<OneBotGroupMember[]> {
    const resp = await this.callApi('get_group_member_list', {
      group_id: Number(groupId),
    });
    return (resp.data as OneBotGroupMember[]) || [];
  }

  async getLoginInfo(): Promise<{ user_id: number; nickname: string }> {
    const resp = await this.callApi('get_login_info');
    return resp.data as { user_id: number; nickname: string };
  }

  async setGroupCard(groupId: string, userId: string, card: string): Promise<OneBotResponse> {
    return this.callApi('set_group_card', {
      group_id: Number(groupId),
      user_id: Number(userId),
      card,
    });
  }

  async setGroupName(groupId: string, groupName: string): Promise<OneBotResponse> {
    return this.callApi('set_group_name', {
      group_id: Number(groupId),
      group_name: groupName,
    });
  }

  async isAlive(): Promise<boolean> {
    try {
      await this.getLoginInfo();
      return true;
    } catch {
      return false;
    }
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }
}
