/** Shared by the suites that construct server objects wanting a logger. */
export function noopLogger() {
  const log = {
    info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {},
    child() {
      return log;
    },
  };
  return log as unknown as import('../server/src/util/logger.js').Logger;
}
