export const start: (
  width: number,
  height: number,
  fps: number,
  bitrate: number,
  port: number
) => boolean;

export const stop: () => void;

export const isRunning: () => boolean;
