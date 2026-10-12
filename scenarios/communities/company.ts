/**
 * 3. Company team. Sub-teams: `hr` writes `app.hr`, `eng` writes `app.eng`
 * (and `web`, inside `eng`, writes `app.web`); the company's admins manage
 * them all but can't read `app.hr`, and can't assign themselves a team.
 * `web` is a sub-team: the role `web` holds the role `eng`. Nesting is part
 * of web's definition, so whoever defines roles sets it up (the CEO here).
 */
import type { Assignment, Delegation, Nesting } from '../host/library.js';

export const CEO = 'did:key:ceo'; // founder
export const ANN = 'did:key:ann'; // company admin
export const HAL = 'did:key:hal'; // hr
export const EVE = 'did:key:eve'; // eng
export const WES = 'did:key:wes'; // web, so eng too

// -- The community: UCAN grants --------------------------------------------------

export const grants: Delegation[] = [
  { iss: CEO, aud: 'role:hr', cmd: '/record', pol: [['==', '.collection', 'app.hr']] },
  { iss: CEO, aud: 'role:eng', cmd: '/record', pol: [['==', '.collection', 'app.eng']] },
  { iss: CEO, aud: 'role:web', cmd: '/record', pol: [['==', '.collection', 'app.web']] },
  {
    iss: CEO,
    aud: 'role:admin',
    cmd: '/role/assign',
    pol: [
      [
        'or',
        [
          ['==', '.role', 'hr'],
          ['==', '.role', 'eng'],
          ['==', '.role', 'web'],
        ],
      ],
      ['==', '.self', false],
    ],
  },
  { iss: CEO, aud: 'role:admin', cmd: '/record/read', pol: [['not', ['==', '.collection', 'app.hr']]] },
];

// -- The story ---------------------------------------------------------------------

/** The CEO makes Ann admin and puts the web team inside eng; Ann staffs the teams. */
export const assignments: Assignment[] = [
  { by: CEO, to: ANN, role: 'admin' },
  { by: ANN, to: HAL, role: 'hr' },
  { by: ANN, to: EVE, role: 'eng' },
  { by: ANN, to: WES, role: 'web' },
];

export const nestings: Nesting[] = [{ by: CEO, role: 'web', holds: 'eng' }];

/** A second account Ann controls */
export const SOCK = 'did:key:ann-second-account';
