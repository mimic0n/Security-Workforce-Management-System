export const FIRE_ALARM_PORT = Symbol("FIRE_ALARM_PORT");

export interface FireAlarmPort {
  triggerAlarm(zone?: string): Promise<any>;
  clearAlarm(): Promise<any>;
}
