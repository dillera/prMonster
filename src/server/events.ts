// In-memory SSE broadcaster for scan progress (DESIGN.md §5 /api/events).

import type { ScanEvent } from "../shared/types.js";

type Subscriber = (event: ScanEvent) => void;

const subscribers = new Set<Subscriber>();

/**
 * Events of the scan currently running, replayed to a client that connects
 * mid-scan. A blind "last N" buffer replayed events from a finished job as
 * though they were live, so the dashboard showed a phantom scan in progress.
 */
const recent: ScanEvent[] = [];
const RECENT_LIMIT = 500;
let currentJobId: string | null = null;
let lastDone: ScanEvent | null = null;

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function emit(event: ScanEvent): void {
  if (event.type === "scan:start") {
    recent.length = 0;
    currentJobId = event.jobId;
    lastDone = null;
  }
  recent.push(event);
  if (recent.length > RECENT_LIMIT) recent.shift();
  if (event.type === "scan:done") {
    currentJobId = null;
    lastDone = event;
  }
  for (const fn of [...subscribers]) {
    try {
      fn(event);
    } catch {
      subscribers.delete(fn);
    }
  }
}

/**
 * What a newly connected client should be told about: everything from the scan
 * still running, or — when nothing is running — only the fact that the last one
 * finished, so the UI can settle rather than replay a completed scan.
 */
export function recentEvents(): ScanEvent[] {
  if (currentJobId !== null) return [...recent];
  return lastDone ? [lastDone] : [];
}

/** Test seam. */
export function resetEvents(): void {
  recent.length = 0;
  currentJobId = null;
  lastDone = null;
}

export function subscriberCount(): number {
  return subscribers.size;
}

/** Format one event as an SSE frame. */
export function sseFrame(event: ScanEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
