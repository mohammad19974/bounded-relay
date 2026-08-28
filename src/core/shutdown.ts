export interface ShutdownTarget {
  shutdown(): Promise<void>;
}

export interface CloseableTransport {
  close(): Promise<void>;
}

/**
 * Closes the transport even when job shutdown fails, so a failing cleanup can
 * never leave the stdio server running with no way to exit.
 */
export async function shutdownWorker(
  jobs: ShutdownTarget,
  transport: CloseableTransport,
): Promise<void> {
  try {
    await jobs.shutdown();
  } finally {
    await transport.close();
  }
}
