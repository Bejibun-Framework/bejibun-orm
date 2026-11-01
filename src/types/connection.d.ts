/** Connection-resource counters used for liveness diagnostics. */
export interface ConnectionMetrics {
    /** Active `isolated()` scopes. */
    scopes: number;

    /** Open connections owned by live isolation scopes. */
    scopedConnections: number;

    /** Cached shared connection pools. */
    sharedConnections: number;
}
