import { h } from 'preact';
import htm from 'htm';

/** Preact's elements as tagged templates, so a screen needs no build step */
export const html = htm.bind(h);
