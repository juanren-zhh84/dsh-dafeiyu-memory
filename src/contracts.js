/** Registered Cordis service name. */
export const MEMORY_SERVICE_NAME = 'dafeiyuMemory';

/**
 * Public service boundary. recall() returns a projection string synchronously;
 * status() returns { state: 'ready' | 'disposed' } synchronously. All other
 * methods return Promises. Unimplemented operations reject rather than pretend
 * that memory has been persisted. After disposal only status()/dispose() work.
 */
export const MEMORY_METHODS = Object.freeze([
  'recordEvent', 'recall', 'status', 'search', 'importExisting',
  'runDueReviews', 'backup', 'restoreRecycleItem', 'purgeRecycleItem',
  'promoteToDiary', 'dispose',
]);

export function memoryError(code, message) {
  return Object.assign(new Error(message), { code });
}
