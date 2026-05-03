# Plan vs Docs Differences

For each difference, mark whether the plan or the docs needs updating, then check it off when addressed.

---

## 1. `src/decide.ts` missing from the plan's file layout

HOW_IT_WORKS.md describes "interpret, apply rules (`src/interpret.ts` + `src/decide.ts`)" as two separate files. The plan's file layout only includes `src/interpret.ts` with no `decide.ts`.

- [ ] Plan is wrong — add `src/decide.ts` to the plan's file layout
- [x] Docs are wrong — remove `src/decide.ts` from HOW_IT_WORKS.md; it should be `src/interpret.ts` only
- [ ] Do nothing

- [x] Addressed

---

## 2. README sections in the plan that don't exist in the actual README

Plan step 0 specifies these README sections: Scripts table, Built-in rules table, YAML schema reference. None of these appear in the actual README.

- [ ] Plan is wrong — remove those sections from the plan's README spec
- [ ] Docs are wrong — add Scripts table, Built-in rules table, and YAML schema reference to README.md
- [x] Do nothing

- [x] Addressed

---

## 3. README sections that exist but aren't in the plan

The actual README has "Verifying the plugin" and "Configuration" (allow-all settings) sections. Plan step 0 doesn't mention either of these.

- [ ] Plan is wrong — add "Verifying the plugin" and "Configuration" to the plan's README spec
- [ ] Docs are wrong — remove those sections from README.md
- [x] Do nothing

- [x] Addressed

---

## 4. Two doc files missing from the plan entirely

Plan step 0 only covers creating `README.md` and `docs/HOW_IT_WORKS.md`. The actual docs also include `docs/USER-DEFINED-RULES.md` and `docs/DEVELOPMENT.md`. Neither is mentioned in any plan step.

- [ ] Plan is wrong — add steps to create `docs/USER-DEFINED-RULES.md` and `docs/DEVELOPMENT.md`
- [ ] Docs are wrong — remove `docs/USER-DEFINED-RULES.md` and `docs/DEVELOPMENT.md`
- [x] Do nothing

- [x] Addressed

---

## 5. Quick start: TypeScript path missing from README

Plan step 0 says the quick start should cover "TypeScript path and YAML path". The actual README quick start only shows YAML rules.

- [ ] Plan is wrong — update the plan's README spec so quick start is YAML-only
- [ ] Docs are wrong — add a TypeScript quick start path to README.md
- [x] Do nothing

- [x] Addressed

---

## 6. YAML flag and positional matcher field names differ between the plan, USER-DEFINED-RULES.md, and the README

The README quick start uses a unified `args` field: a list (`args: [r, f]`) for flag-presence matching and a string (`args: "."`) for positional matching. Both the plan (step 8) and `docs/USER-DEFINED-RULES.md` use separate fields instead: `flags: [r, f]` for flag-presence and `pos: "."` for positionals.

- [x] Plan is wrong — update step 8 to use `args` (list) for flags and `args` (string) for positionals, to match the README. USER-DEFINED-RULES.md also needs updating to use `args` instead of `flags` and `pos`.
- [ ] README is wrong — update the README quick start examples to use `flags` and `pos`, to match USER-DEFINED-RULES.md and the plan
- [ ] Do nothing

- [x] Addressed

---

## 7. Broken link in HOW_IT_WORKS.md

HOW_IT_WORKS.md links to `../README.md#yaml-schema-reference`, but no such section exists in the README. The YAML schema reference is in `docs/USER-DEFINED-RULES.md` instead. The plan (step 0) puts this content in the README, but it ended up in a separate file.

- [ ] Plan is wrong — update the plan's step 0 to say YAML schema reference goes in USER-DEFINED-RULES.md, not README
- [x] Docs are wrong — fix the link in HOW_IT_WORKS.md to point to `USER-DEFINED-RULES.md` instead
- [ ] Do nothing

- [x] Addressed

---

## 8. Step 12 doesn't cover all doc files

Step 12 ("Update documentation") only says to review `README.md` and `docs/HOW_IT_WORKS.md`. It should also cover `docs/USER-DEFINED-RULES.md` and `docs/DEVELOPMENT.md`.

- [x] Plan is wrong — add USER-DEFINED-RULES.md and DEVELOPMENT.md to step 12's checklist
- [ ] Docs are wrong — remove USER-DEFINED-RULES.md and DEVELOPMENT.md
- [ ] Do nothing

- [x] Addressed
