# Contributing

Thanks for helping make wallet privacy measurable. This repository holds the scan rules, so every
change here changes someone's score: keep changes small, explained and tested.

## Good first contributions

- **A new chain.** One line in `src/chains.ts`. The chain must be EVM compatible and have a public
  explorer API that returns transactions and token transfers for an address, keyless where one
  exists. Say in the pull request which explorer, and whether it exposes internal transfers (traces).
- **A label fix.** A missing or wrong exchange, bridge or service address, with a public source.
- **A false positive.** A public address where a finding is clearly wrong. Include the address,
  the finding id and why it is wrong.

## Changing a rule or the score

1. Open an issue first and explain the leak the rule measures, or why a weight is wrong.
2. Change `src/score.ts` or the detector, and update `RULES.md` in the same pull request.
3. Bump `RULES_VERSION` in `src/score.ts`.
4. Add or update a test in `test/` and regenerate the fixtures with `npm run fixtures`. A rule test
   must fail when the rule is broken: `npm run mutate` checks that for every detector.

## House rules for text

Every explanation a user reads is English, plain and short (1 to 3 sentences).

- A link between wallets is always a likelihood with a confidence. Write "likely", "often" or
  "may"; never "this is your wallet" or a name as the owner.
- No em dash and no middle dot. A missing value is `n/a`.

## Before you open a pull request

```sh
npm test
npm run typecheck
```

Both must pass. Add no dependencies: the engine runs in the browser.

## Security

Never report a vulnerability in an issue or pull request. See [SECURITY.md](SECURITY.md).

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
