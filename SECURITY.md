# Security policy

## Report a vulnerability

Write to **contact@nymra.si**, or use "Report a vulnerability" on this repository's Security tab.
Do not open a public issue for a security problem.

Please include what you found, how to reproduce it, and what an attacker could do with it.

## In scope

- Code in this repository: a crafted explorer response that crashes the scan, runs code, or makes
  the engine report a wrong score or a wrong link on purpose.
- Anything that would make the engine send data anywhere other than the explorers and RPC nodes in
  `src/chains.ts`, the ENS service it names and the relay you configure.
- The relay in `proxy/`: a way to read an API key from any answer, to reach a host outside the
  register, to call it from another site, or to make it log an address.
- A result that states ownership as fact instead of a likelihood.

## Out of scope

- Wrong or missing labels in third-party label lists: open a normal issue.
- Rate limits or outages of the public explorers.

## Rules for testing

Only test with your own addresses or public data. Never send funds or sign anything as part of a
test; the engine only reads.

We reply as fast as we can and credit reporters who want to be credited.
