export interface CameraAiEvent {
  postId: string;
  confidence?: number;
  atTime?: Date;
}

export const CAMERA_AI_PORT = Symbol("CAMERA_AI_PORT");

export interface CameraAiPort {
  reportMotion(event: CameraAiEvent): Promise<any>;
}
