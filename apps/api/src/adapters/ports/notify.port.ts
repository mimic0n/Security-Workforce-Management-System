export interface NotificationMessage {
  recipient: string;
  message: string;
  channel?: "SMS" | "ZALO" | "PUSH";
  payload?: Record<string, any>;
}

export const NOTIFY_PORT = Symbol("NOTIFY_PORT");

export interface NotifyPort {
  sendNotification(msg: NotificationMessage): Promise<void>;
}
