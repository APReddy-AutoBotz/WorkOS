import {performance} from 'node:perf_hooks';

const limitsMs = [100, 250, 500, 1000, 2000, 3000, 5000];
const emptyWindow = () => ({
  responses: {'1xx': 0, '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0, other: 0},
  interrupted: 0,
  latencyCounts: Array(limitsMs.length + 1).fill(0),
});

export function createApiTrafficMetrics({clock = () => performance.now()} = {}) {
  let window = emptyWindow();
  let started = clock();
  let inFlight = 0;

  function observe(_req, res, next) {
    const began = clock();
    inFlight++;
    function finished() {
      const duration = clock() - began;
      res.off('close', interrupted);
      inFlight--;
      const bucket = limitsMs.findIndex(limit => duration <= limit);
      window.latencyCounts[bucket < 0 ? limitsMs.length : bucket]++;
      const statusClass = Math.floor(res.statusCode / 100);
      window.responses[statusClass >= 1 && statusClass <= 5 ? statusClass + 'xx' : 'other']++;
    }
    function interrupted() {
      res.off('finish', finished);
      inFlight--;
      window.interrupted++;
    }
    res.once('finish', finished);
    res.once('close', interrupted);
    next();
  }

  function takeWindow() {
    const end = clock();
    const record = {
      timestamp: new Date().toISOString(), level: 'info', service: 'api', operation: 'http.traffic',
      windowMs: Math.round(end - started), inFlight,
      ...window, latencyUpperBoundsMs: [...limitsMs],
    };
    window = emptyWindow();
    started = end;
    return record;
  }

  return {observe, takeWindow};
}
