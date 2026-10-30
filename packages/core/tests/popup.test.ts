import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { popupFeatures } from '../src/session/popup.js';

/** The window a popup opens from: where it is on the screen, and its size */
const WINDOW = ['screenX', 'screenY', 'outerWidth', 'outerHeight'] as const;
const at = (place: Readonly<Record<(typeof WINDOW)[number], number>>) => Object.assign(globalThis, place);

describe('a popup', () => {
  afterEach(() => {
    for (const key of WINDOW) Reflect.deleteProperty(globalThis, key);
  });

  test('opens centred on the window it opens from, not where the browser likes', () => {
    at({ screenX: 100, screenY: 50, outerWidth: 1400, outerHeight: 900 });
    assert.equal(popupFeatures(460, 720), 'popup,width=460,height=720,left=570,top=140');
  });

  test('never off the screen, when its window is smaller than it', () => {
    at({ screenX: 0, screenY: 0, outerWidth: 400, outerHeight: 600 });
    assert.equal(popupFeatures(460, 720), 'popup,width=460,height=720,left=0,top=0');
  });

  test('off a browser, where there is no window, is just its size', () => {
    assert.equal(popupFeatures(460, 720), 'popup,width=460,height=720');
  });
});
