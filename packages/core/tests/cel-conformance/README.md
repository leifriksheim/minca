# CEL conformance tests

Files from the CEL spec's conformance suite (`tests/simple/testdata` in
github.com/google/cel-spec, commit `40a3c9007a9305d1f2638d5f538a4e011732cace`),
under the Apache License 2.0 (`LICENSE`), unchanged.

`../cel-conformance.test.ts` runs every test in them against
`packages/core/src/records/cel.ts`: each expression must either be refused
when it is checked (it is outside the subset) or give the expected result.
