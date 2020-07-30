export interface DetectedItem {
  area: number;
  confidence: number;
  label: string;
  x1: number;
  x2: number;
  y1: number;
  y2: number;
}

export type ItemLabel = string;

export interface TaskPayload {
  items: ItemLabel[];
  pushTokens: string[];
}
