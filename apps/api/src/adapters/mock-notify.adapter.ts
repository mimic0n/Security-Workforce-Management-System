import { Injectable, Inject } from "@nestjs/common";
import { NotifyPort, NotificationMessage } from "./ports/notify.port.js";
import { CLOCK_TOKEN, type Clock } from "../core/clock/clock.interface.js";

export interface SentNotificationRecord extends NotificationMessage {
  timestamp: Date;
}

@Injectable()
export class MockNotifyAdapter implements NotifyPort {
  private readonly sentNotifications: SentNotificationRecord[] = [];

  constructor(@Inject(CLOCK_TOKEN) private readonly clock: Clock) {}

  async sendNotification(msg: NotificationMessage): Promise<void> {
    this.sentNotifications.push({
      ...msg,
      timestamp: this.clock.now()
    });
  }

  getSentNotifications(): SentNotificationRecord[] {
    return [...this.sentNotifications];
  }

  clear(): void {
    this.sentNotifications.length = 0;
  }
}
