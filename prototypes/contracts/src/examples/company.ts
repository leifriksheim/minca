/**
 * 3. Company team. Sub-teams: `hr` writes `app.hr`, `eng` writes `app.eng`
 * (and `web`, inside `eng`, writes `app.web`); the company's admins manage
 * them all but can't read `app.hr`.
 */
import type { Delegation } from '../grants.js';

export const CEO = 'did:key:ceo'; // founder
export const ANN = 'did:key:ann'; // company admin
export const HAL = 'did:key:hal'; // hr
export const EVE = 'did:key:eve'; // eng
export const WES = 'did:key:wes'; // web, so eng too

// -- (A) UCAN grants ---------------------------------------------------------

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
    ],
  },
  { iss: CEO, aud: 'role:admin', cmd: '/record/read', pol: [['not', ['==', '.collection', 'app.hr']]] },
];

// -- (C) Datalog --------------------------------------------------------------

export const datalog = `
parent("company", "hr"); parent("company", "eng"); parent("eng", "web");
writes("hr", "app.hr"); writes("eng", "app.eng"); writes("web", "app.web");
private("app.hr");

// A team's admins manage every team below it.
below($t, $s) <- parent($t, $s);
below($t, $s) <- below($t, $m), parent($m, $s);

// in_team(Who, Team, As): As is "member" or "admin". Not by oneself.
joined($by, $who, $t, $as) <- record($j, "std.role", $by), field($j, "to", $who), field($j, "team", $t), field($j, "as", $as);
in_team($who, $t, $as) <- joined($by, $who, $t, $as), founder($by);
in_team($who, $t, $as) <- joined($by, $who, $t, $as), in_team($by, $top, "admin"), below($top, $t), $by != $who;

// A sub-team's members work in the team above it too.
works_in($who, $t) <- in_team($who, $t, "member");
works_in($who, $t) <- works_in($who, $s), parent($t, $s);

allowed($w, $c, $k) <- request($w, $c, $k), founder($w);
allowed($w, $c, $k) <- request($w, $c, $k), works_in($w, $t), writes($t, $k);
allowed($w, "/record/read", $k) <- request($w, "/record/read", $k), in_team($w, $top, "admin"), below($top, $t), writes($t, $k), !private($k);
`;
