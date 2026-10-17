// ENS / public identity: a name, linked accounts, public labels.
import { cexLabel } from '../labels.ts';
import type { Evidence, Finding } from '../types.ts';
import { finding, type Detector } from './context.ts';

const KEY_NAMES: Record<string, string> = {
  'com.twitter': 'X (Twitter)', 'com.github': 'GitHub', url: 'website', email: 'email', 'com.discord': 'Discord',
  'org.telegram': 'Telegram', 'com.linkedin': 'LinkedIn', 'xyz.farcaster': 'Farcaster', name: 'name', location: 'location',
};

export const publicIdentity: Detector = {
  id: 'public_identity',
  network: false,
  async run(ctx) {
    const p = ctx.profile;
    const out: Finding[] = [];
    // A contract or a service is not a person: its findings speak of "this address", never "you".
    const it = !!ctx.thirdPerson;
    // An ENS name can be made up (1.4.0): it shows a name, not who holds the wallet, so it is medium and no
    // ceiling. Its records with real handles stay high: they lead to an account.
    if (p.ens) {
      out.push(finding({
        id: 'public_identity.ens_reverse', detector: 'public_identity', severity: 'medium', confidence: 1,
        title: it ? 'This address has a public name' : 'Your wallet has a public name',
        explanation: it
          ? `This address is set to show the ENS name ${p.ens}. Anyone who knows the name finds this address, and anyone looking at it sees the name.`
          : `This address is set to show the ENS name ${p.ens}. Anyone who knows the name finds this wallet, and anyone looking at the wallet sees the name.`,
        evidence: [{ kind: 'ens', text: `Primary ENS name: ${p.ens}`, value: p.ens, chainId: 1 }],
        chains: [1],
      }));
    }
    const recs = Object.entries(p.ensRecords);
    if (recs.length) {
      const ev: Evidence[] = recs.map(([k, v]) => ({ kind: 'ens', text: `${KEY_NAMES[k] ?? k}: ${v}`, value: k }));
      const social = recs.filter(([k]) => k !== 'name' && k !== 'location').map(([k]) => KEY_NAMES[k] ?? k);
      out.push(finding({
        id: 'public_identity.ens_records', detector: 'public_identity', severity: social.length ? 'high' : 'medium', confidence: 0.95,
        title: it ? 'Its ENS name points to other accounts' : 'Your ENS name points to other accounts',
        explanation: it
          ? (social.length ? `The ENS name lists: ${social.join(', ')}. That ties this address to an identity outside the chain.` : 'The ENS name carries details that anyone can read.')
          : social.length
            ? `The ENS name lists your ${social.join(', ')}. That ties this wallet to an identity outside the chain.`
            : 'The ENS name carries personal details that anyone can read.',
        evidence: ev, chains: [1],
      }));
    }
    if (p.ownedNames.length) {
      out.push(finding({
        id: 'public_identity.owned_names', detector: 'public_identity', severity: p.ens ? 'low' : 'medium', confidence: 0.9,
        title: `This ${it ? 'address' : 'wallet'} owns ${p.ownedNames.length === 1 ? 'an ENS name' : `${p.ownedNames.length} ENS names`}`,
        explanation: it
          ? 'ENS ownership is public. A name this address owns can be searched, and it leads back to the address even when it is not its primary name.'
          : 'ENS ownership is public. A name you own can be searched, and it leads back to this wallet even when it is not your primary name.',
        evidence: p.ownedNames.slice(0, 8).map((n) => ({ kind: 'ens' as const, text: n, value: n })),
        chains: [1],
      }));
    }
    const cex = cexLabel(ctx.me);
    const tags = [...p.tags];
    if (cex && cex.kind === 'hot') tags.push(`${cex.entity} (exchange wallet)`);
    if (cex && cex.kind === 'deposit') tags.push(`${cex.entity} deposit address`);
    if (tags.length) {
      out.push(finding({
        id: 'public_identity.public_label', detector: 'public_identity', severity: 'critical', confidence: 1,
        title: it ? 'This address carries a public label' : 'Your address carries a public label',
        explanation: `Explorers or open label lists name this address: ${tags.slice(0, 3).join(', ')}. Labels travel with the address to every site that uses them.`,
        evidence: tags.slice(0, 6).map((t) => ({ kind: 'label' as const, text: t, label: t })),
        chains: [1],
      }));
    }
    if (p.isContract) {
      out.push(finding({
        id: 'public_identity.is_contract', detector: 'public_identity', severity: 'info', confidence: 1,
        title: 'This is a smart contract',
        explanation: `This address holds code${p.contractName ? ` (${p.contractName})` : ''}. A contract is public by design, so read the score as a description of its traffic, not of a person.`,
        evidence: [{ kind: 'stat', text: 'Address has contract code on Ethereum', chainId: 1 }],
        chains: [1],
      }));
    }
    return out;
  },
};
