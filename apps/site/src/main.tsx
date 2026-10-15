import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { baseCss } from '@minca/app-shared/styles';
import { APP } from './pages/Site';
import { router } from './router';

// The app is a site of its own now. A link made when it lived here, at `/app`
// or with an invite or door in its fragment, goes on to it, with the
// fragment (which never reached a server) intact.
const { pathname, hash } = globalThis.location;
const appLink = /^\/app(\/|$)/.test(pathname) || /[#&](invite|door)=/.test(hash);
if (appLink) globalThis.location.replace(`${APP}/${hash}`);

// The design system's tokens and base rules; the pages' own styles are in pages/site.css.
const style = globalThis.document.createElement('style');
style.textContent = baseCss;
globalThis.document.head.append(style);

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
if (!appLink) createRoot(root).render(<RouterProvider router={router} />);
