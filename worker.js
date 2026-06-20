import { Worker, isMainThread, parentPort } from 'worker_threads';

if (isMainThread) {
  // Only the main thread spawns workers
  const w1 = new Worker(new URL(import.meta.url));
  const w2 = new Worker(new URL(import.meta.url));

  w1.on('message', (msg) => console.log('w1:', msg));
  w2.on('message', (msg) => console.log('w2:', msg));
} else {
  // Worker thread code goes here
  parentPort.postMessage('hello from worker');
}