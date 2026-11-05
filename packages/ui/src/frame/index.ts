/**
 * What runs in front of every screen, after `window.minca` and before the
 * screen's own scripts: the `ui` global. Preact with htm, so a screen writes
 * components without a build step; hooks over `minca` that redraw when the
 * space changes; the pieces apps share (faces, comments, places, dialogs,
 * shapes); and Minca's look. Bundled into one script by `bundle.ts`. What it
 * offers is in `guide.ts`.
 */
import { Fragment, h, render } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { positionBetween } from '@minca/core/schemas';
import { ago } from '../time';
import * as when from '../when';
import { Attachments, Playable, attach, useSeen } from './attachments';
import { sizeOf } from '../size';
import { Comments } from './comments';
import { useBlob, useCan, useFile, useMarked, usePeople, useRecords, useShown, useView } from './hooks';
import { useLive, usePresence } from './live';
import { html } from './html';
import { FormatMenu, MentionInput } from './editor';
import { MentionText } from './markdown';
import { mentionsIn } from './mentions';
import { Modal } from './modal';
import { AddMenu, EmojiPicker, Reactions, RowMenu, react } from './menus';
import { Record, recordTitle } from './record';
import { Shared, Sharing, useShare } from './share';
import { Avatar, Person, useName } from './people';
import {
  MapLink,
  NearButton,
  PlaceField,
  distanceFrom,
  distanceText,
  inReach,
  nearWhere,
  placeLabel,
  useNear,
} from './places';
import { Cover, Empty, Icon, Shape } from './shapes';

/**
 * Preact's `render`, except that with nowhere to draw it draws into an
 * element of its own at the end of the page, once there is a page: a
 * screen's scripts often run in its head, before the body exists, and
 * rendering into the body itself would take whatever else is in it.
 */
function draw(tree: Parameters<typeof render>[0], into?: Element | null) {
  if (into) return render(tree, into);
  const go = () => {
    const root = document.createElement('div');
    root.id = 'app';
    document.body.append(root);
    render(tree, root);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', go, { once: true });
  else go();
}

/** Minca's stylesheet (css/minca.css), written in by bundleUi */
declare const MINCA_CSS: string;

const style = document.createElement('style');
style.textContent = MINCA_CSS;
document.head.append(style);

Object.defineProperty(globalThis, 'ui', {
  value: Object.freeze({
    html,
    h,
    render: draw,
    Fragment,
    useState,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useCallback,
    useReducer,
    useRecords,
    usePeople,
    useCan,
    useFile,
    useBlob,
    useShown,
    useView,
    useMarked,
    useLive,
    usePresence,
    useName,
    Avatar,
    Person,
    Comments,
    MentionInput,
    MentionText,
    mentionsIn,
    Attachments,
    Playable,
    attach,
    useSeen,
    sizeOf,
    Modal,
    AddMenu,
    RowMenu,
    EmojiPicker,
    FormatMenu,
    Reactions,
    react,
    Record,
    recordTitle,
    useShare,
    Sharing,
    Shared,
    Shape,
    Icon,
    Empty,
    Cover,
    PlaceField,
    NearButton,
    MapLink,
    useNear,
    placeLabel,
    distanceFrom,
    distanceText,
    inReach,
    nearWhere,
    positionBetween,
    ago,
    when: Object.freeze({ ...when }),
  }),
});
