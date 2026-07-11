// Centralized Redis key builders + TTLs — never inline key literals.

export const cacheTtl = {
  /** Inbound dedup marker: 5 hours, in seconds. */
  fanoutDedup: 60 * 60 * 5,
};

export const cacheKeys = {
  /** Marks an inbound requestId as already enqueued (at-most-once fanout). */
  inboundDedupKey(requestId: string): string {
    return `graph:fanout:inbound:${requestId}`;
  },
};
