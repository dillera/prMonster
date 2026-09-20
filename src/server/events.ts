// In-memory SSE broadcaster for scan progress (DESIGN.md §5 /api/events).

import type { DeepEvent, ScanEvent } from "../shared/types.js";

/**
 * Everything the broadcaster carries. Deep-analysis events ride the same
 * /api/events stream as scan events (DESIGN-deep.md routes table), so the UI
 * needs one connection.
 */
export type BroadcastEvent = ScanEvent | DeepEvent;

type Subscriber = (event: BroadcastEvent) => void;

const subscribers = new Set<Subscriber>();

/**
 * Events of the scan currently running, replayed to a client that connects
 * mid-scan. A blind "last N" buffer replayed events from a finished job as
 * though they were live, so the dashboard showed a phantom scan in progress.
 */
const recent: BroadcastEvent[] = [];
const RECENT_LIMIT = 500;
let currentJobId: string | null = null;
let lastDone: BroadcastEvent | null = null;

/**
 * Deep runs are not part of a scan job, so they get their own replay: the
 * events of runs still in flight, plus the most recent completion, so a client
 * that reloads mid-run sees the step log it missed.
 */
const deepInFlight = new Map<string, DeepEvent[]>();
let lastDeepDone: DeepEvent | null = null;
const DEEP_RUN_LIMIT = 200;

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function emit(event: BroadcastEvent): void {
  if (event.type.startsWith("deep:")) {
    const deep = event as DeepEvent;
    if (deep.type === "deep:start") deepInFlight.set(deep.runId, [deep]);
    else {
      const list = deepInFlight.get(deep.runId);
      if (list) {
        list.push(deep);
        if (list.length > DEEP_RUN_LIMIT) list.splice(1, 1); // keep deep:start
      }
    }
    if (deep.type === "deep:done") {
      deepInFlight.delete(deep.runId);
      lastDeepDone = deep;
    }
  } else {
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
export function recentEvents(): BroadcastEvent[] {
  const scan = currentJobId !== null ? [...recent] : lastDone ? [lastDone] : [];
  const deep: BroadcastEvent[] = [...deepInFlight.values()].flat();
  if (deep.length === 0 && lastDeepDone) deep.push(lastDeepDone);
  return [...scan, ...deep];
}

/** Test seam. */
export function resetEvents(): void {
  recent.length = 0;
  currentJobId = null;
  lastDone = null;
  deepInFlight.clear();
  lastDeepDone = null;
}

export function subscriberCount(): number {
  return subscribers.size;
}

/** Format one event as an SSE frame. */
export function sseFrame(event: BroadcastEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
