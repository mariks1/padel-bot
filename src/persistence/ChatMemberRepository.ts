import type { User } from "grammy/types";

export interface ChatMemberRepository {
  save(chatId: number, user: User): void;
  remove(chatId: number, userId: number): void;
  list(chatId: number): User[];
  acquireAllCooldown(chatId: number, now: number, durationMs: number): number;
  releaseAllCooldown(chatId: number, claimedAt: number): void;
}

export class InMemoryChatMemberRepository implements ChatMemberRepository {
  private readonly chats = new Map<number, Map<number, User>>();
  private readonly allCooldowns = new Map<number, number>();

  save(chatId: number, user: User): void {
    if (user.is_bot) return;
    const members = this.chats.get(chatId) ?? new Map<number, User>();
    members.set(user.id, { ...user });
    this.chats.set(chatId, members);
  }

  remove(chatId: number, userId: number): void {
    this.chats.get(chatId)?.delete(userId);
  }

  list(chatId: number): User[] {
    return [...(this.chats.get(chatId)?.values() ?? [])];
  }

  acquireAllCooldown(chatId: number, now: number, durationMs: number): number {
    const claimedAt = this.allCooldowns.get(chatId);
    if (claimedAt !== undefined && now < claimedAt + durationMs) return claimedAt + durationMs - now;
    this.allCooldowns.set(chatId, now);
    return 0;
  }

  releaseAllCooldown(chatId: number, claimedAt: number): void {
    if (this.allCooldowns.get(chatId) === claimedAt) this.allCooldowns.delete(chatId);
  }
}
