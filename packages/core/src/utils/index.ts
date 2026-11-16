/**
 * @module utils
 * Small helpers the Minca packages share. None of it is protocol: nothing
 * here is something a peer checks.
 */
export { isRecord, isObject, unref, bufferSource } from './guards.js';
export { backoff } from './backoff.js';
export { markStep } from './step.js';
